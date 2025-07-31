#!/usr/bin/env node

/**
 * Populate elo_ratings table with historical matchup data
 * 
 * This script processes all versus_matches entries chronologically and creates
 * corresponding elo_ratings entries that track each team's Elo rating evolution
 * after each matchup.
 * 
 * Usage: node scripts/populate_elo_ratings.js
 */

const sqlite3 = require("sqlite3").verbose();
const path = require("path");

// Configuration - match Python script values
const STARTING_ELO = 1500.0;
const BASE_K_FACTOR = 128.0;

// Database path from environment or default
const DB_PATH = process.env.DB_PATH || "../teams-2025-07-31-1529.db";
console.log('DB_PATH', DB_PATH);

/**
 * Calculate vote weight using same logic as Python script
 */
function calculateVoteWeight(voterId, winnerUserId, loserUserId) {
    if (!voterId) {
        return 1.0;
    }
    
    const voterIdStr = String(voterId);
    const winnerUserIdStr = winnerUserId ? String(winnerUserId) : null;
    const loserUserIdStr = loserUserId ? String(loserUserId) : null;
    
    if (voterIdStr === winnerUserIdStr) {
        return 0.5; // Self-votes count as half
    } else if (voterIdStr === loserUserIdStr) {
        return 1.5; // Voting against own team gets extra credit
    } else {
        return 1.0; // Neutral votes get normal weight
    }
}

/**
 * Calculate expected score for team A against team B using logistic function
 */
function expectedScore(ratingA, ratingB) {
    return 1.0 / (1.0 + Math.pow(10, (ratingB - ratingA) / 400.0));
}

/**
 * Calculate adaptive K-factor based on vote confidence and team experience
 */
function adaptiveKFactor(baseK, voteWeight, matchesPlayed) {
    // Weight adjustment: higher weight = higher K-factor
    const weightMultiplier = voteWeight;
    
    // Experience adjustment: fewer matches = higher K-factor
    const experienceFactor = Math.max(0.5, 1.0 - (matchesPlayed / 200.0));
    
    return baseK * weightMultiplier * experienceFactor;
}

/**
 * Main function to populate elo_ratings table
 */
