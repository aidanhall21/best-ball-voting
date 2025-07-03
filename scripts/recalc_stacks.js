// recalc_stacks.js – Re-evaluate RB/WR/TE stack flags for every team already in the DB
// Usage: node scripts/recalc_stacks.js
// 
// The algorithm mirrors the logic used when new CSV files are uploaded. It works in 3 passes
//   1. Clear any existing stack flags for every player.
//   2. For each QB on the roster mark it and any WR/TE/RB teammates (same NFL team)
//      as `primary`.
//   3. Among the remaining un-stacked receivers (WR/TE/RB), mark groups with two or
//      more players from the same NFL team as `secondary`.
//
// After running the script your existing teams will have identical stack behaviour to
// newly uploaded teams.

const db = require('../db');

// ---- New: wait up to 5s if the DB is temporarily locked ----
db.run('PRAGMA busy_timeout = 5000');

// Helper to perform one DB call and return a Promise
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function applyStacksToTeam(teamId) {
  const players = await all(
    `SELECT rowid, position, team FROM players WHERE team_id = ? ORDER BY pick`,
    [teamId]
  );

  // Pass 0 removed – stacks are cleared once globally before the loop

  // Identify QBs and receivers
  const qbs = players.filter((p) => p.position === 'QB');
  const receivers = players.filter((p) => ['WR', 'TE', 'RB'].includes(p.position));

  const primaryIds = new Set();
  const secondaryIds = new Set();

  // Pass 1: QB-centric primary stacks
  for (const qb of qbs) {
    const mates = receivers.filter((p) => p.team === qb.team);
    if (mates.length > 0) {
      primaryIds.add(qb.rowid);
      mates.forEach((m) => primaryIds.add(m.rowid));
    }
  }

  // Pass 2: secondary stacks among remaining receivers
  const remaining = receivers.filter((p) => !primaryIds.has(p.rowid));
  const groupedByTeam = {};
  for (const p of remaining) {
    if (!groupedByTeam[p.team]) groupedByTeam[p.team] = [];
    groupedByTeam[p.team].push(p);
  }
  Object.values(groupedByTeam).forEach((group) => {
    if (group.length > 1) {
      group.forEach((p) => secondaryIds.add(p.rowid));
    }
  });

  // Persist updates
  const updatePromises = [];
  primaryIds.forEach((id) => {
    updatePromises.push(run(`UPDATE players SET stack = 'primary' WHERE rowid = ?`, [id]));
  });
  secondaryIds.forEach((id) => {
    updatePromises.push(run(`UPDATE players SET stack = 'secondary' WHERE rowid = ?`, [id]));
  });

  await Promise.all(updatePromises);
}

async function main() {
  try {
    // Start one big write transaction for speed & atomicity
    await run('BEGIN IMMEDIATE TRANSACTION');

    // Clear all existing stack flags in one shot
    await run('UPDATE players SET stack = NULL');

    const teamRows = await all(`SELECT id FROM teams`);
    const total = teamRows.length;
    console.log(`Re-calculating stacks for ${total} teams…`);

    let processed = 0;
    const REPORT_EVERY = 500; // adjust as desired
    for (const { id } of teamRows) {
      await applyStacksToTeam(id);
      processed++;
      if (processed % REPORT_EVERY === 0 || processed === total) {
        const pct = ((processed / total) * 100).toFixed(1);
        console.log(` … ${processed}/${total} (${pct}%)`);
      }
    }

    await run('COMMIT');
    console.log('✅ All teams updated (transaction committed).');
    process.exit(0);
  } catch (err) {
    console.error('Failed to recalculate stacks:', err);
    try { await run('ROLLBACK'); } catch (_) {}
    process.exit(1);
  }
}

main(); 