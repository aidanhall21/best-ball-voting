const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

// Configuration
const DB_PATH = path.join(__dirname, '..', 'teams-2025-08-04-0920.db');
const TOURNAMENT_ID = process.env.TOURNAMENT_ID || 'the-puppy';
const TOURNAMENT_NAME = process.env.TOURNAMENT_NAME || 'The Puppy';

function createTournamentBracket() {
    const db = new sqlite3.Database(DB_PATH);
    
    console.log('🏆 Creating tournament bracket...');
    
    db.serialize(() => {
        // Step 1: Create tournament tables if they don't exist
        console.log('📋 Setting up tournament tables...');
        const createTablesSQL = fs.readFileSync(
            path.join(__dirname, 'create_tournament_tables.sql'), 
            'utf8'
        );
        db.exec(createTablesSQL, (err) => {
            if (err) {
                console.error('Error creating tables:', err);
                return;
            }
            
            // Step 2: Create tournament instance
            console.log('🎯 Creating tournament instance...');
            db.run(`
                INSERT OR REPLACE INTO tournaments (id, name, status, start_date)
                VALUES (?, ?, 'setup', datetime('now'))
            `, [TOURNAMENT_ID, TOURNAMENT_NAME], (err) => {
                if (err) {
                    console.error('Error creating tournament:', err);
                    return;
                }
                
                // Step 3: Get teams from tournament_nominations
                console.log('👥 Fetching nominated teams...');
                db.all(`
                    SELECT tn.id, tn.username, tn.draft_id, t.tournament
                    FROM tournament_nominations tn
                    JOIN teams t ON tn.id = t.id
                    WHERE tn.tournament = ?
                    ORDER BY tn.username, tn.nominated_at
                `, [TOURNAMENT_NAME], (err, teams) => {
                    if (err) {
                        console.error('Error fetching teams:', err);
                        return;
                    }
                    
                    console.log(`Found ${teams.length} nominated teams from ${new Set(teams.map(t => t.username)).size} users`);
                    
                    if (teams.length === 0) {
                        console.error('❌ No teams found in tournament_nominations table');
                        db.close();
                        return;
                    }
                    
                    // Step 4: Create matchups
                    const matchups = createBalancedMatchups(teams);
                    console.log(`📊 Created ${matchups.length} first round matchups`);
                    
                    // Step 5: Insert matchups into database
                    console.log('💾 Saving matchups to database...');
                    insertMatchups(db, matchups, () => {
                        // Step 6: Create bracket structure
                        console.log('🏗️ Creating bracket structure...');
                        createBracketStructure(db, TOURNAMENT_ID, matchups.length, () => {
                            console.log('✅ Tournament bracket created successfully!');
                            console.log(`Tournament ID: ${TOURNAMENT_ID}`);
                            console.log(`Total teams: ${teams.length}`);
                            console.log(`First round matchups: ${matchups.length}`);
                            db.close();
                        });
                    });
                });
            });
        });
    });
}

function createBalancedMatchups(teams) {
    const matchups = [];
    const usedTeams = new Set();
    
    // Group teams by username
    const teamsByUser = {};
    teams.forEach(team => {
        if (!teamsByUser[team.username]) {
            teamsByUser[team.username] = [];
        }
        teamsByUser[team.username].push(team);
    });
    
    // Convert to array and shuffle
    const allTeams = [];
    Object.entries(teamsByUser).forEach(([username, userTeams]) => {
        userTeams.forEach(team => {
            allTeams.push({ ...team, username });
        });
    });
    
    shuffleArray(allTeams);
    
    // Create matchups ensuring different usernames
    let i = 0;
    while (i < allTeams.length - 1) {
        const team1 = allTeams[i];
        
        if (usedTeams.has(team1.id)) {
            i++;
            continue;
        }
        
        // Find next team with different username
        let team2 = null;
        for (let j = i + 1; j < allTeams.length; j++) {
            const candidate = allTeams[j];
            if (!usedTeams.has(candidate.id) && candidate.username !== team1.username) {
                team2 = candidate;
                break;
            }
        }
        
        if (team2) {
            matchups.push({ team1, team2 });
            usedTeams.add(team1.id);
            usedTeams.add(team2.id);
            console.log(`  ${matchups.length}: ${team1.username} (${team1.id}) vs ${team2.username} (${team2.id})`);
        }
        
        i++;
    }
    
    // Handle any remaining unmatched teams
    const unmatchedTeams = allTeams.filter(team => !usedTeams.has(team.id));
    if (unmatchedTeams.length > 1) {
        console.log(`⚠️ Found ${unmatchedTeams.length} unmatched teams, creating additional matchups...`);
        
        for (let i = 0; i < unmatchedTeams.length - 1; i += 2) {
            const matchup = {
                team1: unmatchedTeams[i],
                team2: unmatchedTeams[i + 1]
            };
            matchups.push(matchup);
            console.log(`  ${matchups.length}: ${matchup.team1.username} (${matchup.team1.id}) vs ${matchup.team2.username} (${matchup.team2.id})`);
        }
    }
    
    return matchups;
}

