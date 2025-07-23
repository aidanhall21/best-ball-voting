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
      // Optional: Log successful verification details
      console.log("Turnstile verification successful:", {
        hostname: result.hostname,
        challenge_ts: result.challenge_ts,
        action: result.action
      });
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

// Serve index.html without CSRF token since we're using Turnstile
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  const tokenScript = `\n<script>\n    window.TURNSTILE_SITE_KEY='${CF_SITE_KEY}';\n  </script>\n`;
  html = html.replace('</head>', tokenScript + '</head>');
  // Inject cache-busting query string into main bundle
  html = html.replace('script.js"', `script.js?v=${ASSET_VERSION}"`);
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
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
                `UPDATE players SET picked_at = COALESCE(picked_at, ?), appearance = COALESCE(appearance, ?) WHERE team_id = ? AND position = ? AND name = ? AND pick = ?`,
                [pl.pickedAt, pl.appearance, pl.teamId, pl.position, pl.name, pl.pick],
                function(err) {
                  if (err) { console.error('Player update err', err); return; }
                  if (this.changes === 0) {
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
                `UPDATE players SET picked_at = COALESCE(picked_at, ?), appearance = COALESCE(appearance, ?) WHERE team_id = ? AND position = ? AND name = ? AND pick = ?`,
                [pl.pickedAt, pl.appearance, pl.teamId, pl.position, pl.name, pl.pick],
                function(err) {
                  if (err) { console.error('Player update err', err); return; }
                  if (this.changes === 0) {
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
    const sql = `
      WITH win_ct AS (
        SELECT winner_id AS team_id, COUNT(*) AS wins
        FROM versus_matches
        GROUP BY winner_id
      ),
      loss_ct AS (
        SELECT loser_id AS team_id, COUNT(*) AS losses
        FROM versus_matches
        GROUP BY loser_id
      )
      SELECT 
        t.id            AS team_id,
        t.tournament    AS tournament,
        t.username      AS username,
        t.user_id       AS user_id,
        COALESCE(w.wins, 0)   AS wins,
        COALESCE(l.losses, 0) AS losses,
        p.position      AS position,
        p.name          AS name,
        p.pick          AS pick,
        p.team          AS team,
        p.stack         AS stack
      FROM teams t
      JOIN players p     ON p.team_id = t.id
      LEFT JOIN win_ct w ON w.team_id = t.id
      LEFT JOIN loss_ct l ON l.team_id = t.id
    `;

    db.all(sql, [], (err, rows) => {
      if (err) return reject(err);

      const teams = {};
      const tournaments = {};
      const usernames = {};
      const userIds = {};
      const totals = {}; // wins & losses per team

      rows.forEach((row) => {
        if (!teams[row.team_id]) {
          teams[row.team_id] = [];
          tournaments[row.team_id] = row.tournament;
          usernames[row.team_id] = row.username;
          userIds[row.team_id] = row.user_id;
          totals[row.team_id] = { wins: row.wins, losses: row.losses };
        }
        teams[row.team_id].push({
          position: row.position,
          name: row.name,
          pick: row.pick,
          team: row.team,
          stack: row.stack
        });
      });

      const payloadObj = { teams: Object.entries(teams), tournaments, usernames, userIds, totals };
      const jsonStr = JSON.stringify(payloadObj);
      const gz = zlib.gzipSync(jsonStr);

      fs.writeFileSync(CACHE_FILE_PATH, gz);
      teamsCacheMeta = {
        etag: crypto.createHash('md5').update(jsonStr).digest('hex'),
        stamp: Date.now()
      };
      resolve();
    });
  });
}

// Initial build and periodic refresh
buildTeamsCache().catch(err => console.error('Error building /teams cache:', err));
setInterval(() => buildTeamsCache().catch(err => console.error('Error building /teams cache:', err)), CACHE_REFRESH_MS);

app.get('/teams', (req, res) => {
  if (!teamsCacheMeta.etag) {
    return res.status(503).json({ error: 'Cache building, try again shortly.' });
  }

  if (req.headers['if-none-match'] === teamsCacheMeta.etag) {
    return res.status(304).end();
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Encoding', 'gzip');
  res.setHeader('Cache-Control', 'public, max-age=900');
  res.setHeader('ETag', teamsCacheMeta.etag);

  fs.createReadStream(CACHE_FILE_PATH).pipe(res);
});

// Yes/No voting has been removed - only versus matchups are supported

// Record versus match result (captcha-protected, rate limiting handled client-side)
app.post("/versus", verifyCaptcha, (req, res) => {
  const { winnerId, loserId } = req.body;
  const voterId = req.user ? req.user.id : null;

  if (!winnerId || !loserId) {
    return res.status(400).json({ error: "Winner and loser IDs required" });
  }

  db.run(
    `INSERT INTO versus_matches (winner_id, loser_id, voter_id) VALUES (?, ?, ?)`,
    [winnerId, loserId, voterId],
    (err) => {
      if (err) return res.status(500).json({ error: "Failed to record match result" });
      
      // Clear cache for both teams since their stats changed
      teamMetaCache.delete(winnerId);
      teamMetaCache.delete(loserId);
      
      // Create detailed notifications for team owners (if voter is logged in and different from team owners)
      if (voterId) {
        // Get comprehensive team and voter information
        db.all(
          `SELECT t.id, t.user_id, t.username, t.tournament, u.display_name
           FROM teams t 
           LEFT JOIN users u ON t.user_id = u.id 
           WHERE t.id IN (?, ?)`,
          [winnerId, loserId],
          (err2, teamRows) => {
            if (err2) {
              console.error('Error fetching team owners for notifications:', err2);
              return; // Don't fail the entire request
            }

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
                    const message = `${emoji}${voterName} voted ${isWinner ? 'for' : 'against'} your team in the ${team.tournament} against ${opponentName}`;
                    
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
        );
      }
      
      res.json({ status: "recorded" });
    }
  );
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

// Cleanup expired cache entries every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of teamMetaCache.entries()) {
    if (now - value.timestamp > TEAM_META_CACHE_TTL) {
      teamMetaCache.delete(key);
    }
  }
}, 2 * 60 * 1000);

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
    }

    // Cache the result
    teamMetaCache.set(teamId, {
      data: meta,
      timestamp: Date.now()
    });

    res.json(meta);
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
    `;

    db.all(sql, [
      tournament || null, tournament || null, tournament || null, // wins subquery
      tournament || null, tournament || null, tournament || null, // losses subquery  
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

          // Get voting stats - first get my team IDs
          db.all(
            'SELECT id FROM teams WHERE user_id = ?',
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

              // Complex query to get win/loss stats by voter
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

              // Build params array - need to repeat myTeamIds 4 times for the different IN clauses
              const params = [
                ...myTeamIds, // For wins IN clause
                ...myTeamIds, // For losses IN clause
                ...myTeamIds, // For winner_id IN clause
                ...myTeamIds  // For loser_id IN clause
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

                // === NEW: Fetch vote results for each of the user's teams ===
                const teamStatsSql = `
                  WITH team_stats AS (
                    SELECT
                      t.id,
                      t.tournament,
                      COALESCE((SELECT COUNT(*) FROM versus_matches vm WHERE vm.winner_id = t.id), 0) AS wins,
                      COALESCE((SELECT COUNT(*) FROM versus_matches vm WHERE vm.loser_id = t.id), 0) AS losses,
                      COALESCE((SELECT madden FROM ratings_history rh WHERE rh.team_id = t.id ORDER BY rh.computed_at DESC LIMIT 1), 0) AS madden
                    FROM teams t
                    WHERE t.user_id = ?
                  )
                  SELECT * FROM team_stats
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
                    const voteTotal = r.yes_votes + r.no_votes;
                    const yes_pct = voteTotal ? ((r.yes_votes / voteTotal) * 100).toFixed(1) : 0;
                    const h2hTotal = r.wins + r.losses;
                    const win_pct = h2hTotal ? ((r.wins / h2hTotal) * 100).toFixed(1) : 0;
                    return { ...r, yes_pct, win_pct };
                  });

                  response.voteResults = enriched;

                  // === NEW: Pull median rating from cached user leaderboard ===
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
                    COALESCE((SELECT madden FROM ratings_history rh WHERE rh.team_id = t.id ORDER BY rh.computed_at DESC LIMIT 1), 0) AS madden
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

                // === NEW: Pull median rating from cached user leaderboard ===
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

      // Get voting history for this team
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

      // Need to pass teamId 6 times for the different CASE statements and WHERE clause
      const params = [teamId, teamId, teamId, teamId, teamId, teamId];

      db.all(sql, params, (err2, votes) => {
        if (err2) {
          console.error('DB error fetching team votes:', err2);
          return res.status(500).json({ error: 'Database error' });
        }

        res.json({ votes: votes || [] });
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

    // Re-use same query as private endpoint (no ownership check)
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
            SELECT madden FROM ratings_history rh_loser 
            WHERE rh_loser.team_id = vm.loser_id 
            ORDER BY rh_loser.computed_at DESC LIMIT 1
          )
          ELSE (
            SELECT madden FROM ratings_history rh_winner 
            WHERE rh_winner.team_id = vm.winner_id 
            ORDER BY rh_winner.computed_at DESC LIMIT 1
          )
        END as opponent_madden,
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
      res.json({ votes: votes || [] });
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
app.get('/api/widgets/top-drafters', async (req, res) => {
  const tournament = req.query.tournament || null;
  const key = sanitizeKey(tournament);

  try {
    let meta = userLeaderboardCacheMeta.get(key);
    if (!meta || (Date.now() - meta.stamp > LEADER_CACHE_REFRESH_MS)) {
      await buildUserLeaderboardCache(tournament);
      meta = userLeaderboardCacheMeta.get(key);
    }

    // Read and decompress cached leaderboard
    const buf = fs.readFileSync(meta.filePath);
    const jsonStr = zlib.gunzipSync(buf).toString('utf8');
    const data = JSON.parse(jsonStr);

    const top10 = data
      .sort((a, b) => b.median_madden - a.median_madden)
      .slice(0, 10)
      .map(u => ({
        username: u.username,
        wins: u.wins,
        losses: u.losses,
        median_rating: u.median_madden,
        win_pct: u.win_pct
      }));

    res.json(top10);
  } catch (e) {
    console.error('Error building top drafters widget:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// === NEW: Top 10 Teams Widget Endpoint ===
app.get('/api/widgets/top-teams', (req, res) => {
  const sql = `
    WITH team_stats AS (
      SELECT
        t.id,
        t.username,
        t.tournament,
        COALESCE((SELECT madden FROM ratings_history rh WHERE rh.team_id = t.id ORDER BY rh.computed_at DESC LIMIT 1), 0) AS madden,
        COALESCE((
          SELECT COUNT(*) FROM versus_matches vm 
          WHERE vm.winner_id = t.id
        ), 0) AS wins,
        COALESCE((
          SELECT COUNT(*) FROM versus_matches vm 
          WHERE vm.loser_id = t.id
        ), 0) AS losses
      FROM teams t
    )
    SELECT 
      id,
      username,
      tournament,
      madden,
      wins,
      losses,
      wins + losses as total_votes
    FROM team_stats
    WHERE total_votes > 0
    ORDER BY madden DESC
    LIMIT 10
  `;

  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error('Error fetching top teams:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(rows);
  });
});

// === NEW: Recent Votes Widget Endpoint ===
app.get('/api/widgets/recent-votes', (req, res) => {
  const sql = `
    SELECT 
      vm.id,
      vm.winner_id,
      vm.loser_id,
      vm.created_at,
      tw.username as winner_username,
      tw.tournament as winner_tournament,
      tl.username as loser_username,
      tl.tournament as loser_tournament,
      CASE 
        WHEN vm.voter_id IS NULL THEN 'Anonymous'
        ELSE COALESCE(
          NULLIF(TRIM(u.display_name), ''),
          (SELECT username FROM teams WHERE user_id = vm.voter_id LIMIT 1),
          'Anonymous'
        )
      END as voter_name
    FROM versus_matches vm
    LEFT JOIN teams tw ON vm.winner_id = tw.id
    LEFT JOIN teams tl ON vm.loser_id = tl.id
    LEFT JOIN users u ON vm.voter_id = u.id
    ORDER BY vm.created_at DESC
    LIMIT 10
  `;

  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error('Error fetching recent votes:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    
    // Format the timestamps for display
    const formattedRows = rows.map(row => ({
      ...row,
      time_ago: getTimeAgo(new Date(row.created_at + ' UTC'))
    }));
    
    res.json(formattedRows);
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
