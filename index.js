require('dotenv').config();
const express = require("express");
const app = express();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const morgan = require('morgan');
const Papa = require("papaparse");
const db = require("./db");
const crypto = require("crypto");
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const passport = require('./auth');
const bcrypt = require('bcryptjs');
const sendMail = require('./mailer');
const compression = require('compression');

const upload = multer({ dest: "uploads/" });
app.use(compression());
app.use(express.static(__dirname));
app.use(express.json());

// Request logging
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

// Middleware to identify user (basic fingerprint via cookie or IP)
app.use((req, res, next) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  req.voterId = ip || crypto.randomUUID();
  next();
});

// Simple in-memory rate limiter for votes: max 5 per 10-second window per voter
const voteHistory = new Map(); // voterId -> [timestamps]
function voteRateLimiter(req, res, next) {
  const id = req.user ? req.user.id : crypto.randomUUID();
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

// Home page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Handle CSV Upload
app.post("/upload", requireAuth, upload.single("csv"), (req, res) => {
  const csvPath = req.file.path;
  const fileContent = fs.readFileSync(csvPath, "utf8");

  // Username supplied by the uploader (sent as a regular form field alongside the file)
  const uploaderUsername = (req.body.username || "anonymous")
    .trim()
    .replace(/[^a-zA-Z0-9]/g, '') // Remove all non-alphanumeric characters
    .toUpperCase();

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
            const tournament = row["Tournament Title"];
            const fullName = `${row["First Name"]} ${row["Last Name"]}`;
            const position = row["Position"];
            const pick = parseInt(row["Pick Number"]);
            const draftId = row["Draft"];
            const team = row["Team"];

            if (!teamId || !fullName || !position || isNaN(pick)) return;
            if (existingTeamIds.has(teamId)) return; // Skip if team already exists
            if (invalidTeamIds.has(teamId)) return;  // Skip if team contains invalid position

            if (!groupedTeams[teamId]) {
              groupedTeams[teamId] = {
                tournament,
                players: [],
                draftId
              };
            }

            groupedTeams[teamId].players.push({ position, name: fullName, pick, team });
          });

          // Only proceed with insert if we have new teams
          const addedTeamsCount = Object.keys(groupedTeams).length;
          const skippedIdsSet = new Set([
            ...skippedExistingIds,
            ...invalidTeamIds
          ]);

          if (addedTeamsCount === 0) {
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

              // Insert players with stack information
              players.forEach((player) => {
                db.run(
                  `INSERT INTO players (team_id, position, name, pick, team, stack) VALUES (?, ?, ?, ?, ?, ?)`,
                  [teamId, player.position, player.name, player.pick, player.team, player.stack || null]
                );
              });
            }
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
});

// ---- In-memory cache for heavy endpoints ----
const TEAMS_CACHE_TTL_MS = 30 * 1000; // 30 seconds
let teamsCache = { json: null, etag: null, timestamp: 0 };

app.get("/teams", (req, res) => {
  // Serve from cache if fresh
  if (teamsCache.json && (Date.now() - teamsCache.timestamp < TEAMS_CACHE_TTL_MS)) {
    if (req.headers["if-none-match"] === teamsCache.etag) {
      return res.status(304).end();
    }
    res.setHeader("ETag", teamsCache.etag);
    res.setHeader("Cache-Control", "public, max-age=30");
    res.type("application/json").send(teamsCache.json);
    return;
  }

  // Rebuild the payload from DB
  const sql = `
    SELECT t.id as team_id, t.tournament, t.username, t.user_id, p.position, p.name, p.pick, p.team, p.stack
    FROM teams t
    JOIN players p ON p.team_id = t.id
  `;

  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: "DB error" });

    const teams = {};
    const tournaments = {};
    const usernames = {};
    const userIds = {}; // NEW: map teamId -> user_id

    rows.forEach((row) => {
      if (!teams[row.team_id]) {
        teams[row.team_id] = [];
        tournaments[row.team_id] = row.tournament;
        usernames[row.team_id] = row.username;
        userIds[row.team_id] = row.user_id; // NEW
      }
      teams[row.team_id].push({
        position: row.position,
        name: row.name,
        pick: row.pick,
        team: row.team,
        stack: row.stack
      });
    });

    const payloadObj = { teams: Object.entries(teams), tournaments, usernames, userIds }; // NEW include userIds
    const jsonStr = JSON.stringify(payloadObj);
    const etag = crypto.createHash("md5").update(jsonStr).digest("hex");

    // Update cache
    teamsCache = { json: jsonStr, etag, timestamp: Date.now() };

    if (req.headers["if-none-match"] === etag) {
      return res.status(304).end();
    }

    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "public, max-age=30");
    res.type("application/json").send(jsonStr);
  });
});

