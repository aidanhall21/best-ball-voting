#!/usr/bin/env node
/*
 Import the Eliminator CSV into the SQLite database.

 Usage:
   DB_PATH=/var/data/teams.db node scripts/import_eliminator_csv.js /path/to/the_eliminator_rd2.csv [--drop]

 Notes:
 - Creates table eliminator_rd2 if it does not exist.
 - Optional --drop will drop and recreate the table before import.
 - Streams the CSV and inserts in a single transaction for speed.
 - Adds helpful indexes after import.
*/

const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '..', 'teams-2025-08-15-1533.db');
const csvPath = process.argv[2];
const shouldDrop = process.argv.includes('--drop');

if (!csvPath) {
  console.error('Usage: DB_PATH=/var/data/teams.db node scripts/import_eliminator_csv.js /path/to/the_eliminator_rd2.csv [--drop]');
  process.exit(1);
}

if (!fs.existsSync(csvPath)) {
  console.error(`CSV not found: ${csvPath}`);
  process.exit(1);
}

const db = new sqlite3.Database(DB_PATH);

const COLUMNS = [
  'draft_id',
  'user_id',
  'username',
  'draft_created_time',
  'draft_filled_time',
  'draft_time',
  'draft_completed_time',
  'draft_clock',
  'draft_entry_id',
  'tournament_entry_id',
  'tournament_round_draft_entry_id',
  'tournament_round_number',
  'player_name',
  'player_id',
  'position_name',
  'projection_adp',
  'source',
  'pick_order',
  'overall_pick_number',
  'team_pick_number',
  'pick_created_time',
  'pick_points',
  'roster_points',
  'made_playoffs'
];

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS eliminator_rd2 (
  draft_id TEXT,
  user_id TEXT,
  username TEXT,
  draft_created_time TEXT,
  draft_filled_time TEXT,
  draft_time TEXT,
  draft_completed_time TEXT,
  draft_clock TEXT,
  draft_entry_id TEXT,
  tournament_entry_id TEXT,
  tournament_round_draft_entry_id TEXT,
  tournament_round_number TEXT,
  player_name TEXT,
  player_id TEXT,
  position_name TEXT,
  projection_adp TEXT,
  source TEXT,
  pick_order TEXT,
  overall_pick_number TEXT,
  team_pick_number TEXT,
  pick_created_time TEXT,
  pick_points TEXT,
  roster_points TEXT,
  made_playoffs TEXT
);
`;

const INDEX_SQL = [
  `CREATE INDEX IF NOT EXISTS idx_elim_rd2_draft ON eliminator_rd2(draft_id)`,
  `CREATE INDEX IF NOT EXISTS idx_elim_rd2_draft_entry ON eliminator_rd2(draft_id, draft_entry_id)`,
  `CREATE INDEX IF NOT EXISTS idx_elim_rd2_pick_order ON eliminator_rd2(draft_id, draft_entry_id, team_pick_number, overall_pick_number)`
];

async function run() {
  console.log(`Using DB: ${DB_PATH}`);
  console.log(`Importing CSV: ${csvPath}`);

  await exec(`PRAGMA journal_mode = WAL`);
  await exec(`PRAGMA synchronous = NORMAL`);
  await exec(`PRAGMA temp_store = MEMORY`);
  await exec(`PRAGMA cache_size = -50000`); // ~50MB page cache

  if (shouldDrop) {
    console.log('Dropping existing table eliminator_rd2 (if exists)...');
    await exec(`DROP TABLE IF EXISTS eliminator_rd2`);
  }

  await exec(CREATE_SQL);

  // Prepare insert
  const placeholders = COLUMNS.map(() => '?').join(',');
  const insertSql = `INSERT INTO eliminator_rd2 (${COLUMNS.join(',')}) VALUES (${placeholders})`;

  await exec('BEGIN');

  const insertStmt = await prepare(insertSql);

  let rowCount = 0;
  let t0 = Date.now();

  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(csvPath);
    Papa.parse(stream, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false, // keep as strings
      chunkSize: 1024 * 1024, // 1MB chunks
      step: (results, parser) => {
        const row = results.data;
        // Map values in canonical column order; default to null for missing fields
        const values = COLUMNS.map((col) => (row[col] === undefined || row[col] === '' ? null : String(row[col])));
        insertStmt.run(values, (err) => {
          if (err) {
            parser.abort();
            reject(err);
            return;
          }
        });
        rowCount++;
        if (rowCount % 10000 === 0) {
          const dt = ((Date.now() - t0) / 1000).toFixed(1);
          console.log(`Inserted ${rowCount.toLocaleString()} rows in ${dt}s`);
        }
      },
      complete: async () => {
        try {
          insertStmt.finalize();
          await exec('COMMIT');
          console.log(`Import complete. Rows inserted: ${rowCount.toLocaleString()}`);
          console.log('Creating indexes...');
          for (const sql of INDEX_SQL) {
            await exec(sql);
          }
          console.log('All indexes created.');
          resolve();
        } catch (e) {
          reject(e);
        }
      },
      error: (err) => reject(err)
    });
  });

  db.close();
}

function exec(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err){
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function prepare(sql) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare(sql, (err) => {
      if (err) return reject(err);
      resolve(stmt);
    });
  });
}

run().catch(err => {
  console.error('Import failed:', err);
  try { db.run('ROLLBACK'); } catch (_) {}
  process.exit(1);
});

