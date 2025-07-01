let teams = [];
let currentIndex = 0;
let userVotes = {};
let teamTournaments = {};
let currentMode = "upload"; // 'upload' | 'versus' | 'leaderboard'
let leaderboardType = "team"; // 'team' or 'user'
let leaderboardData = [];
let sortKey = "wins";
let sortDir = "desc";
let teamUsernames = {};
const MAX_LEADERBOARD_ROWS = 150; // how many rows to actually render after sorting

document.addEventListener("DOMContentLoaded", () => {
  // initial state: upload mode visible
  const uploadButton = document.getElementById("uploadButton");
  const loginTwitterBtn = document.getElementById('loginTwitterBtn');
  const loginEmailForm = document.getElementById('loginEmailForm');
  const logoutBtn = document.getElementById('logoutBtn');
  const registerBtn = document.getElementById('registerBtn');
  const forgotPasswordLink = document.getElementById('forgotPasswordLink');
  const authStatus = document.getElementById('authStatus');
  const loginMessageEl = document.getElementById('loginMessage');
  const csvUpload = document.getElementById("csvUpload");
  const usernameInput = document.getElementById("usernameInput");
  const uploadPanel = document.querySelector('.upload-panel');
  const gearBtn = document.getElementById('userGear');
  const userMenu = document.getElementById('userMenu');
  const userLabel = document.getElementById('userLabel');
  const loginPanel = document.getElementById('loginPanel');

  // Mobile menu elements
  const hamburgerBtn = document.getElementById('hamburgerBtn');
  const mobileMenu = document.getElementById('mobileMenu');
  const closeMobileMenu = document.getElementById('closeMobileMenu');
  const mobileUserInfo = document.getElementById('mobileUserInfo');
  const mobileUserLabel = document.getElementById('mobileUserLabel');
  const mobileLogoutBtn = document.getElementById('mobileLogoutBtn');
  const mobileLoginPrompt = document.getElementById('mobileLoginPrompt');

  // Mobile menu functionality
  function toggleMobileMenu() {
    const isActive = mobileMenu.classList.contains('active');
    if (isActive) {
      closeMobileMenuFunc();
    } else {
      openMobileMenuFunc();
    }
  }

  function openMobileMenuFunc() {
    mobileMenu.classList.add('active');
    hamburgerBtn.classList.add('active');
    document.body.style.overflow = 'hidden'; // Prevent background scrolling
  }

  function closeMobileMenuFunc() {
    mobileMenu.classList.remove('active');
    hamburgerBtn.classList.remove('active');
    document.body.style.overflow = ''; // Restore scrolling
  }

  // Mobile menu event listeners
  hamburgerBtn.addEventListener('click', toggleMobileMenu);
  closeMobileMenu.addEventListener('click', closeMobileMenuFunc);
  
  // Close mobile menu when clicking outside the menu content
  mobileMenu.addEventListener('click', (e) => {
    if (e.target === mobileMenu) {
      closeMobileMenuFunc();
    }
  });

  // Mobile logout functionality
  mobileLogoutBtn.addEventListener('click', async () => {
    await fetch('/logout', { method: 'POST' });
    await refreshAuth();
    showLoginMessage('', '');
    closeMobileMenuFunc(); // Close menu after logout
  });

  async function refreshAuth() {
    const res = await fetch('/me');
    const data = await res.json();
    const loggedIn = !!data.user;
    if (loggedIn) {
      const displayName = data.user.display_name || data.user.email || 'User';
      
      // Update desktop user controls
      userLabel.textContent = displayName;
      gearBtn.style.display = 'inline-block';
      userMenu.style.display = 'none'; // Hide menu by default when logged in
      
      // Update mobile user controls
      mobileUserLabel.textContent = displayName;
      mobileUserInfo.style.display = 'block';
      mobileLoginPrompt.style.display = 'none';
      
      // Show upload section, hide login panel
      document.getElementById('uploadSection').style.display = 'block';
      loginPanel.style.display = 'none';
      
      // Enable upload controls
      usernameInput.disabled = false;
      csvUpload.disabled = !usernameInput.value.trim();
      uploadButton.disabled = !csvUpload.files.length || !usernameInput.value.trim();
      document.getElementById('uploadSection').style.opacity = '1';
    } else {
      // Update desktop user controls
      gearBtn.style.display = 'none';
      userMenu.style.display = 'none';
      
      // Update mobile user controls
      mobileUserInfo.style.display = 'none';
      mobileLoginPrompt.style.display = 'block';
      
      // In upload mode, show login panel and hide upload section
      if (currentMode === 'upload') {
        const uploadSection = document.getElementById('uploadSection');
        uploadSection.style.display = 'none';
        uploadSection.style.opacity = '0.4';
        loginPanel.style.display = 'block';
      }
      
      // Disable upload controls
      usernameInput.disabled = true;
      csvUpload.disabled = true;
      uploadButton.disabled = true;
    }
    showLoginMessage('', '');
  }

  function showLoginMessage(msg, type) {
    loginMessageEl.textContent = msg;
    loginMessageEl.style.display = msg ? 'block' : 'none';
    loginMessageEl.className = 'upload-message';
    if (type) loginMessageEl.classList.add(type);
  }

  // Event: Twitter login
  loginTwitterBtn.addEventListener('click', () => {
    window.location = '/auth/twitter';
  });

  // Event: Email login
  loginEmailForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    if (!email || !password) return;
    const res = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    if (res.ok) {
      await refreshAuth();
    } else {
      const err = await res.json().catch(() => ({}));
      showLoginMessage(err.error || 'Login failed', 'error');
    }
  });

  // Event: Register
  registerBtn.addEventListener('click', async () => {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    if (!email || !password) {
      showLoginMessage('Provide email and password', 'error');
      return;
    }
    const res = await fetch('/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    if (res.ok) {
      // automatically log in after register
      const loginRes = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      if (loginRes.ok) {
        await refreshAuth();
        showLoginMessage('Registration successful', 'success');
      } else {
        showLoginMessage('Registered but auto login failed. Please try logging in.', 'error');
      }
    } else {
      const err = await res.json().catch(() => ({}));
      showLoginMessage(err.error || 'Registration failed', 'error');
    }
  });

  // Event: logout (button inside menu now)
  logoutBtn.addEventListener("click", async () => {
    await fetch('/logout', { method: 'POST' });
    await refreshAuth();
    showLoginMessage('', '');
  });

  // Event: Forgot password
  forgotPasswordLink.addEventListener('click', async (e) => {
    e.preventDefault();
    const emailInput = document.getElementById('loginEmail');
    const email = emailInput.value.trim();
    if (!email) {
      showLoginMessage('Please enter your email address above first.', 'error');
      emailInput.focus();
      return;
    }

    const res = await fetch('/password-reset/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    if (res.ok) {
      showLoginMessage('If that email is registered, a reset link has been sent.', 'info');
    } else {
      showLoginMessage('Failed to initiate reset.', 'error');
    }
  });

  // Check auth on load and then set initial mode once we know auth state
  refreshAuth().then(() => {
    // Ensure correct initial layout after auth status is known
    setMode("upload");
  });

  // Enable/disable file input and upload button based on username presence
  usernameInput.addEventListener("input", (e) => {
    const val = e.target.value.trim();
    csvUpload.disabled = !val;
    if (!val) {
      uploadButton.disabled = true;
      csvUpload.value = ""; // Clear file input if username is cleared
    }
  });

  // Enable/disable upload button based on file selection
  csvUpload.addEventListener("change", (e) => {
    uploadButton.disabled = !e.target.files.length || !usernameInput.value.trim();
  });

  // Handle file upload when button is clicked
  uploadButton.addEventListener("click", () => {
    const file = csvUpload.files[0];
    const username = usernameInput.value.trim();

    if (!file || !username) {
      showUploadMessage("Please select a file and enter your username", "error");
      return;
    }

    const formData = new FormData();
    formData.append("csv", file);
    formData.append("username", username);

    uploadButton.disabled = true;
    showUploadMessage("Uploading...", "");

    fetch("/upload", {
      method: "POST",
      body: formData
    })
      .then(response => {
        if (!response.ok) {
          return response.json().then(err => {
            throw new Error(err.message || "Upload failed");
          });
        }
        return response.json();
      })
      .then(data => {
        // Clear inputs after any successful upload attempt
        csvUpload.value = "";
        usernameInput.value = "";
        csvUpload.disabled = true;
        uploadButton.disabled = true;

        if (data.message === "No new teams to add") {
          showUploadMessage("File processed - all teams were already in the database", "info");
        } else if (typeof data.added === 'number') {
          const pluralize = (n, singular) => `${n} ${singular}${n === 1 ? '' : 's'}`;

          const addedCount = data.added;
          const skippedInvalidCount = Array.isArray(data.skippedInvalid) ? data.skippedInvalid.length : (typeof data.skippedInvalid === 'number' ? data.skippedInvalid : 0);
          const existingCount = Array.isArray(data.skippedExisting) ? data.skippedExisting.length : (typeof data.skippedExisting === 'number' ? data.skippedExisting : 0);

          const parts = [pluralize(addedCount, 'team') + ' added'];
          if (skippedInvalidCount > 0) parts.push(pluralize(skippedInvalidCount, 'team') + ' skipped');
          if (existingCount > 0) parts.push(pluralize(existingCount, 'team') + ' already exist');

          const msg = parts.join(', ');
          const msgType = addedCount > 0 ? 'success' : 'info';
          showUploadMessage(msg, msgType);
        } else {
          // fallback to provided message if counts not present
          showUploadMessage(data.message || "Teams uploaded successfully!", "success");
        }
        // Refresh teams list regardless (force refresh to get latest)
        fetchTeams(true);
      })
      .catch(error => {
        showUploadMessage(error.message || "Failed to upload teams. Please try again.", "error");
        uploadButton.disabled = false;
      });
  });

  // Gear button click handler
  if (gearBtn) {
    gearBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent document click from immediately closing menu
      userMenu.style.display = userMenu.style.display === 'none' ? 'block' : 'none';
    });
  }

  // Hide menu when clicking outside
  document.addEventListener('click', (e) => {
    if (userMenu && !userMenu.contains(e.target) && e.target !== gearBtn) {
      userMenu.style.display = 'none';
    }
  });

  function setMode(mode) {
    currentMode = mode;
    
    // Update desktop navigation buttons
    document.getElementById("modeUploadBtn").classList.toggle("active", mode === "upload");
    document.getElementById("modeVersusBtn").classList.toggle("active", mode === "versus");
    document.getElementById("modeLeaderboardBtn").classList.toggle("active", mode === "leaderboard");
    
    // Update mobile navigation buttons
    document.getElementById("mobileUploadBtn").classList.toggle("active", mode === "upload");
    document.getElementById("mobileVersusBtn").classList.toggle("active", mode === "versus");
    document.getElementById("mobileLeaderboardBtn").classList.toggle("active", mode === "leaderboard");
    
    const container = document.getElementById("teamsContainer");
    const uploadSection = document.getElementById('uploadSection');
    
    // Close mobile menu when switching modes
    closeMobileMenuFunc();
    
    if (mode === "upload") {
      uploadPanel.style.display = "block";
      container.style.display = "none";
      container.innerHTML = "";
      
      // Check if user is logged in
      const isLoggedIn = gearBtn.style.display !== 'none';
      if (isLoggedIn) {
        uploadSection.style.display = 'block';
        loginPanel.style.display = 'none';
      } else {
        uploadSection.style.display = 'none';
        loginPanel.style.display = 'block';
      }
    } else {
      uploadPanel.style.display = "none";
      container.style.display = "block";
      // Show loading indicator immediately to signal work is happening
      container.innerHTML = "<div class='loading-indicator'>Loading teams…</div>";
      if (mode === "leaderboard") {
        fetchLeaderboard();
      } else {
        fetchTeams();
      }
    }
  }

  // Desktop mode selection event listeners
  document.getElementById("modeUploadBtn").addEventListener("click", () => setMode("upload"));
  document.getElementById("modeVersusBtn").addEventListener("click", () => setMode("versus"));
  document.getElementById("modeLeaderboardBtn").addEventListener("click", () => setMode("leaderboard"));

  // Mobile mode selection event listeners
  document.getElementById("mobileUploadBtn").addEventListener("click", () => setMode("upload"));
  document.getElementById("mobileVersusBtn").addEventListener("click", () => setMode("versus"));
  document.getElementById("mobileLeaderboardBtn").addEventListener("click", () => setMode("leaderboard"));

  // Modal close button
  document.getElementById("modalCloseBtn").addEventListener("click", hideModal);
});

