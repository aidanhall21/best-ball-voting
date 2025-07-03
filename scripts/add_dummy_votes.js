const db = require('../db');

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

// Get a random item from an array
function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Generate random voting data
async function addDummyVotes() {
  try {
    // Get teams for user 1
    const user1Teams = await all('SELECT id FROM teams WHERE user_id = 1');
    if (!user1Teams.length) {
      console.error('No teams found for user 1');
      process.exit(1);
    }

    // Get some other teams to compete against
    const otherTeams = await all('SELECT id FROM teams WHERE user_id != 1 LIMIT 100');
    if (!otherTeams.length) {
      console.error('No other teams found to compete against');
      process.exit(1);
    }

    // Get some voter IDs (users who will be voting)
    const voters = await all('SELECT id FROM users WHERE id != 1 LIMIT 20');
    if (!voters.length) {
      console.error('No voters found');
      process.exit(1);
    }

    // Generate 100 random votes
    const votes = [];
    for (let i = 0; i < 100; i++) {
      const voter = randomChoice(voters);
      const user1Team = randomChoice(user1Teams);
      const otherTeam = randomChoice(otherTeams);
      
      // 50/50 chance if user1's team wins or loses
      const isWin = Math.random() < 0.5;
      
      votes.push({
        winner_id: isWin ? user1Team.id : otherTeam.id,
        loser_id: isWin ? otherTeam.id : user1Team.id,
        voter_id: voter.id,
        created_at: new Date().toISOString()
      });
    }

    // Insert all votes
    console.log('Adding dummy votes...');
    await run('BEGIN TRANSACTION');

    for (const vote of votes) {
      await run(
        'INSERT INTO versus_matches (winner_id, loser_id, voter_id, created_at) VALUES (?, ?, ?, ?)',
        [vote.winner_id, vote.loser_id, vote.voter_id, vote.created_at]
      );
    }

    await run('COMMIT');
    console.log('✅ Added 100 dummy votes');
    
    // Show some stats
    const stats = await all(`
      SELECT 
        u.id,
        COALESCE(u.display_name, u.twitter_username, u.email) as voter_name,
        COUNT(*) as total_votes,
        COUNT(CASE WHEN winner_id IN (SELECT id FROM teams WHERE user_id = 1) THEN 1 END) as wins_given
      FROM versus_matches vm
      JOIN users u ON vm.voter_id = u.id
      WHERE vm.winner_id IN (SELECT id FROM teams WHERE user_id = 1)
         OR vm.loser_id IN (SELECT id FROM teams WHERE user_id = 1)
      GROUP BY u.id
      ORDER BY wins_given DESC
    `);

    console.log('\nVoting stats for user 1:');
    console.log('------------------------');
    stats.forEach(row => {
      const winRate = ((row.wins_given / row.total_votes) * 100).toFixed(1);
      console.log(`${row.voter_name}: ${row.wins_given}/${row.total_votes} (${winRate}%)`);
    });

  } catch (err) {
    console.error('Error:', err);
    try { await run('ROLLBACK'); } catch (_) {}
    process.exit(1);
  }
}

// Run the script
addDummyVotes(); 