const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Connect to the database
const dbPath = path.join(__dirname, '..', 'teams-2025-08-04-0920.db');
const db = new sqlite3.Database(dbPath);

// Function to add dummy votes for user_id 1 for all round 1 matchups
function addDummyTournamentVotes() {
    console.log('Adding dummy tournament votes for user_id 1...');
    
    // Get all round 1 matchups for the tournament
    const query = `
        SELECT id, team1_id, team2_id 
        FROM tournament_matchups 
        WHERE tournament_id = 'the-puppy' 
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
        const total = matchups.length;
        
        matchups.forEach((matchup, index) => {
            // Randomly choose between team1 and team2 for each vote
            const teamId = Math.random() < 0.5 ? matchup.team1_id : matchup.team2_id;
            
            // Insert the vote
            const insertQuery = `
                INSERT OR REPLACE INTO tournament_votes (matchup_id, team_id, voter_id, created_at)
                VALUES (?, ?, ?, datetime('now', '+' || ? || ' minutes'))
            `;
            
            // Add some time variation to the votes (0-30 minutes ago)
            const timeOffset = Math.floor(Math.random() * 30);
            
            db.run(insertQuery, [matchup.id, teamId, 1, timeOffset], function(err) {
                if (err) {
                    console.error(`Error inserting vote for matchup ${matchup.id}:`, err);
                } else {
                    console.log(`Added vote for matchup ${matchup.id} (${matchup.team1_id} vs ${matchup.team2_id}) -> voted for ${teamId}`);
                }
                
                completed++;
                if (completed === total) {
                    console.log('All dummy votes added successfully!');
                    
                    // Show summary of votes added
                    const summaryQuery = `
                        SELECT 
                            tm.id as matchup_id,
                            tm.bracket_position,
                            t1.username as team1_name,
                            t2.username as team2_name,
                            tv.team_id as voted_for,
                            tv.created_at
                        FROM tournament_votes tv
                        JOIN tournament_matchups tm ON tv.matchup_id = tm.id
                        LEFT JOIN teams t1 ON tm.team1_id = t1.id
                        LEFT JOIN teams t2 ON tm.team2_id = t2.id
                        WHERE tv.voter_id = 1 
                        AND tm.tournament_id = 'the-puppy'
                        AND tm.round_number = 1
                        ORDER BY tm.bracket_position
                    `;
                    
                    db.all(summaryQuery, [], (err, votes) => {
                        if (err) {
                            console.error('Error fetching vote summary:', err);
                        } else {
                            console.log('\nVote Summary:');
                            console.log('=============');
                            votes.forEach(vote => {
                                const votedTeamName = vote.voted_for === vote.team1_name ? vote.team1_name : vote.team2_name;
                                console.log(`Matchup ${vote.matchup_id} (Position ${vote.bracket_position}): ${vote.team1_name} vs ${vote.team2_name} -> Voted for ${votedTeamName} at ${vote.created_at}`);
                            });
                        }
                        db.close();
                    });
                }
            });
        });
    });
}

// Run the script
addDummyTournamentVotes(); 