function showUploadMessage(message, type) {
  const messageEl = document.getElementById("uploadMessage");
  messageEl.textContent = message;
  messageEl.className = "upload-message";
  if (type) {
    messageEl.classList.add(type);
  }
}

// Fetch teams, optionally bypassing the cache
function fetchTeams(force = false) {
  // If we already have teams cached and not forcing a refresh, reuse them
  if (!force && teams.length) {
    if (currentMode === "versus") {
      renderVersus();
    }
    return;
  }

  const container = document.getElementById("teamsContainer");
  if (container) {
    container.innerHTML = "<div class='loading-indicator'>Loading teams…</div>";
  }

  fetch("/teams")
    .then(res => res.json())
    .then(data => {
      teams = shuffle(data.teams);
      teamTournaments = data.tournaments || {};
      // build username map
      if (data.usernames) {
        teamUsernames = data.usernames;
      } else {
        // derive from rows if provided
        data.teams.forEach(([id, players]) => {
          // username not sent explicitly, keep previous mapping if exists
          if (!teamUsernames[id]) teamUsernames[id] = null;
        });
      }
      currentIndex = 0;
      if (currentMode === "upload") return;
      if (currentMode === "versus") {
        renderVersus();
      }
    });
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function getBorderColor(position) {
  switch (position) {
    case "QB": return "#a855f7";
    case "RB": return "#22c55e";
    case "WR": return "#facc15";
    case "TE": return "#3b82f6";
    default: return "#999";
  }
}

function buildTeamCard(teamId, players) {
  const card = document.createElement("div");
  card.className = "team-card";

  // --- Roster construction counts at the top ---
  const counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
  players.forEach(p => { if (counts[p.position] !== undefined) counts[p.position]++; });
  const rosterConstruction = document.createElement("div");
  rosterConstruction.className = "roster-construction";
  rosterConstruction.innerHTML = `<div class="roster-counts">QB${counts.QB} | RB${counts.RB} | WR${counts.WR} | TE${counts.TE}</div>`;
  card.appendChild(rosterConstruction);

  // --- Player list (vertical) ---
  const list = document.createElement("div");
  list.className = "player-list";

  // Sort players first by position (QB, RB, WR, TE) then by pick number
  const positionOrder = { QB: 0, RB: 1, WR: 2, TE: 3 };
  const playersSorted = [...players].sort((a, b) => {
    if (positionOrder[a.position] !== positionOrder[b.position]) {
      return positionOrder[a.position] - positionOrder[b.position];
    }
    return (a.pick || 0) - (b.pick || 0);
  });

  ["QB", "RB", "WR", "TE"].forEach(pos => {
    playersSorted.filter(p => p.position === pos).forEach(pl => {
      const row = document.createElement("div");
      row.className = "player-row";

      const bubble = document.createElement("div");
      bubble.className = "player-bubble";
      const stackStar = pl.stack ? 
        `<span class="stack-star ${pl.stack}">★</span>` : '';
      // Build bubble content with pick number left-aligned and player info centered
      const pickHTML = (pl.pick || pl.pick === 0) ? `<span class="pick-num">#${pl.pick}</span>` : '';
      const infoHTML = `<span class="player-info">${pl.name}${pl.team ? ` - ${pl.team}` : ''}</span>`;
      const starHTML = stackStar; // star after info for positioning via CSS
      bubble.innerHTML = `${pickHTML}${infoHTML}${starHTML}`;
      bubble.style.border = `2px solid ${getBorderColor(pl.position)}`;

      row.appendChild(bubble);
      list.appendChild(row);
    });
  });

  card.appendChild(list);
  return card;
}

function renderVersus() {
  const container = document.getElementById("teamsContainer");
  container.innerHTML = "";

  if (teams.length < 2) return;

  // Create outer container for everything
  const outerContainer = document.createElement("div");
  outerContainer.className = "versus-outer-container";

  // Create versus container just for the cards
  const versusWrapper = document.createElement("div");
  versusWrapper.className = "versus-container";

  // Build tournament -> teamIds map
  const tourGroups = {};
  teams.forEach(([tid]) => {
    const tour = teamTournaments[tid];
    if (!tour) return;
    if (!tourGroups[tour]) tourGroups[tour] = [];
    tourGroups[tour].push(tid);
  });

  // Helper to get random element
  const randElem = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // Helper for weighted tournament selection
  const weightedTournamentSelect = (tournaments) => {
    // Calculate total weight (sum of all team counts)
    const totalWeight = tournaments.reduce((sum, [_, teams]) => sum + teams.length, 0);
    
    // Generate random value between 0 and total weight
    let random = Math.random() * totalWeight;
    
    // Find the tournament that contains this weighted random value
    for (const tournament of tournaments) {
      const weight = tournament[1].length;
      if (random < weight) {
        return tournament;
      }
      random -= weight;
    }
    
    // Fallback to last tournament (shouldn't happen due to math above)
    return tournaments[tournaments.length - 1];
  };

  let teamId1, teamId2;

  const eligibleTours = Object.entries(tourGroups).filter(([tour, tlist]) => {
    const usernamesSet = new Set(tlist.map(id => teamUsernames[id] || "__anon__"));
    return usernamesSet.size >= 2;
  });

  if (eligibleTours.length) {
    // Use weighted selection for tournament
    const [tour, list] = weightedTournamentSelect(eligibleTours);
    // pick first team
    teamId1 = randElem(list);
    const user1 = teamUsernames[teamId1] || "__anon__";
    // candidates for second team with different username
    const differentUserTeams = list.filter(id => id !== teamId1 && (teamUsernames[id] || "__anon__") !== user1);
    teamId2 = randElem(differentUserTeams);
  } else {
    // fallback: original random distinct teams
    let idx1 = Math.floor(Math.random() * teams.length);
    let idx2;
    do {
      idx2 = Math.floor(Math.random() * teams.length);
    } while (idx2 === idx1);
    teamId1 = teams[idx1][0];
    teamId2 = teams[idx2][0];
  }

  // Retrieve players arrays
  const players1 = teams.find(([id]) => id === teamId1)[1];
  const players2 = teams.find(([id]) => id === teamId2)[1];

  const card1 = buildTeamCard(teamId1, players1);
  const card2 = buildTeamCard(teamId2, players2);

  // Add choose buttons under each card (center VS column removed)
  const chooseBtn1 = document.createElement("button");
  chooseBtn1.innerHTML = "<span>⬅️</span> Choose";
  chooseBtn1.className = "choose-button";

  const chooseBtn2 = document.createElement("button");
  chooseBtn2.innerHTML = "Choose <span>➡️</span>";
  chooseBtn2.className = "choose-button";

  const sendVersusVote = (winnerId, loserId) => {
    // Disable both buttons immediately
    chooseBtn1.disabled = true;
    chooseBtn2.disabled = true;
    
    // Update button states visually
    if (winnerId === teamId1) {
      chooseBtn1.className = "choose-button selected";
      chooseBtn2.className = "choose-button disabled";
      chooseBtn1.innerHTML = "<span>⬅️</span> Winner";
      chooseBtn2.innerHTML = "Loser <span>➡️</span>";
    } else {
      chooseBtn2.className = "choose-button selected";
      chooseBtn1.className = "choose-button disabled";
      chooseBtn2.innerHTML = "Winner <span>➡️</span>";
      chooseBtn1.innerHTML = "<span>⬅️</span> Loser";
    }

    fetch("/versus", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ winnerId, loserId }),
    }).then(res => {
      if (handleRateLimit(res)) return;
      
      // Show stats for both teams after vote
      Promise.all([
        fetch(`/team-owner/${teamId1}`).then(r=>r.json()).catch(()=>({})),
        fetch(`/team-owner/${teamId2}`).then(r=>r.json()).catch(()=>({})),
        fetch(`/versus-stats/${teamId1}`).then(r=>r.json()).catch(()=>({wins:0,losses:0,win_pct:0})),
        fetch(`/versus-stats/${teamId2}`).then(r=>r.json()).catch(()=>({wins:0,losses:0,win_pct:0}))
      ]).then(([info1, info2, stats1, stats2])=>{
        // Create owner info sections if they don't exist
        let ownerInfo1 = card1.querySelector('.owner-info');
        let ownerInfo2 = card2.querySelector('.owner-info');
        
        if (!ownerInfo1) {
          ownerInfo1 = document.createElement('div');
          ownerInfo1.className = 'owner-info';
          card1.insertBefore(ownerInfo1, chooseBtn1);
        }
        if (!ownerInfo2) {
          ownerInfo2 = document.createElement('div');
          ownerInfo2.className = 'owner-info';
          card2.insertBefore(ownerInfo2, chooseBtn2);
        }

        // Update owner info content with win percentage
        ownerInfo1.innerHTML = `
          <div class="owner-stats">
            ${info1.username || 'Anonymous'}${info1.twitter_username ? ` | @${info1.twitter_username}` : ''} 
            | <strong>W:</strong> ${stats1.wins || 0} | <strong>L:</strong> ${stats1.losses || 0} | <strong>Win %:</strong> ${stats1.win_pct || '0.0'}%
          </div>
        `;
        ownerInfo2.innerHTML = `
          <div class="owner-stats">
            ${info2.username || 'Anonymous'}${info2.twitter_username ? ` | @${info2.twitter_username}` : ''} 
            | <strong>W:</strong> ${stats2.wins || 0} | <strong>L:</strong> ${stats2.losses || 0} | <strong>Win %:</strong> ${stats2.win_pct || '0.0'}%
          </div>
        `;

        // Add "Next Matchup" button to outer container
        const nextButton = document.createElement("button");
        nextButton.textContent = "Next Matchup →";
        nextButton.className = "next-button";
        nextButton.onclick = () => renderVersus();
        document.querySelector('.versus-outer-container').appendChild(nextButton);
      });
    });
  };

  chooseBtn1.onclick = () => sendVersusVote(teamId1, teamId2);
  chooseBtn2.onclick = () => sendVersusVote(teamId2, teamId1);

  // Place choose buttons at the bottom of each card
  card1.appendChild(chooseBtn1);
  card2.appendChild(chooseBtn2);

  versusWrapper.appendChild(card1);
  versusWrapper.appendChild(card2);

  // Add versus wrapper to outer container
  outerContainer.appendChild(versusWrapper);
  
  // Add outer container to main container
  container.appendChild(outerContainer);
}

