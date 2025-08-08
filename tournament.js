// Tournament frontend functionality
// This file handles the tournament voting interface and bracket display

let currentMatchup = null;
let tournamentId = null; // Will be set dynamically from API
let pollInterval = null;

// Load current tournament ID
async function loadCurrentTournamentId() {
    try {
        const response = await fetch('/api/tournament/current');
        const data = await response.json();
        if (data.tournament) {
            tournamentId = data.tournament.id;
            console.log('Tournament ID loaded:', tournamentId);
            return tournamentId;
        } else {
            console.error('No current tournament found');
            return null;
        }
    } catch (err) {
        console.error('Failed to load tournament ID:', err);
        return null;
    }
}

// Initialize tournament functionality
async function initializeTournament() {
    console.log('Initializing tournament system...');
    
    // Load tournament ID first
    await loadCurrentTournamentId();
    if (!tournamentId) {
        console.error('Cannot initialize tournament without valid tournament ID');
        return;
    }
    
    loadCurrentMatchup();
    loadTournamentBracket();
    loadNominationsCount();
    
    // Poll for updates every 10 seconds
    pollInterval = setInterval(() => {
        loadCurrentMatchup();
        loadTournamentBracket();
        loadNominationsCount();
    }, 10000);
    
    console.log('Tournament system initialized');
}

// Load current active matchup for voting
async function loadCurrentMatchup() {
    try {
        console.log('Loading current matchup for tournament:', tournamentId);
        const response = await fetch(`/api/tournament/current-matchup/${tournamentId}`);
        const data = await response.json();
        console.log('Current matchup response:', data);
        
        if (data.matchup) {
            currentMatchup = data.matchup;
            console.log('Displaying matchup:', data.matchup);
            displayTournamentMatchup(data.matchup);
        } else {
            console.log('No active matchup:', data.message);
            displayNoActiveMatchup(data.message);
        }
    } catch (error) {
        console.error('Error loading current matchup:', error);
        displayError('Failed to load current matchup');
    }
}

