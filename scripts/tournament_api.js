// Tournament API functions for integration with your existing db.js
// Add these functions to your db.js file and create the corresponding endpoints

// Get a random unfinished matchup from the current active round that the user hasn't voted on
function getCurrentTournamentMatchup(db, tournamentId, userId, callback) {
    // If no userId provided, use the original query (for non-logged in users)
    if (!userId) {
        return callback(null, null); // Will be handled by frontend to show login message
    }
    
    const query = `
        SELECT 
            tm.*,
            t1.username as team1_username,
            t1.draft_id as team1_draft_id,
            t2.username as team2_username,
            t2.draft_id as team2_draft_id,
            (SELECT COUNT(*) FROM tournament_votes tv WHERE tv.matchup_id = tm.id AND tv.team_id = tm.team1_id) as team1_votes,
            (SELECT COUNT(*) FROM tournament_votes tv WHERE tv.matchup_id = tm.id AND tv.team_id = tm.team2_id) as team2_votes
        FROM tournament_matchups tm
        LEFT JOIN teams t1 ON tm.team1_id = t1.id
        LEFT JOIN teams t2 ON tm.team2_id = t2.id
        WHERE tm.tournament_id = ? 
            AND tm.status = 'active'
            AND tm.team1_id IS NOT NULL 
            AND tm.team2_id IS NOT NULL
            AND tm.winner_id IS NULL
            AND tm.id NOT IN (
                SELECT matchup_id 
                FROM tournament_votes 
                WHERE voter_id = ?
            )
            AND t1.user_id != ?
            AND t2.user_id != ?
        ORDER BY RANDOM()
        LIMIT 1
    `;
    
    db.get(query, [tournamentId, userId, userId, userId], (err, matchup) => {
        if (err) return callback(err);
        if (!matchup) {
            // Check if user has voted on all active matchups in current round (excluding their own teams)
            db.get(`
                SELECT COUNT(*) as total_active,
                       (SELECT COUNT(DISTINCT matchup_id) 
                        FROM tournament_votes 
                        WHERE voter_id = ? 
                        AND matchup_id IN (
                            SELECT tm.id FROM tournament_matchups tm
                            LEFT JOIN teams t1 ON tm.team1_id = t1.id
                            LEFT JOIN teams t2 ON tm.team2_id = t2.id
                            WHERE tm.tournament_id = ? 
                            AND tm.status = 'active' 
                            AND tm.winner_id IS NULL
                            AND t1.user_id != ?
                            AND t2.user_id != ?
                        )) as user_voted
                FROM tournament_matchups tm
                LEFT JOIN teams t1 ON tm.team1_id = t1.id
                LEFT JOIN teams t2 ON tm.team2_id = t2.id
                WHERE tm.tournament_id = ? 
                AND tm.status = 'active' 
                AND tm.winner_id IS NULL
                AND t1.user_id != ?
                AND t2.user_id != ?
            `, [userId, tournamentId, userId, userId, tournamentId, userId, userId], (err, stats) => {
                if (err) return callback(err);
                
                if (stats.total_active > 0 && stats.user_voted >= stats.total_active) {
                    return callback(null, { 
                        allVoted: true, 
                        message: "You've voted on every matchup this round. Please return when the next round starts." 
                    });
                } else {
                    return callback(null, { 
                        noMatchups: true, 
                        message: "No active matchups available at this time." 
                    });
                }
            });
            return;
        }
        
        // Get roster data for both teams
        const getRosterForTeam = (teamId, cb) => {
            const rosterQuery = `
                SELECT position, name, pick, team, stack
                FROM players 
                WHERE team_id = ?
                ORDER BY 
                    CASE position 
                        WHEN 'QB' THEN 1 
                        WHEN 'RB' THEN 2 
                        WHEN 'WR' THEN 3 
                        WHEN 'TE' THEN 4 
                        ELSE 5 
                    END,
                    pick
            `;
            db.all(rosterQuery, [teamId], cb);
        };
        
        // Get ELO ratings for both teams
        const getLatestEloForTeam = (teamId, cb) => {
            const eloQuery = `
                SELECT elo
                FROM elo_ratings 
                WHERE team_id = ?
                ORDER BY created_at DESC
                LIMIT 1
            `;
            db.get(eloQuery, [teamId], (err, result) => {
                if (err) return cb(err);
                // Return ELO rating or default 1500 if not found
                cb(null, result ? result.elo : 1500);
            });
        };
        
        // Get rosters and ELO ratings for both teams
        getRosterForTeam(matchup.team1_id, function(err1, team1Players) {
            if (err1) return callback(err1);
            
            getRosterForTeam(matchup.team2_id, function(err2, team2Players) {
                if (err2) return callback(err2);
                
                // Get ELO ratings
                getLatestEloForTeam(matchup.team1_id, function(err3, team1Elo) {
                    if (err3) return callback(err3);
                    
                    getLatestEloForTeam(matchup.team2_id, function(err4, team2Elo) {
                        if (err4) return callback(err4);
                        
                        // Calculate betting odds and probabilities
                        const calculateBettingData = function(elo1, elo2) {
                            // Calculate win probability for team 1 using ELO formula
                            const prob1 = 1 / (1 + Math.pow(10, (elo2 - elo1) / 400));
                            const prob2 = 1 - prob1;
                            
                            // Convert probabilities to American odds
                            const getAmericanOdds = function(probability) {
                                if (probability > 0.5) {
                                    return Math.round(-(probability / (1 - probability)) * 100);
                                } else {
                                    return Math.round(((1 - probability) / probability) * 100);
                                }
                            };
                            
                            return {
                                team1_odds: getAmericanOdds(prob1),
                                team2_odds: getAmericanOdds(prob2),
                                team1_probability: Math.round(prob1 * 100),
                                team2_probability: Math.round(prob2 * 100),
                                team1_elo: elo1,
                                team2_elo: elo2
                            };
                        };
                        
                        const bettingData = calculateBettingData(team1Elo, team2Elo);
                        
                        // Add all data to matchup object
                        matchup.team1_roster = team1Players || [];
                        matchup.team2_roster = team2Players || [];
                        matchup.team1_odds = bettingData.team1_odds;
                        matchup.team2_odds = bettingData.team2_odds;
                        matchup.team1_probability = bettingData.team1_probability;
                        matchup.team2_probability = bettingData.team2_probability;
                        matchup.team1_elo = bettingData.team1_elo;
                        matchup.team2_elo = bettingData.team2_elo;
                        
                        callback(null, matchup);
                    });
                });
            });
        });
    });
}

