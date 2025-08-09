const sqlite3 = require('sqlite3').verbose();
const path = require('path');

/**
 * Tournament Bracket Creation Script
 * 
 * Creates a March Madness-style tournament bracket with regional distribution:
 * - Distributes teams across 4 regions (Midwest, East, West, South)
 * - Ensures max 1 team per user per region for balanced competition
 * - Creates matchups within each region to avoid same-user matchups
 * - Supports up to 4 teams per user (one in each region)
 */

// Configuration
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'teams-2025-08-09-0917.db');
const TOURNAMENT_ID = process.env.TOURNAMENT_ID || '1';
const TOURNAMENT_NAME = process.env.TOURNAMENT_NAME || 'The Puppy';
const SOURCE_CONTEST = process.env.SOURCE_CONTEST || TOURNAMENT_NAME;
const MAX_TEAMS = process.env.MAX_TEAMS ? parseInt(process.env.MAX_TEAMS) : 256;
const MAX_TEAMS_PER_USER = process.env.MAX_TEAMS_PER_USER ? parseInt(process.env.MAX_TEAMS_PER_USER) : 4;

console.log('DB_PATH', DB_PATH);
console.log('TOURNAMENT_ID', TOURNAMENT_ID);
console.log('TOURNAMENT_NAME', TOURNAMENT_NAME);
console.log('SOURCE_CONTEST', SOURCE_CONTEST);
console.log('MAX_TEAMS', MAX_TEAMS);
console.log('MAX_TEAMS_PER_USER', MAX_TEAMS_PER_USER);

function createTournamentBracket() {
    const db = new sqlite3.Database(DB_PATH);
    
    console.log('🏆 Creating tournament bracket...');
    
    db.serialize(() => {
        // Step 1: Verify tournament exists (should already be created by API)
        console.log('🎯 Verifying tournament exists...');
        db.get(`SELECT * FROM tournaments WHERE id = ?`, [TOURNAMENT_ID], (err, tournament) => {
            if (err) {
                console.error('Error checking tournament:', err);
                return;
            }
            
            if (!tournament) {
                console.error(`❌ Tournament ${TOURNAMENT_ID} not found. Please create it first via the admin interface.`);
                return;
            }
            
            console.log(`✅ Tournament found: ${tournament.name} (status: ${tournament.status})`);
            
            // Step 2: Get teams from tournament nominations
            console.log(`👥 Fetching nominated teams for tournament: ${TOURNAMENT_NAME}...`);
            
            const sql = `
                SELECT tn.id, tn.username, tn.draft_id, t.tournament, tn.user_id
                FROM tournament_nominations tn
                JOIN teams t ON tn.id = t.id
                WHERE tn.tournament = ?
                ORDER BY tn.username, tn.nominated_at
            `;
            
            db.all(sql, [SOURCE_CONTEST], (err, teams) => {
                if (err) {
                    console.error('Error fetching teams:', err);
                    return;
                }
                
                console.log(`Found ${teams.length} nominated teams from ${new Set(teams.map(t => t.username)).size} users in contest: ${SOURCE_CONTEST}`);
                
                if (teams.length === 0) {
                    console.error(`❌ No nominated teams found for contest: ${SOURCE_CONTEST}`);
                    db.close();
                    return;
                }
                
                // Use all nominated teams (no additional filtering needed as nominations are pre-filtered)
                const finalTeams = teams;
                
                // Step 3: Create matchups
                const matchups = createBalancedMatchups(finalTeams);
                console.log(`📊 Created ${matchups.length} first round matchups`);
                
                // Step 4: Insert matchups into database
                console.log('💾 Saving matchups to database...');
                insertMatchups(db, matchups, () => {
                    // Step 5: Create bracket structure
                    console.log('🏗️ Creating bracket structure...');
                    createBracketStructure(db, TOURNAMENT_ID, matchups.length, () => {
                        console.log('✅ Tournament bracket created successfully!');
                        console.log(`Tournament ID: ${TOURNAMENT_ID}`);
                        console.log(`Source Contest: ${SOURCE_CONTEST}`);
                        console.log(`Total teams: ${finalTeams.length}`);
                        console.log(`Max teams per user: ${MAX_TEAMS_PER_USER}`);
                        console.log(`🏟️ Regional distribution: Max 1 team per user per region (Midwest/East/West/South)`);
                        if (MAX_TEAMS) console.log(`Max teams limit: ${MAX_TEAMS}`);
                        console.log(`First round matchups: ${matchups.length}`);
                        db.close();
                    });
                });
            });
        });
    });
}