function insertMatchups(db, matchups, callback) {
    let completed = 0;
    
    matchups.forEach((matchup, index) => {
        db.run(`
            INSERT INTO tournament_matchups 
            (tournament_id, round_number, bracket_position, team1_id, team2_id, status)
            VALUES (?, ?, ?, ?, ?, 'pending')
        `, [
            TOURNAMENT_ID,
            1, // First round
            index + 1, // Bracket position
            matchup.team1.id,
            matchup.team2.id
        ], (err) => {
            if (err) {
                console.error('Error inserting matchup:', err);
                return;
            }
            
            completed++;
            if (completed === matchups.length) {
                callback();
            }
        });
    });
}

function createBracketStructure(db, tournamentId, firstRoundMatchups, callback) {
    // Get first round matchup IDs
    db.all(`
        SELECT id FROM tournament_matchups 
        WHERE tournament_id = ? AND round_number = 1 
        ORDER BY bracket_position
    `, [tournamentId], (err, firstRoundRows) => {
        if (err) {
            console.error('Error getting first round matchups:', err);
            return;
        }
        
        let previousRoundIds = firstRoundRows.map(row => row.id);
        let currentRoundMatchups = firstRoundMatchups;
        let roundNumber = 2;
        
        createNextRound(db, tournamentId, previousRoundIds, currentRoundMatchups, roundNumber, callback);
    });
}

function createNextRound(db, tournamentId, previousRoundIds, currentRoundMatchups, roundNumber, callback) {
    if (currentRoundMatchups <= 1) {
        console.log(`Created bracket structure with ${roundNumber - 1} rounds`);
        callback();
        return;
    }
    
    const nextRoundMatchups = Math.ceil(currentRoundMatchups / 2);
    console.log(`Round ${roundNumber}: ${nextRoundMatchups} matchups`);
    
    const currentRoundIds = [];
    let completed = 0;
    
    // Create matchups for this round
    for (let i = 0; i < nextRoundMatchups; i++) {
        db.run(`
            INSERT INTO tournament_matchups 
            (tournament_id, round_number, bracket_position, status)
            VALUES (?, ?, ?, 'pending')
        `, [tournamentId, roundNumber, i + 1], function(err) {
            if (err) {
                console.error('Error creating next round matchup:', err);
                return;
            }
            
            const matchupId = this.lastID;
            currentRoundIds.push(matchupId);
            
            // Update parent matchups to point to this matchup
            const parentMatch1 = previousRoundIds[i * 2];
            const parentMatch2 = previousRoundIds[i * 2 + 1];
            
            let updates = 0;
            const updateComplete = () => {
                updates++;
                if (updates === 2 || !parentMatch2) {
                    completed++;
                    if (completed === nextRoundMatchups) {
                        // Move to next round
                        createNextRound(db, tournamentId, currentRoundIds, nextRoundMatchups, roundNumber + 1, callback);
                    }
                }
            };
            
            if (parentMatch1) {
                db.run(`
                    UPDATE tournament_matchups 
                    SET parent_matchup_id = ?, parent_position = 1 
                    WHERE id = ?
                `, [matchupId, parentMatch1], updateComplete);
            } else {
                updateComplete();
            }
            
            if (parentMatch2) {
                db.run(`
                    UPDATE tournament_matchups 
                    SET parent_matchup_id = ?, parent_position = 2 
                    WHERE id = ?
                `, [matchupId, parentMatch2], updateComplete);
            } else {
                updateComplete();
            }
        });
    }
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

// Run the script
if (require.main === module) {
    createTournamentBracket();
}

module.exports = { createTournamentBracket };