// fetchLeaderboard
function fetchLeaderboard() {
  // Ensure default sort for both views is by Versus Wins (desc)
  if (sortKey !== "wins") {
    sortKey = "wins";
    sortDir = "desc";
  }

  const endpoint = leaderboardType === "team" ? "/leaderboard" : "/leaderboard/users";
  fetch(endpoint)
    .then(res => res.json())
    .then(data => {
      leaderboardData = data;
      sortAndRender();
    });
}

function sortAndRender() {
  const sorted = [...leaderboardData].sort((a, b) => {
    if (sortKey === "win_pct") {
      // Win percentage first, then total wins for tiebreaker
      const ap = parseFloat(a.win_pct);
      const bp = parseFloat(b.win_pct);
      if (ap !== bp) {
        return sortDir === "asc" ? ap - bp : bp - ap;
      }
      // If percentages are equal, break tie with total wins
      return sortDir === "asc" ? a.wins - b.wins : b.wins - a.wins;
    }
    
    // default single-column numeric sort
    let aval = a[sortKey];
    let bval = b[sortKey];
    aval = parseFloat(aval);
    bval = parseFloat(bval);
    if (sortDir === "asc") return aval - bval;
    return bval - aval;
  });
  renderLeaderboard(sorted.slice(0, MAX_LEADERBOARD_ROWS));
}

