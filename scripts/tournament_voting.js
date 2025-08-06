// Tournament voting system
// Add these functions to your main server file or create API endpoints

const sqlite3 = require('sqlite3').verbose();

class TournamentVoting {
    constructor(dbPath) {
        this.db = new sqlite3.Database(dbPath);
    }
    
    // Get a random unfinished matchup from the current active round that the user hasn't voted on
    getCurrentMatchup(tournamentId, userId = null) {
        if (!userId) {
            return null; // User must be logged in
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
            ORDER BY RANDOM()
            LIMIT 1
        `;
        
        const matchup = this.db.prepare(query).get(tournamentId, userId);
        
        if (!matchup) {
            // Check if user has voted on all active matchups in current round
            const stats = this.db.prepare(`
                SELECT COUNT(*) as total_active,
                       (SELECT COUNT(DISTINCT matchup_id) 
                        FROM tournament_votes 
                        WHERE voter_id = ? 
                        AND matchup_id IN (
                            SELECT id FROM tournament_matchups 
                            WHERE tournament_id = ? 
                            AND status = 'active' 
                            AND winner_id IS NULL
                        )) as user_voted
                FROM tournament_matchups 
                WHERE tournament_id = ? 
                AND status = 'active' 
                AND winner_id IS NULL
            `).get(userId, tournamentId, tournamentId);
            
            if (stats.total_active > 0 && stats.user_voted >= stats.total_active) {
                return { 
                    allVoted: true, 
                    message: "You've voted on every matchup this round. Please return when the next round starts." 
                };
            } else {
                return { 
                    noMatchups: true, 
                    message: "No active matchups available at this time." 
                };
            }
        }
        
        return matchup;
    }
    
    // Get next pending matchup to activate
    getNextPendingMatchup(tournamentId) {
        const query = `
            SELECT 
                tm.*,
                t1.username as team1_username,
                t2.username as team2_username
            FROM tournament_matchups tm
            LEFT JOIN teams t1 ON tm.team1_id = t1.id
            LEFT JOIN teams t2 ON tm.team2_id = t2.id
            WHERE tm.tournament_id = ? 
                AND tm.status = 'pending'
                AND tm.team1_id IS NOT NULL 
                AND tm.team2_id IS NOT NULL
            ORDER BY tm.round_number, tm.bracket_position
            LIMIT 1
        `;
        
        return this.db.prepare(query).get(tournamentId);
    }
    
    // Cast vote in tournament matchup
    castVote(matchupId, teamId, voterId = null) {
        const matchup = this.db.prepare('SELECT * FROM tournament_matchups WHERE id = ?').get(matchupId);
        
        if (!matchup) {
            throw new Error('Matchup not found');
        }
        
        if (matchup.status !== 'active') {
            throw new Error('Matchup is not active for voting');
        }
        
        if (teamId !== matchup.team1_id && teamId !== matchup.team2_id) {
            throw new Error('Invalid team for this matchup');
        }
        
        // Insert or replace vote
        const insertVote = this.db.prepare(`
            INSERT OR REPLACE INTO tournament_votes (matchup_id, team_id, voter_id)
            VALUES (?, ?, ?)
        `);
        
        insertVote.run(matchupId, teamId, voterId);
        
        // Check if matchup is complete (first to 4 votes wins)
        const voteCount = this.getVoteCounts(matchupId);
        const votesNeeded = matchup.votes_needed || 4;
        
        if (voteCount.team1_votes >= votesNeeded || voteCount.team2_votes >= votesNeeded) {
            this.completeMatchup(matchupId, voteCount);
        }
        
        return voteCount;
    }
    
    // Get vote counts for a matchup
    getVoteCounts(matchupId) {
        const matchup = this.db.prepare('SELECT * FROM tournament_matchups WHERE id = ?').get(matchupId);
        
        const team1Votes = this.db.prepare(
            'SELECT COUNT(*) as count FROM tournament_votes WHERE matchup_id = ? AND team_id = ?'
        ).get(matchupId, matchup.team1_id).count;
        
        const team2Votes = this.db.prepare(
            'SELECT COUNT(*) as count FROM tournament_votes WHERE matchup_id = ? AND team_id = ?'
        ).get(matchupId, matchup.team2_id).count;
        
        return {
            team1_votes: team1Votes,
            team2_votes: team2Votes,
            votes_needed: matchup.votes_needed || 4
        };
    }
    
    // Complete a matchup and advance winner
    completeMatchup(matchupId, voteCount) {
        const matchup = this.db.prepare('SELECT * FROM tournament_matchups WHERE id = ?').get(matchupId);
        const winnerId = voteCount.team1_votes >= (matchup.votes_needed || 4) ? matchup.team1_id : matchup.team2_id;
        
        // Update matchup as completed
        const updateMatchup = this.db.prepare(`
            UPDATE tournament_matchups 
            SET status = 'completed', winner_id = ?, completed_at = datetime('now')
            WHERE id = ?
        `);
        
        updateMatchup.run(winnerId, matchupId);
        
        // Advance winner to next round
        this.advanceWinner(matchup, winnerId);
        
        // Check if we should activate next matchup
        this.activateNextMatchup(matchup.tournament_id);
        
        console.log(`Matchup ${matchupId} completed. Winner: ${winnerId}`);
    }
    
    // Advance winner to parent matchup
    advanceWinner(matchup, winnerId) {
        if (!matchup.parent_matchup_id) {
            // This was the final - tournament complete!
            this.completeTournament(matchup.tournament_id, winnerId);
            return;
        }
        
        const updateParent = this.db.prepare(`
            UPDATE tournament_matchups 
            SET ${matchup.parent_position === 1 ? 'team1_id' : 'team2_id'} = ?
            WHERE id = ?
        `);
        
        updateParent.run(winnerId, matchup.parent_matchup_id);
        
        // Check if parent matchup is ready to be activated
        const parentMatchup = this.db.prepare('SELECT * FROM tournament_matchups WHERE id = ?').get(matchup.parent_matchup_id);
        
        if (parentMatchup.team1_id && parentMatchup.team2_id && parentMatchup.status === 'pending') {
            // Both teams are set, we can activate this matchup later
            console.log(`Parent matchup ${matchup.parent_matchup_id} is ready for activation`);
        }
    }
    
    // Activate next round (activates all matchups in the next round)
    activateNextMatchup(tournamentId) {
        // Check if current round is finished (all active matchups have winners)
        const unfinishedCount = this.db.prepare(`
            SELECT COUNT(*) as count
            FROM tournament_matchups 
            WHERE tournament_id = ? 
                AND status = 'active' 
                AND winner_id IS NULL
        `).get(tournamentId);
        
        if (unfinishedCount.count > 0) {
            return { message: `Current round still has ${unfinishedCount.count} unfinished matchups` };
        }
        
        // Current round is finished, find the next round to activate
        const nextRoundResult = this.db.prepare(`
            SELECT MIN(round_number) as next_round
            FROM tournament_matchups tm
            WHERE tm.tournament_id = ? 
                AND tm.status = 'pending'
                AND tm.team1_id IS NOT NULL 
                AND tm.team2_id IS NOT NULL
        `).get(tournamentId);
        
        if (!nextRoundResult.next_round) {
            return { message: 'Tournament complete - no more rounds to activate' };
        }
        
        const nextRound = nextRoundResult.next_round;
        
        // Activate all matchups in the next round
        const activateMatchups = this.db.prepare(`
            UPDATE tournament_matchups 
            SET status = 'active' 
            WHERE tournament_id = ? 
                AND round_number = ?
                AND team1_id IS NOT NULL 
                AND team2_id IS NOT NULL
        `);
        
        const result = activateMatchups.run(tournamentId, nextRound);
        console.log(`Activated ${result.changes} matchups in round ${nextRound} for tournament ${tournamentId}`);
        return { activated_matchups: result.changes, round: nextRound, success: true };
    }
    
    // Complete tournament
    completeTournament(tournamentId, winnerId) {
        const updateTournament = this.db.prepare(`
            UPDATE tournaments 
            SET status = 'completed', end_date = datetime('now')
            WHERE id = ?
        `);
        
        updateTournament.run(tournamentId);
        
        // Generate final results
        this.generateTournamentResults(tournamentId, winnerId);
        
        console.log(`🏆 Tournament ${tournamentId} completed! Winner: ${winnerId}`);
    }
    
    // Generate tournament results for historical tracking
    generateTournamentResults(tournamentId, winnerId) {
        // This is a complex function that would analyze all matchups
        // and determine final positions for all teams
        // For now, just record the winner
        
        const insertResult = this.db.prepare(`
            INSERT OR REPLACE INTO tournament_results 
            (tournament_id, team_id, final_position, rounds_won)
            VALUES (?, ?, 1, 
                (SELECT COUNT(*) FROM tournament_matchups 
                 WHERE tournament_id = ? AND winner_id = ?))
        `);
        
        insertResult.run(tournamentId, winnerId, tournamentId, winnerId);
    }
    
    // Get tournament bracket view
    getTournamentBracket(tournamentId) {
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
        
        const matchups = this.db.prepare(query).all(tournamentId);
        
        // Group by rounds
        const bracket = {};
        matchups.forEach(matchup => {
            if (!bracket[matchup.round_number]) {
                bracket[matchup.round_number] = [];
            }
            bracket[matchup.round_number].push(matchup);
        });
        
        return bracket;
    }
    
    // Initialize tournament (activate all round 1 matchups)
    initializeTournament(tournamentId) {
        const updateTournament = this.db.prepare(`
            UPDATE tournaments 
            SET status = 'active', start_date = datetime('now')
            WHERE id = ?
        `);
        
        updateTournament.run(tournamentId);
        
        // Activate ALL matchups in round 1
        const activateRound1 = this.db.prepare(`
            UPDATE tournament_matchups 
            SET status = 'active' 
            WHERE tournament_id = ? 
                AND round_number = 1
                AND team1_id IS NOT NULL 
                AND team2_id IS NOT NULL
        `);
        
        const result = activateRound1.run(tournamentId);
        console.log(`Activated ${result.changes} matchups in round 1 for tournament ${tournamentId}`);
        return { activated_matchups: result.changes, round: 1 };
    }
    
    close() {
        this.db.close();
    }
}

module.exports = TournamentVoting;