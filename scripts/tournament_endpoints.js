// Tournament API endpoints
// Add these to your main server file that has your Express app and db connection

const {
    getCurrentTournamentMatchup,
    castTournamentVote,
    castTournamentVoteWithResults,
    getTournamentBracket,
    initializeTournament,
    activateNextTournamentMatchup
} = require('./tournament_api');

// Tournament endpoints to add to your Express app:

// Get current tournament matchup for voting
app.get('/api/tournament/current-matchup/:tournamentId', (req, res) => {
    const { tournamentId } = req.params;
    const userId = req.user?.id || null;
    
    getCurrentTournamentMatchup(db, tournamentId, userId, (err, result) => {
        if (err) {
            console.error('Error getting current matchup:', err);
            return res.status(500).json({ error: 'Failed to get current matchup' });
        }
        
        if (!result) {
            return res.json({ 
                matchup: null, 
                requiresLogin: true,
                message: 'You must be logged in to vote in the tournament' 
            });
        }
        
        if (result.allVoted) {
            return res.json({ 
                matchup: null, 
                allVoted: true,
                message: result.message 
            });
        }
        
        if (result.noMatchups) {
            return res.json({ 
                matchup: null, 
                message: result.message 
            });
        }
        
        res.json({ matchup: result });
    });
});

// Cast vote in tournament matchup
app.post('/api/tournament/vote', (req, res) => {
    const { matchupId, teamId } = req.body;
    const voterId = req.user?.id || null; // Use authenticated user if available
    
    if (!matchupId || !teamId) {
        return res.status(400).json({ error: 'Missing matchupId or teamId' });
    }
    
    castTournamentVoteWithResults(db, matchupId, teamId, voterId, (err, result) => {
        if (err) {
            console.error('Error casting vote:', err);
            return res.status(400).json({ error: err.message });
        }
        
        res.json({ 
            success: true, 
            ...result,
            message: 'Vote cast successfully' 
        });
    });
});

// Get tournament bracket
app.get('/api/tournament/bracket/:tournamentId', (req, res) => {
    const { tournamentId } = req.params;
    
    getTournamentBracket(db, tournamentId, (err, bracket) => {
        if (err) {
            console.error('Error getting tournament bracket:', err);
            return res.status(500).json({ error: 'Failed to get tournament bracket' });
        }
        
        res.json({ bracket });
    });
});

// Initialize tournament (admin endpoint)
app.post('/api/tournament/initialize/:tournamentId', (req, res) => {
    const { tournamentId } = req.params;
    
    // Add admin check here if needed
    // if (!req.user?.isAdmin) return res.status(403).json({ error: 'Admin required' });
    
    initializeTournament(db, tournamentId, (err, firstMatchup) => {
        if (err) {
            console.error('Error initializing tournament:', err);
            return res.status(500).json({ error: 'Failed to initialize tournament' });
        }
        
        res.json({ 
            success: true, 
            message: 'Tournament initialized',
            firstMatchup 
        });
    });
});

// Manually activate next matchup (admin endpoint)
app.post('/api/tournament/activate-next/:tournamentId', (req, res) => {
    const { tournamentId } = req.params;
    
    // Add admin check here if needed
    // if (!req.user?.isAdmin) return res.status(403).json({ error: 'Admin required' });
    
    activateNextTournamentMatchup(db, tournamentId, (err, nextMatchup) => {
        if (err) {
            console.error('Error activating next matchup:', err);
            return res.status(500).json({ error: 'Failed to activate next matchup' });
        }
        
        if (nextMatchup) {
            res.json({ 
                success: true, 
                message: 'Next matchup activated',
                matchup: nextMatchup 
            });
        } else {
            res.json({ 
                success: false, 
                message: 'No matchups available to activate' 
            });
        }
    });
});

// Get tournament info
app.get('/api/tournament/info/:tournamentId', (req, res) => {
    try {
        const { tournamentId } = req.params;
        
        const tournament = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(tournamentId);
        
        if (!tournament) {
            return res.status(404).json({ error: 'Tournament not found' });
        }
        
        // Get tournament stats
        const stats = db.prepare(`
            SELECT 
                COUNT(*) as total_matchups,
                COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_matchups,
                COUNT(CASE WHEN status = 'active' THEN 1 END) as active_matchups,
                COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_matchups
            FROM tournament_matchups 
            WHERE tournament_id = ?
        `).get(tournamentId);
        
        res.json({ 
            tournament: {
                ...tournament,
                stats
            }
        });
    } catch (error) {
        console.error('Error getting tournament info:', error);
        res.status(500).json({ error: 'Failed to get tournament info' });
    }
});

// Export tournament functions
module.exports = {
    getCurrentTournamentMatchup,
    castTournamentVote,
    getTournamentBracket,
    initializeTournament,
    activateNextTournamentMatchup
};