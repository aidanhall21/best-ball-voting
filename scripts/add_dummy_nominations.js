const { db } = require('../db');

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

// Generate random tournament nominations
async function addDummyNominations() {
  try {
    console.log('🔍 Checking existing data...');
    
    // Get teams for "The Puppy" tournament
    const teams = await all(`
      SELECT id, tournament, username, draft_id, user_id 
      FROM teams 
      WHERE tournament = 'The Puppy'
      ORDER BY RANDOM()
      LIMIT 300
    `);
    
    if (!teams.length) {
      console.error('❌ No teams found for "The Puppy" tournament');
      console.log('💡 Make sure you have teams uploaded for this tournament first');
      process.exit(1);
    }

    // Get existing nominations count
    const existingCount = await all(`
      SELECT COUNT(*) as count 
      FROM tournament_nominations 
      WHERE tournament = 'The Puppy'
    `);
    
    const currentCount = existingCount[0].count;
    console.log(`📊 Current nominations: ${currentCount}/256`);
    
    if (currentCount >= 256) {
      console.log('✅ Tournament is already full (256 nominations)');
      return;
    }
    
    const targetCount = 254; // Add 254 to reach 256 total
    const toAdd = Math.min(targetCount, 256 - currentCount);
    
    console.log(`🎯 Adding ${toAdd} dummy nominations...`);
    
    // Generate nominations
    const nominations = [];
    const usedTeamIds = new Set();
    
    // Get existing nominated team IDs to avoid duplicates
    const existingNominations = await all(`
      SELECT id FROM tournament_nominations 
      WHERE tournament = 'The Puppy'
    `);
    existingNominations.forEach(n => usedTeamIds.add(n.id));
    
    // Track nominations per username to enforce 5 team limit
    const nominationsPerUsername = new Map();
    
    // Initialize with existing nominations
    const existingNominationsByUser = await all(`
      SELECT username, COUNT(*) as count 
      FROM tournament_nominations 
      WHERE tournament = 'The Puppy'
      GROUP BY username
    `);
    existingNominationsByUser.forEach(row => {
      nominationsPerUsername.set(row.username, row.count);
    });
    
    for (let i = 0; i < toAdd; i++) {
      // Find a team that hasn't been nominated yet and user hasn't reached 5 team limit
      let team;
      for (const t of teams) {
        if (!usedTeamIds.has(t.id)) {
          const currentUserNominations = nominationsPerUsername.get(t.username) || 0;
          if (currentUserNominations < 5) {
            team = t;
            usedTeamIds.add(t.id);
            nominationsPerUsername.set(t.username, currentUserNominations + 1);
            break;
          }
        }
      }
      
      if (!team) {
        console.log(`⚠️  Only ${i} nominations added (no more available teams)`);
        break;
      }
      
      nominations.push({
        id: team.id,
        tournament: 'The Puppy',
        username: team.username,
        draft_id: team.draft_id,
        user_id: team.user_id,
        nominated_at: new Date().toISOString()
      });
    }

    if (!nominations.length) {
      console.log('❌ No nominations to add (all teams already nominated)');
      return;
    }

    // Insert all nominations
    console.log('💾 Inserting nominations...');
    await run('BEGIN TRANSACTION');

    for (const nomination of nominations) {
      await run(
        'INSERT INTO tournament_nominations (id, tournament, username, draft_id, user_id, nominated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [nomination.id, nomination.tournament, nomination.username, nomination.draft_id, nomination.user_id, nomination.nominated_at]
      );
    }

    await run('COMMIT');
    console.log(`✅ Added ${nominations.length} dummy nominations`);
    
    // Show final stats
    const finalStats = await all(`
      SELECT 
        COUNT(*) as total_nominations,
        COUNT(DISTINCT user_id) as unique_users,
        COUNT(DISTINCT username) as unique_usernames
      FROM tournament_nominations 
      WHERE tournament = 'The Puppy'
    `);
    
    const stats = finalStats[0];
    console.log('\n📈 Final Tournament Stats:');
    console.log('---------------------------');
    console.log(`Total nominations: ${stats.total_nominations}/256`);
    console.log(`Unique users: ${stats.unique_users}`);
    console.log(`Unique usernames: ${stats.unique_usernames}`);
    
    // Show top users by nominations
    const topUsers = await all(`
      SELECT 
        username,
        COUNT(*) as nominations
      FROM tournament_nominations 
      WHERE tournament = 'The Puppy'
      GROUP BY username
      ORDER BY nominations DESC
      LIMIT 10
    `);
    
    console.log('\n🏆 Top Users by Nominations:');
    console.log('----------------------------');
    topUsers.forEach((user, index) => {
      console.log(`${index + 1}. ${user.username}: ${user.nominations} nominations`);
    });
    
    // Show distribution of teams per user
    const teamsPerUserDistribution = await all(`
      SELECT 
        nominations,
        COUNT(*) as user_count
      FROM (
        SELECT username, COUNT(*) as nominations
        FROM tournament_nominations 
        WHERE tournament = 'The Puppy'
        GROUP BY username
      )
      GROUP BY nominations
      ORDER BY nominations
    `);
    
    console.log('\n📊 Teams per User Distribution:');
    console.log('--------------------------------');
    teamsPerUserDistribution.forEach(row => {
      console.log(`${row.nominations} teams: ${row.user_count} users`);
    });
    
  } catch (err) {
    console.error('❌ Error adding dummy nominations:', err);
    process.exit(1);
  }
}

// Run the script
addDummyNominations().then(() => {
  console.log('\n🎉 Script completed successfully!');
  process.exit(0);
}).catch(err => {
  console.error('💥 Script failed:', err);
  process.exit(1);
}); 