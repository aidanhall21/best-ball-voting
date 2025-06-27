const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("./teams.db");

// Enable Write-Ahead Logging for better concurrency
db.exec('PRAGMA journal_mode = WAL;');

// Create tables if not exist
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      tournament TEXT,
      username TEXT,
      draft_id TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS players (
      team_id TEXT,
      position TEXT,
      name TEXT,
      pick INTEGER
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS votes (
      team_id TEXT,
      vote_type TEXT,
      voter_id TEXT,
      PRIMARY KEY (team_id, voter_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS versus_matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      winner_id TEXT NOT NULL,
      loser_id TEXT NOT NULL,
      voter_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (winner_id) REFERENCES teams (id),
      FOREIGN KEY (loser_id) REFERENCES teams (id)
    )
  `);

  // ---- Indexes for performance ----
  db.run(`CREATE INDEX IF NOT EXISTS idx_votes_team_type ON votes(team_id, vote_type)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_players_team ON players(team_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_versus_winner ON versus_matches(winner_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_versus_loser ON versus_matches(loser_id)`);
});

// If the teams table was created in an older version without the username or draft_id columns,
// add them now. SQLite doesn't support IF NOT EXISTS for ALTER TABLE, so we
// inspect the existing schema first.
db.all('PRAGMA table_info(teams)', (err, cols) => {
  if (err) return; // silent fail – app still works, just without new columns
  const hasUsername = cols.some((c) => c.name === 'username');
  const hasDraftId = cols.some((c) => c.name === 'draft_id');
  
  if (!hasUsername) {
    db.run('ALTER TABLE teams ADD COLUMN username TEXT');
  }
  if (!hasDraftId) {
    db.run('ALTER TABLE teams ADD COLUMN draft_id TEXT');
  }
});

module.exports = db;