function createBalancedMatchups(teams) {
    console.log('🎯 Creating regionally balanced matchups...');
    
    // Group teams by username
    const teamsByUser = {};
    teams.forEach(team => {
        if (!teamsByUser[team.username]) {
            teamsByUser[team.username] = [];
        }
        teamsByUser[team.username].push(team);
    });
    
    console.log(`👥 Found ${Object.keys(teamsByUser).length} users with teams`);
    
    // Distribute teams across 4 regions (max 1 team per user per region)
    const regions = [[], [], [], []]; // Midwest, East, West, South
    const regionNames = ['Midwest', 'East', 'West', 'South'];
    
    // Track which users have teams in which regions
    const userRegionAssignments = {}; // username -> Set of region indices
    
    Object.entries(teamsByUser).forEach(([username, userTeams]) => {
        userRegionAssignments[username] = new Set();
        
        // Shuffle user's teams for random distribution
        shuffleArray(userTeams);
        
        // Assign each team to a different region (max 4 teams per user, max 1 per region)
        userTeams.forEach((team, index) => {
            if (index < 4) { // Only assign up to 4 teams (one per region)
                const regionIndex = index;
                regions[regionIndex].push({ ...team, username, regionIndex });
                userRegionAssignments[username].add(regionIndex);
                console.log(`  📍 ${username} team ${team.id} → ${regionNames[regionIndex]} region`);
            } else {
                console.log(`  ⚠️ Skipping ${username} team ${team.id} (user already has 4 teams across regions)`);
            }
        });
    });
    
    // Balance region sizes by moving teams if necessary
    console.log('\n📊 Regional distribution:');
    regions.forEach((region, i) => {
        console.log(`  ${regionNames[i]}: ${region.length} teams`);
    });
    
    // Find target size for each region (for 256 teams, each region should have 64)
    const totalTeams = regions.reduce((sum, region) => sum + region.length, 0);
    const targetRegionSize = Math.ceil(totalTeams / 4);
    
    console.log(`\n🎯 Target region size: ${targetRegionSize} teams each`);
    
    // Redistribute teams to balance regions while maintaining user constraints
    balanceRegions(regions, userRegionAssignments, targetRegionSize, regionNames);
    
    // Create matchups within each region
    const allMatchups = [];
    
    regions.forEach((region, regionIndex) => {
        console.log(`\n🏟️ Creating matchups for ${regionNames[regionIndex]} region (${region.length} teams):`);
        
        const regionMatchups = createRegionMatchups(region, regionIndex * 64); // Each region starts at different bracket positions
        allMatchups.push(...regionMatchups);
    });
    
    console.log(`\n✅ Created ${allMatchups.length} total matchups across all regions`);
    return allMatchups;
}

function balanceRegions(regions, userRegionAssignments, targetSize, regionNames) {
    // Simple balancing: move excess teams from larger regions to smaller ones
    // while respecting the constraint that each user can only have 1 team per region
    
    let moved = true;
    while (moved) {
        moved = false;
        
        // Find regions that are over/under target
        const overRegions = regions.map((region, i) => ({ index: i, size: region.length, excess: region.length - targetSize }))
                                   .filter(r => r.excess > 0)
                                   .sort((a, b) => b.excess - a.excess);
        
        const underRegions = regions.map((region, i) => ({ index: i, size: region.length, deficit: targetSize - region.length }))
                                    .filter(r => r.deficit > 0)
                                    .sort((a, b) => b.deficit - a.deficit);
        
        if (overRegions.length === 0 || underRegions.length === 0) break;
        
        // Try to move a team from an over-region to an under-region
        for (const overRegion of overRegions) {
            for (const underRegion of underRegions) {
                // Find a team in the over-region whose user doesn't already have a team in the under-region
                const teamToMove = regions[overRegion.index].find(team => 
                    !userRegionAssignments[team.username].has(underRegion.index)
                );
                
                if (teamToMove) {
                    // Move the team
                    regions[overRegion.index] = regions[overRegion.index].filter(t => t.id !== teamToMove.id);
                    teamToMove.regionIndex = underRegion.index;
                    regions[underRegion.index].push(teamToMove);
                    
                    // Update user assignments
                    userRegionAssignments[teamToMove.username].delete(overRegion.index);
                    userRegionAssignments[teamToMove.username].add(underRegion.index);
                    
                    console.log(`  🔄 Moved ${teamToMove.username} team ${teamToMove.id} from ${regionNames[overRegion.index]} to ${regionNames[underRegion.index]}`);
                    moved = true;
                    break;
                }
            }
            if (moved) break;
        }
    }
    
    // Final region sizes
    console.log('\n📊 Final regional distribution:');
    regions.forEach((region, i) => {
        console.log(`  ${regionNames[i]}: ${region.length} teams`);
    });
}

