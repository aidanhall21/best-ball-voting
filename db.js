const sqlite3 = require("sqlite3").verbose();
const DB_PATH = process.env.DB_PATH || "./teams-2025-08-09-0917.db"; // allow override in prod
const ANALYTICS_DB_PATH = process.env.ANALYTICS_DB_PATH || "./analytics-2025-08-09-0813.db";
const db = new sqlite3.Database(DB_PATH);
const analyticsDb = new sqlite3.Database(ANALYTICS_DB_PATH);

// Enable Write-Ahead Logging for better concurrency
db.exec('PRAGMA journal_mode = WAL;');
analyticsDb.exec('PRAGMA journal_mode = WAL;');

// Create tables if not exist
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      tournament TEXT,
      username TEXT,
      draft_id TEXT,
      user_id INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS players (
      team_id TEXT,
      position TEXT,
      name TEXT,
      pick INTEGER,
      team TEXT,
      stack TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS votes (
      team_id TEXT,
      vote_type TEXT,
      voter_id TEXT NULL,
      PRIMARY KEY (team_id, voter_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS versus_matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      winner_id TEXT NOT NULL,
      loser_id TEXT NOT NULL,
      voter_id TEXT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (winner_id) REFERENCES teams (id),
      FOREIGN KEY (loser_id) REFERENCES teams (id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS elo_ratings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id TEXT NOT NULL,
      tournament TEXT,
      username TEXT,
      elo REAL NOT NULL,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (team_id) REFERENCES teams (id)
    )
  `);

  // (no single-row ratings table anymore; snapshots are stored in ratings_history)

  // Store the computed Bradley-Terry ratings and Madden-style overall ratings
  db.run(`
    CREATE TABLE IF NOT EXISTS ratings_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id TEXT NOT NULL,
      tournament TEXT,
      rating REAL,        -- Bradley-Terry rating (raw ability score)
      madden REAL,        -- Madden-style 10-99 overall rating (with decimals)
      wins INTEGER,
      losses INTEGER,
      computed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (team_id) REFERENCES teams(id)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_ratings_hist_team ON ratings_history(team_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_ratings_hist_tourn ON ratings_history(tournament)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_ratings_hist_time ON ratings_history(computed_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_ratings_history_team_time ON ratings_history(team_id, computed_at DESC)`);

  // Elo ratings indexes
  db.run(`CREATE INDEX IF NOT EXISTS idx_elo_ratings_team ON elo_ratings(team_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_elo_ratings_tournament ON elo_ratings(tournament)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_elo_ratings_created ON elo_ratings(created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_elo_ratings_team_time ON elo_ratings(team_id, created_at DESC)`);

  // Notifications table for when users receive notifications about their teams
  db.run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      related_team_id TEXT,
      related_user_id INTEGER,
      opponent_team_id TEXT,
      is_read BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (related_team_id) REFERENCES teams(id),
      FOREIGN KEY (related_user_id) REFERENCES users(id),
      FOREIGN KEY (opponent_team_id) REFERENCES teams(id)
    )
  `);

  // Matchup settings table for admin configuration
  db.run(`
    CREATE TABLE IF NOT EXISTS matchup_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      tournament TEXT,
      team1_stack TEXT,
      team2_stack TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Tournament nominations table for storing nominated teams
  db.run(`
    CREATE TABLE IF NOT EXISTS tournament_nominations (
      id TEXT NOT NULL,
      tournament TEXT NOT NULL,
      username TEXT NOT NULL,
      draft_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      nominated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id, tournament),
      FOREIGN KEY (id) REFERENCES teams(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Add new player columns if they don't exist
  db.run(`ALTER TABLE matchup_settings ADD COLUMN team1_player TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Error adding team1_player column:', err);
    }
  });

  db.run(`ALTER TABLE matchup_settings ADD COLUMN team2_player TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Error adding team2_player column:', err);
    }
  });

  // Add new strategy type columns if they don't exist
  db.run(`ALTER TABLE matchup_settings ADD COLUMN team1_strategy TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Error adding team1_strategy column:', err);
    }
  });

  db.run(`ALTER TABLE matchup_settings ADD COLUMN team2_strategy TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Error adding team2_strategy column:', err);
    }
  });

  // ---- Indexes for performance ----
  db.run(`CREATE INDEX IF NOT EXISTS idx_votes_team_type ON votes(team_id, vote_type)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_players_team ON players(team_id)`);
  
  // Versus matches indexes for widget performance
  db.run(`CREATE INDEX IF NOT EXISTS idx_versus_winner ON versus_matches(winner_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_versus_loser ON versus_matches(loser_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_versus_matches_created_at ON versus_matches(created_at DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_versus_matches_voter ON versus_matches(voter_id)`);
  
  // Teams indexes for faster lookups
  db.run(`CREATE INDEX IF NOT EXISTS idx_teams_user_id ON teams(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_teams_username ON teams(username)`);
  
  // User indexes
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_twitter ON users(twitter_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_display_name ON users(display_name)`);
  
  // Notification indexes
  db.run(`CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, is_read)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at)`);
  
  // Tournament nominations indexes
  db.run(`CREATE INDEX IF NOT EXISTS idx_nominations_user ON tournament_nominations(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_nominations_tournament ON tournament_nominations(tournament)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_nominations_user_tournament ON tournament_nominations(user_id, tournament)`);

  // Tournament system tables
  db.run(`
    CREATE TABLE IF NOT EXISTS tournaments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      start_date DATETIME,
      end_date DATETIME,
      status TEXT DEFAULT 'setup',
      bracket_type TEXT DEFAULT 'single_elimination',
      source_contest TEXT,
      max_teams INTEGER,
      max_teams_per_user INTEGER DEFAULT 1,
      scheduled_start_time DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tournament_matchups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id TEXT NOT NULL,
      round_number INTEGER NOT NULL,
      bracket_position INTEGER NOT NULL,
      team1_id TEXT,
      team2_id TEXT,
      winner_id TEXT,
      status TEXT DEFAULT 'pending',
      votes_needed INTEGER DEFAULT 4,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      parent_matchup_id INTEGER,
      parent_position INTEGER,
      FOREIGN KEY (tournament_id) REFERENCES tournaments(id),
      FOREIGN KEY (team1_id) REFERENCES teams(id),
      FOREIGN KEY (team2_id) REFERENCES teams(id),
      FOREIGN KEY (winner_id) REFERENCES teams(id),
      FOREIGN KEY (parent_matchup_id) REFERENCES tournament_matchups(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tournament_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      matchup_id INTEGER NOT NULL,
      team_id TEXT NOT NULL,
      voter_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (matchup_id) REFERENCES tournament_matchups(id),
      FOREIGN KEY (team_id) REFERENCES teams(id),
      UNIQUE(matchup_id, voter_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tournament_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      final_position INTEGER,
      rounds_won INTEGER DEFAULT 0,
      total_votes_received INTEGER DEFAULT 0,
      total_votes_against INTEGER DEFAULT 0,
      elimination_round INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (tournament_id) REFERENCES tournaments(id),
      FOREIGN KEY (team_id) REFERENCES teams(id)
    )
  `);

  // Tournament indexes
  db.run(`CREATE INDEX IF NOT EXISTS idx_tournament_matchups_tournament ON tournament_matchups(tournament_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_tournament_matchups_round ON tournament_matchups(tournament_id, round_number)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_tournament_matchups_status ON tournament_matchups(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_tournament_votes_matchup ON tournament_votes(matchup_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_tournament_votes_team ON tournament_votes(team_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_tournament_results_tournament ON tournament_results(tournament_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_tournament_results_position ON tournament_results(tournament_id, final_position)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      password_hash TEXT,
      twitter_id TEXT UNIQUE,
      display_name TEXT,
      twitter_username TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS password_resets (
      token TEXT PRIMARY KEY,
      user_id INTEGER,
      expires_at INTEGER
    )
  `);
});

// Create analytics tables in separate database
analyticsDb.serialize(() => {
  analyticsDb.run(`
    CREATE TABLE IF NOT EXISTS page_time (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visitor_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      user_id INTEGER NULL,
      page TEXT,
      duration_ms INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ---- Analytics indexes ----
  analyticsDb.run(`CREATE INDEX IF NOT EXISTS idx_page_time_created ON page_time(created_at)`);
  analyticsDb.run(`CREATE INDEX IF NOT EXISTS idx_page_time_visitor ON page_time(visitor_id)`);
  analyticsDb.run(`CREATE INDEX IF NOT EXISTS idx_page_time_session ON page_time(session_id)`);
  analyticsDb.run(`CREATE INDEX IF NOT EXISTS idx_page_time_user ON page_time(user_id)`);
});

// If the teams table was created in an older version without the username or draft_id columns,
// add them now. SQLite doesn't support IF NOT EXISTS for ALTER TABLE, so we
// inspect the existing schema first.
db.all('PRAGMA table_info(teams)', (err, cols) => {
  if (err) return; // silent fail – app still works, just without new columns
  const hasUsername = cols.some((c) => c.name === 'username');
  const hasDraftId = cols.some((c) => c.name === 'draft_id');
  const hasUserId = cols.some((c) => c.name === 'user_id');
  const hasFileName = cols.some((c) => c.name === 'file_name');
  
  if (!hasUsername) {
    db.run('ALTER TABLE teams ADD COLUMN username TEXT');
  }
  if (!hasDraftId) {
    db.run('ALTER TABLE teams ADD COLUMN draft_id TEXT');
  }
  if (!hasUserId) {
    db.run('ALTER TABLE teams ADD COLUMN user_id INTEGER');
  }
  if (!hasFileName) {
    db.run('ALTER TABLE teams ADD COLUMN file_name TEXT');
  }
  // Add any new optional metadata columns for teams (added July 2025)
  const extraTeamCols = {
    draft_entry_fee: 'TEXT',
    draft_size: 'INTEGER',
    draft_total_prizes: 'TEXT',
    tournament_id: 'TEXT',
    tournament_entry_fee: 'TEXT',
    tournament_total_prizes: 'TEXT',
    tournament_size: 'INTEGER',
    draft_pool_title: 'TEXT',
    draft_pool: 'TEXT',
    draft_pool_entry_fee: 'TEXT',
    draft_pool_total_prizes: 'TEXT',
    draft_pool_size: 'INTEGER',
    weekly_winner_title: 'TEXT',
    weekly_winner: 'TEXT',
    weekly_winner_entry_fee: 'TEXT',
    weekly_winner_total_prizes: 'TEXT',
    weekly_winner_size: 'INTEGER',
    elite_te: 'INTEGER DEFAULT 0',
    zero_rb: 'INTEGER DEFAULT 0', 
    elite_qb: 'INTEGER DEFAULT 0',
    high_t: 'INTEGER DEFAULT 0',
    hero_rb: 'INTEGER DEFAULT 0'
  };
  Object.entries(extraTeamCols).forEach(([col, type]) => {
    if (!cols.some(c => c.name === col)) {
      db.run(`ALTER TABLE teams ADD COLUMN ${col} ${type}`);
    }
  });
});

// Check if players table has team column and add it if missing
db.all('PRAGMA table_info(players)', (err, cols) => {
  if (err) return; // silent fail
  const hasTeam = cols.some((c) => c.name === 'team');
  const hasStack = cols.some((c) => c.name === 'stack');
  if (!hasTeam) {
    db.run('ALTER TABLE players ADD COLUMN team TEXT');
  }
  if (!hasStack) {
    db.run('ALTER TABLE players ADD COLUMN stack TEXT');
  }
  // Ensure new player-level metadata columns exist
  const extraPlayerCols = {
    picked_at: 'TEXT',
    appearance: 'TEXT'
  };
  Object.entries(extraPlayerCols).forEach(([col, type]) => {
    if (!cols.some(c => c.name === col)) {
      db.run(`ALTER TABLE players ADD COLUMN ${col} ${type}`);
    }
  });
});

// ---- Ensure twitter_username column exists in users table ----
db.all('PRAGMA table_info(users)', (err, cols) => {
  if (err) return; // silent fail – app still works without the new column
  const hasTwitterUsername = cols.some((c) => c.name === 'twitter_username');
  if (!hasTwitterUsername) {
    db.run('ALTER TABLE users ADD COLUMN twitter_username TEXT');
  }
  db.run('CREATE INDEX IF NOT EXISTS idx_users_twitter_username ON users(twitter_username)');
  
  // Add unique constraint on display_name (case-insensitive)
  // First, check if there are existing duplicates and handle them
  db.get("SELECT COUNT(*) as count FROM users WHERE display_name IS NOT NULL", (err, result) => {
    if (err) return;
    
    if (result.count > 0) {
      // Check for duplicates and resolve them before adding constraint
      db.all(`
        SELECT display_name, COUNT(*) as count, GROUP_CONCAT(id) as ids 
        FROM users 
        WHERE display_name IS NOT NULL 
        GROUP BY display_name COLLATE NOCASE 
        HAVING count > 1
      `, (err, duplicates) => {
        if (err) return;
        
        if (duplicates.length > 0) {
          
          // For each set of duplicates, append numbers to make them unique
          duplicates.forEach(dup => {
            const ids = dup.ids.split(',');
            ids.forEach((id, index) => {
              if (index > 0) { // Keep first one as-is, modify others
                const newName = `${dup.display_name}${index + 1}`;
                db.run('UPDATE users SET display_name = ? WHERE id = ?', [newName, id]);
              }
            });
          });
        }
        
        // After resolving duplicates, add the unique constraint
        setTimeout(() => {
          db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_display_name_unique ON users(display_name COLLATE NOCASE)');
        }, 100);
      });
    } else {
      // No existing data, safe to add constraint immediately
      db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_display_name_unique ON users(display_name COLLATE NOCASE)');
    }
  });
});

// ---- Ensure opponent_team_id column exists in notifications table ----
db.all('PRAGMA table_info(notifications)', (err, cols) => {
  if (err) return; // silent fail
  const hasOpponentTeamId = cols.some((c) => c.name === 'opponent_team_id');
  if (!hasOpponentTeamId) {
    db.run('ALTER TABLE notifications ADD COLUMN opponent_team_id TEXT');
  }
});

// ---- Ensure new tournament columns exist ----
db.all('PRAGMA table_info(tournaments)', (err, cols) => {
  if (err) return; // silent fail
  const extraTournamentCols = {
    source_contest: 'TEXT',
    max_teams: 'INTEGER',
    max_teams_per_user: 'INTEGER DEFAULT 1',
    scheduled_start_time: 'DATETIME'
  };
  Object.entries(extraTournamentCols).forEach(([col, type]) => {
    if (!cols.some(c => c.name === col)) {
      db.run(`ALTER TABLE tournaments ADD COLUMN ${col} ${type}`);
    }
  });
});

module.exports = { db, analyticsDb };