// Cast vote in tournament matchup
function castTournamentVote(db, matchupId, teamId, voterId, callback) {
    // First, get the matchup to validate
    db.get('SELECT * FROM tournament_matchups WHERE id = ?', [matchupId], (err, matchup) => {
        if (err) return callback(err);
        if (!matchup) return callback(new Error('Matchup not found'));
        if (matchup.status !== 'active') return callback(new Error('Matchup is not active for voting'));
        if (teamId !== matchup.team1_id && teamId !== matchup.team2_id) {
            return callback(new Error('Invalid team for this matchup'));
        }
        
        // Insert or replace vote
        db.run(`
            INSERT OR REPLACE INTO tournament_votes (matchup_id, team_id, voter_id)
            VALUES (?, ?, ?)
        `, [matchupId, teamId, voterId], (err) => {
            if (err) return callback(err);
            
            // Check if matchup is complete (first to 4 votes wins)
            getTournamentVoteCounts(db, matchupId, (err, voteCount) => {
                if (err) return callback(err);
                
                const votesNeeded = matchup.votes_needed || 4;
                
                if (voteCount.team1_votes >= votesNeeded || voteCount.team2_votes >= votesNeeded) {
                    completeTournamentMatchup(db, matchupId, voteCount, matchup, callback);
                } else {
                    callback(null, voteCount);
                }
            });
        });
    });
}

// Get vote counts for a matchup
function getTournamentVoteCounts(db, matchupId, callback) {
    db.get('SELECT * FROM tournament_matchups WHERE id = ?', [matchupId], (err, matchup) => {
        if (err) return callback(err);
        
        db.get(
            'SELECT COUNT(*) as count FROM tournament_votes WHERE matchup_id = ? AND team_id = ?',
            [matchupId, matchup.team1_id],
            (err, team1Result) => {
                if (err) return callback(err);
                
                db.get(
                    'SELECT COUNT(*) as count FROM tournament_votes WHERE matchup_id = ? AND team_id = ?',
                    [matchupId, matchup.team2_id],
                    (err, team2Result) => {
                        if (err) return callback(err);
                        
                        callback(null, {
                            team1_votes: team1Result.count,
                            team2_votes: team2Result.count,
                            votes_needed: matchup.votes_needed || 4
                        });
                    }
                );
            }
        );
    });
}