function createRegionMatchups(regionTeams, startingBracketPosition) {
    const matchups = [];
    const usedTeams = new Set();
    
    // Shuffle teams within the region
    shuffleArray(regionTeams);
    
    // Create matchups ensuring different usernames
    let i = 0;
    while (i < regionTeams.length - 1) {
        const team1 = regionTeams[i];
        
        if (usedTeams.has(team1.id)) {
            i++;
            continue;
        }
        
        // Find next team with different username
        let team2 = null;
        for (let j = i + 1; j < regionTeams.length; j++) {
            const candidate = regionTeams[j];
            if (!usedTeams.has(candidate.id) && candidate.username !== team1.username) {
                team2 = candidate;
                break;
            }
        }
        
        if (team2) {
            matchups.push({ 
                team1, 
                team2, 
                bracketPosition: startingBracketPosition + matchups.length + 1 
            });
            usedTeams.add(team1.id);
            usedTeams.add(team2.id);
            console.log(`    ${matchups.length}: ${team1.username} vs ${team2.username}`);
        }
        
        i++;
    }
    
    // Handle any remaining unmatched teams within this region
    const unmatchedTeams = regionTeams.filter(team => !usedTeams.has(team.id));
    if (unmatchedTeams.length > 1) {
        console.log(`    ⚠️ Found ${unmatchedTeams.length} unmatched teams in region, creating additional matchups...`);
        
        for (let i = 0; i < unmatchedTeams.length - 1; i += 2) {
            const matchup = {
                team1: unmatchedTeams[i],
                team2: unmatchedTeams[i + 1],
                bracketPosition: startingBracketPosition + matchups.length + 1
            };
            matchups.push(matchup);
            console.log(`    ${matchups.length}: ${matchup.team1.username} vs ${matchup.team2.username}`);
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
            matchup.bracketPosition || (index + 1), // Use regional bracket position if available
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
    
    const currentRoundIds = new Array(nextRoundMatchups); // Pre-allocate array with correct size
    let completed = 0;
    
    // Create matchups for this round
    for (let i = 0; i < nextRoundMatchups; i++) {
        // Use an IIFE to capture the current value of i
        ((matchupIndex) => {
            db.run(`
                INSERT INTO tournament_matchups 
                (tournament_id, round_number, bracket_position, status)
                VALUES (?, ?, ?, 'pending')
            `, [tournamentId, roundNumber, matchupIndex + 1], function(err) {
                if (err) {
                    console.error('Error creating next round matchup:', err);
                    return;
                }
                
                const matchupId = this.lastID;
                currentRoundIds[matchupIndex] = matchupId; // Store in correct position
                
                // Update parent matchups to point to this matchup
                // Special handling for semifinals: when we have exactly 4 teams going to 2 (regardless of round number)
                let parentMatch1, parentMatch2;
                if (currentRoundMatchups === 4 && nextRoundMatchups === 2) {
                    // Semifinals: Cross-pair the regions (1 vs 3, 2 vs 4)
                    if (matchupIndex === 0) {
                        // First semifinal: bracket positions 1 vs 3
                        parentMatch1 = previousRoundIds[0]; // bracket_position 1
                        parentMatch2 = previousRoundIds[2]; // bracket_position 3
                    } else {
                        // Second semifinal: bracket positions 2 vs 4
                        parentMatch1 = previousRoundIds[1]; // bracket_position 2
                        parentMatch2 = previousRoundIds[3]; // bracket_position 4
                    }
                } else {
                    // Normal pairing for all other rounds
                    parentMatch1 = previousRoundIds[matchupIndex * 2];
                    parentMatch2 = previousRoundIds[matchupIndex * 2 + 1];
                }
                
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
        })(i);
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