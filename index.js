require('dotenv').config();
// Silence console logging in production unless explicitly enabled
if (process.env.NODE_ENV === 'production' && !process.env.ENABLE_LOGS) {
  // Mute only verbose logs; keep warnings & errors
  ['log','info','debug'].forEach(fn => {
    console[fn] = () => {};
  });
}
const express = require("express");
const app = express();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const morgan = require('morgan');
const Papa = require("papaparse");
const { db, analyticsDb } = require("./db");
const crypto = require("crypto");
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const passport = require('./auth');
const bcrypt = require('bcryptjs');
const sendMail = require('./mailer');
const compression = require('compression');
const zlib = require('zlib');
const cookieParser = require('cookie-parser');
const csrf = require('csurf');
const fetch = require("node-fetch");

const upload = multer({ dest: "uploads/" });
app.use(compression());
app.use(express.json());
app.use(cookieParser(process.env.COOKIE_SECRET || 'change_this_cookie_secret'));

// Request logging
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

// Middleware to assign a stable, signed visitor ID cookie for anonymous voters
app.use((req, res, next) => {
  let visitorId = (req.signedCookies && req.signedCookies.visitor_id) || null;
  const hasExistingCookie = !!visitorId;
  
  // Get IP address for fallback identification
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || 'unknown';

  if (!visitorId) {
    visitorId = crypto.randomUUID();
    // Signed, HTTP-only cookie so users can't trivially forge new IDs without clearing cookies
    res.cookie('visitor_id', visitorId, {
      maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
      httpOnly: true,
      sameSite: 'lax',
      signed: true
    });
  }

  // Use cookie if it existed before this request, otherwise fall back to IP for rate limiting
  req.voterId = visitorId;
  req.voterKey = hasExistingCookie ? `v:${visitorId}` : `ip:${ip}`;
  next();
});

// Simple in-memory rate limiter for votes: max 5 per 10-second window per voter
const voteHistory = new Map(); // voterId -> [timestamps]
function voteRateLimiter(req, res, next) {
  const id = req.user ? `u:${req.user.id}` : req.voterKey;
  const now = Date.now();
  const WINDOW_MS = 10 * 1000; // 10 seconds
  const MAX_VOTES = 5;

  let arr = voteHistory.get(id) || [];
  // Keep only timestamps within the window
  arr = arr.filter(ts => now - ts < WINDOW_MS);
  
  if (arr.length >= MAX_VOTES) {
    return res.status(429).json({ error: "Rate limit exceeded: max 5 votes per 10 seconds" });
  }
  arr.push(now);
  voteHistory.set(id, arr);
  next();
}

// Helper middleware to protect routes
function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.status(401).json({ error: 'Login required' });
}

// ---- Sessions & Passport ----
// Store sessions in a file that lives on the same persistent disk as the main DB
// In production (Render) DB_PATH=/var/data/teams.db so sessions go to /var/data/sessions.sqlite
// In local dev DB_PATH is unset → sessions.sqlite is created in the project root (as before)
const sessionDir = process.env.SESSION_DIR || (process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : '.');

app.use(session({
  store: new SQLiteStore({
    db: 'sessions.sqlite',
    dir: sessionDir
  }),
  secret: process.env.SESSION_SECRET || 'change_this_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(passport.initialize());
app.use(passport.session());

// CSRF protection stored in session (now that session is set up)
const csrfProtection = csrf({ sessionKey: 'session' });

// Cloudflare Turnstile configuration
const CF_SECRET = process.env.CF_TURNSTILE_SECRET || "1x0000000000000000000000000000000AA"; // demo key
const CF_SITE_KEY = process.env.CF_TURNSTILE_SITE_KEY || "1x00000000000000000000AA"; // demo key
// ✨ Static asset version (cache-buster)
// Priority:
// 1. Manual override via ASSET_VERSION env var
// 2. Git commit hash (if available) + timestamp
// 3. Timestamp only (YYYYMMDDHHmmss)
const ASSET_VERSION = (() => {
  // 1. Check for manual override
  if (process.env.ASSET_VERSION) return process.env.ASSET_VERSION;

  // 2. Try to get git commit hash
  let gitHash = '';
  try {
    gitHash = require('child_process')
      .execSync('git rev-parse --short HEAD')
      .toString()
      .trim();
  } catch (e) {
    console.log('No git hash available:', e.message);
  }

  // 3. Generate timestamp (YYYYMMDD.HHmmss)
  const now = new Date();
  const date = now.toISOString().slice(0,10).replace(/-/g, '');
  const time = now.toISOString().slice(11,19).replace(/:/g, '');
  
  // Combine parts that are available
  return gitHash 
    ? `${date}.${time}.${gitHash}` 
    : `${date}.${time}`;
})();

// ---- ELO Rating Calculation Functions ----
const STARTING_ELO = 1500.0;
const BASE_K_FACTOR = 128.0;

function calculateVoteWeight(voterId, winnerUserId, loserUserId) {
  if (!voterId) return 1.0;
  
  const voterIdStr = String(voterId);
  const winnerUserIdStr = winnerUserId ? String(winnerUserId) : null;
  const loserUserIdStr = loserUserId ? String(loserUserId) : null;
  
  if (voterIdStr === winnerUserIdStr) {
    return 0.5; // Self-votes count as half
  } else if (voterIdStr === loserUserIdStr) {
    return 1.5; // Voting against own team gets extra credit
  } else {
    return 1.0; // Neutral votes get normal weight
  }
}

function calculateExpectedScore(ratingA, ratingB) {
  return 1.0 / (1.0 + Math.pow(10, (ratingB - ratingA) / 400.0));
}

function calculateAdaptiveKFactor(baseK, voteWeight, matchesPlayed) {
  // Weight adjustment: higher weight = higher K-factor
  const weightMultiplier = voteWeight;
  
  // Experience adjustment: fewer matches = higher K-factor
  const experienceFactor = Math.max(0.5, 1.0 - (matchesPlayed / 200.0));
  
  return baseK * weightMultiplier * experienceFactor;
}

function getLatestEloRatings(teamIds, callback) {
  // Get the most recent ELO rating for each team, or use starting rating if none exists
  const placeholders = teamIds.map(() => '?').join(',');
  
  db.all(
    `SELECT 
      team_id,
      elo,
      wins,
      losses,
      tournament,
      username
    FROM (
      SELECT 
        team_id,
        elo,
        wins,
        losses,
        tournament,
        username,
        ROW_NUMBER() OVER (PARTITION BY team_id ORDER BY created_at DESC) as rn
      FROM elo_ratings
      WHERE team_id IN (${placeholders})
    ) ranked
    WHERE rn = 1`,
    teamIds,
    (err, rows) => {
      if (err) return callback(err, null);
      
      // Create map of team_id -> rating data
      const ratings = {};
      
      // Get team info for teams that don't have ELO ratings yet
      db.all(
        `SELECT id, tournament, username FROM teams WHERE id IN (${placeholders})`,
        teamIds,
        (err2, teamRows) => {
          if (err2) return callback(err2, null);
          
          teamIds.forEach(teamId => {
            const existingRating = rows.find(r => r.team_id === teamId);
            const teamInfo = teamRows.find(t => t.id === teamId);
            
            if (existingRating) {
              ratings[teamId] = {
                elo: existingRating.elo,
                wins: existingRating.wins,
                losses: existingRating.losses,
                tournament: existingRating.tournament,
                username: existingRating.username
              };
            } else {
              // Use starting ELO for new teams
              ratings[teamId] = {
                elo: STARTING_ELO,
                wins: 0,
                losses: 0,
                tournament: teamInfo ? teamInfo.tournament : null,
                username: teamInfo ? teamInfo.username : null
              };
            }
          });
          
          callback(null, ratings);
        }
      );
    }
  );
}

function calculateNewEloRatings(winnerElo, loserElo, voteWeight, winnerMatches, loserMatches) {
  // Calculate expected scores
  const winnerExpected = calculateExpectedScore(winnerElo, loserElo);
  const loserExpected = 1.0 - winnerExpected;
  
  // Calculate adaptive K-factors
  const winnerK = calculateAdaptiveKFactor(BASE_K_FACTOR, voteWeight, winnerMatches);
  const loserK = calculateAdaptiveKFactor(BASE_K_FACTOR, voteWeight, loserMatches);
  
  // Update ELO ratings
  const winnerNewElo = winnerElo + winnerK * (1.0 - winnerExpected);
  const loserNewElo = loserElo + loserK * (0.0 - loserExpected);
  
  return {
    winnerNewElo: Math.round(winnerNewElo),
    loserNewElo: Math.round(loserNewElo)
  };
}

// Middleware to verify Turnstile captcha token
async function verifyCaptcha(req, res, next) {
  const token = req.body.captcha;
  if (!token) {
    console.warn("Turnstile verification failed: missing token");
    return res.status(400).json({ error: "Turnstile verification required" });
  }

  // Validate token length (max 2048 characters per documentation)
  if (token.length > 2048) {
    console.warn("Turnstile verification failed: token too long");
    return res.status(400).json({ error: "Invalid token format" });
  }

  try {
    const formData = new URLSearchParams();
    formData.append('secret', CF_SECRET);
    formData.append('response', token);
    formData.append('remoteip', req.ip);

    const cfRes = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formData.toString()
      }
    );

    if (!cfRes.ok) {
      console.error("Turnstile API error:", cfRes.status, cfRes.statusText);
      return res.status(500).json({ error: "Verification service error" });
    }

    const result = await cfRes.json();

    if (result.success) {
      return next();
    } else {
      // Log detailed error information
      console.warn("Turnstile verification failed:", {
        error_codes: result['error-codes'],
        hostname: result.hostname
      });
      
      // Handle specific error cases
      const errorCodes = result['error-codes'] || [];
      if (errorCodes.includes('timeout-or-duplicate')) {
        return res.status(400).json({ error: "Token already used or expired" });
      } else if (errorCodes.includes('invalid-input-response')) {
        return res.status(400).json({ error: "Invalid or expired token" });
      } else {
        return res.status(403).json({ error: "Verification failed" });
      }
    }
  } catch (e) {
    console.error("Turnstile verification error:", e);
    return res.status(500).json({ error: "Verification service unavailable" });
  }
}

// Health check endpoint (lightweight, no database dependency)
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: ASSET_VERSION
  });
});

// ✨ Homepage HTML cache for performance
let homepageHtmlCache = null;
let homepageHtmlCacheEtag = null;