// Complete a matchup and advance winner
function completeTournamentMatchup(db, matchupId, voteCount, matchup, callback) {
    const winnerId = voteCount.team1_votes >= (matchup.votes_needed || 4) ? matchup.team1_id : matchup.team2_id;
    
    // Update matchup as completed
    db.run(`
        UPDATE tournament_matchups 
        SET status = 'completed', winner_id = ?, completed_at = datetime('now')
        WHERE id = ?
    `, [winnerId, matchupId], (err) => {
        if (err) return callback(err);
        
        console.log(`Matchup ${matchupId} completed. Winner: ${winnerId}`);
        
        // Advance winner to next round
        advanceTournamentWinner(db, matchup, winnerId, (err) => {
            if (err) return callback(err);
            
            // Check if we should activate next matchup
            activateNextTournamentMatchup(db, matchup.tournament_id, (err, nextMatchup) => {
                if (err) return callback(err);
                
                callback(null, { 
                    winnerId, 
                    voteCount, 
                    nextMatchup,
                    completed: true 
                });
            });
        });
    });
}

// Advance winner to parent matchup
function advanceTournamentWinner(db, matchup, winnerId, callback) {
    if (!matchup.parent_matchup_id) {
        // This was the final - tournament complete!
        completeTournament(db, matchup.tournament_id, winnerId, callback);
        return;
    }
    
    const teamColumn = matchup.parent_position === 1 ? 'team1_id' : 'team2_id';
    
    db.run(`
        UPDATE tournament_matchups 
        SET ${teamColumn} = ?
        WHERE id = ?
    `, [winnerId, matchup.parent_matchup_id], (err) => {
        if (err) return callback(err);
        
        console.log(`Advanced ${winnerId} to parent matchup ${matchup.parent_matchup_id}`);
        callback(null);
    });
}

// Activate next round (activates all matchups in the next round)
function activateNextTournamentMatchup(db, tournamentId, callback) {
    // Check if current round is finished (all active matchups have winners)
    db.get(`
        SELECT COUNT(*) as unfinished_count
        FROM tournament_matchups 
        WHERE tournament_id = ? 
            AND status = 'active' 
            AND winner_id IS NULL
    `, [tournamentId], (err, result) => {
        if (err) return callback(err);
        
        if (result.unfinished_count > 0) {
            return callback(null, { message: `Current round still has ${result.unfinished_count} unfinished matchups` });
        }
        
        // Current round is finished, find the next round to activate
        db.get(`
            SELECT MIN(round_number) as next_round
            FROM tournament_matchups tm
            WHERE tm.tournament_id = ? 
                AND tm.status = 'pending'
                AND tm.team1_id IS NOT NULL 
                AND tm.team2_id IS NOT NULL
        `, [tournamentId], (err, nextRoundResult) => {
            if (err) return callback(err);
            if (!nextRoundResult.next_round) return callback(null, { message: 'Tournament complete - no more rounds to activate' });
            
            const nextRound = nextRoundResult.next_round;
            
            // Activate all matchups in the next round
            db.run(`
                UPDATE tournament_matchups 
                SET status = 'active' 
                WHERE tournament_id = ? 
                    AND round_number = ?
                    AND team1_id IS NOT NULL 
                    AND team2_id IS NOT NULL
            `, [tournamentId, nextRound], (err) => {
                if (err) return callback(err);
                
                // Get the count of activated matchups
                db.get(`
                    SELECT COUNT(*) as count
                    FROM tournament_matchups 
                    WHERE tournament_id = ? AND round_number = ? AND status = 'active'
                `, [tournamentId, nextRound], (err, result) => {
                    if (err) return callback(err);
                    console.log(`Activated ${result.count} matchups in round ${nextRound} for tournament ${tournamentId}`);
                    callback(null, { activated_matchups: result.count, round: nextRound, success: true });
                });
            });
        });
    });
}

// Complete tournament
function completeTournament(db, tournamentId, winnerId, callback) {
    db.run(`
        UPDATE tournaments 
        SET status = 'completed', end_date = datetime('now')
        WHERE id = ?
    `, [tournamentId], (err) => {
        if (err) return callback(err);
        
        console.log(`🏆 Tournament ${tournamentId} completed! Winner: ${winnerId}`);
        
        // Generate final results
        generateTournamentResults(db, tournamentId, winnerId, callback);
    });
}

// Generate tournament results for historical tracking
function generateTournamentResults(db, tournamentId, winnerId, callback) {
    db.run(`
        INSERT OR REPLACE INTO tournament_results 
        (tournament_id, team_id, final_position, rounds_won)
        VALUES (?, ?, 1, 
            (SELECT COUNT(*) FROM tournament_matchups 
             WHERE tournament_id = ? AND winner_id = ?))
    `, [tournamentId, winnerId, tournamentId, winnerId], callback);
}