// POST vote for a team
app.post("/vote", voteRateLimiter, (req, res) => {
  const { teamId, voteType } = req.body;
  const voterId = req.user ? req.user.id : null;

  if (!["yes", "no"].includes(voteType)) {
    return res.status(400).json({ error: "Invalid vote type" });
  }

  db.get(
    `SELECT vote_type FROM votes WHERE team_id = ? AND voter_id ${voterId ? '= ?' : 'IS NULL'}`,
    voterId ? [teamId, voterId] : [teamId],
    (err, row) => {
      if (err) return res.status(500).json({ error: "DB error" });

      if (!row) {
        db.run(
          `INSERT INTO votes (team_id, vote_type, voter_id) VALUES (?, ?, ?)`,
          [teamId, voteType, voterId],
          () => res.json({ status: "voted" })
        );
      } else if (row.vote_type !== voteType) {
        db.run(
          `UPDATE votes SET vote_type = ? WHERE team_id = ? AND voter_id ${voterId ? '= ?' : 'IS NULL'}`,
          voterId ? [voteType, teamId, voterId] : [voteType, teamId],
          () => res.json({ status: "updated" })
        );
      } else {
        res.json({ status: "unchanged" });
      }
    }
  );
});

// Get vote counts
app.get("/votes/:teamId", (req, res) => {
  const teamId = req.params.teamId;

  db.all(
    `SELECT vote_type, COUNT(*) as count FROM votes WHERE team_id = ? GROUP BY vote_type`,
    [teamId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error" });

      const results = { yes: 0, no: 0 };
      rows.forEach((r) => {
        results[r.vote_type] = r.count;
      });
      res.json(results);
    }
  );
});

