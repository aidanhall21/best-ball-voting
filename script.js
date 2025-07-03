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
let teamUserIds = {}; // teamId -> user_id mapping
let currentUserId = null; // logged-in user id
let userVotesCount = 0;   // total versus votes cast by user
let myTeamIds = [];       // array of teamIds owned by current user
const MAX_LEADERBOARD_ROWS = 150; // how many rows to actually render after sorting
let currentTournament = ""; // Add this at the top with other state variables
let currentUsernameFilter = ""; // Username filter for team leaderboard
let leaderboardRawData = []; // unfiltered data cache

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

  // === NEW: overlay to catch clicks on disabled file input ===
  const fileInputContainer = document.querySelector('.file-input-container');
  let fileInputOverlay;
  if (fileInputContainer) {
    // Ensure the container is positioned relatively so the overlay can be absolutely positioned
    fileInputContainer.style.position = 'relative';

    fileInputOverlay = document.createElement('div');
    fileInputOverlay.className = 'file-input-overlay';
    Object.assign(fileInputOverlay.style, {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      cursor: 'not-allowed',
      background: 'transparent',
      display: 'none', // hidden by default; shown when username is empty
      zIndex: 2 // sit above the disabled input
    });

    // Clicking the overlay shows a helpful message
    fileInputOverlay.addEventListener('click', () => {
      showUploadMessage('Please input Underdog or Twitter handle', 'error');
    });

    fileInputContainer.appendChild(fileInputOverlay);
  }

  // Helper to keep file input state & overlay in sync
  function updateFileInputState() {
    const hasUsername = !!usernameInput.value.trim();
    csvUpload.disabled = !hasUsername;
    if (fileInputOverlay) {
      fileInputOverlay.style.display = hasUsername ? 'none' : 'block';
    }
  }

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
    // Track current user id for ownership logic
    currentUserId = loggedIn ? data.user.id : null;

    // If logged in, fetch the current versus vote count
    if (loggedIn) {
      try {
        const vcRes = await fetch('/my/votes-count');
        if (vcRes.ok) {
          const vcJson = await vcRes.json();
          userVotesCount = vcJson.count || 0;
        } else {
          userVotesCount = 0;
        }
      } catch (e) {
        console.error('Failed to fetch vote count', e);
        userVotesCount = 0;
      }
    } else {
      userVotesCount = 0;
    }

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
      updateFileInputState();
    }
    showLoginMessage('', '');

    // Keep overlay visibility in sync after auth refresh
    updateFileInputState();
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
    updateFileInputState();
    if (!e.target.value.trim()) {
      uploadButton.disabled = true;
      csvUpload.value = ""; // Clear file input if username is cleared
    } else {
      // Clear any previous warning once typing starts
      showUploadMessage('', '');
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
        updateFileInputState();

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
    const uploadPanel = document.querySelector('.upload-panel');
    
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
      
      if (mode === "leaderboard") {
        container.innerHTML = ""; // Don't show loading for leaderboard
        fetchLeaderboard();
      } else {
        // Show loading indicator only for versus mode
        container.innerHTML = "<div class='loading-indicator'>Loading teams…</div>";
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
  
  // Clear previous content
  messageEl.textContent = message;
  messageEl.className = "upload-message";
  if (type) {
    messageEl.classList.add(type);
  }

  // Remove any existing CTA
  const existingCTA = document.getElementById("startVotingCTA");
  if (existingCTA) existingCTA.remove();

  // Add CTA button below message for non-error outcomes with a real message
  if (message && type !== "error") {
    const ctaBtn = document.createElement("button");
    ctaBtn.id = "startVotingCTA";
    ctaBtn.className = "start-voting-btn"; // new css class
    ctaBtn.textContent = "Start voting now! →";
    ctaBtn.addEventListener("click", () => {
      // Programmatically switch to the Draft or Pass tab (versus mode)
      const versusBtn = document.getElementById("modeVersusBtn");
      if (versusBtn) versusBtn.click();
    });
    // Insert after the message element
    messageEl.parentNode.insertBefore(ctaBtn, messageEl.nextSibling);
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
      // NEW: build userIds map
      if (data.userIds) {
        teamUserIds = data.userIds;
      }
      // Determine myTeamIds based on currentUserId
      if (currentUserId) {
        myTeamIds = Object.keys(teamUserIds).filter(tid => teamUserIds[tid] === currentUserId);
      } else {
        myTeamIds = [];
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

// ----- New helper: map raw tournament names to user-friendly category labels -----
function getTournamentCategory(tourName = "") {
  const preDraftNames = [
    "The Big Board",
    "The Little Board",
    "The Little Board 2",
    "The Bigger Board",
    "The Biggest Board",
    "The War Room",
  ];

  if (!tourName) return "Post Draft";
  if (tourName === "The Marathon") return "Marathon";
  if (tourName === "The Sprint") return "Sprint";
  if (tourName.endsWith("but Superflex")) return "Superflex";
  if (tourName === "The Eliminator") return "Eliminator";
  if (tourName === "Weekly Winners") return "Weekly Winners";
  if (preDraftNames.includes(tourName)) return "Pre Draft";
  return "Post Draft";
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

  const ALPHA = 0.7; // exponent between 0.5 (sqrt) and 1 (linear)
  let includeMyTeamChance = 0;
  if (currentUserId && myTeamIds.length) {
    if (userVotesCount === 0) {
      includeMyTeamChance = 1; // 100% if no votes yet
    } else {
      includeMyTeamChance = 1 / (Math.pow(userVotesCount, ALPHA) + 1);
    }
    // Enforce 5% floor so probability never drops below 0.05
    includeMyTeamChance = Math.max(0.05, Math.min(1, includeMyTeamChance));
  }
  const includeMyTeam = Math.random() < includeMyTeamChance;

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
    let random = Math.random() * totalWeight;
    for (const tournament of tournaments) {
      const weight = tournament[1].length;
      if (random < weight) {
        return tournament;
      }
      random -= weight;
    }
    return tournaments[tournaments.length - 1];
  };

  let teamId1, teamId2;

  // --- Try to include one of the user's own teams if requested ---
  if (includeMyTeam) {
    const myEligible = myTeamIds.filter(tid => {
      const tour = teamTournaments[tid];
      if (!tour) return false;
      const list = tourGroups[tour] || [];
      if (list.length < 2) return false;
      // ensure there is at least one opponent team not owned by the current user
      return list.some(id => id !== tid && (teamUserIds[id] || null) !== currentUserId);
    });

    if (myEligible.length) {
      teamId1 = randElem(myEligible);
      const tour = teamTournaments[teamId1];
      const list = tourGroups[tour] || [];
      const opponentCandidates = list.filter(id => id !== teamId1 && (teamUserIds[id] || null) !== currentUserId);
      if (opponentCandidates.length) {
        teamId2 = randElem(opponentCandidates);
      } else {
        // shouldn't happen, but fallback
        teamId1 = null;
      }
    }
  }

  // ---- Fallback to original random selection if we didn't get valid ids ----
  const eligibleTours = Object.entries(tourGroups).filter(([tour, tlist]) => {
    const usernamesSet = new Set(tlist.map(id => teamUsernames[id] || "__anon__"));
    return usernamesSet.size >= 2;
  });

  if (!teamId1 || !teamId2) {
    if (eligibleTours.length) {
      const [tour, list] = weightedTournamentSelect(eligibleTours);
      teamId1 = randElem(list);
      const user1 = teamUsernames[teamId1] || "__anon__";
      const differentUserTeams = list.filter(id => id !== teamId1 && (teamUsernames[id] || "__anon__") !== user1);
      teamId2 = randElem(differentUserTeams);
    } else {
      // ultimate fallback: any two distinct random teams
      let idx1 = Math.floor(Math.random() * teams.length);
      let idx2;
      do {
        idx2 = Math.floor(Math.random() * teams.length);
      } while (idx2 === idx1);
      teamId1 = teams[idx1][0];
      teamId2 = teams[idx2][0];
    }
  }

  // Retrieve players arrays
  const players1 = teams.find(([id]) => id === teamId1)[1];
  const players2 = teams.find(([id]) => id === teamId2)[1];

  const card1 = buildTeamCard(teamId1, players1);
  const card2 = buildTeamCard(teamId2, players2);

  // === NEW: centered category header for the matchup -----
  const tournamentName1 = teamTournaments[teamId1] || "";
  const tournamentName2 = teamTournaments[teamId2] || "";

  const category1 = getTournamentCategory(tournamentName1);
  const category2 = getTournamentCategory(tournamentName2);
  const headerLabelText = category1 === category2 ? category1 : `${category1} / ${category2}`;

  const matchupHeader = document.createElement("div");
  matchupHeader.className = "matchup-category-header";
  matchupHeader.textContent = headerLabelText;

  // Insert header before the versus cards
  outerContainer.appendChild(matchupHeader);

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

    // Clear any existing highlight classes
    ownerInfo1.classList.remove('winner','loser');
    ownerInfo2.classList.remove('winner','loser');
    
    // Update button states visually
    if (winnerId === teamId1) {
      chooseBtn1.className = "choose-button selected";
      chooseBtn2.className = "choose-button disabled";
      chooseBtn1.innerHTML = "<span>⬅️</span> Winner";
      chooseBtn2.innerHTML = "Loser <span>➡️</span>";
      // Highlight corresponding owner info
      ownerInfo1.classList.add('winner');
      ownerInfo2.classList.add('loser');
    } else {
      chooseBtn2.className = "choose-button selected";
      chooseBtn1.className = "choose-button disabled";
      chooseBtn2.innerHTML = "Winner <span>➡️</span>";
      chooseBtn1.innerHTML = "<span>⬅️</span> Loser";
      // Highlight corresponding owner info
      ownerInfo2.classList.add('winner');
      ownerInfo1.classList.add('loser');
    }

    // === Reveal tournament/contest names at the bottom after vote ===
    const revealTourLabel = (card, tourName) => {
      if (!tourName) return;
      if (card.querySelector('.tournament-label')) return; // already added
      const label = createTourLabel(tourName);
      const chooseButton = card.querySelector('.choose-button');
      if (chooseButton) {
        card.insertBefore(label, chooseButton); // insert just above choose button
      } else {
        card.appendChild(label);
      }
    };
    revealTourLabel(card1, tournamentName1);
    revealTourLabel(card2, tournamentName2);

    fetch("/versus", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ winnerId, loserId }),
    }).then(res => {
      if (handleRateLimit(res)) return;
      
      // Show combined owner + versus stats for both teams after vote
      Promise.all([
        fetch(`/team-meta/${teamId1}`).then(r=>r.json()).catch(()=>({username:null,twitter_username:null,wins:0,losses:0,win_pct:0})),
        fetch(`/team-meta/${teamId2}`).then(r=>r.json()).catch(()=>({username:null,twitter_username:null,wins:0,losses:0,win_pct:0}))
      ]).then(([meta1, meta2])=>{
        ownerInfo1.innerHTML = `
          <div class="owner-stats">
            ${meta1.username || 'Anonymous'}${meta1.twitter_username ? ` | @${meta1.twitter_username}` : ''} 
            | <strong>W:</strong> ${meta1.wins || 0} | <strong>L:</strong> ${meta1.losses || 0} | <strong>Win %:</strong> ${meta1.win_pct || '0.0'}%
          </div>
        `;
        ownerInfo2.innerHTML = `
          <div class="owner-stats">
            ${meta2.username || 'Anonymous'}${meta2.twitter_username ? ` | @${meta2.twitter_username}` : ''} 
            | <strong>W:</strong> ${meta2.wins || 0} | <strong>L:</strong> ${meta2.losses || 0} | <strong>Win %:</strong> ${meta2.win_pct || '0.0'}%
          </div>
        `;

        // Add "Next Matchup" button to outer container
        const nextButton = document.createElement("button");
        nextButton.textContent = "Next Matchup →";
        nextButton.className = "next-button";
        nextButton.onclick = () => renderVersus();
        document.querySelector('.versus-outer-container').appendChild(nextButton);

        // Increment local vote count so future probability adjusts on the fly
        if (currentUserId) {
          userVotesCount += 1;
        }
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
function fetchLeaderboard(force = false) {
  // Ensure default sort for both views is by Versus Wins (desc)
  if (sortKey !== "wins") {
    sortKey = "wins";
    sortDir = "desc";
  }

  // Reuse cached data ONLY for team view (and when not forcing)
  if (!force && leaderboardType === "team" && leaderboardRawData.length && leaderboardRawData[0]?.id !== undefined) {
    leaderboardData = leaderboardRawData;
    sortAndRender();
    return;
  }

  let endpoint;
  if (leaderboardType === "team") {
    endpoint = "/leaderboard";
  } else {
    // leaderboardType === "user"
    endpoint = "/leaderboard/users";
    if (currentTournament) {
      endpoint += `?tournament=${encodeURIComponent(currentTournament)}`;
    }
  }

  fetch(endpoint)
    .then(res => res.json())
    .then(data => {
      leaderboardRawData = data;
      leaderboardData = data;
      sortAndRender();
    });
}

function sortAndRender() {
  const sorted = [...leaderboardData]
    // Apply username and tournament filters
    .filter(row => {
      if (leaderboardType !== "team") return true;
      if (currentUsernameFilter && (row.username || "") !== currentUsernameFilter) return false;
      if (currentTournament && (row.tournament || "") !== currentTournament) return false;
      return true;
    })
    .sort((a, b) => {
      if (sortKey === "win_pct") {
        // Win percentage first, then total wins for tiebreaker
        const ap = parseFloat(a.win_pct);
        const bp = parseFloat(b.win_pct);
        if (ap !== bp) {
          return sortDir === "asc" ? ap - bp : bp - ap;
        }
        // If percentages are equal, apply secondary key based on sort direction:
        //  • Ascending win %  → more losses first (losses DESC) to surface weaker teams
        //  • Descending win % → more wins first   (wins DESC)   to surface stronger teams
        if (sortDir === "asc") {
          return b.losses - a.losses; // tie-break: losses DESC
        }
        // sortDir === "desc"
        return b.wins - a.wins;      // tie-break: wins DESC
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
  
  // === View switch (By Team / By User) ===
  let switchDiv = container.querySelector('.leaderboard-switch');
  if (!switchDiv) {
    switchDiv = document.createElement("div");
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
      currentTournament = ""; // reset tournament
      // Keep currentUsernameFilter as-is
      // Update tournament select dropdown later
      const tsel = document.getElementById('tournamentSelect');
      if (tsel) tsel.value = "";
      fetchLeaderboard();
    };
    btnUser.onclick = () => {
      leaderboardType = "user";
      sortKey = "wins";
      sortDir = "desc";
      currentTournament = "";
      currentUsernameFilter = ""; // reset user filter when switching views
      const tsel = document.getElementById('tournamentSelect');
      if (tsel) tsel.value = "";
      fetchLeaderboard();
    };
    switchDiv.appendChild(btnTeam);
    switchDiv.appendChild(btnUser);
    container.appendChild(switchDiv);
  } else {
    // update active states
    const [btnTeam, btnUser] = switchDiv.querySelectorAll('button');
    if (btnTeam && btnUser) {
      btnTeam.classList.toggle("active", leaderboardType === "team");
      btnUser.classList.toggle("active", leaderboardType === "user");
    }
  }

  // ==== Filter wrapper (holds tournament + username selects) ====
  let filtersWrapper = container.querySelector('.filters-wrapper');
  if (!filtersWrapper) {
    filtersWrapper = document.createElement('div');
    filtersWrapper.className = 'filters-wrapper';
    container.appendChild(filtersWrapper);
  }

  // ---- Tournament filter (creates/updates) ----
  let filterDiv = filtersWrapper.querySelector('.tournament-filter');
  if (!filterDiv) {
    filterDiv = document.createElement("div");
    filterDiv.className = "tournament-filter";

    const select = document.createElement("select");
    select.id = "tournamentSelect";
    select.style.padding = "8px";
    select.style.borderRadius = "6px";
    select.style.border = "1px solid #30363d";
    select.style.background = "#0d1117";
    select.style.color = "#f0f6fc";
    select.style.cursor = "pointer";
    filterDiv.appendChild(select);
    filtersWrapper.appendChild(filterDiv);
  }

  // Populate tournaments each render, reflecting username filter
  const tournamentSelect = document.getElementById('tournamentSelect');
  if (tournamentSelect) {
    // Only rebuild tournament dropdown if it's empty or if we're switching views
    const needsRebuild = !tournamentSelect.options.length || 
                        (leaderboardType === "team" && (
                          tournamentSelect.dataset.viewType !== "team" ||
                          tournamentSelect.dataset.usernameFilter !== (currentUsernameFilter || "")
                        )) ||
                        (leaderboardType === "user" && tournamentSelect.dataset.viewType !== "user");

    if (needsRebuild) {
      // Always start by clearing and adding the default option
      tournamentSelect.innerHTML = "";
      const defaultOption = document.createElement("option");
      defaultOption.value = "";
      defaultOption.textContent = "All Tournaments";
      tournamentSelect.appendChild(defaultOption);

      if (leaderboardType === "team") {
        // Build allowed tournament list from current data (respect username filter)
        const tournamentSet = new Set();
        leaderboardRawData.forEach(row => {
          if (currentUsernameFilter && row.username !== currentUsernameFilter) return;
          if (row.tournament) tournamentSet.add(row.tournament);
        });
        const tournamentsArr = Array.from(tournamentSet).sort((a,b)=>a.localeCompare(b));
        tournamentsArr.forEach(t => {
          const opt = document.createElement("option");
          opt.value = t;
          opt.textContent = t;
          tournamentSelect.appendChild(opt);
        });

        // Validate current selection
        if (currentTournament && !tournamentSet.has(currentTournament)) {
          currentTournament = "";
        }
        tournamentSelect.value = currentTournament;
        tournamentSelect.dataset.viewType = "team";
        tournamentSelect.dataset.usernameFilter = currentUsernameFilter || "";
      } else {
        // User leaderboard: show all tournaments
        fetch("/tournaments")
          .then(res => res.json())
          .then(tournaments => {
            const sorted = tournaments.sort((a,b)=>a.localeCompare(b));
            sorted.forEach(t => {
              const opt = document.createElement("option");
              opt.value = t;
              opt.textContent = t;
              tournamentSelect.appendChild(opt);
            });

            if (currentTournament && !sorted.includes(currentTournament)) {
              currentTournament = "";
            }
            tournamentSelect.value = currentTournament;
            tournamentSelect.dataset.viewType = "user";
          });
      }

      tournamentSelect.onchange = (e) => {
        currentTournament = e.target.value;
        fetchLeaderboard();
      };
    } else {
      // Just ensure the current selection is correct and store current filter
      tournamentSelect.value = currentTournament;
      if (leaderboardType === "team") {
        tournamentSelect.dataset.usernameFilter = currentUsernameFilter || "";
      }
    }
  }

  // ---- Username filter (team view only) ----
  if (leaderboardType === "team") {
    let userFilterDiv = filtersWrapper.querySelector('.username-filter');
    if (!userFilterDiv) {
      userFilterDiv = document.createElement("div");
      userFilterDiv.className = "username-filter";

      const userSelect = document.createElement("select");
      userSelect.id = "usernameSelect";
      userSelect.style.padding = "8px";
      userSelect.style.borderRadius = "6px";
      userSelect.style.border = "1px solid #30363d";
      userSelect.style.background = "#0d1117";
      userSelect.style.color = "#f0f6fc";
      userSelect.style.cursor = "pointer";

      userFilterDiv.appendChild(userSelect);
      filtersWrapper.appendChild(userFilterDiv);
    }

    // Populate user select options
    const userSelect = document.getElementById('usernameSelect');
    if (userSelect) {
      // Clear existing options
      userSelect.innerHTML = "";

      const defaultOpt = document.createElement("option");
      defaultOpt.value = "";
      defaultOpt.textContent = "All Users";
      userSelect.appendChild(defaultOpt);

      // Build usernames set respecting currentTournament filter
      const usernamesSet = new Set();
      leaderboardRawData.forEach(row => {
        if (leaderboardType !== "team") return;
        if (currentTournament && row.tournament !== currentTournament) return;
        if (row.username) usernamesSet.add(row.username);
      });
      const usernames = [...usernamesSet].sort((a,b)=>a.localeCompare(b));
      usernames.forEach(u => {
        const opt = document.createElement("option");
        opt.value = u;
        opt.textContent = u;
        userSelect.appendChild(opt);
      });

      // Ensure currentUsernameFilter is valid; reset if not present
      if (currentUsernameFilter && !usernamesSet.has(currentUsernameFilter)) {
        currentUsernameFilter = "";
      }
      userSelect.value = currentUsernameFilter;

      userSelect.onchange = (e) => {
        currentUsernameFilter = e.target.value;
        sortAndRender(); // This will rebuild UI including tournament dropdown
      };
    }
  } else {
    // Remove username filter dropdown if not in team view
    const existingUF = filtersWrapper.querySelector('.username-filter');
    if (existingUF) existingUF.remove();
    currentUsernameFilter = "";
  }

  // --------- Remove / Rebuild table ------------
  // Remove existing table if it exists
  const existingTable = container.querySelector('.leaderboard-table-container');
  if (existingTable) {
    existingTable.remove();
  }

  // Create and populate table
  const tableContainer = document.createElement("div");
  tableContainer.className = "leaderboard-table-container";
  
  const table = document.createElement("table");
  table.className = `leaderboard-table ${leaderboardType}-view`;

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  headerRow.innerHTML = leaderboardType === "team" ? `
    <th>Team</th>
    <th>User</th>
    <th>Contest</th>
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
      tr.innerHTML = `<td>${viewBtn}</td><td>${row.username || "-"}</td><td>${row.tournament || "-"}</td><td>${row.wins}</td><td>${row.losses}</td><td>${winPct}%</td>`;
    } else {
      tr.innerHTML = `<td>${row.username || "-"}</td><td>${row.wins}</td><td>${row.losses}</td><td>${winPct}%</td>`;
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  tableContainer.appendChild(table);

  // Make W, L, Win% sortable
  const headerCells = headerRow.querySelectorAll("th");
  const sortableKeys = ["wins","losses","win_pct"]; // always last three columns
  headerCells.forEach((th, idx) => {
    const keyIdx = leaderboardType === "team" ? idx - 3 : idx - 1;
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
    tableContainer.querySelectorAll(".view-team-btn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const id = e.target.getAttribute("data-id");
        showTeamModal(id);
      });
    });
  }

  container.appendChild(tableContainer);
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

// Helper to generate the tournament label element (used when revealing names after vote)
function createTourLabel(tourName) {
  const label = document.createElement("div");
  label.className = "tournament-label";
  label.textContent = tourName;
  return label;
}