// Display the current tournament matchup for voting
function displayTournamentMatchup(matchup) {
    const container = document.getElementById('teamsContainer');
    if (!container) return;
    
    const team1VotesNeeded = (matchup.votes_needed || 4) - matchup.team1_votes;
    const team2VotesNeeded = (matchup.votes_needed || 4) - matchup.team2_votes;
    
    container.innerHTML = `
        <div class="tournament-matchup">
            <div class="matchup-header">
                <h3>Round ${matchup.round_number} - Match ${matchup.bracket_position}</h3>
                <p class="matchup-subtitle">First to ${matchup.votes_needed || 4} votes wins!</p>
            </div>
            
            <div class="teams-grid">
                <div class="team-card tournament-team" data-team-id="${matchup.team1_id}">
                    <div class="team-header">
                        <h4>${matchup.team1_username}</h4>
                        <span class="draft-id">${matchup.team1_draft_id}</span>
                    </div>
                    
                    <div class="vote-section">
                        <div class="vote-count">
                            <span class="votes">${matchup.team1_votes}</span>
                            <span class="votes-label">votes</span>
                        </div>
                        <div class="votes-needed">
                            ${team1VotesNeeded > 0 ? `${team1VotesNeeded} more needed` : 'WINNER!'}
                        </div>
                        <button class="vote-btn team1-vote" onclick="castTournamentVote('${matchup.id}', '${matchup.team1_id}')" 
                                ${team1VotesNeeded <= 0 || team2VotesNeeded <= 0 ? 'disabled' : ''}>
                            Vote for ${matchup.team1_username}
                        </button>
                    </div>
                </div>
                
                <div class="matchup-vs">
                    <span>VS</span>
                </div>
                
                <div class="team-card tournament-team" data-team-id="${matchup.team2_id}">
                    <div class="team-header">
                        <h4>${matchup.team2_username}</h4>
                        <span class="draft-id">${matchup.team2_draft_id}</span>
                    </div>
                    
                    <div class="vote-section">
                        <div class="vote-count">
                            <span class="votes">${matchup.team2_votes}</span>
                            <span class="votes-label">votes</span>
                        </div>
                        <div class="votes-needed">
                            ${team2VotesNeeded > 0 ? `${team2VotesNeeded} more needed` : 'WINNER!'}
                        </div>
                        <button class="vote-btn team2-vote" onclick="castTournamentVote('${matchup.id}', '${matchup.team2_id}')"
                                ${team2VotesNeeded <= 0 || team1VotesNeeded <= 0 ? 'disabled' : ''}>
                            Vote for ${matchup.team2_username}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// Display message when no active matchup
function displayNoActiveMatchup(message) {
    const container = document.getElementById('teamsContainer');
    if (!container) return;
    
    container.innerHTML = `
        <div class="no-matchup">
            <h3>Tournament Status</h3>
            <p>${message || 'No active matchup at this time.'}</p>
            <p>Check back soon for the next round!</p>
        </div>
    `;
}

// Display error message
function displayError(message) {
    const container = document.getElementById('teamsContainer');
    if (!container) return;
    
    container.innerHTML = `
        <div class="error-message">
            <h3>Error</h3>
            <p>${message}</p>
            <button onclick="loadCurrentMatchup()">Try Again</button>
        </div>
    `;
}

// Cast vote for a team in tournament matchup
async function castTournamentVote(matchupId, teamId) {
    try {
        const response = await fetch('/api/tournament/vote', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                matchupId: parseInt(matchupId),
                teamId: teamId
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            // Show success feedback
            showVoteFeedback('Vote cast successfully!', 'success');
            
            // Immediately reload the matchup to show updated vote counts
            setTimeout(() => {
                loadCurrentMatchup();
                if (data.completed) {
                    // If matchup completed, also reload bracket
                    loadTournamentBracket();
                }
            }, 500);
        } else {
            showVoteFeedback(data.error || 'Failed to cast vote', 'error');
        }
    } catch (error) {
        console.error('Error casting vote:', error);
        showVoteFeedback('Network error - please try again', 'error');
    }
}

// Show vote feedback message
function showVoteFeedback(message, type) {
    // Remove existing feedback
    const existing = document.querySelector('.vote-feedback');
    if (existing) existing.remove();
    
    const feedback = document.createElement('div');
    feedback.className = `vote-feedback ${type}`;
    feedback.textContent = message;
    
    // Add to top of teams container
    const container = document.getElementById('teamsContainer');
    if (container) {
        container.insertBefore(feedback, container.firstChild);
        
        // Remove after 3 seconds
        setTimeout(() => {
            feedback.remove();
        }, 3000);
    }
}

// Load and display tournament bracket
async function loadTournamentBracket() {
    try {
        console.log('Loading tournament bracket for:', tournamentId);
        const response = await fetch(`/api/tournament/bracket/${tournamentId}`);
        const data = await response.json();
        console.log('Bracket response:', data);
        
        if (data.bracket) {
            console.log('Displaying bracket with', Object.keys(data.bracket).length, 'rounds');
            displayTournamentBracket(data.bracket);
        } else {
            console.log('No bracket data received');
        }
    } catch (error) {
        console.error('Error loading tournament bracket:', error);
    }
}

// Display tournament bracket
function displayTournamentBracket(bracket) {
    const bracketContainer = document.querySelector('.bracket-container');
    if (!bracketContainer) return;
    
    const rounds = Object.keys(bracket).sort((a, b) => parseInt(a) - parseInt(b));
    
    if (rounds.length === 0) {
        bracketContainer.innerHTML = `
            <div class="bracket-placeholder">
                <h3>Tournament Bracket</h3>
                <p>No bracket data available yet.</p>
            </div>
        `;
        return;
    }
    
    let bracketHTML = '<div class="bracket-grid">';
    
    rounds.forEach(round => {
        const roundNumber = parseInt(round);
        const roundName = getRoundName(roundNumber, rounds.length);
        const matchups = bracket[round];
        
        bracketHTML += `
            <div class="bracket-round">
                <h4 class="round-title">${roundName}</h4>
                <div class="round-matchups">
        `;
        
        matchups.forEach(matchup => {
            const team1Status = getTeamStatus(matchup, matchup.team1_id);
            const team2Status = getTeamStatus(matchup, matchup.team2_id);
            
            // Only add click handler if both teams are present
            const clickable = matchup.team1_id && matchup.team2_id;
            const clickHandler = clickable ? `onclick="showMatchupPopup(${matchup.id})"` : '';
            const clickableClass = clickable ? 'clickable' : '';
            
            bracketHTML += `
                <div class="bracket-matchup ${matchup.status} ${clickableClass}" ${clickHandler} data-matchup-id="${matchup.id}">
                    <div class="bracket-team ${team1Status}" data-team-id="${matchup.team1_id || ''}">
                        <span class="team-name">${matchup.team1_username || 'TBD'}</span>
                        <span class="team-votes">${matchup.team1_votes || 0}</span>
                    </div>
                    <div class="bracket-vs">vs</div>
                    <div class="bracket-team ${team2Status}" data-team-id="${matchup.team2_id || ''}">
                        <span class="team-name">${matchup.team2_username || 'TBD'}</span>
                        <span class="team-votes">${matchup.team2_votes || 0}</span>
                    </div>
                </div>
            `;
        });
        
        bracketHTML += `
                </div>
            </div>
        `;
    });
    
    bracketHTML += '</div>';
    bracketContainer.innerHTML = bracketHTML;
}

// Get round name based on round number and total rounds
function getRoundName(roundNumber, totalRounds) {
    const roundsFromEnd = totalRounds - roundNumber + 1;
    
    switch (roundsFromEnd) {
        case 1: return 'Final';
        case 2: return 'Semifinals';
        case 3: return 'Quarterfinals';
        default: return `Round ${roundNumber}`;
    }
}

// Get team status for styling
function getTeamStatus(matchup, teamId) {
    if (!teamId) return 'empty';
    if (matchup.winner_id === teamId) return 'winner';
    if (matchup.status === 'active') return 'active';
    return 'pending';
}

// Show matchup popup with team details
async function showMatchupPopup(matchupId) {
    try {
        // Show loading state
        showPopupLoading();
        
        // Fetch detailed matchup information
        const response = await fetch(`/api/tournament/matchup/${matchupId}`);
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || 'Failed to load matchup details');
        }
        
        if (data.matchup) {
            displayMatchupPopup(data.matchup);
        } else {
            throw new Error('No matchup data received');
        }
    } catch (error) {
        console.error('Error loading matchup popup:', error);
        showPopupError('Failed to load matchup details');
    }
}

// Display the matchup popup
function displayMatchupPopup(matchup) {
    const modal = getOrCreateModal();
    
    const team1VotesNeeded = (matchup.votes_needed || 4) - (matchup.team1_votes || 0);
    const team2VotesNeeded = (matchup.votes_needed || 4) - (matchup.team2_votes || 0);
    const roundName = getRoundName(matchup.round_number, 8); // Assuming 8 total rounds
    
    const modalContent = `
        <div class="modal-header">
            <h2>${roundName} - Match ${matchup.bracket_position}</h2>
            <p class="matchup-status">
                ${matchup.status === 'completed' ? `Winner: ${matchup.winner_username}` : 
                  matchup.status === 'active' ? `First to ${matchup.votes_needed || 4} votes wins!` : 
                  'Pending'}
            </p>
            <button class="modal-close" onclick="closeMatchupPopup()">&times;</button>
        </div>
        
        <div class="modal-body">
            <div class="teams-comparison">
                <div class="team-column">
                    <div class="team-header ${matchup.winner_id === matchup.team1_id ? 'winner' : ''}">
                        <h3>${matchup.team1_username || 'TBD'}</h3>
                        <div class="team-meta">
                            <span class="draft-id">${matchup.team1_draft_id || ''}</span>
                            <div class="vote-info">
                                <span class="votes">${matchup.team1_votes || 0} votes</span>
                                ${matchup.status === 'active' && team1VotesNeeded > 0 ? 
                                  `<span class="votes-needed">${team1VotesNeeded} more needed</span>` : ''}
                            </div>
                        </div>
                    </div>
                    ${generatePopupRoster(matchup.team1_roster)}
                </div>
                
                <div class="vs-divider">
                    <span class="vs-text">VS</span>
                </div>
                
                <div class="team-column">
                    <div class="team-header ${matchup.winner_id === matchup.team2_id ? 'winner' : ''}">
                        <h3>${matchup.team2_username || 'TBD'}</h3>
                        <div class="team-meta">
                            <span class="draft-id">${matchup.team2_draft_id || ''}</span>
                            <div class="vote-info">
                                <span class="votes">${matchup.team2_votes || 0} votes</span>
                                ${matchup.status === 'active' && team2VotesNeeded > 0 ? 
                                  `<span class="votes-needed">${team2VotesNeeded} more needed</span>` : ''}
                            </div>
                        </div>
                    </div>
                    ${generatePopupRoster(matchup.team2_roster)}
                </div>
            </div>
        </div>
    `;
    
    modal.innerHTML = modalContent;
    modal.style.display = 'flex';
    document.body.classList.add('modal-open');
}

// Generate roster HTML for popup
function generatePopupRoster(roster) {
    if (!roster || !roster.length) {
        return '<div class="no-roster">No roster data available</div>';
    }
    
    // Count positions for roster construction
    const counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
    roster.forEach(p => { if (counts[p.position] !== undefined) counts[p.position]++; });
    
    const rosterConstructionHTML = `
        <div class="roster-construction">
            <div class="roster-counts">QB${counts.QB} | RB${counts.RB} | WR${counts.WR} | TE${counts.TE}</div>
        </div>
    `;
    
    // Generate player list HTML
    const playerListHTML = roster.map(player => {
        const stackStar = player.stack ? `<span class="stack-star ${player.stack}">★</span>` : '';
        const pickHTML = (player.pick || player.pick === 0) ? `<span class="pick-num">#${player.pick}</span>` : '';
        const infoHTML = `<span class="player-info">${player.name}${player.team ? ` - ${player.team}` : ''}</span>`;
        
        return `
            <div class="player-row">
                <div class="player-bubble" style="border: 2px solid ${getPositionColor(player.position)}">
                    ${pickHTML}${infoHTML}${stackStar}
                </div>
            </div>
        `;
    }).join('');
    
    return `
        ${rosterConstructionHTML}
        <div class="player-list">
            ${playerListHTML}
        </div>
    `;
}