// Record versus match result (rate-limited)
app.post("/versus", voteRateLimiter, (req, res) => {
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

// Combined meta endpoint: owner info + versus stats (wins/losses)
app.get("/team-meta/:teamId", (req, res) => {
  const { teamId } = req.params;

  const sql = `
    SELECT 
      t.username,
      t.tournament,
      u.twitter_username,
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

    const meta = row || { username: null, twitter_username: null, tournament: null, wins: 0, losses: 0 };
    const total = (meta.wins || 0) + (meta.losses || 0);
    let win_pct = 0;
    if (total > 0) {
      win_pct = (meta.wins / total) * 100;
    } else if (meta.wins > 0) {
      win_pct = 100;
    }
    meta.win_pct = Number(win_pct.toFixed(1));

    res.json(meta);
  });
});

// Leaderboard endpoint (team)
app.get("/leaderboard", (req, res) => {
  const tournament = req.query.tournament;
  
  const sql = `
    WITH team_stats AS (
      SELECT
        t.id,
        t.username,
        t.tournament,
        COALESCE((SELECT COUNT(*) FROM votes v WHERE v.team_id = t.id AND v.vote_type = 'yes'), 0) AS yes_votes,
        COALESCE((SELECT COUNT(*) FROM votes v WHERE v.team_id = t.id AND v.vote_type = 'no'), 0) AS no_votes,
        COALESCE((SELECT COUNT(*) FROM versus_matches vm WHERE vm.winner_id = t.id), 0) AS wins,
        COALESCE((SELECT COUNT(*) FROM versus_matches vm WHERE vm.loser_id = t.id), 0) AS losses
      FROM teams t
      WHERE ($tournament IS NULL OR t.tournament = $tournament)
    )
    SELECT *
    FROM team_stats
    WHERE (yes_votes + no_votes) > 0 OR (wins + losses) > 0
    ORDER BY (CAST(wins AS FLOAT) / NULLIF(wins + losses, 0)) DESC NULLS LAST,
             (CAST(yes_votes AS FLOAT) / NULLIF(yes_votes + no_votes, 0)) DESC NULLS LAST
  `;
  
  const params = { $tournament: tournament || null };
  
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: "DB error" });
    const enriched = rows.map(calcPercents);
    res.json(enriched);
  });
});

function calcPercents(r) {
  const voteTotal = r.yes_votes + r.no_votes;
  const yes_pct = voteTotal ? ((r.yes_votes / voteTotal) * 100).toFixed(1) : 0;
  const h2hTotal = r.wins + r.losses;
  const win_pct = h2hTotal ? ((r.wins / h2hTotal) * 100).toFixed(1) : 0;
  return { ...r, yes_pct, win_pct };
}

// Leaderboard by user
app.get("/leaderboard/users", (req, res) => {
  const tournament = req.query.tournament;
  
  const sql = `
    SELECT
      t.id,
      t.username,
      t.tournament,
      COALESCE((SELECT COUNT(*) FROM votes v WHERE v.team_id = t.id AND v.vote_type = 'yes'), 0) AS yes_votes,
      COALESCE((SELECT COUNT(*) FROM votes v WHERE v.team_id = t.id AND v.vote_type = 'no'), 0) AS no_votes,
      COALESCE((SELECT COUNT(*) FROM versus_matches vm WHERE vm.winner_id = t.id), 0) AS wins,
      COALESCE((SELECT COUNT(*) FROM versus_matches vm WHERE vm.loser_id = t.id), 0) AS losses
    FROM teams t
    WHERE ($tournament IS NULL OR t.tournament = $tournament)
  `;
  
  const params = { $tournament: tournament || null };
  
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: "DB error" });

    // aggregate by username
    const userStats = {};
    rows.forEach((r) => {
      const u = r.username || 'ANON';
      if (!userStats[u]) {
        userStats[u] = { username: u, yes_votes: 0, no_votes: 0, wins: 0, losses: 0 };
      }
      userStats[u].yes_votes += r.yes_votes;
      userStats[u].no_votes += r.no_votes;
      userStats[u].wins += r.wins;
      userStats[u].losses += r.losses;
    });

    const result = Object.values(userStats).map(calcPercents);
    res.json(result);
  });
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
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const hash = await bcrypt.hash(password, 12);
    db.run('INSERT INTO users (email, password_hash) VALUES (?, ?)', [email, hash], function(err) {
      if (err) {
        return res.status(400).json({ error: 'User already exists' });
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

      const base = process.env.BASE_URL || 'https://draftrpass.com';
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

// --- 📊 Reports & Dashboards -------------------------------------------------
// Votes by user (draft vs pass counts)
app.get('/api/reports/votes-by-user', requireAdmin, (req, res) => {
  const sql = `
    SELECT
      COALESCE(voter_id, 'ANON') AS voter,
      SUM(CASE WHEN vote_type = 'yes' THEN 1 ELSE 0 END) AS yes_votes,
      SUM(CASE WHEN vote_type = 'no' THEN 1 ELSE 0 END) AS no_votes
    FROM votes
    GROUP BY COALESCE(voter_id, 'ANON')
    ORDER BY (yes_votes + no_votes) DESC
  `;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    // add handy totals & percentages
    const enriched = rows.map(r => {
      const total = r.yes_votes + r.no_votes;
      const yes_pct = total ? ((r.yes_votes / total) * 100).toFixed(1) : 0;
      return { ...r, total, yes_pct };
    });
    res.json(enriched);
  });
});

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

// Versus votes by day (UTC)
app.get('/api/reports/versus-by-day', requireAdmin, (req, res) => {
  const sql = `
    SELECT DATE(created_at) AS day, COUNT(*) AS votes
    FROM versus_matches
    GROUP BY DATE(created_at)
    ORDER BY day
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
                    COALESCE(
                      (SELECT username FROM teams WHERE user_id = vm.voter_id LIMIT 1),
                      u.twitter_username
                    ) as voter_name,
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

                // Split into friends (high win rate) and foes (low win rate)
                statsRows.sort((a, b) => b.win_rate - a.win_rate);
                
                response.votingStats.friends = statsRows.slice(0, 5).map(r => ({
                  name: r.voter_name,
                  wins: r.wins,
                  losses: r.losses,
                  winRate: (r.win_rate * 100).toFixed(1)
                }));

                response.votingStats.foes = statsRows.slice(-5).reverse().map(r => ({
                  name: r.voter_name,
                  wins: r.wins,
                  losses: r.losses,
                  winRate: (r.win_rate * 100).toFixed(1)
                }));

                // === NEW: Fetch vote results for each of the user's teams ===
                const teamStatsSql = `
                  WITH team_stats AS (
                    SELECT
                      t.id,
                      t.tournament,
                      COALESCE((SELECT COUNT(*) FROM votes v WHERE v.team_id = t.id AND v.vote_type = 'yes'), 0) AS yes_votes,
                      COALESCE((SELECT COUNT(*) FROM votes v WHERE v.team_id = t.id AND v.vote_type = 'no'), 0) AS no_votes,
                      COALESCE((SELECT COUNT(*) FROM versus_matches vm WHERE vm.winner_id = t.id), 0) AS wins,
                      COALESCE((SELECT COUNT(*) FROM versus_matches vm WHERE vm.loser_id = t.id), 0) AS losses
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
                  res.json(response);
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
                    COALESCE((SELECT COUNT(*) FROM votes v WHERE v.team_id = t.id AND v.vote_type = 'yes'), 0) AS yes_votes,
                    COALESCE((SELECT COUNT(*) FROM votes v WHERE v.team_id = t.id AND v.vote_type = 'no'), 0) AS no_votes,
                    COALESCE((SELECT COUNT(*) FROM versus_matches vm WHERE vm.winner_id = t.id), 0) AS wins,
                    COALESCE((SELECT COUNT(*) FROM versus_matches vm WHERE vm.loser_id = t.id), 0) AS losses
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
                res.json(response);
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
                  COALESCE(
                    (SELECT username FROM teams WHERE user_id = vm.voter_id LIMIT 1),
                    u.twitter_username
                  ) as voter_name,
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

              statsRows.sort((a, b) => b.win_rate - a.win_rate);

              response.votingStats.friends = statsRows.slice(0, 5).map(r => ({
                name: r.voter_name,
                wins: r.wins,
                losses: r.losses,
                winRate: (r.win_rate * 100).toFixed(1)
              }));

              response.votingStats.foes = statsRows.slice(-5).reverse().map(r => ({
                name: r.voter_name,
                wins: r.wins,
                losses: r.losses,
                winRate: (r.win_rate * 100).toFixed(1)
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

// === NEW: Update username for a tournament's teams ===
app.post('/my/update-username', requireAuth, express.json(), (req, res) => {
  const { oldUsername, newUsername, tournament } = req.body;
  const userId = req.user.id;

  if (!oldUsername || !newUsername || !tournament) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Verify the new username is one they've used before
  db.get(
    'SELECT 1 FROM teams WHERE user_id = ? AND username = ?',
    [userId, newUsername],
    (err, exists) => {
      if (err) {
        console.error('DB error checking username:', err);
        return res.status(500).json({ error: 'DB error' });
      }

      if (!exists) {
        return res.status(400).json({ error: 'Username not found in your uploads' });
      }

      // Update all matching teams
      db.run(
        `UPDATE teams 
         SET username = ? 
         WHERE user_id = ? 
         AND username = ? 
         AND tournament = ?`,
        [newUsername, userId, oldUsername, tournament],
        function(err2) {
          if (err2) {
            console.error('DB error updating username:', err2);
            return res.status(500).json({ error: 'Failed to update username' });
          }

          res.json({ 
            message: 'Username updated successfully',
            rowsAffected: this.changes
          });
        }
      );
    }
  );
});

// === NEW: Update display name endpoint ===
app.post('/my/update-display-name', requireAuth, express.json(), (req, res) => {
  const { displayName } = req.body;
  const userId = req.user.id;

  // Validate display name
  if (displayName && displayName.length > 50) {
    return res.status(400).json({ error: 'Display name too long (max 50 characters)' });
  }

  // Update the display name
  db.run(
    'UPDATE users SET display_name = ? WHERE id = ?',
    [displayName || null, userId],
    function(err) {
      if (err) {
        console.error('DB error updating display name:', err);
        return res.status(500).json({ error: 'Failed to update display name' });
      }

      res.json({ 
        message: 'Display name updated successfully',
        displayName: displayName || null
      });
    }
  );
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

    const params = [teamId, teamId, teamId, teamId, teamId, teamId];

    db.all(sql, params, (err2, votes) => {
      if (err2) {
        console.error('DB error fetching votes:', err2);
        return res.status(500).json({ error: 'Database error' });
      }
      res.json({ votes: votes || [] });
    });
  });
});

// ✅ Updated to support Replit or local dev port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