// renderLeaderboard implementation
function renderLeaderboard(data) {
  const container = document.getElementById("teamsContainer");
  container.innerHTML = "";
  // switch buttons
  const switchDiv = document.createElement("div");
  switchDiv.className = "leaderboard-switch";
  const btnTeam = document.createElement("button");
  btnTeam.textContent = "By Team";
  btnTeam.classList.toggle("active", leaderboardType === "team");
  const btnUser = document.createElement("button");
  btnUser.textContent = "By User";
  btnUser.classList.toggle("active", leaderboardType === "user");
  btnTeam.onclick = () => {
    leaderboardType = "team";
    sortKey = "wins";
    sortDir = "desc";
    fetchLeaderboard();
  };
  btnUser.onclick = () => { 
    leaderboardType = "user"; 
    sortKey = "wins";
    sortDir = "desc";
    fetchLeaderboard(); 
  };
  switchDiv.appendChild(btnTeam);
  switchDiv.appendChild(btnUser);
  container.appendChild(switchDiv);

  const table = document.createElement("table");
  table.className = `leaderboard-table ${leaderboardType}-view`;

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  headerRow.innerHTML = leaderboardType === "team" ? `
    <th>Team</th>
    <th>User</th>
    <th class="sortable">W</th>
    <th class="sortable">L</th>
    <th class="sortable">Win %</th>
  ` : `
    <th>User</th>
    <th class="sortable">W</th>
    <th class="sortable">L</th>
    <th class="sortable">Win %</th>
  `;
  thead.appendChild(headerRow);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  data.forEach(row=>{
    const tr = document.createElement("tr");
    const winPct = (row.win_pct || 0).toString();

    if (leaderboardType === "team") {
      const viewBtn = `<button class="view-team-btn" data-id="${row.id}">View</button>`;
      tr.innerHTML = `<td>${viewBtn}</td><td>${row.username || "-"}</td><td>${row.wins}</td><td>${row.losses}</td><td>${winPct}%</td>`;
    } else {
      tr.innerHTML = `<td>${row.username || "-"}</td><td>${row.wins}</td><td>${row.losses}</td><td>${winPct}%</td>`;
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  container.appendChild(table);

  // Make W, L, Win% sortable
  const headerCells = headerRow.querySelectorAll("th");
  const sortableKeys = ["wins","losses","win_pct"]; // always last three columns
  headerCells.forEach((th, idx) => {
    const keyIdx = leaderboardType === "team" ? idx - 2 : idx - 1;
    if (keyIdx < 0) return; // skip Team/User columns
    const key = sortableKeys[keyIdx];
    
    th.onclick = () => {
      if (sortKey === key) {
        sortDir = sortDir === "desc" ? "asc" : "desc";
      } else {
        sortKey = key;
        sortDir = "desc";
      }
      sortAndRender();
    };
  });

  // attach view button listeners if team view
  if (leaderboardType === "team") {
    container.querySelectorAll(".view-team-btn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const id = e.target.getAttribute("data-id");
        showTeamModal(id);
      });
    });
  }
}

function hideModal() {
  document.getElementById("modalOverlay").style.display = "none";
  document.getElementById("modalBody").innerHTML = "";
}

function showTeamModal(teamId) {
  fetch(`/team/${teamId}`)
    .then(res => res.json())
    .then(players => {
      const body = document.getElementById("modalBody");
      body.innerHTML = "";
      const card = buildTeamCard(teamId, players);
      body.appendChild(card);
      document.getElementById("modalOverlay").style.display = "flex";
    });
}

// Helper to show a simple alert for rate-limit errors
function handleRateLimit(res) {
  if (res.status === 429) {
    res.json().then(data => {
      alert(data.error || "Rate limit exceeded. Please wait a moment.");
    });
    return true; // handled
  }
  return false;
}