// Get position color (same as existing system)
function getPositionColor(position) {
    const colors = {
        QB: '#a855f7', // Purple
        RB: '#22c55e', // Green
        WR: '#facc15', // Yellow
        TE: '#3b82f6'  // Blue
    };
    return colors[position] || '#999999';
}

// Modal utility functions
function getOrCreateModal() {
    let modal = document.getElementById('matchupModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'matchupModal';
        modal.className = 'matchup-modal';
        document.body.appendChild(modal);
        
        // Close modal when clicking outside
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeMatchupPopup();
            }
        });
        
        // Close modal on Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal.style.display === 'flex') {
                closeMatchupPopup();
            }
        });
    }
    return modal;
}

function showPopupLoading() {
    const modal = getOrCreateModal();
    modal.innerHTML = `
        <div class="modal-loading">
            <div class="loading-spinner"></div>
            <p>Loading matchup details...</p>
        </div>
    `;
    modal.style.display = 'flex';
    document.body.classList.add('modal-open');
}

function showPopupError(message) {
    const modal = getOrCreateModal();
    modal.innerHTML = `
        <div class="modal-error">
            <h3>Error</h3>
            <p>${message}</p>
            <button onclick="closeMatchupPopup()">Close</button>
        </div>
    `;
    modal.style.display = 'flex';
    document.body.classList.add('modal-open');
}