async function main() {
    console.log(`Using database: ${DB_PATH}`);
    
    const db = new sqlite3.Database(DB_PATH);
    
    try {
        // Clear existing elo_ratings data
        await runQuery(db, "DELETE FROM elo_ratings");
        console.log("Cleared existing elo_ratings data");
        
        // Load all teams with tournament info
        const teams = await runQuery(db, `
            SELECT id, tournament, username, user_id
            FROM teams
            WHERE tournament IS NOT NULL AND TRIM(tournament) <> ''
        `);
        
        if (teams.length === 0) {
            console.log("No teams with tournaments found");
            return;
        }
        
        // Load all matches ordered chronologically
        const matches = await runQuery(db, `
            SELECT vm.id, vm.winner_id, vm.loser_id, vm.voter_id, vm.created_at,
                   tw.tournament, tw.user_id AS winner_user_id, tw.username AS winner_username,
                   tl.user_id AS loser_user_id, tl.username AS loser_username
            FROM versus_matches vm
            JOIN teams tw ON tw.id = vm.winner_id
            JOIN teams tl ON tl.id = vm.loser_id
            WHERE tw.tournament = tl.tournament
              AND tw.tournament IS NOT NULL
              AND TRIM(tw.tournament) <> ''
            ORDER BY vm.created_at ASC
        `);
        
        console.log(`Processing ${matches.length} matches across tournaments`);
        
        // Group teams by tournament
        const tournamentTeams = {};
        teams.forEach(team => {
            if (!tournamentTeams[team.tournament]) {
                tournamentTeams[team.tournament] = [];
            }
            tournamentTeams[team.tournament].push(team);
        });
        
        // Process each tournament separately
        for (const [tournament, tournamentTeamList] of Object.entries(tournamentTeams)) {
            console.log(`Processing tournament: ${tournament}`);
            
            // Initialize Elo ratings and stats for all teams in tournament
            const teamElos = {};
            const teamMatchesPlayed = {};
            const teamWins = {};
            const teamLosses = {};
            
            tournamentTeamList.forEach(team => {
                teamElos[team.id] = STARTING_ELO;
                teamMatchesPlayed[team.id] = 0;
                teamWins[team.id] = 0;
                teamLosses[team.id] = 0;
            });
            
            // Get matches for this tournament
            const tournamentMatches = matches.filter(match => match.tournament === tournament);
            
            // Process matches chronologically
            for (const match of tournamentMatches) {
                const { winner_id, loser_id, voter_id, winner_user_id, loser_user_id, 
                       winner_username, loser_username, created_at } = match;
                
                // Skip if teams not in this tournament (shouldn't happen with our query)
                if (!teamElos.hasOwnProperty(winner_id) || !teamElos.hasOwnProperty(loser_id)) {
                    continue;
                }
                
                // Skip self-matches
                if (winner_id === loser_id) {
                    continue;
                }
                
                // Calculate vote weight
                const voteWeight = calculateVoteWeight(voter_id, winner_user_id, loser_user_id);
                
                // Get current ratings
                const winnerElo = teamElos[winner_id];
                const loserElo = teamElos[loser_id];
                
                // Calculate expected scores
                const winnerExpected = expectedScore(winnerElo, loserElo);
                const loserExpected = 1.0 - winnerExpected;
                
                // Calculate adaptive K-factors
                const winnerK = adaptiveKFactor(BASE_K_FACTOR, voteWeight, teamMatchesPlayed[winner_id]);
                const loserK = adaptiveKFactor(BASE_K_FACTOR, voteWeight, teamMatchesPlayed[loser_id]);
                
                // Update Elo ratings
                const winnerNewElo = winnerElo + winnerK * (1.0 - winnerExpected);
                const loserNewElo = loserElo + loserK * (0.0 - loserExpected);
                
                teamElos[winner_id] = winnerNewElo;
                teamElos[loser_id] = loserNewElo;
                
                // Update match counts and win/loss records
                teamMatchesPlayed[winner_id]++;
                teamMatchesPlayed[loser_id]++;
                teamWins[winner_id] += voteWeight;
                teamLosses[loser_id] += voteWeight;
                
                // Insert elo_ratings entries for both teams with their updated ratings
                await runQuery(db, `
                    INSERT INTO elo_ratings (team_id, tournament, username, elo, wins, losses, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `, [winner_id, tournament, winner_username, winnerNewElo, teamWins[winner_id], teamLosses[winner_id], created_at]);
                
                await runQuery(db, `
                    INSERT INTO elo_ratings (team_id, tournament, username, elo, wins, losses, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `, [loser_id, tournament, loser_username, loserNewElo, teamWins[loser_id], teamLosses[loser_id], created_at]);
            }
            
            console.log(`Completed tournament ${tournament}: ${tournamentMatches.length} matches processed`);
        }
        
        // Get final count
        const finalCount = await runQuery(db, "SELECT COUNT(*) as count FROM elo_ratings");
        console.log(`Successfully populated elo_ratings table with ${finalCount[0].count} entries`);
        
    } catch (error) {
        console.error("Error populating elo_ratings:", error);
        throw error;
    } finally {
        db.close();
    }
}

/**
 * Promise wrapper for database queries
 */
function runQuery(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        if (sql.trim().toUpperCase().startsWith('SELECT')) {
            db.all(sql, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        } else {
            db.run(sql, params, function(err) {
                if (err) reject(err);
                else resolve({ lastID: this.lastID, changes: this.changes });
            });
        }
    });
}

if (require.main === module) {
    main().catch(error => {
        console.error("Script failed:", error);
        process.exit(1);
    });
}