function buildHomepageHtml() {
  const htmlPath = path.join(__dirname, 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  const tokenScript = `\n<script>\n    window.TURNSTILE_SITE_KEY='${CF_SITE_KEY}';\n  </script>\n`;
  html = html.replace('</head>', tokenScript + '</head>');
  // Inject cache-busting query string into main bundle
  html = html.replace('script.js"', `script.js?v=${ASSET_VERSION}"`);
  
  homepageHtmlCache = html;
  homepageHtmlCacheEtag = crypto.createHash('md5').update(html).digest('hex');
  return html;
}

// Build initial cache and rebuild on file changes in development
buildHomepageHtml();
if (process.env.NODE_ENV !== 'production') {
  // Watch for changes in development
  fs.watchFile(path.join(__dirname, 'index.html'), () => {
    buildHomepageHtml();
  });
}

// Serve index.html from memory cache with proper ETags
app.get('/', (req, res) => {
  // Check ETag for conditional requests
  if (req.headers['if-none-match'] === homepageHtmlCacheEtag) {
    return res.status(304).end();
  }
  
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Cache-Control', 'public, max-age=300'); // 5 minutes cache
  res.setHeader('ETag', homepageHtmlCacheEtag);
  res.send(homepageHtmlCache);
});

// Serve upload page
app.get('/upload', (req, res) => {
  const htmlPath = path.join(__dirname, 'upload.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  // Inject cache-busting query string
  html = html.replace('upload.js"', `upload.js?v=${ASSET_VERSION}"`);
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// Serve draft or pass page
app.get('/draftorpass', (req, res) => {
  const htmlPath = path.join(__dirname, 'draftorpass.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  const tokenScript = `\n<script>\n    window.TURNSTILE_SITE_KEY='${CF_SITE_KEY}';\n  </script>\n`;
  html = html.replace('</head>', tokenScript + '</head>');
  // Inject cache-busting query string
  html = html.replace('draftorpass.js"', `draftorpass.js?v=${ASSET_VERSION}"`);
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// Serve leaderboard page  
app.get('/leaderboard', (req, res) => {
  const htmlPath = path.join(__dirname, 'leaderboard.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  // Inject cache-busting query string
  html = html.replace('leaderboard.js"', `leaderboard.js?v=${ASSET_VERSION}"`);
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// Serve matchup settings page
app.get('/matchup-settings', requireAdmin, (req, res) => {
  const htmlPath = path.join(__dirname, 'matchup-settings.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// Serve other static assets after the HTML routes so token injection wins
app.use(express.static(__dirname));

// Handle CSV Upload
app.post("/upload", requireAuth, upload.single("csv"), (req, res) => {
  const csvPath = req.file.path;
  // Determine file base name (without extension) for metadata
  const uploadFileBase = path.basename(req.file.originalname || '', path.extname(req.file.originalname || ''));
  const fileContent = fs.readFileSync(csvPath, "utf8");

  // Username supplied by the uploader (sent as a regular form field alongside the file)
  let uploaderUsername = (req.body.username || "").trim();
  
  // If no username provided and user is logged in with a display_name, use that
  if (!uploaderUsername && req.user && req.user.display_name) {
    uploaderUsername = req.user.display_name;
  }
  
  // If still no username, fall back to anonymous
  if (!uploaderUsername) {
    uploaderUsername = "anonymous";
  }
  
  // Clean and format the username
  uploaderUsername = uploaderUsername
    .replace(/[^a-zA-Z0-9]/g, '') // Remove all non-alphanumeric characters
    .toUpperCase();

  // If user provided a username and doesn't have a display_name, check if username is available
  if (req.body.username && req.body.username.trim() && req.user && !req.user.display_name) {
    // Check if username already exists (case-insensitive)
    db.get(
      `SELECT id FROM users WHERE LOWER(display_name) = LOWER(?) AND id != ?`,
      [uploaderUsername, req.user.id],
      (err, existingUser) => {
        if (err) {
          console.error('Error checking username availability:', err);
          return res.status(500).json({ error: "Database error checking username" });
        }
        
        if (existingUser) {
          // Username is taken
          fs.unlinkSync(csvPath); // Clean up uploaded file
          return res.status(400).json({ error: "Username already taken" });
        }
        
        // Username is available, update user's display_name and continue with upload
        db.run(
          `UPDATE users SET display_name = ? WHERE id = ?`,
          [uploaderUsername, req.user.id],
          (updateErr) => {
            if (updateErr) {
              console.error('Error updating user display_name:', updateErr);
              fs.unlinkSync(csvPath); // Clean up uploaded file
              return res.status(500).json({ error: "Error updating username" });
            }
            // Update the user object in the session
            req.user.display_name = uploaderUsername;
            
            // Continue with CSV processing
            processCsvUpload();
          }
        );
      }
    );
    return; // Exit early, CSV processing will continue in callback
  }

  // Continue with CSV processing immediately if no username validation needed
  processCsvUpload();

  function processCsvUpload() {
    Papa.parse(fileContent, {
    header: true,
    complete: (result) => {
      const rows = result.data;
      
      // ⚠️ Validate positions – only allow NFL skill positions
      const allowedPositions = new Set(['QB', 'RB', 'WR', 'TE']);
      const invalidTeamIds = new Set();

      // First pass to identify any teams that include a disallowed position
      rows.forEach(row => {
        const teamId = row["Draft Entry"];
        if (!teamId) return;
        const pos = String(row["Position"] || '').trim().toUpperCase();
        if (!allowedPositions.has(pos)) {
          invalidTeamIds.add(teamId);
        }
      });

      // Check for required columns
      const requiredColumns = [
        "Picked At",
        "Draft Entry",
        "Tournament Title",
        "First Name",
        "Last Name",
        "Position",
        "Pick Number",
        "Draft",
        "Team"
      ];

      const headers = Object.keys(rows[0] || {});
      const missingColumns = requiredColumns.filter(col => !headers.includes(col));

      if (missingColumns.length > 0) {
        return res.status(400).json({
          error: "Invalid CSV format",
          message: `Missing required columns: ${missingColumns.join(", ")}`
        });
      }

      const groupedTeams = {};
      const teamMetaById = {}; // collect first-seen metadata for each team
      const existingPlayerUpdates = []; // rows needing player-level updates

      // Helper: extract optional team metadata from a CSV row (values may be blank)
      const extractMeta = (row) => ({
        draft_entry_fee: row["Draft Entry Fee"] || null,
        draft_size: row["Draft Size"] || null,
        draft_total_prizes: row["Draft Total Prizes"] || null,
        tournament_id: row["Tournament"] || null,
        tournament_entry_fee: row["Tournament Entry Fee"] || null,
        tournament_total_prizes: row["Tournament Total Prizes"] || null,
        tournament_size: row["Tournament Size"] || null,
        draft_pool_title: row["Draft Pool Title"] || null,
        draft_pool: row["Draft Pool"] || null,
        draft_pool_entry_fee: row["Draft Pool Entry Fee"] || null,
        draft_pool_total_prizes: row["Draft Pool Total Prizes"] || null,
        draft_pool_size: row["Draft Pool Size"] || null,
        weekly_winner_title: row["Weekly Winner Title"] || null,
        weekly_winner: row["Weekly Winner"] || null,
        weekly_winner_entry_fee: row["Weekly Winner Entry Fee"] || null,
        weekly_winner_total_prizes: row["Weekly Winner Total Prizes"] || null,
        weekly_winner_size: row["Weekly Winner Size"] || null,
        file_name: uploadFileBase || null
      });

      // First, collect all teamIds to check
      const teamIds = rows.map(row => row["Draft Entry"]).filter(Boolean);

      // Check which teams already exist
      db.all(
        `SELECT id FROM teams WHERE id IN (${teamIds.map(() => '?').join(',')})`,
        teamIds,
        (err, existingTeams) => {
          if (err) {
            console.error('Error checking existing teams:', err);
            return res.status(500).json({ error: "Database error" });
          }

          const existingTeamIds = new Set(existingTeams.map(t => t.id));

          // Track counts for reporting
          const skippedExistingIds = new Set(existingTeamIds);

          // Now process only non-existing teams
          rows.forEach((row) => {
            const teamId = row["Draft Entry"];
            if (!teamId) return;

            // Capture team-level meta once per team (first occurrence)
            if (!teamMetaById[teamId]) {
              teamMetaById[teamId] = extractMeta(row);
            }

            const tournament = row["Tournament Title"];
            
            // Skip rows with blank/empty tournament
            if (!tournament || tournament.trim() === '') {
              return;
            }
            
            const fullName = `${row["First Name"]} ${row["Last Name"]}`;
            let position = row["Position"];
            if ((tournament || '').trim().toLowerCase() === 'rookies and sophomores' && String(position).trim().toUpperCase() === 'TE') {
              position = 'WR';
            }
            const pick = parseInt(row["Pick Number"]);
            const draftId = row["Draft"];
            const team = row["Team"];

            // Validate player info
            if (!fullName || !position || isNaN(pick)) return;
            if (invalidTeamIds.has(teamId)) return; // invalid team composition

            // Only add new teams' players (avoid duplicates for existing teams)
            if (existingTeamIds.has(teamId)) {
              existingPlayerUpdates.push({ teamId, position, name: fullName, pick, team, pickedAt: row["Picked At"] || null, appearance: row["Appearance"] || null });
              return; // skip adding to groupedTeams
            }

            if (!groupedTeams[teamId]) {
              groupedTeams[teamId] = {
                tournament,
                players: [],
                draftId
              };
            }

            const pickedAt = row["Picked At"] || null;
            const appearance = row["Appearance"] || null;

            groupedTeams[teamId].players.push({ position, name: fullName, pick, team, pickedAt, appearance });
          });

          // Prepare counts & helper for metadata update
          const addedTeamsCount = Object.keys(groupedTeams).length;
          const skippedIdsSet = new Set([
            ...skippedExistingIds,
            ...invalidTeamIds
          ]);

          const metaCols = [
            'draft_entry_fee', 'draft_size', 'draft_total_prizes',
            'tournament_id', 'tournament_entry_fee', 'tournament_total_prizes', 'tournament_size',
            'draft_pool_title', 'draft_pool', 'draft_pool_entry_fee', 'draft_pool_total_prizes', 'draft_pool_size',
            'weekly_winner_title', 'weekly_winner', 'weekly_winner_entry_fee', 'weekly_winner_total_prizes', 'weekly_winner_size',
            'file_name'
          ];

          const updateAllTeamMeta = () => {
            for (const [tId, meta] of Object.entries(teamMetaById)) {
              const updateSql = `UPDATE teams SET ` + metaCols.map(c => `${c} = COALESCE(${c}, ? )`).join(', ') + ` WHERE id = ?`;
              const params = metaCols.map(c => meta[c] || null).concat(tId);
              db.run(updateSql, params);
            }
          };

          // If no new teams, just update metadata and respond
          if (addedTeamsCount === 0) {
            updateAllTeamMeta();
            
            // --- Apply player-level updates for existing teams ---
            existingPlayerUpdates.forEach((pl) => {
              db.run(
                `UPDATE players SET name = ?, team = ?, picked_at = COALESCE(picked_at, ?), appearance = COALESCE(appearance, ?) WHERE team_id = ? AND position = ? AND pick = ?`,
                [pl.name, pl.team, pl.pickedAt, pl.appearance, pl.teamId, pl.position, pl.pick],
                function(err) {
                  if (err) { console.error('Player update err', err); return; }
                  if (this.changes === 0) {
                    // Only insert if no player exists at this team_id + position + pick combination
                    db.run(
                      `INSERT INTO players (team_id, position, name, pick, team, stack, picked_at, appearance) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                      [pl.teamId, pl.position, pl.name, pl.pick, pl.team, null, pl.pickedAt, pl.appearance],
                      (insErr) => { if (insErr) console.error('Player insert err', insErr); }
                    );
                  }
                }
              );
            });

            return res.json({
              message: `0 new entries added, ${skippedIdsSet.size} skipped`,
              added: 0,
              skipped: skippedIdsSet.size,
              skippedIds: [...skippedIdsSet],
              skippedExisting: [...skippedExistingIds],
              skippedInvalid: [...invalidTeamIds]
            });
          }

          db.serialize(() => {
            for (const [teamId, data] of Object.entries(groupedTeams)) {
              db.run(
                `INSERT OR IGNORE INTO teams (id, tournament, username, draft_id, user_id) VALUES (?, ?, ?, ?, ?)`,
                [teamId, data.tournament, uploaderUsername, data.draftId, req.user && req.user.id]
              );

              // Sort players by pick number for stack processing
              const players = data.players.sort((a, b) => a.pick - b.pick);
              
              // Find and assign primary stacks (QB-based)
              const qbs = players.filter(p => p.position === 'QB');
              
              // First assign all QB-based primary stacks
              for (const qb of qbs) {
                const receivers = players.filter(p => 
                  (p.position === 'WR' || p.position === 'TE' || p.position === 'RB') && 
                  p.team === qb.team && 
                  p !== qb
                );
                
                if (receivers.length > 0) {
                  qb.stack = 'primary';
                  receivers.forEach(r => r.stack = 'primary');
                }
              }
              
              // Then look for secondary stacks among remaining WR/TE/RBs
              const unstackedReceivers = players.filter(p => 
                (p.position === 'WR' || p.position === 'TE' || p.position === 'RB') && 
                !p.stack
              );
              
              // Group unstacked receivers by team
              const teamGroups = {};
              unstackedReceivers.forEach(p => {
                if (!teamGroups[p.team]) {
                  teamGroups[p.team] = [];
                }
                teamGroups[p.team].push(p);
              });
              
              // Assign secondary stacks where there are multiple receivers from same team
              Object.values(teamGroups).forEach(group => {
                if (group.length > 1) {
                  group.forEach(p => p.stack = 'secondary');
                }
              });

              // Insert players with stack information (including picked_at & appearance)
              players.forEach((player) => {
                db.run(
                  `INSERT INTO players (team_id, position, name, pick, team, stack, picked_at, appearance) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                  [
                    teamId,
                    player.position,
                    player.name,
                    player.pick,
                    player.team,
                    player.stack || null,
                    player.pickedAt || null,
                    player.appearance || null
                  ]
                );
              });
            }

            // === Update (or backfill) team-level metadata for all teams present in CSV ===
            updateAllTeamMeta();
            // --- Apply player-level updates for existing teams ---
            existingPlayerUpdates.forEach((pl) => {
              db.run(
                `UPDATE players SET name = ?, team = ?, picked_at = COALESCE(picked_at, ?), appearance = COALESCE(appearance, ?) WHERE team_id = ? AND position = ? AND pick = ?`,
                [pl.name, pl.team, pl.pickedAt, pl.appearance, pl.teamId, pl.position, pl.pick],
                function(err) {
                  if (err) { console.error('Player update err', err); return; }
                  if (this.changes === 0) {
                    // Only insert if no player exists at this team_id + position + pick combination
                    db.run(
                      `INSERT INTO players (team_id, position, name, pick, team, stack, picked_at, appearance) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                      [pl.teamId, pl.position, pl.name, pl.pick, pl.team, null, pl.pickedAt, pl.appearance],
                      (insErr) => { if (insErr) console.error('Player insert err', insErr); }
                    );
                  }
                }
              );
            });

            res.json({
              message: `${addedTeamsCount} new ${addedTeamsCount === 1 ? 'entry' : 'entries'} added, ${skippedIdsSet.size} skipped`,
              added: addedTeamsCount,
              skipped: skippedIdsSet.size,
              skippedIds: [...skippedIdsSet],
              skippedExisting: [...skippedExistingIds],
              skippedInvalid: [...invalidTeamIds]
            });
          });
        }
      );
    },
    error: (error) => {
      console.error('CSV parsing error:', error);
      res.status(400).json({
        error: "CSV parsing error",
        message: "Failed to parse the CSV file. Please check the file format."
      });
    }
  });
  }
});

// ---- File-based cache for heavy /teams endpoint ----
const CACHE_FILE_PATH = process.env.TEAMS_CACHE_FILE || path.join(sessionDir, 'teams_cache.json.gz');
const CACHE_REFRESH_MS = 15 * 60 * 1000; // 15 minutes
let teamsCacheMeta = { etag: null, stamp: 0 };

async function buildTeamsCache() {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    
    // Get team count first for progress tracking
    db.get('SELECT COUNT(*) as count FROM teams', [], (countErr, countRow) => {
      if (countErr) return reject(countErr);
      
      const totalTeams = countRow.count;
      
      // Use smaller batch size to reduce memory usage
      const BATCH_SIZE = 500; // Reduced from 1000
      const DELAY_BETWEEN_BATCHES = 5; // Reduced delay
      
      const teams = {};
      const tournaments = {};
      const usernames = {};
      const userIds = {};
      const totals = {}; // wins & losses per team
      const strategies = {}; // strategy flags per team
      
      let processed = 0;
      let offset = 0;
      
      const processBatch = async () => {
        // Use LIMIT/OFFSET instead of getting all IDs first
        const sql = `
          SELECT 
            t.id            AS team_id,
            t.tournament    AS tournament,
            t.username      AS username,
            t.user_id       AS user_id,
            t.high_t        AS high_t,
            t.zero_rb       AS zero_rb,
            t.elite_qb      AS elite_qb,
            t.elite_te      AS elite_te,
            t.hero_rb       AS hero_rb,
            COALESCE(wins_count.wins, 0) AS wins,
            COALESCE(losses_count.losses, 0) AS losses,
            p.position      AS position,
            p.name          AS name,
            p.pick          AS pick,
            p.team          AS team,
            p.stack         AS stack
          FROM teams t
          JOIN players p ON p.team_id = t.id
          LEFT JOIN (
            SELECT winner_id, COUNT(*) as wins
            FROM versus_matches
            GROUP BY winner_id
          ) wins_count ON t.id = wins_count.winner_id
          LEFT JOIN (
            SELECT loser_id, COUNT(*) as losses
            FROM versus_matches
            GROUP BY loser_id
          ) losses_count ON t.id = losses_count.loser_id
          WHERE t.id IN (
            SELECT id FROM teams 
            ORDER BY id 
            LIMIT ${BATCH_SIZE} OFFSET ${offset}
          )
          ORDER BY t.id, p.pick
        `;

        db.all(sql, [], (err, rows) => {
          if (err) return reject(err);

          // If no rows, we're done
          if (rows.length === 0) {
            // Write final cache
            const payloadObj = { teams: Object.entries(teams), tournaments, usernames, userIds, totals, strategies };
            const jsonStr = JSON.stringify(payloadObj);
            
            // Use async compression to avoid blocking
            zlib.gzip(jsonStr, (gzipErr, gz) => {
              if (gzipErr) return reject(gzipErr);
              
              fs.writeFile(CACHE_FILE_PATH, gz, (writeErr) => {
                if (writeErr) return reject(writeErr);
                
                teamsCacheMeta = {
                  etag: crypto.createHash('md5').update(jsonStr).digest('hex'),
                  stamp: Date.now()
                };
                
                const duration = Date.now() - startTime;
                return resolve();
              });
            });
            return;
          }

          const processedTeamsInBatch = new Set();
          
          // Process this batch more efficiently
          rows.forEach((row) => {
            if (!teams[row.team_id]) {
              teams[row.team_id] = [];
              tournaments[row.team_id] = row.tournament;
              usernames[row.team_id] = row.username;
              userIds[row.team_id] = row.user_id;
              totals[row.team_id] = { wins: row.wins, losses: row.losses };
              strategies[row.team_id] = {
                high_t: row.high_t,
                zero_rb: row.zero_rb,
                elite_qb: row.elite_qb,
                elite_te: row.elite_te,
                hero_rb: row.hero_rb
              };
              processedTeamsInBatch.add(row.team_id);
            }
            teams[row.team_id].push({
              position: row.position,
              name: row.name,
              pick: row.pick,
              team: row.team,
              stack: row.stack
            });
          });

          processed += processedTeamsInBatch.size;
          offset += BATCH_SIZE;
          
          // Continue with next batch after small delay
          setTimeout(processBatch, DELAY_BETWEEN_BATCHES);
        });
      };
      
      processBatch();
    });
  });
}

// Initial build and periodic refresh
buildTeamsCache().catch(err => console.error('Error building /teams cache:', err));
setInterval(() => buildTeamsCache().catch(err => console.error('Error building /teams cache:', err)), CACHE_REFRESH_MS);

app.get('/teams', async (req, res) => {
  if (!teamsCacheMeta.etag) {
    return res.status(503).json({ error: 'Cache building, try again shortly.' });
  }

  // Check if there are matchup settings that filter teams
  const matchupSettings = await new Promise((resolve) => {
    db.get('SELECT * FROM matchup_settings WHERE id = 1', (err, row) => {
      if (err) {
        console.error('Error fetching matchup settings:', err);
        resolve(null);
      } else {
        resolve(row);
      }
    });
  });

  const filterTournament = matchupSettings?.tournament;
  const filterTeam1Stack = matchupSettings?.team1_stack;
  const filterTeam2Stack = matchupSettings?.team2_stack;
  const filterTeam1Player = matchupSettings?.team1_player;
  const filterTeam2Player = matchupSettings?.team2_player;
  const filterTeam1Strategy = matchupSettings?.team1_strategy;
  const filterTeam2Strategy = matchupSettings?.team2_strategy;
  
  // If no filters at all, serve the full cached file
  if (!filterTournament && !filterTeam1Stack && !filterTeam2Stack && !filterTeam1Player && !filterTeam2Player && !filterTeam1Strategy && !filterTeam2Strategy) {
    if (req.headers['if-none-match'] === teamsCacheMeta.etag) {
      return res.status(304).end();
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Cache-Control', 'public, max-age=900');
    res.setHeader('ETag', teamsCacheMeta.etag);

    return fs.createReadStream(CACHE_FILE_PATH).pipe(res);
  }

  // Filters are active - need to filter the data
  try {
    // Read and decompress the cache file
    const gzippedData = fs.readFileSync(CACHE_FILE_PATH);
    const jsonStr = zlib.gunzipSync(gzippedData).toString('utf8');
    const fullData = JSON.parse(jsonStr);

    // Helper function to check if a team has a primary stack for a given NFL team
    const teamHasPrimaryStack = (teamData, nflTeam) => {
      if (!teamData || !Array.isArray(teamData)) return false;
      return teamData.some(player => 
        player.team === nflTeam && player.stack === 'primary'
      );
    };

    // Helper function to check if a team has a specific player
    const teamHasPlayer = (teamData, playerName) => {
      if (!teamData || !Array.isArray(teamData)) return false;
      return teamData.some(player => 
        player.name === playerName
      );
    };

    // Filter teams based on all criteria
    let filteredTeams = fullData.teams;

    // Filter by tournament if specified
    if (filterTournament) {
      filteredTeams = filteredTeams.filter(([teamId]) => {
        return fullData.tournaments[teamId] === filterTournament;
      });
    }

    // Separate teams into categories based on stack, player, and strategy requirements
    let team1Candidates = [];
    let team2Candidates = [];
    let generalCandidates = [];

    // Strategy data is now available from the cache
    const strategyData = fullData.strategies || {};
    
    if (filterTeam1Strategy || filterTeam2Strategy) {
      
      // Debug: Count strategy distributions in cache
      const strategyCounts = {
        high_t: 0,
        zero_rb: 0,
        elite_qb: 0,
        elite_te: 0,
        hero_rb: 0
      };
      
      Object.values(strategyData).forEach(strategies => {
        if (strategies.high_t === 1) strategyCounts.high_t++;
        if (strategies.zero_rb === 1) strategyCounts.zero_rb++;
        if (strategies.elite_qb === 1) strategyCounts.elite_qb++;
        if (strategies.elite_te === 1) strategyCounts.elite_te++;
        if (strategies.hero_rb === 1) strategyCounts.hero_rb++;
      });
      
    }

    if (filterTeam1Stack || filterTeam2Stack || filterTeam1Player || filterTeam2Player || filterTeam1Strategy || filterTeam2Strategy) {
      
      let debugCount = 0;
      filteredTeams.forEach(([teamId, teamData]) => {
        const hasTeam1Stack = filterTeam1Stack ? teamHasPrimaryStack(teamData, filterTeam1Stack) : true;
        const hasTeam2Stack = filterTeam2Stack ? teamHasPrimaryStack(teamData, filterTeam2Stack) : true;
        const hasTeam1Player = filterTeam1Player ? teamHasPlayer(teamData, filterTeam1Player) : true;
        const hasTeam2Player = filterTeam2Player ? teamHasPlayer(teamData, filterTeam2Player) : true;
        
        // Strategy checks
        const hasTeam1Strategy = filterTeam1Strategy ? (strategyData[teamId] && strategyData[teamId][filterTeam1Strategy] === 1) : true;
        const hasTeam2Strategy = filterTeam2Strategy ? (strategyData[teamId] && strategyData[teamId][filterTeam2Strategy] === 1) : true;

        // Debug first few teams
        if (debugCount < 5 && (filterTeam1Strategy || filterTeam2Strategy)) {
          debugCount++;
        }

        // Team1 candidates must match stack, player, and strategy requirements (if specified)
        const matchesTeam1 = hasTeam1Stack && hasTeam1Player && hasTeam1Strategy;
        // Team2 candidates must match stack, player, and strategy requirements (if specified)  
        const matchesTeam2 = hasTeam2Stack && hasTeam2Player && hasTeam2Strategy;

        if ((filterTeam1Stack || filterTeam1Player || filterTeam1Strategy) && matchesTeam1) {
          team1Candidates.push([teamId, teamData]);
        }
        if ((filterTeam2Stack || filterTeam2Player || filterTeam2Strategy) && matchesTeam2) {
          team2Candidates.push([teamId, teamData]);
        }
        
        // Teams that don't match specific requirements but are still valid
        if (!matchesTeam1 && !matchesTeam2) {
          generalCandidates.push([teamId, teamData]);
        }
      });

      // Update filteredTeams based on filtering logic
      const hasTeam1Filters = filterTeam1Stack || filterTeam1Player || filterTeam1Strategy;
      const hasTeam2Filters = filterTeam2Stack || filterTeam2Player || filterTeam2Strategy;
      
      if (hasTeam1Filters && hasTeam2Filters) {
        // Both teams have filters - include teams that match either filter
        filteredTeams = [...team1Candidates, ...team2Candidates];
      } else if (hasTeam1Filters) {
        // Only team1 has filters - include team1 candidates + general candidates
        filteredTeams = [...team1Candidates, ...generalCandidates];
      } else if (hasTeam2Filters) {
        // Only team2 has filters - include team2 candidates + general candidates  
        filteredTeams = [...team2Candidates, ...generalCandidates];
      }
      // If no filters, filteredTeams stays as the original (all teams)
      
      // Remove duplicates (teams that might match both team1 and team2 criteria)
      const seenTeamIds = new Set();
      filteredTeams = filteredTeams.filter(([teamId]) => {
        if (seenTeamIds.has(teamId)) {
          return false;
        }
        seenTeamIds.add(teamId);
        return true;
      });

      // If no teams match the requirements, fall back to a different tournament
      if (((filterTeam1Stack || filterTeam1Player || filterTeam1Strategy) && team1Candidates.length === 0) || 
          ((filterTeam2Stack || filterTeam2Player || filterTeam2Strategy) && team2Candidates.length === 0)) {
        
        
        // Query database for teams with the required stacks/players across all tournaments
        const findTeamsWithFilters = () => {
          return new Promise((resolve) => {
            let conditions = [];
            let params = [];
            
            if (filterTeam1Stack) {
              conditions.push(`EXISTS (SELECT 1 FROM players p1 WHERE p1.team_id = t.id AND p1.team = ? AND p1.stack = 'primary')`);
              params.push(filterTeam1Stack);
            }
            
            if (filterTeam1Player) {
              conditions.push(`EXISTS (SELECT 1 FROM players p1p WHERE p1p.team_id = t.id AND p1p.name = ?)`);
              params.push(filterTeam1Player);
            }
            
            if (filterTeam2Stack) {
              conditions.push(`EXISTS (SELECT 1 FROM players p2 WHERE p2.team_id = t.id AND p2.team = ? AND p2.stack = 'primary')`);
              params.push(filterTeam2Stack);
            }
            
            if (filterTeam2Player) {
              conditions.push(`EXISTS (SELECT 1 FROM players p2p WHERE p2p.team_id = t.id AND p2p.name = ?)`);
              params.push(filterTeam2Player);
            }
            
            if (filterTeam1Strategy) {
              conditions.push(`t.${filterTeam1Strategy} = 1`);
            }
            
            if (filterTeam2Strategy) {
              conditions.push(`t.${filterTeam2Strategy} = 1`);
            }
            
            const sql = `
              SELECT DISTINCT t.tournament
              FROM teams t
              WHERE ${conditions.join(' OR ')}
              AND t.tournament IS NOT NULL
              ORDER BY t.tournament
              LIMIT 1
            `;
            
            db.get(sql, params, (err, row) => {
              if (err) {
                console.error('Error finding tournament with filters:', err);
                resolve(null);
              } else {
                resolve(row?.tournament || null);
              }
            });
          });
        };

        const fallbackTournament = await findTeamsWithFilters();
        
        if (fallbackTournament) {
          
          // Re-filter with the fallback tournament
          filteredTeams = fullData.teams.filter(([teamId]) => {
            return fullData.tournaments[teamId] === fallbackTournament;
          });
          
          // Recalculate candidates with the new tournament
          team1Candidates = [];
          team2Candidates = [];
          generalCandidates = [];
          
          filteredTeams.forEach(([teamId, teamData]) => {
            const hasTeam1Stack = filterTeam1Stack ? teamHasPrimaryStack(teamData, filterTeam1Stack) : true;
            const hasTeam2Stack = filterTeam2Stack ? teamHasPrimaryStack(teamData, filterTeam2Stack) : true;
            const hasTeam1Player = filterTeam1Player ? teamHasPlayer(teamData, filterTeam1Player) : true;
            const hasTeam2Player = filterTeam2Player ? teamHasPlayer(teamData, filterTeam2Player) : true;

            const matchesTeam1 = hasTeam1Stack && hasTeam1Player;
            const matchesTeam2 = hasTeam2Stack && hasTeam2Player;

            if ((filterTeam1Stack || filterTeam1Player) && matchesTeam1) {
              team1Candidates.push([teamId, teamData]);
            }
            if ((filterTeam2Stack || filterTeam2Player) && matchesTeam2) {
              team2Candidates.push([teamId, teamData]);
            }
            
            if (!matchesTeam1 && !matchesTeam2) {
              generalCandidates.push([teamId, teamData]);
            }
          });
        }
      }

      // Add metadata to help frontend identify which teams match which criteria
      filteredTeams = filteredTeams.map(([teamId, teamData]) => {
        const hasTeam1Stack = filterTeam1Stack ? teamHasPrimaryStack(teamData, filterTeam1Stack) : false;
        const hasTeam2Stack = filterTeam2Stack ? teamHasPrimaryStack(teamData, filterTeam2Stack) : false;
        const hasTeam1Player = filterTeam1Player ? teamHasPlayer(teamData, filterTeam1Player) : false;
        const hasTeam2Player = filterTeam2Player ? teamHasPlayer(teamData, filterTeam2Player) : false;
        
        const matchesTeam1 = (filterTeam1Stack ? hasTeam1Stack : true) && (filterTeam1Player ? hasTeam1Player : true);
        const matchesTeam2 = (filterTeam2Stack ? hasTeam2Stack : true) && (filterTeam2Player ? hasTeam2Player : true);
        
        return [teamId, teamData, {
          matchesTeam1Stack: hasTeam1Stack,
          matchesTeam2Stack: hasTeam2Stack,
          matchesTeam1Player: hasTeam1Player,
          matchesTeam2Player: hasTeam2Player,
          matchesTeam1: matchesTeam1,
          matchesTeam2: matchesTeam2,
          preferredFor: matchesTeam1 ? 'team1' : (matchesTeam2 ? 'team2' : null)
        }];
      });
    }

    // Filter other maps to only include the filtered teams
    const filteredTeamIds = new Set(filteredTeams.map(([teamId]) => teamId));
    const filteredTournaments = {};
    const filteredUsernames = {};
    const filteredUserIds = {};
    const filteredTotals = {};
    const filteredStrategies = {};

    filteredTeamIds.forEach(teamId => {
      if (fullData.tournaments[teamId]) filteredTournaments[teamId] = fullData.tournaments[teamId];
      if (fullData.usernames[teamId]) filteredUsernames[teamId] = fullData.usernames[teamId];
      if (fullData.userIds[teamId]) filteredUserIds[teamId] = fullData.userIds[teamId];
      if (fullData.totals[teamId]) filteredTotals[teamId] = fullData.totals[teamId];
      if (fullData.strategies[teamId]) filteredStrategies[teamId] = fullData.strategies[teamId];
    });

    const filteredData = {
      teams: filteredTeams,
      tournaments: filteredTournaments,
      usernames: filteredUsernames,
      userIds: filteredUserIds,
      totals: filteredTotals,
      strategies: filteredStrategies,
      // Add filtering metadata
      stackFilters: {
        team1Stack: filterTeam1Stack,
        team2Stack: filterTeam2Stack,
        team1Player: filterTeam1Player,
        team2Player: filterTeam2Player,
        team1Strategy: filterTeam1Strategy,
        team2Strategy: filterTeam2Strategy,
        team1Candidates: team1Candidates.length,
        team2Candidates: team2Candidates.length
      }
    };
    

    // Create a custom ETag for the filtered data
    const filteredJsonStr = JSON.stringify(filteredData);
    const filteredEtag = crypto.createHash('md5').update(filteredJsonStr).digest('hex');

    if (req.headers['if-none-match'] === filteredEtag) {
      return res.status(304).end();
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=300'); // Shorter cache for filtered data
    res.setHeader('ETag', filteredEtag);

    res.json(filteredData);

  } catch (error) {
    console.error('Error filtering teams data:', error);
    res.status(500).json({ error: 'Failed to filter teams data' });
  }
});

// Yes/No voting has been removed - only versus matchups are supported

// Record versus match result (captcha-protected, rate limiting handled client-side)
app.post("/versus", verifyCaptcha, (req, res) => {
  const { winnerId, loserId } = req.body;
  const voterId = req.user ? req.user.id : null;

  if (!winnerId || !loserId) {
    return res.status(400).json({ error: "Winner and loser IDs required" });
  }

  // First, get current ELO ratings for both teams
  getLatestEloRatings([winnerId, loserId], (eloErr, eloRatings) => {
    if (eloErr) {
      console.error('Error getting ELO ratings:', eloErr);
      return res.status(500).json({ error: "Failed to get team ratings" });
    }

    // Get team owner info for vote weight calculation
    db.all(
      `SELECT t.id, t.user_id, t.username, t.tournament, u.display_name
       FROM teams t 
       LEFT JOIN users u ON t.user_id = u.id 
       WHERE t.id IN (?, ?)`,
      [winnerId, loserId],
      (err2, teamRows) => {
        if (err2) {
          console.error('Error fetching team info:', err2);
          return res.status(500).json({ error: "Failed to get team information" });
        }

        const winnerTeam = teamRows.find(t => t.id === winnerId);
        const loserTeam = teamRows.find(t => t.id === loserId);
        
        if (!winnerTeam || !loserTeam) {
          return res.status(400).json({ error: "Invalid team IDs" });
        }

        // Calculate vote weight
        const voteWeight = calculateVoteWeight(voterId, winnerTeam.user_id, loserTeam.user_id);
        
        // Get current ELO data
        const winnerRating = eloRatings[winnerId];
        const loserRating = eloRatings[loserId];
        
        // Calculate match counts for adaptive K-factor
        const winnerMatches = winnerRating.wins + winnerRating.losses;
        const loserMatches = loserRating.wins + loserRating.losses;
        
        // Calculate new ELO ratings
        const newRatings = calculateNewEloRatings(
          winnerRating.elo,
          loserRating.elo,
          voteWeight,
          winnerMatches,
          loserMatches
        );

        // Record the versus match
        db.run(
          `INSERT INTO versus_matches (winner_id, loser_id, voter_id) VALUES (?, ?, ?)`,
          [winnerId, loserId, voterId],
          (err) => {
            if (err) return res.status(500).json({ error: "Failed to record match result" });
            
            // Record new ELO ratings for both teams
            const winnerNewWins = winnerRating.wins + voteWeight;
            const loserNewLosses = loserRating.losses + voteWeight;
            
            // Insert winner's new ELO rating
            db.run(
              `INSERT INTO elo_ratings (team_id, tournament, username, elo, wins, losses) 
               VALUES (?, ?, ?, ?, ?, ?)`,
              [winnerId, winnerTeam.tournament, winnerTeam.username, newRatings.winnerNewElo, winnerNewWins, winnerRating.losses],
              (eloErr1) => {
                if (eloErr1) {
                  console.error('Error recording winner ELO rating:', eloErr1);
                }
              }
            );
            
            // Insert loser's new ELO rating
            db.run(
              `INSERT INTO elo_ratings (team_id, tournament, username, elo, wins, losses) 
               VALUES (?, ?, ?, ?, ?, ?)`,
              [loserId, loserTeam.tournament, loserTeam.username, newRatings.loserNewElo, loserRating.wins, loserNewLosses],
              (eloErr2) => {
                if (eloErr2) {
                  console.error('Error recording loser ELO rating:', eloErr2);
                }
              }
            );
            
            // Clear cache for both teams since their stats changed
            teamMetaCache.delete(winnerId);
            teamMetaCache.delete(loserId);
            
            // Invalidate recent votes cache since new vote was added
            widgetCache.delete('recent-votes');
            widgetCache.delete('recent-votes-count');
            
            // Create detailed notifications for team owners (if voter is logged in and different from team owners)
            if (voterId) {
              // Get voter information
              db.get(
                `SELECT u.display_name
                 FROM users u WHERE u.id = ?`,
                [voterId],
                (err3, voterRow) => {
                  if (err3) {
                    console.error('Error fetching voter info for notifications:', err3);
                    return;
                  }

                  const voterName = voterRow?.display_name || 'Someone';

                  teamRows.forEach(team => {
                    // Only create notification if team has an owner and it's not the voter themselves
                    if (team.user_id && team.user_id !== voterId) {
                      const isWinner = team.id === winnerId;
                      const opponentTeam = teamRows.find(t => t.id !== team.id);
                      const opponentName = opponentTeam?.display_name || opponentTeam?.username || 'another user';
                      
                      // Build the notification message
                      const emoji = isWinner ? '🔥 ' : '❌ ';
                      const message = `${emoji}${voterName} voted ${isWinner ? 'for' : 'against'} your team in ${team.tournament} against ${opponentName}`;
                      
                      db.run(
                        `INSERT INTO notifications (user_id, type, message, related_team_id, related_user_id, opponent_team_id) 
                         VALUES (?, ?, ?, ?, ?, ?)`,
                        [team.user_id, 'versus_vote', message, team.id, voterId, opponentTeam?.id],
                        (err4) => {
                          if (err4) {
                            console.error('Error creating notification:', err4);
                          }
                        }
                      );
                    }
                  });
                }
              );
            }
            
            res.json({ status: "recorded" });
          }
        );
      }
    );
  });
});

// Get versus stats for a team
app.get("/versus-stats/:teamId", (req, res) => {
  const { teamId } = req.params;
  
  db.all(
    `SELECT 
      (SELECT COUNT(*) FROM versus_matches WHERE winner_id = ?) as wins,
      (SELECT COUNT(*) FROM versus_matches WHERE loser_id = ?) as losses
    `,
    [teamId, teamId],
    (err, rows) => {
      if (err) {
        console.error('Error getting versus stats:', err);
        return res.status(500).json({ error: 'Database error' });
      }

      // Ensure we get numbers, not strings
      const stats = {
        wins: parseInt(rows[0]?.wins || 0, 10),
        losses: parseInt(rows[0]?.losses || 0, 10)
      };
      
      const total = stats.wins + stats.losses;
      
      // Calculate win percentage
      let winPct = 0;
      if (total > 0) {
        winPct = (stats.wins / total) * 100;
      } else if (stats.wins > 0) {
        winPct = 100; // If we have wins but total calculation failed
      }
      stats.win_pct = Number(winPct.toFixed(1));
      
      res.json(stats);
    }
  );
});

// Simple in-memory cache for team metadata (30 second TTL)
const teamMetaCache = new Map();
const TEAM_META_CACHE_TTL = 30 * 1000; // 30 seconds

// Cleanup expired cache entries every 5 minutes (reduced from 2 minutes)
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, value] of teamMetaCache.entries()) {
    if (now - value.timestamp > TEAM_META_CACHE_TTL) {
      teamMetaCache.delete(key);
      cleaned++;
    }
  }
}, 5 * 60 * 1000); // Changed from 2 minutes to 5 minutes

// === Memory monitoring ===
setInterval(() => {
  const used = process.memoryUsage();
  const mb = (bytes) => Math.round(bytes / 1024 / 1024 * 100) / 100;
  
  // Log memory usage if it's getting high
  if (used.heapUsed > 1024 * 1024 * 1024) { // > 1GB
    console.warn(`⚠️ High memory usage: RSS: ${mb(used.rss)}MB, Heap: ${mb(used.heapUsed)}MB`);
    
    // Log cache sizes
    
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }
  }
}, 60 * 1000); // Check every minute

// Combined meta endpoint: owner info + versus stats (wins/losses)
app.get("/team-meta/:teamId", (req, res) => {
  const { teamId } = req.params;

  // Add cache headers for better performance
  res.setHeader('Cache-Control', 'public, max-age=30'); // Cache for 30 seconds

  // Check in-memory cache first
  const cached = teamMetaCache.get(teamId);
  if (cached && (Date.now() - cached.timestamp) < TEAM_META_CACHE_TTL) {
    return res.json(cached.data);
  }

  const sql = `
    SELECT 
      t.username,
      t.tournament,
      u.twitter_username,
      COALESCE((SELECT madden FROM ratings_history rh WHERE rh.team_id = $id ORDER BY rh.computed_at DESC LIMIT 1), 0) AS madden,
      COALESCE((SELECT elo FROM elo_ratings er WHERE er.team_id = $id ORDER BY er.created_at DESC LIMIT 1), 1500) AS elo_rating,
      (
        SELECT COUNT(*) FROM versus_matches vm WHERE vm.winner_id = $id
      ) AS wins,
      (
        SELECT COUNT(*) FROM versus_matches vm WHERE vm.loser_id = $id
      ) AS losses
    FROM teams t
    LEFT JOIN users u ON t.user_id = u.id
    WHERE t.id = $id
  `;

  const params = { $id: teamId };

  db.get(sql, params, (err, row) => {
    if (err) {
      console.error('Error getting team meta:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    let meta;
    if (!row) {
      // Team not found, but return empty structure for consistency
      meta = { 
        username: null, 
        twitter_username: null, 
        tournament: null, 
        madden: 0,
        elo_rating: 1500,
        percentile: 0.5,
        wins: 0, 
        losses: 0, 
        win_pct: 0 
      };
    } else {
      meta = {
        username: row.username,
        twitter_username: row.twitter_username,
        tournament: row.tournament,
        madden: Math.round(row.madden) || 0,
        elo_rating: Math.round(row.elo_rating) || 1500,
        wins: parseInt(row.wins) || 0,
        losses: parseInt(row.losses) || 0
      };
      
      const total = meta.wins + meta.losses;
      let win_pct = 0;
      if (total > 0) {
        win_pct = (meta.wins / total) * 100;
      } else if (meta.wins > 0) {
        win_pct = 100;
      }
      meta.win_pct = Number(win_pct.toFixed(1));
      
      // Calculate percentile for ELO rating
      if (meta.elo_rating > 0) {
        const globalEloSql = `
          SELECT er.elo as elo_rating
          FROM elo_ratings er
          JOIN teams t ON t.id = er.team_id
          LEFT JOIN (
            SELECT vm.winner_id as team_id, COUNT(*) as wins
            FROM versus_matches vm GROUP BY vm.winner_id
          ) win_counts ON win_counts.team_id = er.team_id
          LEFT JOIN (
            SELECT vm.loser_id as team_id, COUNT(*) as losses
            FROM versus_matches vm GROUP BY vm.loser_id
          ) loss_counts ON loss_counts.team_id = er.team_id
          WHERE er.id IN (
            SELECT MAX(id) FROM elo_ratings GROUP BY team_id, tournament
          )
          AND (COALESCE(win_counts.wins, 0) + COALESCE(loss_counts.losses, 0)) > 0
          ORDER BY er.elo DESC
        `;
        
        db.all(globalEloSql, [], (globalErr, globalRows) => {
          if (!globalErr && globalRows.length > 0) {
            const globalEloValues = globalRows.map(r => r.elo_rating);
            const minGlobalElo = globalEloValues[globalEloValues.length - 1];
            const maxGlobalElo = globalEloValues[0];
            
            if (maxGlobalElo === minGlobalElo) {
              meta.percentile = 0.5;
            } else {
              meta.percentile = (meta.elo_rating - minGlobalElo) / (maxGlobalElo - minGlobalElo);
            }
          } else {
            meta.percentile = 0.5;
          }
          
          // Cache the result and respond
          teamMetaCache.set(teamId, {
            data: meta,
            timestamp: Date.now()
          });
          
          res.json(meta);
        });
      } else {
        meta.percentile = 0.5;
        
        // Cache the result and respond
        teamMetaCache.set(teamId, {
          data: meta,
          timestamp: Date.now()
        });
        
        res.json(meta);
      }
    }
  });
});

// Leaderboard endpoint (team)
const teamLeaderboardCacheMeta = new Map();
const userLeaderboardCacheMeta = new Map();

const LEADER_CACHE_REFRESH_MS = 15 * 60 * 1000; // 15 minutes

// Helper to compute percentages for leaderboard rows
function calcPercents(r) {
  const voteTotal = (r.yes_votes || 0) + (r.no_votes || 0);
  const yes_pct = voteTotal ? ((r.yes_votes / voteTotal) * 100).toFixed(1) : 0;
  const h2hTotal = (r.wins || 0) + (r.losses || 0);
  const win_pct = h2hTotal ? ((r.wins / h2hTotal) * 100).toFixed(1) : 0;
  return { ...r, yes_pct, win_pct };
}

function sanitizeKey(t) {
  return t ? t.replace(/[^a-zA-Z0-9_-]/g, '_') : 'ALL';
}

function buildTeamLeaderboardCache(tournament) {
  return new Promise((resolve, reject) => {
    const key = sanitizeKey(tournament);
    const filePath = path.join(sessionDir, `leaderboard_${key}.json.gz`);

    const sql = `
      WITH team_stats AS (
        SELECT
          t.id,
          t.username,
          t.tournament,
          COALESCE((SELECT madden FROM ratings_history rh WHERE rh.team_id = t.id ORDER BY rh.computed_at DESC LIMIT 1), 0) AS madden,
          COALESCE((
            SELECT COUNT(*) FROM versus_matches vm 
            JOIN teams tw ON vm.winner_id = tw.id 
            JOIN teams tl ON vm.loser_id = tl.id
            WHERE vm.winner_id = t.id 
            AND (? IS NULL OR (tw.tournament = ? AND tl.tournament = ?))
          ), 0) AS wins,
          COALESCE((
            SELECT COUNT(*) FROM versus_matches vm 
            JOIN teams tw ON vm.winner_id = tw.id 
            JOIN teams tl ON vm.loser_id = tl.id
            WHERE vm.loser_id = t.id 
            AND (? IS NULL OR (tw.tournament = ? AND tl.tournament = ?))
          ), 0) AS losses
        FROM teams t
        WHERE (? IS NULL OR t.tournament = ?)
      )
      SELECT * FROM team_stats
      WHERE (wins + losses) > 0
    `;

    db.all(sql, [
      tournament || null, tournament || null, tournament || null, // wins subquery
      tournament || null, tournament || null, tournament || null, // losses subquery  
      tournament || null, tournament || null                      // main WHERE clause
    ], (err, rows) => {
      if (err) return reject(err);

      const enriched = rows.map(calcPercents);
      const jsonStr = JSON.stringify(enriched);
      const gz = zlib.gzipSync(jsonStr);
      fs.writeFileSync(filePath, gz);
      teamLeaderboardCacheMeta.set(key, {
        etag: crypto.createHash('md5').update(jsonStr).digest('hex'),
        stamp: Date.now(),
        filePath
      });
      resolve();
    });
  });
}

function buildUserLeaderboardCache(tournament) {
  return new Promise((resolve, reject) => {
    const key = sanitizeKey(tournament);
    const filePath = path.join(sessionDir, `leaderboard_users_${key}.json.gz`);

    const sql = `
      SELECT
        t.id,
        t.username,
        COALESCE((SELECT ROUND(elo * 99.0 / 2000.0) FROM elo_ratings er WHERE er.team_id = t.id ORDER BY er.created_at DESC LIMIT 1), 75) AS madden,
        COALESCE((SELECT wins FROM elo_ratings er WHERE er.team_id = t.id ORDER BY er.created_at DESC LIMIT 1), 0) AS wins,
        COALESCE((SELECT losses FROM elo_ratings er WHERE er.team_id = t.id ORDER BY er.created_at DESC LIMIT 1), 0) AS losses
      FROM teams t
      WHERE (? IS NULL OR t.tournament = ?)
    `;

    db.all(sql, [
      tournament || null, tournament || null                      // main WHERE clause
    ], (err, rows) => {
      if (err) return reject(err);

      // --- NEW: variables to compute global average Madden rating across all eligible teams ---
      let globalSum = 0;
      let globalCount = 0;

      const userStats = {};
      rows.forEach((r) => {
        const u = r.username || 'ANON';
        if (!userStats[u]) {
          userStats[u] = { username: u, wins: 0, losses: 0, maddens: [] };
        }
        userStats[u].wins += r.wins;
        userStats[u].losses += r.losses;
        // Only include madden ratings for teams with at least 1 total vote
        if (r.madden && (r.wins + r.losses) >= 1) {
          userStats[u].maddens.push(r.madden);
          // --- NEW: feed into global average ---
          globalSum += r.madden;
          globalCount += 1;
        }
      });

      // --- NEW: Compute global average (C) and confidence constant (M) for Bayesian shrinkage ---
      const C = globalCount ? (globalSum / globalCount) : 0;
      const M = 20; // number of votes required before trusting the median fully

      const result = Object.values(userStats)
        .filter(u => (u.wins + u.losses) > 0) // ✂️ exclude users with no votes at all
        .map((u) => {
         // Compute median madden rating
         const arr = u.maddens.sort((a,b)=>a-b);
         let median = 0;
         if (arr.length) {
           const mid = Math.floor(arr.length / 2);
           median = arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
         }
         // Bayesian shrinkage: weight by total votes V vs. confidence constant M
         const V = u.wins + u.losses;
         const adj = (V + M) ? ((V / (V + M)) * median + (M / (V + M)) * C) : C;

         const win_pct = (u.wins + u.losses) ? ((u.wins / (u.wins + u.losses)) * 100).toFixed(1) : 0;
         return {
           username: u.username,
           wins: u.wins,
           losses: u.losses,
           win_pct,
           median_madden: Math.round(adj), // adjusted rating used for sorting/display
           raw_median: median               // keep raw median for reference (front-end ignores)
         };
       });

      const jsonStr = JSON.stringify(result);
      const gz = zlib.gzipSync(jsonStr);
      fs.writeFileSync(filePath, gz);
      userLeaderboardCacheMeta.set(key, {
        etag: crypto.createHash('md5').update(jsonStr).digest('hex'),
        stamp: Date.now(),
        filePath
      });
      resolve();
    });
  });
}

app.get('/api/leaderboard', async (req, res) => {
  const tournament = req.query.tournament || null;
  const key = sanitizeKey(tournament);
  let meta = teamLeaderboardCacheMeta.get(key);

  if (!meta || (Date.now() - meta.stamp > LEADER_CACHE_REFRESH_MS)) {
    try {
      await buildTeamLeaderboardCache(tournament);
      meta = teamLeaderboardCacheMeta.get(key);
    } catch (e) {
      console.error('Error building leaderboard cache:', e);
      return res.status(500).json({ error: 'DB error' });
    }
  }

  if (req.headers['if-none-match'] === meta.etag) {
    return res.status(304).end();
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Encoding', 'gzip');
  res.setHeader('Cache-Control', `public, max-age=${LEADER_CACHE_REFRESH_MS / 1000}`);
  res.setHeader('ETag', meta.etag);

  // Create read stream with error handling for missing cache files
  const stream = fs.createReadStream(meta.filePath);
  stream.on('error', async (err) => {
    if (err.code === 'ENOENT') {
      try {
        // Clear stale meta and rebuild cache
        teamLeaderboardCacheMeta.delete(key);
        await buildTeamLeaderboardCache(tournament);
        const newMeta = teamLeaderboardCacheMeta.get(key);
        
        // Update response headers with new ETag
        res.setHeader('ETag', newMeta.etag);
        
        // Try streaming the newly created file
        const newStream = fs.createReadStream(newMeta.filePath);
        newStream.on('error', (newErr) => {
          console.error('Failed to stream rebuilt cache:', newErr);
          res.status(500).json({ error: 'Cache rebuild failed' });
        });
        newStream.pipe(res);
      } catch (e) {
        console.error('Failed to rebuild leaderboard cache after ENOENT:', e);
        res.status(500).json({ error: 'Cache rebuild failed' });
      }
    } else {
      console.error('Leaderboard stream error:', err);
      res.status(500).json({ error: 'File stream error' });
    }
  });
  stream.pipe(res);
});

app.get('/api/leaderboard/users', async (req, res) => {
  const tournament = req.query.tournament || null;
  const key = sanitizeKey(tournament);
  let meta = userLeaderboardCacheMeta.get(key);

  if (!meta || (Date.now() - meta.stamp > LEADER_CACHE_REFRESH_MS)) {
    try {
      await buildUserLeaderboardCache(tournament);
      meta = userLeaderboardCacheMeta.get(key);
    } catch (e) {
      console.error('Error building user leaderboard cache:', e);
      return res.status(500).json({ error: 'DB error' });
    }
  }

  if (req.headers['if-none-match'] === meta.etag) {
    return res.status(304).end();
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Encoding', 'gzip');
  res.setHeader('Cache-Control', `public, max-age=${LEADER_CACHE_REFRESH_MS / 1000}`);
  res.setHeader('ETag', meta.etag);

  // Create read stream with error handling for missing cache files
  const stream = fs.createReadStream(meta.filePath);
  stream.on('error', async (err) => {
    if (err.code === 'ENOENT') {
      try {
        // Clear stale meta and rebuild cache
        userLeaderboardCacheMeta.delete(key);
        await buildUserLeaderboardCache(tournament);
        const newMeta = userLeaderboardCacheMeta.get(key);
        
        // Update response headers with new ETag
        res.setHeader('ETag', newMeta.etag);
        
        // Try streaming the newly created file
        const newStream = fs.createReadStream(newMeta.filePath);
        newStream.on('error', (newErr) => {
          console.error('Failed to stream rebuilt user cache:', newErr);
          res.status(500).json({ error: 'Cache rebuild failed' });
        });
        newStream.pipe(res);
      } catch (e) {
        console.error('Failed to rebuild user leaderboard cache after ENOENT:', e);
        res.status(500).json({ error: 'Cache rebuild failed' });
      }
    } else {
      console.error('User leaderboard stream error:', err);
      res.status(500).json({ error: 'File stream error' });
    }
  });
  stream.pipe(res);
});

// Get available tournaments for filter
app.get("/tournaments", (req, res) => {
  const sql = `
    SELECT DISTINCT tournament 
    FROM teams 
    WHERE tournament IS NOT NULL AND tournament != ''
    ORDER BY tournament
  `;
  
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: "DB error" });
    res.json(rows.map(r => r.tournament));
  });
});

// Get Elo ratings leaderboard (team view)
app.get("/api/leaderboard/elo", (req, res) => {
  const tournament = req.query.tournament;
  
  let sql = `
    SELECT 
      er.team_id as id,
      t.username,
      t.tournament,
      er.elo as elo_rating,
      COALESCE(win_counts.wins, 0) as wins,
      COALESCE(loss_counts.losses, 0) as losses,
      ROUND((CAST(COALESCE(win_counts.wins, 0) AS REAL) / NULLIF(COALESCE(win_counts.wins, 0) + COALESCE(loss_counts.losses, 0), 0)) * 100, 1) as win_pct,
      er.created_at
    FROM elo_ratings er
    JOIN teams t ON t.id = er.team_id
    LEFT JOIN (
      SELECT 
        vm.winner_id as team_id,
        tw.tournament,
        COUNT(*) as wins
      FROM versus_matches vm
      JOIN teams tw ON tw.id = vm.winner_id
      WHERE tw.tournament IS NOT NULL AND TRIM(tw.tournament) <> ''
      GROUP BY vm.winner_id, tw.tournament
    ) win_counts ON win_counts.team_id = er.team_id AND win_counts.tournament = t.tournament
    LEFT JOIN (
      SELECT 
        vm.loser_id as team_id,
        tl.tournament,
        COUNT(*) as losses
      FROM versus_matches vm
      JOIN teams tl ON tl.id = vm.loser_id
      WHERE tl.tournament IS NOT NULL AND TRIM(tl.tournament) <> ''
      GROUP BY vm.loser_id, tl.tournament
    ) loss_counts ON loss_counts.team_id = er.team_id AND loss_counts.tournament = t.tournament
    WHERE er.id IN (
      SELECT MAX(id) 
      FROM elo_ratings 
      GROUP BY team_id, tournament
    )
  `;
  
  const params = [];
  if (tournament) {
    sql += ` AND t.tournament = ?`;
    params.push(tournament);
  }
  
  sql += ` ORDER BY er.elo DESC`;
  
  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('Elo leaderboard query error:', err);
      return res.status(500).json({ error: "DB error" });
    }
    
    // Calculate percentiles based on ALL teams with at least one vote
    const globalSql = `
      SELECT er.elo as elo_rating
      FROM elo_ratings er
      JOIN teams t ON t.id = er.team_id
      LEFT JOIN (
        SELECT vm.winner_id as team_id, COUNT(*) as wins
        FROM versus_matches vm GROUP BY vm.winner_id
      ) win_counts ON win_counts.team_id = er.team_id
      LEFT JOIN (
        SELECT vm.loser_id as team_id, COUNT(*) as losses
        FROM versus_matches vm GROUP BY vm.loser_id
      ) loss_counts ON loss_counts.team_id = er.team_id
      WHERE er.id IN (
        SELECT MAX(id) FROM elo_ratings GROUP BY team_id, tournament
      )
      AND (COALESCE(win_counts.wins, 0) + COALESCE(loss_counts.losses, 0)) > 0
      ORDER BY er.elo DESC
    `;
    
    db.all(globalSql, [], (globalErr, globalRows) => {
      if (globalErr) {
        console.error('Global Elo query error:', globalErr);
        return res.status(500).json({ error: "DB error" });
      }
      
      if (globalRows.length > 0) {
        const globalEloValues = globalRows.map(r => r.elo_rating);
        const minGlobalElo = globalEloValues[globalEloValues.length - 1];
        const maxGlobalElo = globalEloValues[0];        
        // Add percentile to each row
        rows.forEach(row => {
          if (maxGlobalElo === minGlobalElo) {
            row.percentile = 0.5;
          } else {
            row.percentile = (row.elo_rating - minGlobalElo) / (maxGlobalElo - minGlobalElo);
          }
        });
      }
      
      res.json(rows);
    });
  });
});

// Get Elo ratings leaderboard (user view)
app.get("/api/leaderboard/elo/users", (req, res) => {
  const tournament = req.query.tournament;
  
  let sql = `
    SELECT 
      t.username,
      COUNT(*) as team_count,
      AVG(er.elo) as avg_elo,
      COALESCE(SUM(win_counts.wins), 0) as wins,
      COALESCE(SUM(loss_counts.losses), 0) as losses,
      ROUND((CAST(COALESCE(SUM(win_counts.wins), 0) AS REAL) / NULLIF(COALESCE(SUM(win_counts.wins), 0) + COALESCE(SUM(loss_counts.losses), 0), 0)) * 100, 1) as win_pct
    FROM elo_ratings er
    JOIN teams t ON t.id = er.team_id
    LEFT JOIN (
      SELECT 
        vm.winner_id as team_id,
        tw.tournament,
        COUNT(*) as wins
      FROM versus_matches vm
      JOIN teams tw ON tw.id = vm.winner_id
      WHERE tw.tournament IS NOT NULL AND TRIM(tw.tournament) <> ''
      GROUP BY vm.winner_id, tw.tournament
    ) win_counts ON win_counts.team_id = er.team_id AND win_counts.tournament = t.tournament
    LEFT JOIN (
      SELECT 
        vm.loser_id as team_id,
        tl.tournament,
        COUNT(*) as losses
      FROM versus_matches vm
      JOIN teams tl ON tl.id = vm.loser_id
      WHERE tl.tournament IS NOT NULL AND TRIM(tl.tournament) <> ''
      GROUP BY vm.loser_id, tl.tournament
    ) loss_counts ON loss_counts.team_id = er.team_id AND loss_counts.tournament = t.tournament
    WHERE er.id IN (
      SELECT MAX(id) 
      FROM elo_ratings 
      GROUP BY team_id, tournament
    )
  `;
  
  const params = [];
  if (tournament) {
    sql += ` AND t.tournament = ?`;
    params.push(tournament);
  }
  
  sql += ` 
    GROUP BY t.username
    HAVING t.username IS NOT NULL AND t.username != ''
    ORDER BY avg_elo DESC
  `;
  
  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('Elo user leaderboard query error:', err);
      return res.status(500).json({ error: "DB error" });
    }
    
    // Calculate percentiles based on user average elo ratings (filtered by tournament if specified)
    const globalUserSql = `
      SELECT AVG(er.elo) as avg_elo
      FROM elo_ratings er
      JOIN teams t ON t.id = er.team_id
      LEFT JOIN (
        SELECT vm.winner_id as team_id, COUNT(*) as wins
        FROM versus_matches vm GROUP BY vm.winner_id
      ) win_counts ON win_counts.team_id = er.team_id
      LEFT JOIN (
        SELECT vm.loser_id as team_id, COUNT(*) as losses
        FROM versus_matches vm GROUP BY vm.loser_id
      ) loss_counts ON loss_counts.team_id = er.team_id
      WHERE er.id IN (
        SELECT MAX(id) FROM elo_ratings GROUP BY team_id, tournament
      )
      AND (COALESCE(win_counts.wins, 0) + COALESCE(loss_counts.losses, 0)) > 0
      ${tournament ? 'AND t.tournament = ?' : ''}
      GROUP BY t.username
      HAVING t.username IS NOT NULL AND t.username != ''
    `;
    
    db.all(globalUserSql, tournament ? [tournament] : [], (globalErr, globalRows) => {
      if (globalErr) {
        console.error('Global user Elo query error:', globalErr);
        return res.status(500).json({ error: "DB error" });
      }
      
      if (globalRows.length > 0) {
        const globalAvgElos = globalRows.map(r => r.avg_elo).sort((a, b) => a - b);
        const minGlobalAvgElo = globalAvgElos[0];
        const maxGlobalAvgElo = globalAvgElos[globalAvgElos.length - 1];
        
        // Add percentile to each user row
        rows.forEach(row => {
          if (maxGlobalAvgElo === minGlobalAvgElo) {
            row.percentile = 0.5;
          } else {
            row.percentile = (row.avg_elo - minGlobalAvgElo) / (maxGlobalAvgElo - minGlobalAvgElo);
            console.log(row.avg_elo, minGlobalAvgElo, maxGlobalAvgElo, row.percentile);
          }
        });
      }
      
      res.json(rows);
    });
  });
});

// Admin endpoint to clear leaderboard cache (called by rating script)
app.post('/admin/clear-cache', requireAdmin, (req, res) => {
  try {
    const teamCacheSize = teamLeaderboardCacheMeta.size;
    const userCacheSize = userLeaderboardCacheMeta.size;
    
    teamLeaderboardCacheMeta.clear();
    userLeaderboardCacheMeta.clear();
    
    res.json({ 
      status: 'cleared', 
      teamCacheCleared: teamCacheSize, 
      userCacheCleared: userCacheSize 
    });
  } catch (e) {
    console.error('Error clearing cache:', e);
    res.status(500).json({ error: 'Failed to clear cache' });
  }
});

// Internal endpoint to clear leaderboard cache (called by rating script with secret)
app.post('/internal/clear-cache', (req, res) => {
  const secret = (req.body && req.body.secret) || req.headers['x-internal-secret'];
  const expectedSecret = process.env.INTERNAL_SECRET || 'change_this_internal_secret';
  
  if (!secret) {
    return res.status(400).json({ error: 'Secret required in body or x-internal-secret header' });
  }
  
  if (secret !== expectedSecret) {
    return res.status(403).json({ error: 'Invalid secret' });
  }
  
  try {
    const teamCacheSize = teamLeaderboardCacheMeta.size;
    const userCacheSize = userLeaderboardCacheMeta.size;
    
    teamLeaderboardCacheMeta.clear();
    userLeaderboardCacheMeta.clear();
    
    res.json({ 
      status: 'cleared', 
      teamCacheCleared: teamCacheSize, 
      userCacheCleared: userCacheSize 
    });
  } catch (e) {
    console.error('Error clearing cache:', e);
    res.status(500).json({ error: 'Failed to clear cache' });
  }
});

// Single team detail
app.get('/team/:id', (req, res) => {
  const teamId = req.params.id;
  db.all(`SELECT position, name, pick, team, stack FROM players WHERE team_id = ?`, [teamId], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows);
  });
});

// Get team owner info
app.get("/team-owner/:teamId", (req, res) => {
  const teamId = req.params.teamId;
  
  db.get(`
    SELECT t.username, u.twitter_username 
    FROM teams t 
    LEFT JOIN users u ON t.user_id = u.id 
    WHERE t.id = ?
  `, [teamId], (err, row) => {
    if (err) return res.status(500).json({ error: "DB error" });
    res.json(row || { username: null, twitter_username: null });
  });
});

// ---- Auth Routes ----
app.post('/register', async (req, res) => {
  const { username, email, emailConfirm, password } = req.body || {};
  if (!username || !email || !emailConfirm || !password) {
    return res.status(400).json({ error: 'Username, email, confirmed email and password required' });
  }
  if (email !== emailConfirm) {
    return res.status(400).json({ error: 'Emails do not match' });
  }
  
  // Validate username (alphanumeric only, reasonable length)
  const cleanUsername = username.trim();
  
  if (cleanUsername.length < 2 || cleanUsername.length > 30) {
    return res.status(400).json({ error: 'Username must be 2-30 characters' });
  }
  if (!/^[a-zA-Z0-9_]+$/.test(cleanUsername)) {
    return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
  }
  
  try {
    const hash = await bcrypt.hash(password, 12);
    
    db.run('INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)', [email, hash, cleanUsername.toUpperCase()], function(err) {
      if (err) {
        if (err.message && err.message.includes('UNIQUE constraint failed: users.email')) {
          return res.status(400).json({ error: 'Email already registered' });
        }
        if (err.message && (err.message.includes('idx_users_display_name_unique') || err.message.includes('UNIQUE constraint failed: users.display_name'))) {
          return res.status(400).json({ error: 'Username already taken' });
        }
        return res.status(400).json({ error: 'Registration failed' });
      }
      res.json({ status: 'registered', id: this.lastID });
    });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/login', (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) return next(err);
    if (!user) {
      return res.status(401).json({ error: info?.message || 'Login failed' });
    }
    req.logIn(user, (err2) => {
      if (err2) return next(err2);
      res.json({ status: 'logged_in', user: { id: user.id, email: user.email } });
    });
  })(req, res, next);
});

app.post('/logout', (req, res) => {
  req.logout(() => {
    res.json({ status: 'logged_out' });
  });
});

app.get('/auth/twitter', passport.authenticate('twitter', { includeEmail: true }));

app.get('/auth/twitter/callback',
  passport.authenticate('twitter', { failureRedirect: '/' }),
  (req, res) => {
    res.redirect('/');
  }
);

app.get('/me', (req, res) => {
  res.json({ user: req.user || null });
});

// ---- Password reset ----
const PASSWORD_RESET_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

const cryptoRandom = () => crypto.randomBytes(32).toString('hex');

app.post('/password-reset/request', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required' });

  db.get('SELECT id FROM users WHERE email = ?', [email], (err, row) => {
    if (err) return res.status(500).json({ error: 'DB error' });

    if (!row) {
      // don't reveal user existence
      return res.json({ status: 'ok' });
    }

    const token = cryptoRandom();
    const expires = Date.now() + PASSWORD_RESET_EXPIRY_MS;

    db.run('INSERT OR REPLACE INTO password_resets (token, user_id, expires_at) VALUES (?,?,?)', [token, row.id, expires], async (insertErr) => {
      if (insertErr) return res.status(500).json({ error: 'DB error' });

      const base = 'https://draftrpass.com';
      const link = `${base}/reset-password.html?token=${token}`;

      try {
        await sendMail({
          to: email,
          subject: 'Reset your Draft or Pass password',
          html: `<p>Hello,</p><p>Click the link below to reset your password (valid for 1 hour):</p><p><a href="${link}">${link}</a></p><p>If you did not request this, you can ignore this email.</p>`
        });
      } catch (mailErr) {
        console.error('Failed to send reset email:', mailErr);
      }

      res.json({ status: 'ok' });
    });
  });
});

app.post('/password-reset/confirm', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'Token and password required' });

  db.get('SELECT user_id, expires_at FROM password_resets WHERE token = ?', [token], async (err, row) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    if (!row || Date.now() > row.expires_at) {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }

    const hash = await bcrypt.hash(password, 12);
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, row.user_id], (updErr) => {
      if (updErr) return res.status(500).json({ error: 'DB error' });

      db.run('DELETE FROM password_resets WHERE token = ?', [token]);
      res.json({ status: 'password_reset' });
    });
  });
});

// ---- Admin list -------------------------------------------------------------
const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
function requireAdmin(req, res, next) {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.status(401).json({ error: 'Login required' });
  }
  const email = (req.user?.email || '').toLowerCase();
  if (adminEmails.includes(email)) return next();
  return res.status(403).json({ error: 'Admin only' });
}

// Overall summary counts
app.get('/api/reports/summary', requireAdmin, (req, res) => {
  const sql = `
    SELECT 
      (SELECT COUNT(*) FROM versus_matches) AS total_versus_votes,
      (SELECT COUNT(*) FROM users)          AS total_signups,
      (SELECT COUNT(DISTINCT username) FROM teams WHERE username IS NOT NULL AND username <> '') AS users_with_uploads,
      (SELECT COUNT(*) FROM teams)          AS total_teams,
      (SELECT COUNT(*) FROM versus_matches 
       WHERE created_at >= datetime('now', '-1 hour')) AS votes_last_hour
  `;
  db.get(sql, [], (err, row) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(row);
  });
});

// Versus votes by day (Eastern Time – UTC-4)
app.get('/api/reports/versus-by-day', requireAdmin, (req, res) => {
  const sql = `
    SELECT DATE(datetime(created_at, '-4 hours')) AS day, COUNT(*) AS votes
    FROM versus_matches
    GROUP BY DATE(datetime(created_at, '-4 hours'))
    ORDER BY day
  `;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows);
  });
});

// Versus votes by hour (Eastern Time – UTC-4)
app.get('/api/reports/versus-by-hour', requireAdmin, (req, res) => {
  const sql = `
    SELECT strftime('%Y-%m-%d %H:00', datetime(created_at, '-4 hours')) AS hour,
           COUNT(*) AS votes
    FROM versus_matches
    GROUP BY hour
    ORDER BY hour
  `;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows);
  });
});

// Total lineups by username
app.get('/api/reports/lineups-by-user', requireAdmin, (req, res) => {
  const sql = `
    SELECT username, COUNT(*) AS lineups
    FROM teams
    WHERE username IS NOT NULL AND username <> ''
    GROUP BY username
    ORDER BY lineups DESC
  `;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows);
  });
});

// Tournament counts
app.get('/api/reports/tournament-counts', requireAdmin, (req, res) => {
  const sql = `
    SELECT tournament, COUNT(*) as count
    FROM teams
    WHERE tournament IS NOT NULL
    GROUP BY tournament
    ORDER BY count DESC
  `;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows);
  });
});

// Versus votes by user
app.get('/api/reports/versus-votes-by-user', requireAdmin, (req, res) => {
  const sql = `
    SELECT 
      CASE 
        WHEN vm.voter_id IS NULL THEN 'Anonymous'
        ELSE COALESCE(
          NULLIF(TRIM(u.display_name), ''),
          (SELECT username FROM teams WHERE user_id = vm.voter_id LIMIT 1),
          'Anonymous'
        )
      END as username,
      COUNT(*) as vote_count
    FROM versus_matches vm
    LEFT JOIN users u ON vm.voter_id = u.id
    GROUP BY 
      CASE 
        WHEN vm.voter_id IS NULL THEN 'Anonymous'
        ELSE COALESCE(
          NULLIF(TRIM(u.display_name), ''),
          (SELECT username FROM teams WHERE user_id = vm.voter_id LIMIT 1),
          'Anonymous'
        )
      END
    ORDER BY vote_count DESC
  `;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows);
  });
});

// Serve simple admin dashboard (protected)
app.get('/dashboard', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// === NEW: Admin check endpoint ===
app.get('/api/admin/check', requireAdmin, (req, res) => {
  res.json({ admin: true });
});

// === NEW: Teams with stacks endpoint ===
app.get('/api/admin/teams-with-stacks', requireAdmin, (req, res) => {
  const sql = `
    SELECT DISTINCT 
      p.team as stack
    FROM players p
    WHERE p.team IS NOT NULL AND p.team != ''
    ORDER BY p.team
  `;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows);
  });
});

// === NEW: Players endpoint ===
app.get('/api/admin/players', requireAdmin, (req, res) => {
  const sql = `
    SELECT DISTINCT 
      p.name,
      p.position,
      p.team
    FROM players p
    WHERE p.name IS NOT NULL AND p.name != ''
    ORDER BY p.name
  `;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows);
  });
});

// === NEW: Get current matchup settings ===
app.get('/api/admin/matchup-settings', requireAdmin, (req, res) => {
  db.get('SELECT * FROM matchup_settings WHERE id = 1', (err, row) => {
    if (err) {
      console.error('Error fetching matchup settings:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    
    // Return the settings or defaults if none exist
    res.json({
      tournament: row ? row.tournament : '',
      team1Stack: row ? row.team1_stack : '',
      team2Stack: row ? row.team2_stack : '',
      team1Player: row ? row.team1_player : '',
      team2Player: row ? row.team2_player : '',
      team1Strategy: row ? row.team1_strategy : '',
      team2Strategy: row ? row.team2_strategy : ''
    });
  });
});

// === NEW: Force cache rebuild (admin only) ===
app.post('/api/admin/rebuild-cache', requireAdmin, async (req, res) => {
  try {
    await buildTeamsCache();
    res.json({ success: true, message: 'Cache rebuilt successfully' });
  } catch (err) {
    console.error('Cache rebuild failed:', err);
    res.status(500).json({ error: 'Cache rebuild failed' });
  }
});

// === NEW: Save matchup settings ===
app.post('/api/admin/matchup-settings', requireAdmin, (req, res) => {
  const { tournament, team1Stack, team2Stack, team1Player, team2Player, team1Strategy, team2Strategy } = req.body;
  
  // Use INSERT OR REPLACE to handle both first-time and update scenarios
  db.run(
    `INSERT OR REPLACE INTO matchup_settings (id, tournament, team1_stack, team2_stack, team1_player, team2_player, team1_strategy, team2_strategy, updated_at) 
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [tournament || null, team1Stack || null, team2Stack || null, team1Player || null, team2Player || null, team1Strategy || null, team2Strategy || null],
    function(err) {
      if (err) {
        console.error('Error saving matchup settings:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      
      res.json({ success: true, message: 'Settings saved successfully' });
    }
  );
});

// === NEW: Return total number of versus votes cast by the logged-in user ===
app.get("/my/votes-count", requireAuth, (req, res) => {
  db.get(
    `SELECT COUNT(*) as count FROM versus_matches WHERE voter_id = ?`,
    [req.user.id],
    (err, row) => {
      if (err) {
        console.error('Error fetching vote count:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      res.json({ count: (row && row.count) ? row.count : 0 });
    }
  );
});

// === NEW: User profile data endpoint ===
app.get('/my/profile', requireAuth, (req, res) => {
  const user = req.user;
  if (!user) {
    return res.status(401).json({ error: 'Login required' });
  }
  const userId = user.id;

  const response = {
    user: {
      id: user.id,
      email: user.email,
      twitter_username: user.twitter_username,
      display_name: user.display_name,
      login_method: user.twitter_id ? 'twitter' : 'email'
    },
    uploads: [],
    usernames: [],
    votingStats: {
      friends: [],
      foes: []
    },
    voteResults: [],
    isOwnProfile: true,
    viewerLoggedIn: true
  };

  // First get distinct usernames for this user
  db.all(
    'SELECT DISTINCT username FROM teams WHERE user_id = ? AND username IS NOT NULL ORDER BY username',
    [userId],
    (err, usernameRows) => {
      if (err) {
        console.error('DB error fetching usernames:', err);
        return res.status(500).json({ error: 'DB error' });
      }
      response.usernames = usernameRows.map(r => r.username);

      // Then get the upload data
      db.all(
        `SELECT username, tournament, COUNT(*) as count 
         FROM teams 
         WHERE user_id = ? 
         GROUP BY username, tournament
         ORDER BY tournament, username`,
        [userId],
        (err2, rows) => {
          if (err2) {
            console.error('DB error in /my/profile:', err2);
            return res.status(500).json({ error: 'DB error' });
          }
          response.uploads = rows || [];

          // Get voting stats - first get my team IDs with limit
          db.all(
            'SELECT id FROM teams WHERE user_id = ? LIMIT 500',
            [userId],
            (err3, myTeams) => {
              if (err3) {
                console.error('DB error fetching teams:', err3);
                return res.status(500).json({ error: 'DB error' });
              }

              const myTeamIds = myTeams.map(t => t.id);
              if (!myTeamIds.length) {
                return res.json(response); // No teams, return early
              }

              // Limit team IDs to prevent massive IN clauses
              const limitedTeamIds = myTeamIds.slice(0, 100); // Limit to 100 teams max
              
              if (limitedTeamIds.length === 0) {
                return res.json(response);
              }

              // Simplified query to reduce memory usage
              const statsQuery = `
                SELECT 
                  vm.voter_id,
                  u.display_name as voter_name,
                  COUNT(CASE WHEN vm.winner_id IN (${limitedTeamIds.map(() => '?').join(',')}) THEN 1 END) as wins,
                  COUNT(CASE WHEN vm.loser_id IN (${limitedTeamIds.map(() => '?').join(',')}) THEN 1 END) as losses,
                  COUNT(*) as total_votes
                FROM versus_matches vm
                JOIN users u ON vm.voter_id = u.id
                WHERE vm.voter_id IS NOT NULL
                  AND (
                    vm.winner_id IN (${limitedTeamIds.map(() => '?').join(',')})
                    OR 
                    vm.loser_id IN (${limitedTeamIds.map(() => '?').join(',')})
                  )
                GROUP BY vm.voter_id
                HAVING total_votes >= 3
                ORDER BY wins DESC
                LIMIT 50
              `;

              // Build params array - need to repeat limitedTeamIds 4 times for the different IN clauses
              const params = [
                ...limitedTeamIds, // For wins IN clause
                ...limitedTeamIds, // For losses IN clause
                ...limitedTeamIds, // For winner_id IN clause
                ...limitedTeamIds  // For loser_id IN clause
              ];

              db.all(statsQuery, params, (err4, statsRows) => {
                if (err4) {
                  console.error('DB error fetching voting stats:', err4);
                  return res.status(500).json({ error: 'DB error' });
                }

                // --- Updated: Rank friends & foes using Wilson lower-bound score ---
                const z = 1.96; // 95% confidence interval constant

                statsRows.forEach(r => {
                  const n = r.wins + r.losses;
                  const p = n ? r.wins / n : 0;
                  r.wilson = n ? (
                    (
                      p + (z * z) / (2 * n) -
                      z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)
                    ) /
                    (1 + (z * z) / n)
                  ) : 0;
                });

                // Sort descending by Wilson score (higher = more supportive)
                statsRows.sort((a, b) => b.wilson - a.wilson);

                // Build friends (top 5) and foes (bottom 5 not in friends) lists, excluding myself
                const filtered = statsRows.filter(r => r.voter_id !== userId);

                const LIMIT = 10; // number of friends / foes to display

                const friendCandidates = filtered.filter(r => r.win_rate > 0.5);
                const foeCandidates    = filtered.filter(r => r.win_rate <= 0.5);

                const takeRows = (arr, limit, descending=true) => {
                  const sorted = arr.sort((a,b)=>descending ? b.wilson-a.wilson : a.wilson-b.wilson);
                  const out=[];
                  const seen=new Set();
                  for(const row of sorted){
                    if(out.length>=limit) break;
                    if(!row.voter_name||!row.voter_name.trim()) continue;
                    if(seen.has(row.voter_id)) continue;
                    out.push(row);
                    seen.add(row.voter_id);
                  }
                  return out;
                };

                const friendsRows = takeRows(friendCandidates, LIMIT, true);
                const friendIds = new Set(friendsRows.map(r=>r.voter_id));

                const foesRows = takeRows(foeCandidates.filter(r=>!friendIds.has(r.voter_id)), LIMIT, false);

                response.votingStats.friends = friendsRows.map(r => ({
                  name: r.voter_name,
                  wins: r.wins,
                  losses: r.losses,
                  winRate: ((r.wins / (r.wins + r.losses)) * 100).toFixed(1)
                }));

                response.votingStats.foes = foesRows.map(r => ({
                  name: r.voter_name,
                  wins: r.wins,
                  losses: r.losses,
                  winRate: ((r.wins / (r.wins + r.losses)) * 100).toFixed(1)
                }));

                // === Simplified team stats query ===
                const teamStatsSql = `
                  SELECT
                    t.id,
                    t.tournament,
                    COALESCE((SELECT COUNT(*) FROM versus_matches vm WHERE vm.winner_id = t.id), 0) AS wins,
                    COALESCE((SELECT COUNT(*) FROM versus_matches vm WHERE vm.loser_id = t.id), 0) AS losses,
                    COALESCE((SELECT madden FROM ratings_history rh WHERE rh.team_id = t.id ORDER BY rh.computed_at DESC LIMIT 1), 0) AS madden,
                    COALESCE((SELECT elo FROM elo_ratings er WHERE er.team_id = t.id ORDER BY er.created_at DESC LIMIT 1), 0) AS elo_rating
                  FROM teams t
                  WHERE t.user_id = ?
                  LIMIT 100
                `;

                db.all(teamStatsSql, [userId], (err5, teamRows) => {
                  if (err5) {
                    console.error('DB error fetching team vote results:', err5);
                    // Even if this fails, send rest of profile; leave voteResults empty
                    response.voteResults = [];
                    return res.json(response);
                  }

                  // Calculate percentages to match leaderboard formatting
                  const enriched = teamRows.map(r => {
                    const h2hTotal = r.wins + r.losses;
                    const win_pct = h2hTotal ? ((r.wins / h2hTotal) * 100).toFixed(1) : 0;
                    
                    return { ...r, win_pct };
                  });

                  response.voteResults = enriched;

                  // Calculate global percentiles for individual team Elo ratings
                  const globalEloSql = `
                    SELECT er.elo as elo_rating
                    FROM elo_ratings er
                    JOIN teams t ON t.id = er.team_id
                    LEFT JOIN (
                      SELECT vm.winner_id as team_id, COUNT(*) as wins
                      FROM versus_matches vm GROUP BY vm.winner_id
                    ) win_counts ON win_counts.team_id = er.team_id
                    LEFT JOIN (
                      SELECT vm.loser_id as team_id, COUNT(*) as losses
                      FROM versus_matches vm GROUP BY vm.loser_id
                    ) loss_counts ON loss_counts.team_id = er.team_id
                    WHERE er.id IN (
                      SELECT MAX(id) FROM elo_ratings GROUP BY team_id, tournament
                    )
                    AND (COALESCE(win_counts.wins, 0) + COALESCE(loss_counts.losses, 0)) > 0
                    ORDER BY er.elo DESC
                  `;

                  db.all(globalEloSql, [], (globalErr, globalRows) => {
                    if (globalErr) {
                      console.error('Global Elo query error:', globalErr);
                      // Continue without global percentiles
                      return sendWithRating(0);
                    }

                    if (globalRows.length > 0) {
                      const globalEloValues = globalRows.map(r => r.elo_rating);
                      const minGlobalElo = globalEloValues[globalEloValues.length - 1];
                      const maxGlobalElo = globalEloValues[0];

                      // Add global percentiles to each team
                      response.voteResults = enriched.map(row => {
                        if (maxGlobalElo === minGlobalElo) {
                          row.percentile = 0.5;
                        } else if (row.elo_rating > 0) {
                          row.percentile = (row.elo_rating - minGlobalElo) / (maxGlobalElo - minGlobalElo);
                        } else {
                          row.percentile = 0.5;
                        }
                        return row;
                      });

                      // Calculate user's average Elo rating
                      const userEloRatings = enriched.filter(r => r.elo_rating > 0).map(r => r.elo_rating);
                      if (userEloRatings.length > 0) {
                        response.eloRating = userEloRatings.reduce((a, b) => a + b, 0) / userEloRatings.length;
                        
                        // Get percentile by comparing against all users' average Elo ratings
                        const userAvgEloSql = `
                          SELECT AVG(er.elo) as avg_elo
                          FROM elo_ratings er
                          JOIN teams t ON t.id = er.team_id
                          LEFT JOIN (
                            SELECT vm.winner_id as team_id, COUNT(*) as wins
                            FROM versus_matches vm GROUP BY vm.winner_id
                          ) win_counts ON win_counts.team_id = er.team_id
                          LEFT JOIN (
                            SELECT vm.loser_id as team_id, COUNT(*) as losses
                            FROM versus_matches vm GROUP BY vm.loser_id
                          ) loss_counts ON loss_counts.team_id = er.team_id
                          WHERE er.id IN (
                            SELECT MAX(id) FROM elo_ratings GROUP BY team_id, tournament
                          )
                          AND (COALESCE(win_counts.wins, 0) + COALESCE(loss_counts.losses, 0)) > 0
                          GROUP BY t.username
                          HAVING t.username IS NOT NULL AND t.username != ''
                        `;

                        db.all(userAvgEloSql, [], (userEloErr, userEloRows) => {
                          if (!userEloErr && userEloRows.length > 0) {
                            const allUserAvgElos = userEloRows.map(r => r.avg_elo).sort((a, b) => a - b);
                            const minUserElo = allUserAvgElos[0];
                            const maxUserElo = allUserAvgElos[allUserAvgElos.length - 1];
                            
                            if (maxUserElo !== minUserElo) {
                              response.percentile = (response.eloRating - minUserElo) / (maxUserElo - minUserElo);
                            } else {
                              response.percentile = 0.5;
                            }
                          } else {
                            response.percentile = 0.5;
                          }

                          // Continue with median Madden calculation
                          proceedWithMaddenCalc();
                        });
                      } else {
                        // Continue with median Madden calculation
                        proceedWithMaddenCalc();
                      }

                      function proceedWithMaddenCalc() {
                        // Continue with median Madden calculation
                        const usernameKey = (response.user.display_name || response.usernames[0] || 'ANON').toUpperCase();
                        const cacheKey = sanitizeKey(null); // ALL tournaments

                        const sendWithRating = (rating) => {
                          response.medianMadden = rating;
                          res.json(response);
                        };

                        let meta = userLeaderboardCacheMeta.get(cacheKey);
                        const maybeSend = () => {
                          if (!meta) return sendWithRating(0);
                          try {
                            const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(meta.filePath)).toString('utf8'));
                            const row = data.find(r => (r.username || '').toUpperCase() === usernameKey);
                            if (row) return sendWithRating(row.median_madden);
                          } catch(e){ console.error('profile cache read error',e); }
                          sendWithRating(0);
                        };

                        if (!meta || (Date.now() - meta.stamp > LEADER_CACHE_REFRESH_MS)) {
                          buildUserLeaderboardCache(null).then(()=>{ meta = userLeaderboardCacheMeta.get(cacheKey); maybeSend();}).catch(()=>maybeSend());
                        } else {
                          maybeSend();
                        }
                      }
                  }});
                });
              });
            }
          );
        }
      );
    }
  );
});

// === NEW: Get public profile for any user by username ===
app.get('/profile/:username', (req, res) => {
  const { username } = req.params;
  const viewerUserId = req.user ? req.user.id : null;

  if (!username) {
    return res.status(400).json({ error: 'Username required' });
  }

  // First find the user by username (from teams table)
  db.get(
    'SELECT user_id FROM teams WHERE username = ? LIMIT 1',
    [username],
    (err, userRow) => {
      if (err) {
        console.error('DB error finding user:', err);
        return res.status(500).json({ error: 'Database error' });
      }

      if (!userRow) {
        return res.status(404).json({ error: 'User not found' });
      }

      const targetUserId = userRow.user_id;

      // Get user details
      db.get(
        'SELECT id, display_name, twitter_username FROM users WHERE id = ?',
        [targetUserId],
        (err2, user) => {
          if (err2) {
            console.error('DB error fetching user details:', err2);
            return res.status(500).json({ error: 'Database error' });
          }

          if (!user) {
            return res.status(404).json({ error: 'User not found' });
          }

          const response = {
            user: {
              id: user.id,
              display_name: user.display_name,
              twitter_username: user.twitter_username
            },
            isOwnProfile: viewerUserId === targetUserId,
            viewerLoggedIn: !!viewerUserId,
            voteResults: [],
            votingStats: { friends: [], foes: [] }
          };

          // First gather this user's team IDs (used for both voting stats & team stats)
          db.all('SELECT id FROM teams WHERE user_id = ?', [targetUserId], (errTeams, teamIdRows) => {
            if (errTeams) {
              console.error('DB error fetching team ids:', errTeams);
              return res.status(500).json({ error: 'Database error' });
            }

            const myTeamIds = teamIdRows.map(r => r.id);

            const afterVotingStats = () => {
              // === Get vote results for each of the user\'s teams (same as before) ===
              const teamStatsSql = `
                WITH team_stats AS (
                  SELECT
                    t.id,
                    t.tournament,
                    COALESCE((SELECT COUNT(*) FROM versus_matches vm WHERE vm.winner_id = t.id), 0) AS wins,
                    COALESCE((SELECT COUNT(*) FROM versus_matches vm WHERE vm.loser_id = t.id), 0) AS losses,
                    COALESCE((SELECT madden FROM ratings_history rh WHERE rh.team_id = t.id ORDER BY rh.computed_at DESC LIMIT 1), 0) AS madden,
                    COALESCE((SELECT elo FROM elo_ratings er WHERE er.team_id = t.id ORDER BY er.created_at DESC LIMIT 1), 0) AS elo_rating
                  FROM teams t
                  WHERE t.user_id = ?
                )
                SELECT * FROM team_stats
              `;

              db.all(teamStatsSql, [targetUserId], (err3, teamRows) => {
                if (err3) {
                  console.error('DB error fetching team vote results:', err3);
                  return res.status(500).json({ error: 'Database error' });
                }

                                  const enriched = teamRows.map(r => {
                    const voteTotal = r.yes_votes + r.no_votes;
                    const yes_pct = voteTotal ? ((r.yes_votes / voteTotal) * 100).toFixed(1) : 0;
                    const h2hTotal = r.wins + r.losses;
                    const win_pct = h2hTotal ? ((r.wins / h2hTotal) * 100).toFixed(1) : 0;
                    
                    return { ...r, yes_pct, win_pct };
                  });

                response.voteResults = enriched;

                // Calculate global percentiles for individual team Elo ratings
                const globalEloSql = `
                  SELECT er.elo as elo_rating
                  FROM elo_ratings er
                  JOIN teams t ON t.id = er.team_id
                  LEFT JOIN (
                    SELECT vm.winner_id as team_id, COUNT(*) as wins
                    FROM versus_matches vm GROUP BY vm.winner_id
                  ) win_counts ON win_counts.team_id = er.team_id
                  LEFT JOIN (
                    SELECT vm.loser_id as team_id, COUNT(*) as losses
                    FROM versus_matches vm GROUP BY vm.loser_id
                  ) loss_counts ON loss_counts.team_id = er.team_id
                  WHERE er.id IN (
                    SELECT MAX(id) FROM elo_ratings GROUP BY team_id, tournament
                  )
                  AND (COALESCE(win_counts.wins, 0) + COALESCE(loss_counts.losses, 0)) > 0
                  ORDER BY er.elo DESC
                `;

                db.all(globalEloSql, [], (globalErr, globalRows) => {
                  if (globalErr) {
                    console.error('Global Elo query error:', globalErr);
                    // Continue without global percentiles
                    return deliver(0);
                  }

                  if (globalRows.length > 0) {
                    const globalEloValues = globalRows.map(r => r.elo_rating);
                    const minGlobalElo = globalEloValues[globalEloValues.length - 1];
                    const maxGlobalElo = globalEloValues[0];

                    // Add global percentiles to each team
                    response.voteResults = enriched.map(row => {
                      if (maxGlobalElo === minGlobalElo) {
                        row.percentile = 0.5;
                      } else if (row.elo_rating > 0) {
                        row.percentile = (row.elo_rating - minGlobalElo) / (maxGlobalElo - minGlobalElo);
                      } else {
                        row.percentile = 0.5;
                      }
                      return row;
                    });

                                         // Calculate user's average Elo rating
                     const userEloRatings = enriched.filter(r => r.elo_rating > 0).map(r => r.elo_rating);
                     if (userEloRatings.length > 0) {
                       response.eloRating = userEloRatings.reduce((a, b) => a + b, 0) / userEloRatings.length;
                       
                       // Get percentile by comparing against all users' average Elo ratings
                       const userAvgEloSql = `
                         SELECT AVG(er.elo) as avg_elo
                         FROM elo_ratings er
                         JOIN teams t ON t.id = er.team_id
                         LEFT JOIN (
                           SELECT vm.winner_id as team_id, COUNT(*) as wins
                           FROM versus_matches vm GROUP BY vm.winner_id
                         ) win_counts ON win_counts.team_id = er.team_id
                         LEFT JOIN (
                           SELECT vm.loser_id as team_id, COUNT(*) as losses
                           FROM versus_matches vm GROUP BY vm.loser_id
                         ) loss_counts ON loss_counts.team_id = er.team_id
                         WHERE er.id IN (
                           SELECT MAX(id) FROM elo_ratings GROUP BY team_id, tournament
                         )
                         AND (COALESCE(win_counts.wins, 0) + COALESCE(loss_counts.losses, 0)) > 0
                         GROUP BY t.username
                         HAVING t.username IS NOT NULL AND t.username != ''
                       `;

                       db.all(userAvgEloSql, [], (userEloErr, userEloRows) => {
                         if (!userEloErr && userEloRows.length > 0) {
                           const allUserAvgElos = userEloRows.map(r => r.avg_elo).sort((a, b) => a - b);
                           const minUserElo = allUserAvgElos[0];
                           const maxUserElo = allUserAvgElos[allUserAvgElos.length - 1];
                           
                           if (maxUserElo !== minUserElo) {
                             response.percentile = (response.eloRating - minUserElo) / (maxUserElo - minUserElo);
                           } else {
                             response.percentile = 0.5;
                           }
                         } else {
                           response.percentile = 0.5;
                         }

                         // Continue with median Madden calculation
                         proceedWithMaddenCalcPub();
                       });
                     } else {
                       // Continue with median Madden calculation
                       proceedWithMaddenCalcPub();
                     }

                     function proceedWithMaddenCalcPub() {
                       // Continue with median Madden calculation
                       const usernameKeyPublic = (response.user.display_name || username).toUpperCase();
                       const cacheKeyPub = sanitizeKey(null); // global leaderboard cache

                       const deliver = (ratingVal) => {
                         response.medianMadden = ratingVal;
                         res.json(response);
                       };

                       let metaPub = userLeaderboardCacheMeta.get(cacheKeyPub);

                       const maybeSendPub = () => {
                         if (!metaPub) return deliver(0);
                         try {
                           const raw = fs.readFileSync(metaPub.filePath);
                           const data = JSON.parse(zlib.gunzipSync(raw).toString('utf8'));
                           const rowPub = data.find(r => (r.username || '').toUpperCase() === usernameKeyPublic);
                           if (rowPub) return deliver(rowPub.median_madden);
                         } catch(e) {
                           console.error('public profile cache read error', e);
                         }
                         deliver(0);
                       };

                       if (!metaPub || (Date.now() - metaPub.stamp > LEADER_CACHE_REFRESH_MS)) {
                         buildUserLeaderboardCache(null)
                           .then(() => { metaPub = userLeaderboardCacheMeta.get(cacheKeyPub); maybeSendPub(); })
                           .catch(() => maybeSendPub());
                       } else {
                         maybeSendPub();
                       }
                     }
                }});
              });
            };

            // If no teams, we can skip votingStats and directly get teamStats (which will return empty anyway)
            if (!myTeamIds.length) {
              return afterVotingStats();
            }

            // === Build voter friend/foe stats (same logic as /my/profile) ===
            const statsQuery = `
              WITH voter_stats AS (
                SELECT 
                  vm.voter_id,
                  u.display_name as voter_name,
                  COUNT(CASE WHEN vm.winner_id IN (${myTeamIds.map(() => '?').join(',')}) THEN 1 END) as wins,
                  COUNT(CASE WHEN vm.loser_id IN (${myTeamIds.map(() => '?').join(',')}) THEN 1 END) as losses,
                  COUNT(*) as total_votes
                FROM versus_matches vm
                JOIN users u ON vm.voter_id = u.id
                WHERE vm.voter_id IS NOT NULL
                  AND (
                    vm.winner_id IN (${myTeamIds.map(() => '?').join(',')})
                    OR 
                    vm.loser_id IN (${myTeamIds.map(() => '?').join(',')})
                  )
                GROUP BY vm.voter_id
                HAVING total_votes >= 3
              )
              SELECT 
                voter_id,
                voter_name,
                wins,
                losses,
                total_votes,
                CAST(wins AS FLOAT) / (wins + losses) as win_rate
              FROM voter_stats
              WHERE voter_name IS NOT NULL
              ORDER BY win_rate DESC`;

            const params = [
              ...myTeamIds,
              ...myTeamIds,
              ...myTeamIds,
              ...myTeamIds
            ];

            db.all(statsQuery, params, (errStats, statsRows) => {
              if (errStats) {
                console.error('DB error fetching voting stats:', errStats);
                // Continue without voting stats
                return afterVotingStats();
              }

              // --- Updated: Rank friends & foes using Wilson lower-bound score ---
              const z = 1.96; // 95% confidence interval constant

              statsRows.forEach(r => {
                const n = r.wins + r.losses;
                const p = n ? r.wins / n : 0;
                r.wilson = n ? (
                  (
                    p + (z * z) / (2 * n) -
                    z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)
                  ) /
                  (1 + (z * z) / n)
                ) : 0;
              });

              statsRows.sort((a, b) => b.wilson - a.wilson);

              // Build friends (top 5) and foes (bottom 5 not in friends) lists, excluding profile user themselves
              const filteredPub = statsRows.filter(r => r.voter_id !== targetUserId);

              const LIMIT = 10;

              const friendCandidatesPub = filteredPub.filter(r=>r.win_rate > 0.5);
              const foeCandidatesPub    = filteredPub.filter(r=>r.win_rate <= 0.5);

              const takeRowsPub = (arr, limit, descending=true)=>{
                const sorted = arr.sort((a,b)=>descending? b.wilson - a.wilson : a.wilson - b.wilson);
                const out=[]; const seen=new Set();
                for(const row of sorted){
                  if(out.length>=limit) break;
                  if(!row.voter_name||!row.voter_name.trim()) continue;
                  if(seen.has(row.voter_id)) continue;
                  out.push(row); seen.add(row.voter_id);
                }
                return out;
              };

              const friendsRowsPub = takeRowsPub(friendCandidatesPub, LIMIT, true);
              const friendIdsPub = new Set(friendsRowsPub.map(r=>r.voter_id));

              const foesRowsPub = takeRowsPub(foeCandidatesPub.filter(r=>!friendIdsPub.has(r.voter_id)), LIMIT, false);

              response.votingStats.friends = friendsRowsPub.map(r => ({
                name: r.voter_name,
                wins: r.wins,
                losses: r.losses,
                winRate: ((r.wins / (r.wins + r.losses)) * 100).toFixed(1)
              }));

              response.votingStats.foes = foesRowsPub.map(r => ({
                name: r.voter_name,
                wins: r.wins,
                losses: r.losses,
                winRate: ((r.wins / (r.wins + r.losses)) * 100).toFixed(1)
              }));

              afterVotingStats();
            });
          });
        }
      );
    }
  );
});

// === NEW: Get voting history for a specific team ===
app.get('/my/team-votes/:teamId', requireAuth, (req, res) => {
  const { teamId } = req.params;
  const userId = req.user.id;

  // First verify the team belongs to the current user
  db.get(
    'SELECT id FROM teams WHERE id = ? AND user_id = ?',
    [teamId, userId],
    (err, team) => {
      if (err) {
        console.error('DB error verifying team ownership:', err);
        return res.status(500).json({ error: 'Database error' });
      }

      if (!team) {
        return res.status(404).json({ error: 'Team not found or not owned by you' });
      }

      // Get voting history for this team with Elo ratings
      const sql = `
        SELECT 
          vm.id,
          vm.winner_id,
          vm.loser_id,
          vm.voter_id,
          vm.created_at,
          CASE 
            WHEN vm.winner_id = ? THEN 'win'
            ELSE 'loss'
          END as result,
          CASE 
            WHEN vm.winner_id = ? THEN vm.loser_id
            ELSE vm.winner_id
          END as opponent_id,
          CASE 
            WHEN vm.winner_id = ? THEN ot_loser.tournament
            ELSE ot_winner.tournament
          END as opponent_tournament,
          CASE 
            WHEN vm.winner_id = ? THEN ot_loser.username
            ELSE ot_winner.username
          END as opponent_username,
          CASE 
            WHEN vm.winner_id = ? THEN (
              SELECT elo FROM elo_ratings er_loser 
              WHERE er_loser.team_id = vm.loser_id 
              ORDER BY er_loser.created_at DESC LIMIT 1
            )
            ELSE (
              SELECT elo FROM elo_ratings er_winner 
              WHERE er_winner.team_id = vm.winner_id 
              ORDER BY er_winner.created_at DESC LIMIT 1
            )
          END as opponent_elo,
          CASE 
            WHEN vm.voter_id IS NULL THEN 'Anonymous'
            ELSE COALESCE(
              NULLIF(TRIM(u.display_name), ''),
              (SELECT username FROM teams WHERE user_id = vm.voter_id LIMIT 1),
              'Anonymous'
            )
          END as voter_name
        FROM versus_matches vm
        LEFT JOIN users u ON vm.voter_id = u.id
        LEFT JOIN teams ot_winner ON vm.winner_id = ot_winner.id
        LEFT JOIN teams ot_loser ON vm.loser_id = ot_loser.id
        WHERE vm.winner_id = ? OR vm.loser_id = ?
        ORDER BY vm.created_at DESC
        LIMIT 50
      `;

      // Need to pass teamId 7 times for the different CASE statements and WHERE clause
      const params = [teamId, teamId, teamId, teamId, teamId, teamId, teamId];

      db.all(sql, params, (err2, votes) => {
        if (err2) {
          console.error('DB error fetching team votes:', err2);
          return res.status(500).json({ error: 'Database error' });
        }

        // Get global Elo data for percentile calculation
        const globalEloSql = `
          SELECT er.elo as elo_rating
          FROM elo_ratings er
          JOIN teams t ON t.id = er.team_id
          LEFT JOIN (
            SELECT vm.winner_id as team_id, COUNT(*) as wins
            FROM versus_matches vm GROUP BY vm.winner_id
          ) win_counts ON win_counts.team_id = er.team_id
          LEFT JOIN (
            SELECT vm.loser_id as team_id, COUNT(*) as losses
            FROM versus_matches vm GROUP BY vm.loser_id
          ) loss_counts ON loss_counts.team_id = er.team_id
          WHERE er.id IN (
            SELECT MAX(id) FROM elo_ratings GROUP BY team_id, tournament
          )
          AND (COALESCE(win_counts.wins, 0) + COALESCE(loss_counts.losses, 0)) > 0
          ORDER BY er.elo DESC
        `;

        db.all(globalEloSql, [], (globalErr, globalRows) => {
          if (globalErr) {
            console.error('Global Elo query error:', globalErr);
            // Continue without percentiles
            return res.json({ votes: votes || [] });
          }

          // Calculate percentiles for each vote's opponent Elo
          if (globalRows.length > 0) {
            const globalEloValues = globalRows.map(r => r.elo_rating);
            const minGlobalElo = globalEloValues[globalEloValues.length - 1];
            const maxGlobalElo = globalEloValues[0];

            // Add percentile to each vote
            votes.forEach(vote => {
              if (vote.opponent_elo && vote.opponent_elo > 0) {
                if (maxGlobalElo === minGlobalElo) {
                  vote.opponent_percentile = 0.5;
                } else {
                  vote.opponent_percentile = (vote.opponent_elo - minGlobalElo) / (maxGlobalElo - minGlobalElo);
                }
              } else {
                vote.opponent_percentile = 0.5;
              }
            });
          }

          res.json({ votes: votes || [] });
        });
      });
    }
  );
});

// === NEW: Update display name endpoint ===
app.post('/my/update-display-name', requireAuth, express.json(), (req, res) => {
  const { displayName } = req.body;
  const userId = req.user.id;

  // Normalize and validate display name
  const displayNameUpper = (displayName || '').trim().toUpperCase();

  if (displayNameUpper && displayNameUpper.length > 50) {
    return res.status(400).json({ error: 'Username too long (max 50 characters)' });
  }

  // Start a transaction to update both users and teams tables
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');

    // Update the display name in users table (always use upper-case value, can be null)
    db.run(
      'UPDATE users SET display_name = ? WHERE id = ?',
      [displayNameUpper || null, userId],
      function(err) {
        if (err) {
          console.error('DB error updating display name:', err);
          // Handle duplicate display name (unique constraint violation)
          if (
            err.code === 'SQLITE_CONSTRAINT' &&
            (err.message || '').includes('UNIQUE constraint failed: users.display_name')
          ) {
            db.run('ROLLBACK');
            return res.status(409).json({ error: 'Username already taken' });
          }

          db.run('ROLLBACK');
          return res.status(500).json({ error: 'Failed to update display name' });
        }

        // If a non-empty name supplied, also update team usernames to same upper-case string
        if (displayNameUpper) {
          db.run(
            'UPDATE teams SET username = ? WHERE user_id = ?',
            [displayNameUpper, userId],
            function(err2) {
              if (err2) {
                console.error('DB error updating teams username:', err2);
                db.run('ROLLBACK');
                return res.status(500).json({ error: 'Failed to update teams username' });
              }
              
              db.run('COMMIT');
              res.json({ 
                message: 'Username and team usernames updated successfully',
                displayName: displayNameUpper,
                teamsUpdated: this.changes,
                username: displayNameUpper
              });
            }
          );
        } else {
          // Name was cleared – commit users update only
          db.run('COMMIT');
          res.json({ 
            message: 'Username cleared',
            displayName: null,
            teamsUpdated: 0
          });
        }
      }
    );
  });
});

// === NEW: Public voting history for any team ===
app.get('/team-votes/:teamId', (req, res) => {
  const { teamId } = req.params;

  // Verify the team exists
  db.get('SELECT id FROM teams WHERE id = ?', [teamId], (err, team) => {
    if (err) {
      console.error('DB error verifying team:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    // Get voting history with Elo ratings
    const sql = `
      SELECT 
        vm.id,
        vm.winner_id,
        vm.loser_id,
        vm.voter_id,
        vm.created_at,
        CASE 
          WHEN vm.winner_id = ? THEN 'win'
          ELSE 'loss'
        END as result,
        CASE 
          WHEN vm.winner_id = ? THEN vm.loser_id
          ELSE vm.winner_id
        END as opponent_id,
        CASE 
          WHEN vm.winner_id = ? THEN ot_loser.tournament
          ELSE ot_winner.tournament
        END as opponent_tournament,
        CASE 
          WHEN vm.winner_id = ? THEN ot_loser.username
          ELSE ot_winner.username
        END as opponent_username,
        CASE 
          WHEN vm.winner_id = ? THEN (
            SELECT elo FROM elo_ratings er_loser 
            WHERE er_loser.team_id = vm.loser_id 
            ORDER BY er_loser.created_at DESC LIMIT 1
          )
          ELSE (
            SELECT elo FROM elo_ratings er_winner 
            WHERE er_winner.team_id = vm.winner_id 
            ORDER BY er_winner.created_at DESC LIMIT 1
          )
        END as opponent_elo,
        CASE 
          WHEN vm.voter_id IS NULL THEN 'Anonymous'
          ELSE COALESCE(
            NULLIF(TRIM(u.display_name), ''),
            (SELECT username FROM teams WHERE user_id = vm.voter_id LIMIT 1),
            'Anonymous'
          )
        END as voter_name
      FROM versus_matches vm
      LEFT JOIN users u ON vm.voter_id = u.id
      LEFT JOIN teams ot_winner ON vm.winner_id = ot_winner.id
      LEFT JOIN teams ot_loser ON vm.loser_id = ot_loser.id
      WHERE vm.winner_id = ? OR vm.loser_id = ?
      ORDER BY vm.created_at DESC
      LIMIT 50
    `;

    const params = [teamId, teamId, teamId, teamId, teamId, teamId, teamId];

    db.all(sql, params, (err2, votes) => {
      if (err2) {
        console.error('DB error fetching votes:', err2);
        return res.status(500).json({ error: 'Database error' });
      }

      // Get global Elo data for percentile calculation
      const globalEloSql = `
        SELECT er.elo as elo_rating
        FROM elo_ratings er
        JOIN teams t ON t.id = er.team_id
        LEFT JOIN (
          SELECT vm.winner_id as team_id, COUNT(*) as wins
          FROM versus_matches vm GROUP BY vm.winner_id
        ) win_counts ON win_counts.team_id = er.team_id
        LEFT JOIN (
          SELECT vm.loser_id as team_id, COUNT(*) as losses
          FROM versus_matches vm GROUP BY vm.loser_id
        ) loss_counts ON loss_counts.team_id = er.team_id
        WHERE er.id IN (
          SELECT MAX(id) FROM elo_ratings GROUP BY team_id, tournament
        )
        AND (COALESCE(win_counts.wins, 0) + COALESCE(loss_counts.losses, 0)) > 0
        ORDER BY er.elo DESC
      `;

      db.all(globalEloSql, [], (globalErr, globalRows) => {
        if (globalErr) {
          console.error('Global Elo query error:', globalErr);
          // Continue without percentiles
          return res.json({ votes: votes || [] });
        }

        // Calculate percentiles for each vote's opponent Elo
        if (globalRows.length > 0) {
          const globalEloValues = globalRows.map(r => r.elo_rating);
          const minGlobalElo = globalEloValues[globalEloValues.length - 1];
          const maxGlobalElo = globalEloValues[0];

          // Add percentile to each vote
          votes.forEach(vote => {
            if (vote.opponent_elo && vote.opponent_elo > 0) {
              if (maxGlobalElo === minGlobalElo) {
                vote.opponent_percentile = 0.5;
              } else {
                vote.opponent_percentile = (vote.opponent_elo - minGlobalElo) / (maxGlobalElo - minGlobalElo);
              }
            } else {
              vote.opponent_percentile = 0.5;
            }
          });
        }

        res.json({ votes: votes || [] });
      });
    });
  });
});

// === NEW: Get Elo history for a team ===
app.get('/team-elo-history/:teamId', (req, res) => {
  const { teamId } = req.params;

  // Verify the team exists
  db.get('SELECT id FROM teams WHERE id = ?', [teamId], (err, team) => {
    if (err) {
      console.error('DB error verifying team:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    // Get all Elo rating changes for this team in chronological order
    const sql = `
      SELECT 
        er.elo,
        er.created_at,
        ROW_NUMBER() OVER (ORDER BY er.created_at) as vote_number
      FROM elo_ratings er
      WHERE er.team_id = ?
      ORDER BY er.created_at ASC
    `;

    db.all(sql, [teamId], (err2, eloHistory) => {
      if (err2) {
        console.error('DB error fetching Elo history:', err2);
        return res.status(500).json({ error: 'Database error' });
      }

      // Add starting point if we have data
      let history = [];
      if (eloHistory.length > 0) {
        // Add the initial 1500 rating as vote 0
        history.push({
          vote_number: 0,
          elo: 1500,
          created_at: null
        });
        
        // Add all the actual Elo changes
        history = history.concat(eloHistory);
      }

      res.json({ history });
    });
  });
});

// === NEW: Usage endpoint ===
app.post('/usage', (req, res) => {
  const { visitorId, sessionId, durationMs, page } = req.body || {};
  if (!visitorId || !sessionId || !durationMs) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const userId = req.user ? req.user.id : null;
  analyticsDb.run(
    `INSERT INTO page_time (visitor_id, session_id, user_id, page, duration_ms)
     VALUES (?,?,?,?,?)`,
    [visitorId, sessionId, userId, page || null, durationMs],
    (err) => {
      if (err) {
        console.error('DB error inserting page_time:', err);
        return res.status(500).json({ error: 'DB error' });
      }
      res.json({ status: 'ok' });
    }
  );
});

// ---- Notifications API ----

// Get unread notification count
app.get('/notifications/count', requireAuth, (req, res) => {
  const userId = req.user.id;
  
  db.get(
    `SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0`,
    [userId],
    (err, row) => {
      if (err) {
        console.error('Error fetching notification count:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      res.json({ count: row?.count || 0 });
    }
  );
});

// Get notifications for user (with pagination)
app.get('/notifications', requireAuth, (req, res) => {
  const userId = req.user.id;
  // const limit = parseInt(req.query.limit) || 20;
  // const offset = parseInt(req.query.offset) || 0;
  
  db.all(
    `SELECT 
      id, 
      type, 
      message, 
      related_team_id, 
      related_user_id, 
      opponent_team_id,
      is_read, 
      created_at
     FROM notifications 
     WHERE user_id = ?
     ORDER BY created_at DESC`,
    [userId],
    (err, rows) => {
      if (err) {
        console.error('Error fetching notifications:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      
      // Convert SQLite timestamps to proper ISO format for JavaScript
      const notifications = (rows || []).map(row => ({
        ...row,
        created_at: new Date(row.created_at + ' UTC').toISOString()
      }));
      
      res.json({ notifications });
    }
  );
});

// Mark specific notifications as read
app.post('/notifications/read', requireAuth, (req, res) => {
  const userId = req.user.id;
  const { notificationIds } = req.body;
  
  if (!notificationIds || !Array.isArray(notificationIds)) {
    return res.status(400).json({ error: 'notificationIds array required' });
  }
  
  if (notificationIds.length === 0) {
    return res.json({ status: 'no notifications to mark' });
  }
  
  const placeholders = notificationIds.map(() => '?').join(',');
  const params = [userId, ...notificationIds];
  
  db.run(
    `UPDATE notifications 
     SET is_read = 1 
     WHERE user_id = ? AND id IN (${placeholders})`,
    params,
    function(err) {
      if (err) {
        console.error('Error marking notifications as read:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      res.json({ status: 'marked as read', updated: this.changes });
    }
  );
});

// Mark all notifications as read for user
app.post('/notifications/read-all', requireAuth, (req, res) => {
  const userId = req.user.id;
  
  db.run(
    `UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0`,
    [userId],
    function(err) {
      if (err) {
        console.error('Error marking all notifications as read:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      res.json({ status: 'all marked as read', updated: this.changes });
    }
  );
});

// Get vote counts up to current time for today and yesterday
app.get('/api/reports/vote-projection', requireAdmin, (req, res) => {
  const sql = `
    WITH current_day AS (
      -- Get today's vote count (in ET)
      SELECT COUNT(*) as today_votes
      FROM versus_matches
      WHERE DATE(datetime(created_at, '-4 hours')) = DATE(datetime('now', '-4 hours'))
    ),
    yesterday_count AS (
      -- Get yesterday's vote count up to current time of day
      SELECT COUNT(*) as yesterday_votes_at_time
      FROM versus_matches
      WHERE 
        DATE(datetime(created_at, '-4 hours')) = DATE(datetime('now', '-4 hours', '-1 day'))
        AND
        strftime('%H:%M:%S', datetime(created_at, '-4 hours')) <= strftime('%H:%M:%S', datetime('now', '-4 hours'))
    )
    SELECT 
      today_votes,
      yesterday_votes_at_time
    FROM current_day, yesterday_count
  `;
  db.get(sql, [], (err, row) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(row || { today_votes: 0, yesterday_votes_at_time: 0 });
  });
});

// ---- Analytics reports ----
// Summary of page visits & durations
app.get('/api/reports/analytics-summary', requireAdmin, (req, res) => {
  const sql = `
    WITH logged_sessions AS (
      SELECT session_id, SUM(duration_ms) AS total_ms
      FROM page_time
      WHERE user_id IS NOT NULL
      AND created_at >= datetime('now', '-24 hours')
      GROUP BY session_id
    )
    SELECT
      (SELECT COUNT(*) FROM page_time 
       WHERE created_at >= datetime('now', '-24 hours'))                         AS total_page_views,
      (SELECT COUNT(*) FROM page_time 
       WHERE user_id IS NOT NULL 
       AND created_at >= datetime('now', '-24 hours'))                          AS logged_in_page_views,
      (SELECT COUNT(DISTINCT visitor_id) FROM page_time
       WHERE created_at >= datetime('now', '-24 hours'))                        AS unique_visitors,
      (SELECT ROUND(AVG(duration_ms), 0) FROM page_time)                        AS avg_duration_ms,
      (SELECT ROUND(AVG(total_ms), 0) FROM logged_sessions)                     AS avg_session_ms_logged_in,
      (SELECT COUNT(DISTINCT user_id) FROM page_time 
       WHERE user_id IS NOT NULL 
       AND created_at >= datetime('now', '-24 hours'))                         AS unique_users_last_24h
  `;
  analyticsDb.get(sql, [], (err, row) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(row);
  });
});

// Average duration by page for logged-in users
app.get('/api/reports/avg-duration-by-page', requireAdmin, (req, res) => {
  const sql = `
    SELECT page,
           COUNT(*) AS views,
           ROUND(AVG(duration_ms), 0) AS avg_duration_ms
    FROM page_time
    WHERE user_id IS NOT NULL
    GROUP BY page
    ORDER BY views DESC
  `;
  analyticsDb.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows);
  });
});

// ✅ Updated to support Replit or local dev port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

// === NEW: Top 10 Drafters Widget Endpoint ===
app.get('/api/widgets/top-drafters', (req, res) => {
  const startTime = Date.now();
  const tournament = req.query.tournament || null;
  const cacheKey = `top-drafters-${tournament || 'all'}`;
  
  // Check widget cache first
  const cached = getCachedWidget(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    logWidgetPerformance('top-drafters', startTime, true);
    return res.json(cached);
  }

    // Single query: get ALL users' average ELO ratings
  const sql = `
    SELECT 
      username,
      COUNT(*) as team_count,
      AVG(elo) as avg_elo
    FROM elo_ratings er1
    WHERE er1.created_at = (
      SELECT MAX(er2.created_at) 
      FROM elo_ratings er2 
      WHERE er2.team_id = er1.team_id
    )
    AND (er1.wins + er1.losses) > 0
    AND username IS NOT NULL AND username != ''
    GROUP BY username
    ORDER BY avg_elo DESC
  `;
  
  db.all(sql, (err, rows) => {
    if (err) {
      console.error('Error fetching top drafters:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    
    if (rows.length > 0) {
      // Calculate percentiles from all users
      const allAvgElos = rows.map(r => r.avg_elo).sort((a, b) => a - b);
      const minAvgElo = allAvgElos[0];
      const maxAvgElo = allAvgElos[allAvgElos.length - 1];
      
      // Add percentile to each user
      rows.forEach(row => {
        if (maxAvgElo === minAvgElo) {
          row.percentile = 0.5;
        } else {
          row.percentile = (row.avg_elo - minAvgElo) / (maxAvgElo - minAvgElo);
        }
      });
      
      // Take top 10 after percentile calculation
      const top10 = rows.slice(0, 10);
      
      // Cache the result
      setCachedWidget(cacheKey, top10);
      
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('Cache-Control', 'public, max-age=600'); // 10 minutes cache
      logWidgetPerformance('top-drafters', startTime, false);
      res.json(top10);
    } else {
      // No data available
      setCachedWidget(cacheKey, []);
      res.json([]);
    }
  });
});

// === NEW: Top 10 Teams Widget Endpoint ===
app.get('/api/widgets/top-teams', (req, res) => {
  const startTime = Date.now();
  const cacheKey = 'top-teams';
  
  // Check widget cache first
  const cached = getCachedWidget(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    logWidgetPerformance('top-teams', startTime, true);
    return res.json(cached);
  }

  // Updated query to use ELO ratings instead of ratings_history
  const sql = `
    SELECT 
      team_id as id,
      username,
      tournament,
      elo,
      wins + losses as total_votes
    FROM elo_ratings er1
    WHERE er1.created_at = (
      SELECT MAX(er2.created_at) 
      FROM elo_ratings er2 
      WHERE er2.team_id = er1.team_id
    )
    AND (wins + losses) > 0
    ORDER BY elo DESC
    LIMIT 10
  `;

  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error('Error fetching top teams:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    
    // Calculate percentiles based on ALL teams with at least one vote
    const globalSql = `
      SELECT er.elo as elo_rating
      FROM elo_ratings er
      WHERE er.created_at = (
        SELECT MAX(er2.created_at) 
        FROM elo_ratings er2 
        WHERE er2.team_id = er.team_id
      )
      AND (er.wins + er.losses) > 0
      ORDER BY er.elo DESC
    `;
    
    db.all(globalSql, [], (globalErr, globalRows) => {
      if (globalErr) {
        console.error('Global Elo query error:', globalErr);
        return res.status(500).json({ error: 'Database error' });
      }
      
      if (globalRows.length > 0) {
        const globalEloValues = globalRows.map(r => r.elo_rating);
        const minGlobalElo = globalEloValues[globalEloValues.length - 1];
        const maxGlobalElo = globalEloValues[0];
        
        // Add percentile to each row
        rows.forEach(row => {
          if (maxGlobalElo === minGlobalElo) {
            row.percentile = 0.5;
          } else {
            row.percentile = (row.elo - minGlobalElo) / (maxGlobalElo - minGlobalElo);
          }
        });
      } else {
        // No global data available, set default percentiles
        rows.forEach(row => {
          row.percentile = 0.5;
        });
      }
      
      // Cache the result for longer since this data doesn't change frequently
      setCachedWidget(cacheKey, rows);
      
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('Cache-Control', 'public, max-age=600'); // 10 minutes cache
      logWidgetPerformance('top-teams', startTime, false);
      res.json(rows);
    });
  });
});

// === NEW: Recent Votes Widget Endpoint ===
app.get('/api/widgets/recent-votes', (req, res) => {
  const startTime = Date.now();
  const cacheKey = 'recent-votes';
  
  // Check widget cache first (shorter cache for recent votes)
  const cached = getCachedWidget(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    logWidgetPerformance('recent-votes', startTime, true);
    return res.json(cached);
  }

  // Simplified query - remove complex subquery in SELECT for better performance
  const sql = `
    SELECT 
      vm.id,
      vm.winner_id,
      vm.loser_id,
      vm.created_at,
      vm.voter_id,
      tw.username as winner_username,
      tw.tournament as winner_tournament,
      tl.username as loser_username,
      tl.tournament as loser_tournament,
      COALESCE(u.display_name, 'Anonymous') as voter_name
    FROM versus_matches vm
    LEFT JOIN teams tw ON vm.winner_id = tw.id
    LEFT JOIN teams tl ON vm.loser_id = tl.id
    LEFT JOIN users u ON vm.voter_id = u.id
    WHERE vm.created_at >= datetime('now', '-7 days')  -- Only look at recent votes
    ORDER BY vm.created_at DESC
    LIMIT 10
  `;

  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error('Error fetching recent votes:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    
    // Handle voter name fallback if display_name is null but user has teams
    const processedRows = [];
    let completed = 0;
    
    const processRow = (row, index) => {
      // If voter_name is 'Anonymous' but we have a voter_id, try to get team username
      if (row.voter_name === 'Anonymous' && row.voter_id) {
        db.get(
          'SELECT username FROM teams WHERE user_id = ? LIMIT 1',
          [row.voter_id],
          (err, teamRow) => {
            if (!err && teamRow) {
              row.voter_name = teamRow.username;
            }
            
            processedRows[index] = {
              id: row.id,
              winner_id: row.winner_id,
              loser_id: row.loser_id,
              created_at: row.created_at,
              winner_username: row.winner_username || 'Anonymous',
              winner_tournament: row.winner_tournament,
              loser_username: row.loser_username || 'Anonymous',
              loser_tournament: row.loser_tournament,
              voter_name: row.voter_name,
              time_ago: getTimeAgo(new Date(row.created_at + ' UTC'))
            };
            
            completed++;
            if (completed === rows.length) {
              finishResponse();
            }
          }
        );
      } else {
        processedRows[index] = {
          id: row.id,
          winner_id: row.winner_id,
          loser_id: row.loser_id,
          created_at: row.created_at,
          winner_username: row.winner_username || 'Anonymous',
          winner_tournament: row.winner_tournament,
          loser_username: row.loser_username || 'Anonymous',
          loser_tournament: row.loser_tournament,
          voter_name: row.voter_name,
          time_ago: getTimeAgo(new Date(row.created_at + ' UTC'))
        };
        
        completed++;
        if (completed === rows.length) {
          finishResponse();
        }
      }
    };
    
    const finishResponse = () => {
      // Cache for 10 seconds (faster cache for recent votes)
      setCachedWidget(cacheKey, processedRows);
      
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('Cache-Control', 'public, max-age=10'); // 10 seconds browser cache
      logWidgetPerformance('recent-votes', startTime, false);
      res.json(processedRows);
    };
    
    if (rows.length === 0) {
      return finishResponse();
    }
    
    rows.forEach(processRow);
  });
});

// === NEW: Lightweight Recent Votes Count Endpoint ===
app.get('/api/widgets/recent-votes-count', (req, res) => {
  const cacheKey = 'recent-votes-count';
  
  // Check cache first
  const cached = getCachedWidget(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.json(cached);
  }

  // Very lightweight query - just count recent votes
  const sql = `
    SELECT COUNT(*) as count
    FROM versus_matches 
    WHERE created_at >= datetime('now', '-7 days')
  `;

  db.get(sql, [], (err, row) => {
    if (err) {
      console.error('Error fetching recent votes count:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    
    const result = { count: row ? row.count : 0 };
    
    // Cache for 5 seconds (very fast updates for count checking)
    setCachedWidget(cacheKey, result);
    
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('Cache-Control', 'public, max-age=5'); // 5 seconds browser cache
    res.json(result);
  });
});

// === NEW: Performance Monitoring for Recent Votes ===
app.get('/api/widgets/recent-votes-performance', (req, res) => {
  const startTime = Date.now();
  
  // Test the recent votes query performance
  const sql = `
    SELECT 
      vm.id,
      vm.winner_id,
      vm.loser_id,
      vm.created_at,
      vm.voter_id,
      tw.username as winner_username,
      tw.tournament as winner_tournament,
      tl.username as loser_username,
      tl.tournament as loser_tournament,
      COALESCE(
        u.display_name,
        (SELECT username FROM teams WHERE user_id = vm.voter_id LIMIT 1),
        'Anonymous'
      ) as voter_name
    FROM versus_matches vm
    LEFT JOIN teams tw ON vm.winner_id = tw.id
    LEFT JOIN teams tl ON vm.loser_id = tl.id
    LEFT JOIN users u ON vm.voter_id = u.id
    WHERE vm.created_at >= datetime('now', '-7 days')
    ORDER BY vm.created_at DESC
    LIMIT 10
  `;

  db.all(sql, [], (err, rows) => {
    const endTime = Date.now();
    const duration = endTime - startTime;
    
    if (err) {
      console.error('Performance test failed:', err);
      return res.status(500).json({ 
        error: 'Database error',
        duration: duration,
        cache_hit: false
      });
    }
    
    res.json({
      duration: duration,
      row_count: rows.length,
      cache_hit: false,
      timestamp: new Date().toISOString()
    });
  });
});

// Helper function to calculate time ago
function getTimeAgo(date) {
  const now = new Date();
  const diffMs = now - date;
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return `${diffSecs}s ago`;
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

// === NEW: Widget Cache for Homepage Performance ===
const WIDGET_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const RECENT_VOTES_CACHE_TTL = 10 * 1000; // 10 seconds for recent votes (faster updates)
const widgetCache = new Map();

function getCachedWidget(key) {
  const cached = widgetCache.get(key);
  if (!cached) return null;
  
  // Use custom TTL if provided, otherwise use default based on key
  const ttl = cached.customTtl || 
    (key === 'recent-votes' ? RECENT_VOTES_CACHE_TTL : WIDGET_CACHE_TTL);
    
  if ((Date.now() - cached.timestamp) < ttl) {
    return cached.data;
  }
  return null;
}

function setCachedWidget(key, data, customTtl = null) {
  widgetCache.set(key, {
    data,
    timestamp: Date.now(),
    customTtl
  });
}

// Optimized cache cleanup with memory monitoring
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  
  // Get memory usage for monitoring
  const memoryUsage = process.memoryUsage();
  const heapUsedMB = Math.round(memoryUsage.heapUsed / 1024 / 1024);
  
  // More aggressive cleanup if memory usage is high
  const isHighMemory = heapUsedMB > 512; // 512MB threshold
  const aggressiveCleanup = isHighMemory;
  
  // Clean widget cache with adaptive TTL
  for (const [key, value] of widgetCache.entries()) {
    const baseTtl = value.customTtl || 
      (key === 'recent-votes' ? RECENT_VOTES_CACHE_TTL : WIDGET_CACHE_TTL);
    
    // Reduce TTL by 50% if memory is high
    const effectiveTtl = aggressiveCleanup ? baseTtl * 0.5 : baseTtl;
    
    if (now - value.timestamp > effectiveTtl) {
      widgetCache.delete(key);
      cleaned++;
    }
  }
  
  // Clean team metadata cache more aggressively if needed
  if (aggressiveCleanup && teamMetaCache.size > 100) {
    const entries = Array.from(teamMetaCache.entries())
      .sort((a, b) => b[1].timestamp - a[1].timestamp);
    
    teamMetaCache.clear();
    // Keep only the 50 most recent entries
    entries.slice(0, 50).forEach(([key, value]) => {
      teamMetaCache.set(key, value);
    });
    
  }
  
  // Clean old leaderboard cache entries (more aggressive if high memory)
  const maxCacheEntries = aggressiveCleanup ? 3 : 5;
  const cleanLeaderboardCache = (cache, name) => {
    if (cache.size > maxCacheEntries) {
      const entries = Array.from(cache.entries())
        .sort((a, b) => b[1].stamp - a[1].stamp);
      
      cache.clear();
      entries.slice(0, maxCacheEntries).forEach(([key, value]) => {
        cache.set(key, value);
      });
    }
  };
  
  cleanLeaderboardCache(teamLeaderboardCacheMeta, 'team leaderboard');
  cleanLeaderboardCache(userLeaderboardCacheMeta, 'user leaderboard');
  
  // Force garbage collection if memory is very high and gc is available
  if (heapUsedMB > 1024 && global.gc) {
    global.gc();
  }
}, 15 * 60 * 1000); // Run every 15 minutes for more responsive cleanup

// === NEW: Additional Specialized Indexes ===
function createSpecializedIndexes() {
  
  // Specialized composite index for recent votes widget (removed WHERE clause due to SQLite limitations)
  db.run(`CREATE INDEX IF NOT EXISTS idx_versus_matches_recent_widget ON versus_matches(created_at DESC, winner_id, loser_id, voter_id)`, (err) => {
    if (err) console.error('Error creating versus_matches recent widget index:', err);
    else console.log('✅ Recent votes widget index created successfully');
  });
  
}

// Performance monitoring for widget endpoints
function logWidgetPerformance(widgetName, startTime, cacheHit = false) {
  const duration = Date.now() - startTime;
  
  // Track slow operations
  if (duration > 500) {
    console.warn(`⚠️ Slow widget: ${widgetName} took ${duration}ms`);
  }
}

// Create specialized indexes on startup
createSpecializedIndexes();