function closeMatchupPopup() {
    const modal = document.getElementById('matchupModal');
    if (modal) {
        modal.style.display = 'none';
        document.body.classList.remove('modal-open');
    }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    // Only initialize if we're on the tournament page
    if (document.getElementById('teamsContainer')) {
        initializeTournament();
    }
});

// Load tournament nominations count
async function loadNominationsCount() {
    try {
        const response = await fetch(`/api/tournament/nominations-count/The Puppy`);
        const data = await response.json();
        
        if (response.ok) {
            const countElement = document.getElementById('teamsCount');
            if (countElement) {
                countElement.textContent = data.count;
                
                // Add visual feedback based on how full the tournament is
                const percentage = (data.count / data.max) * 100;
                const counterDisplay = countElement.parentElement;
                
                if (percentage >= 90) {
                    counterDisplay.className = 'counter-display almost-full';
                } else if (percentage >= 75) {
                    counterDisplay.className = 'counter-display getting-full';
                } else {
                    counterDisplay.className = 'counter-display';
                }
            }
        } else {
            console.error('Error loading nominations count:', data.error);
        }
    } catch (error) {
        console.error('Error loading nominations count:', error);
    }
}

// Clean up interval when page unloads
window.addEventListener('beforeunload', function() {
    if (pollInterval) {
        clearInterval(pollInterval);
    }
});