const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Connect to the database
const dbPath = path.join(__dirname, '..', 'teams-2025-08-07-1252.db');
const db = new sqlite3.Database(dbPath);

// Function to add 3 dummy votes for each team in each round 1 matchup
function addDummyTournamentVotes() {
    console.log('Adding 3 dummy tournament votes for each team in each matchup...');
    
    // Get all round 1 matchups for the tournament
    const query = `
        SELECT id, team1_id, team2_id 
        FROM tournament_matchups 
        WHERE tournament_id = 1 
        AND round_number = 1 
        AND status = 'active'
        ORDER BY bracket_position
    `;
    
    db.all(query, [], (err, matchups) => {
        if (err) {
            console.error('Error fetching round 1 matchups:', err);
            db.close();
            return;
        }
        
        console.log(`Found ${matchups.length} round 1 matchups`);
        
        let completed = 0;
        const totalVotes = matchups.length * 6; // 3 votes per team, 2 teams per matchup
        let voterIdCounter = 1; // Start with voter_id 1
        
        matchups.forEach((matchup, matchupIndex) => {
            console.log(`\nProcessing matchup ${matchup.id}:`);
            
            // Add 3 votes for team1
            for (let i = 0; i < 3; i++) {
                const insertQuery = `
                    INSERT OR REPLACE INTO tournament_votes (matchup_id, team_id, voter_id, created_at)
                    VALUES (?, ?, ?, datetime('now', '-' || ? || ' minutes'))
                `;
                
                // Add some time variation to the votes (0-60 minutes ago)
                const timeOffset = Math.floor(Math.random() * 60);
                
                db.run(insertQuery, [matchup.id, matchup.team1_id, voterIdCounter, timeOffset], function(err) {
                    if (err) {
                        console.error(`Error inserting vote for matchup ${matchup.id}, team1, voter ${voterIdCounter}:`, err);
                    } else {
                        console.log(`  Added vote for team1 (${matchup.team1_id}) from voter ${voterIdCounter}`);
                    }
                    
                    completed++;
                    if (completed === totalVotes) {
                        console.log('\nAll dummy votes added successfully!');
                        showVoteSummary();
                    }
                });
                
                voterIdCounter++;
            }
            
            // Add 3 votes for team2
            for (let i = 0; i < 3; i++) {
                const insertQuery = `
                    INSERT OR REPLACE INTO tournament_votes (matchup_id, team_id, voter_id, created_at)
                    VALUES (?, ?, ?, datetime('now', '-' || ? || ' minutes'))
                `;
                
                // Add some time variation to the votes (0-60 minutes ago)
                const timeOffset = Math.floor(Math.random() * 60);
                
                db.run(insertQuery, [matchup.id, matchup.team2_id, voterIdCounter, timeOffset], function(err) {
                    if (err) {
                        console.error(`Error inserting vote for matchup ${matchup.id}, team2, voter ${voterIdCounter}:`, err);
                    } else {
                        console.log(`  Added vote for team2 (${matchup.team2_id}) from voter ${voterIdCounter}`);
                    }
                    
                    completed++;
                    if (completed === totalVotes) {
                        console.log('\nAll dummy votes added successfully!');
                        showVoteSummary();
                    }
                });
                
                voterIdCounter++;
            }
        });
    });
}

// Function to show vote summary
function showVoteSummary() {
    console.log('\n' + '='.repeat(50));
    console.log('VOTE SUMMARY');
    console.log('='.repeat(50));
    
    // Get vote counts per matchup
    const summaryQuery = `
        SELECT 
            tm.id as matchup_id,
            tm.bracket_position,
            t1.username as team1_name,
            t2.username as team2_name,
            (SELECT COUNT(*) FROM tournament_votes tv WHERE tv.matchup_id = tm.id AND tv.team_id = tm.team1_id) as team1_votes,
            (SELECT COUNT(*) FROM tournament_votes tv WHERE tv.matchup_id = tm.id AND tv.team_id = tm.team2_id) as team2_votes,
            (SELECT COUNT(*) FROM tournament_votes tv WHERE tv.matchup_id = tm.id) as total_votes
        FROM tournament_matchups tm
        LEFT JOIN teams t1 ON tm.team1_id = t1.id
        LEFT JOIN teams t2 ON tm.team2_id = t2.id
        WHERE tm.tournament_id = 1 
        AND tm.round_number = 1
        ORDER BY tm.bracket_position
    `;
    
    db.all(summaryQuery, [], (err, matchups) => {
        if (err) {
            console.error('Error fetching vote summary:', err);
        } else {
            matchups.forEach(matchup => {
                console.log(`\nMatchup ${matchup.matchup_id} (Position ${matchup.bracket_position}):`);
                console.log(`  ${matchup.team1_name}: ${matchup.team1_votes} votes`);
                console.log(`  ${matchup.team2_name}: ${matchup.team2_votes} votes`);
                console.log(`  Total: ${matchup.total_votes} votes`);
                
                // Check if any team has won (4 or more votes)
                if (matchup.team1_votes >= 4) {
                    console.log(`  🏆 WINNER: ${matchup.team1_name}!`);
                } else if (matchup.team2_votes >= 4) {
                    console.log(`  🏆 WINNER: ${matchup.team2_name}!`);
                } else {
                    console.log(`  ⚖️  Tied at 3-3`);
                }
            });
            
            console.log('\n' + '='.repeat(50));
            console.log('Summary complete!');
        }
        db.close();
    });
}

// Run the script
addDummyTournamentVotes(); 