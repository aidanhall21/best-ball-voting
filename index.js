const express = require("express");
const app = express();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const Papa = require("papaparse");
const db = require("./db");
const crypto = require("crypto");

const upload = multer({ dest: "uploads/" });
app.use(express.static(__dirname));
app.use(express.json());

// Middleware to identify user (basic fingerprint via cookie or IP)
app.use((req, res, next) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  req.voterId = ip || crypto.randomUUID();
  next();
});

// Simple in-memory rate limiter for votes: max 10 per 10-second window per voter
const voteHistory = new Map(); // voterId -> [timestamps]
function voteRateLimiter(req, res, next) {
  const id = req.voterId;
  const now = Date.now();
  const WINDOW_MS = 10 * 1000; // 10 seconds
  const MAX_VOTES = 10;

  let arr = voteHistory.get(id) || [];
  // Keep only timestamps within the window
  arr = arr.filter(ts => now - ts < WINDOW_MS);
  if (arr.length >= MAX_VOTES) {
    return res.status(429).json({ error: "Rate limit exceeded: max 10 votes per 10 seconds" });
  }
  arr.push(now);
  voteHistory.set(id, arr);
  next();
}

// Home page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Handle CSV Upload
app.post("/upload", upload.single("csv"), (req, res) => {
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
      
      // Check for required columns
      const requiredColumns = [
        "Draft Entry",
        "Tournament Title",
        "First Name",
        "Last Name",
        "Position",
        "Pick Number",
        "Draft"
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

          // Now process only non-existing teams
          rows.forEach((row) => {
            const teamId = row["Draft Entry"];
            const tournament = row["Tournament Title"];
            const fullName = `${row["First Name"]} ${row["Last Name"]}`;
            const position = row["Position"];
            const pick = parseInt(row["Pick Number"]);
            const draftId = row["Draft"];

            if (!teamId || !fullName || !position || isNaN(pick)) return;
            if (existingTeamIds.has(teamId)) return; // Skip if team already exists

            if (!groupedTeams[teamId]) {
              groupedTeams[teamId] = {
                tournament,
                players: [],
                draftId
              };
            }

            groupedTeams[teamId].players.push({ position, name: fullName, pick });
          });

          // Only proceed with insert if we have new teams
          if (Object.keys(groupedTeams).length === 0) {
            return res.json({ message: "No new teams to add" });
          }

          db.serialize(() => {
            for (const [teamId, data] of Object.entries(groupedTeams)) {
              db.run(
                `INSERT OR IGNORE INTO teams (id, tournament, username, draft_id) VALUES (?, ?, ?, ?)`,
                [teamId, data.tournament, uploaderUsername, data.draftId]
              );

              data.players.forEach((player) => {
                db.run(
                  `INSERT INTO players (team_id, position, name, pick) VALUES (?, ?, ?, ?)`,
                  [teamId, player.position, player.name, player.pick]
                );
              });
            }
            res.json({ message: "Teams uploaded successfully" });
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

// GET all teams from DB
app.get("/teams", (req, res) => {
  const sql = `
    SELECT t.id as team_id, t.tournament, t.username, p.position, p.name, p.pick
    FROM teams t
    JOIN players p ON p.team_id = t.id
  `;

  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: "DB error" });

    const teams = {};
    const tournaments = {};

    rows.forEach((row) => {
      if (!teams[row.team_id]) {
        teams[row.team_id] = [];
        tournaments[row.team_id] = row.tournament;
      }
      teams[row.team_id].push({
        position: row.position,
        name: row.name,
        pick: row.pick,
      });
    });

    res.json({ teams: Object.entries(teams), tournaments });
  });
});

// POST vote for a team
app.post("/vote", voteRateLimiter, (req, res) => {
  const { teamId, voteType } = req.body;
  const voterId = req.voterId;

  if (!["yes", "no"].includes(voteType)) {
    return res.status(400).json({ error: "Invalid vote type" });
  }

  db.get(
    `SELECT vote_type FROM votes WHERE team_id = ? AND voter_id = ?`,
    [teamId, voterId],
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
          `UPDATE votes SET vote_type = ? WHERE team_id = ? AND voter_id = ?`,
          [voteType, teamId, voterId],
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
  const voterId = req.voterId;

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
  const teamId = req.params.teamId;
  
  db.all(
    `SELECT 
      (SELECT COUNT(*) FROM versus_matches WHERE winner_id = ?) as wins,
      (SELECT COUNT(*) FROM versus_matches WHERE loser_id = ?) as losses
    `,
    [teamId, teamId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "Failed to get versus stats" });
      const stats = rows[0] || { wins: 0, losses: 0 };
      const total = stats.wins + stats.losses;
      const winRate = total ? ((stats.wins / total) * 100).toFixed(1) : 0;
      res.json({ ...stats, winRate });
    }
  );
});

// Leaderboard endpoint (team)
app.get("/leaderboard", (req, res) => {
  const sql = `
    SELECT
      t.id,
      t.username,
      COALESCE((SELECT COUNT(*) FROM votes v WHERE v.team_id = t.id AND v.vote_type = 'yes'), 0) AS yes_votes,
      COALESCE((SELECT COUNT(*) FROM votes v WHERE v.team_id = t.id AND v.vote_type = 'no'), 0) AS no_votes,
      COALESCE((SELECT COUNT(*) FROM versus_matches vm WHERE vm.winner_id = t.id), 0) AS wins,
      COALESCE((SELECT COUNT(*) FROM versus_matches vm WHERE vm.loser_id = t.id), 0) AS losses
    FROM teams t
  `;
  db.all(sql, [], (err, rows) => {
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
  const sql = `
    SELECT
      t.id,
      t.username,
      COALESCE((SELECT COUNT(*) FROM votes v WHERE v.team_id = t.id AND v.vote_type = 'yes'), 0) AS yes_votes,
      COALESCE((SELECT COUNT(*) FROM votes v WHERE v.team_id = t.id AND v.vote_type = 'no'), 0) AS no_votes,
      COALESCE((SELECT COUNT(*) FROM versus_matches vm WHERE vm.winner_id = t.id), 0) AS wins,
      COALESCE((SELECT COUNT(*) FROM versus_matches vm WHERE vm.loser_id = t.id), 0) AS losses
    FROM teams t
  `;
  db.all(sql, [], (err, rows) => {
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

// Single team detail
app.get('/team/:id', (req, res) => {
  const teamId = req.params.id;
  db.all(`SELECT position, name, pick FROM players WHERE team_id = ?`, [teamId], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows);
  });
});

// ✅ Updated to support Replit or local dev port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