// Get tournament bracket view
function getTournamentBracket(db, tournamentId, callback) {
    const query = `
        SELECT 
            tm.*,
            t1.username as team1_username,
            t1.draft_id as team1_draft_id,
            t2.username as team2_username,
            t2.draft_id as team2_draft_id,
            w.username as winner_username,
            (SELECT COUNT(*) FROM tournament_votes tv WHERE tv.matchup_id = tm.id AND tv.team_id = tm.team1_id) as team1_votes,
            (SELECT COUNT(*) FROM tournament_votes tv WHERE tv.matchup_id = tm.id AND tv.team_id = tm.team2_id) as team2_votes
        FROM tournament_matchups tm
        LEFT JOIN teams t1 ON tm.team1_id = t1.id
        LEFT JOIN teams t2 ON tm.team2_id = t2.id
        LEFT JOIN teams w ON tm.winner_id = w.id
        WHERE tm.tournament_id = ?
        ORDER BY tm.round_number, tm.bracket_position
    `;
    
    db.all(query, [tournamentId], (err, matchups) => {
        if (err) return callback(err);
        
        // Group by rounds
        const bracket = {};
        matchups.forEach(matchup => {
            if (!bracket[matchup.round_number]) {
                bracket[matchup.round_number] = [];
            }
            bracket[matchup.round_number].push(matchup);
        });
        
        callback(null, bracket);
    });
}

// Initialize tournament (activate all round 1 matchups)
function initializeTournament(db, tournamentId, callback) {
    db.run(`
        UPDATE tournaments 
        SET status = 'active', start_date = datetime('now')
        WHERE id = ?
    `, [tournamentId], (err) => {
        if (err) return callback(err);
        
        // Activate ALL matchups in round 1
        db.run(`
            UPDATE tournament_matchups 
            SET status = 'active' 
            WHERE tournament_id = ? 
                AND round_number = 1
                AND team1_id IS NOT NULL 
                AND team2_id IS NOT NULL
        `, [tournamentId], (err) => {
            if (err) return callback(err);
            
            // Get the count of activated matchups
            db.get(`
                SELECT COUNT(*) as count
                FROM tournament_matchups 
                WHERE tournament_id = ? AND round_number = 1 AND status = 'active'
            `, [tournamentId], (err, result) => {
                if (err) return callback(err);
                console.log(`Activated ${result.count} matchups in round 1 for tournament ${tournamentId}`);
                callback(null, { activated_matchups: result.count, round: 1 });
            });
        });
    });
}

// Enhanced vote casting that returns detailed results
function castTournamentVoteWithResults(db, matchupId, teamId, voterId, callback) {
    // First, get the matchup to validate
    db.get('SELECT * FROM tournament_matchups WHERE id = ?', [matchupId], (err, matchup) => {
        if (err) return callback(err);
        if (!matchup) return callback(new Error('Matchup not found'));
        if (matchup.status !== 'active') return callback(new Error('Matchup is not active for voting'));
        if (teamId !== matchup.team1_id && teamId !== matchup.team2_id) {
            return callback(new Error('Invalid team for this matchup'));
        }
        
        // Get current ELO ratings before vote
        const getEloRating = (tId, cb) => {
            db.get('SELECT elo FROM elo_ratings WHERE team_id = ? ORDER BY created_at DESC LIMIT 1', [tId], (err, result) => {
                if (err) return cb(err);
                cb(null, result ? result.elo : 1500);
            });
        };
        
        getEloRating(matchup.team1_id, (err1, team1OldElo) => {
            if (err1) return callback(err1);
            
            getEloRating(matchup.team2_id, (err2, team2OldElo) => {
                if (err2) return callback(err2);
                
                // Insert or replace vote
                db.run(`
                    INSERT OR REPLACE INTO tournament_votes (matchup_id, team_id, voter_id)
                    VALUES (?, ?, ?)
                `, [matchupId, teamId, voterId], (err) => {
                    if (err) return callback(err);
                    
                    // Check if matchup is complete (first to 4 votes wins)
                    getTournamentVoteCounts(db, matchupId, (err, voteCount) => {
                        if (err) return callback(err);
                        
                        const votesNeeded = matchup.votes_needed || 4;
                        const totalVotes = voteCount.team1_votes + voteCount.team2_votes;
                        
                        // Return current state with vote counts and ELO data
                        callback(null, {
                            completed: false,
                            voteCount,
                            totalVotes,
                            eloData: {
                                team1_old_elo: team1OldElo,
                                team2_old_elo: team2OldElo,
                                team1_new_elo: team1OldElo, // No change until matchup completes
                                team2_new_elo: team2OldElo, // No change until matchup completes
                                team1_elo_delta: 0,
                                team2_elo_delta: 0
                            }
                        });
                    });
                });
            });
        });
    });
}

module.exports = {
    getCurrentTournamentMatchup,
    castTournamentVote,
    castTournamentVoteWithResults,
    getTournamentVoteCounts,
    getTournamentBracket,
    initializeTournament,
    activateNextTournamentMatchup
};