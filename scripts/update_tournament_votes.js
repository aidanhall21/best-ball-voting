const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Connect to the database
const dbPath = path.join(__dirname, '..', 'teams-2025-08-04-0920.db');
const db = new sqlite3.Database(dbPath);

// Function to update existing votes and add new ones
function updateTournamentVotes() {
    console.log('Updating tournament votes...');
    
    // First, update all existing votes from voter_id 1 to voter_id 2
    const updateQuery = `
        UPDATE tournament_votes 
        SET voter_id = 2 
        WHERE voter_id = 1
    `;
    
    db.run(updateQuery, [], function(err) {
        if (err) {
            console.error('Error updating votes to voter_id 2:', err);
            db.close();
            return;
        }
        
        console.log(`Updated ${this.changes} votes from voter_id 1 to voter_id 2`);
        
        // Now get all the votes for voter_id 2 to use as template for voter_id 3 and 4
        const getVotesQuery = `
            SELECT matchup_id, team_id, created_at
            FROM tournament_votes 
            WHERE voter_id = 2
            ORDER BY matchup_id
        `;
        
        db.all(getVotesQuery, [], (err, votes) => {
            if (err) {
                console.error('Error fetching votes:', err);
                db.close();
                return;
            }
            
            console.log(`Found ${votes.length} votes to replicate for voter_id 3 and 4`);
            
            let completed = 0;
            const total = votes.length * 2; // 2 new voters (3 and 4)
            
            // Add votes for voter_id 3
            votes.forEach((vote, index) => {
                const insertQuery3 = `
                    INSERT INTO tournament_votes (matchup_id, team_id, voter_id, created_at)
                    VALUES (?, ?, 3, datetime(?, '+' || ? || ' minutes'))
                `;
                
                // Add some time variation (0-15 minutes after the original vote)
                const timeOffset = Math.floor(Math.random() * 15);
                
                db.run(insertQuery3, [vote.matchup_id, vote.team_id, vote.created_at, timeOffset], function(err) {
                    if (err) {
                        console.error(`Error inserting vote for voter_id 3, matchup ${vote.matchup_id}:`, err);
                    } else {
                        console.log(`Added vote for voter_id 3: matchup ${vote.matchup_id} -> team ${vote.team_id}`);
                    }
                    
                    completed++;
                    if (completed === total) {
                        console.log('All votes for voter_id 3 added successfully!');
                        addVotesForVoter4(votes);
                    }
                });
            });
        });
    });
}

// Function to add votes for voter_id 4
function addVotesForVoter4(votes) {
    console.log('Adding votes for voter_id 4...');
    
    let completed = 0;
    const total = votes.length;
    
    votes.forEach((vote, index) => {
        const insertQuery4 = `
            INSERT INTO tournament_votes (matchup_id, team_id, voter_id, created_at)
            VALUES (?, ?, 4, datetime(?, '+' || ? || ' minutes'))
        `;
        
        // Add some time variation (0-15 minutes after the original vote)
        const timeOffset = Math.floor(Math.random() * 15);
        
        db.run(insertQuery4, [vote.matchup_id, vote.team_id, vote.created_at, timeOffset], function(err) {
            if (err) {
                console.error(`Error inserting vote for voter_id 4, matchup ${vote.matchup_id}:`, err);
            } else {
                console.log(`Added vote for voter_id 4: matchup ${vote.matchup_id} -> team ${vote.team_id}`);
            }
            
            completed++;
            if (completed === total) {
                console.log('All votes for voter_id 4 added successfully!');
                showFinalSummary();
            }
        });
    });
}

// Function to show final summary
function showFinalSummary() {
    console.log('\nFinal Vote Summary:');
    console.log('===================');
    
    const summaryQuery = `
        SELECT 
            voter_id,
            COUNT(*) as vote_count
        FROM tournament_votes 
        GROUP BY voter_id 
        ORDER BY voter_id
    `;
    
    db.all(summaryQuery, [], (err, results) => {
        if (err) {
            console.error('Error fetching vote summary:', err);
        } else {
            results.forEach(result => {
                console.log(`Voter ID ${result.voter_id}: ${result.vote_count} votes`);
            });
            
            const totalQuery = `SELECT COUNT(*) as total FROM tournament_votes`;
            db.get(totalQuery, [], (err, total) => {
                if (err) {
                    console.error('Error fetching total count:', err);
                } else {
                    console.log(`\nTotal votes in tournament_votes table: ${total.total}`);
                    console.log('Expected: 128 * 3 = 384 votes');
                }
                db.close();
            });
        }
    });
}

// Run the script
updateTournamentVotes(); 