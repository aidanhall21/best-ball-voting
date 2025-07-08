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
const MAX_LEADERBOARD_ROWS = 1000; // how many rows to actually render after sorting
let currentTournament = null;
let currentUsernameFilter = null; // Username filter for team leaderboard
let leaderboardRawData = []; // unfiltered data cache

// Team metadata cache to reduce redundant API calls
let teamMetaCache = new Map();
const TEAM_META_CACHE_TTL = 30000; // 30 seconds cache TTL

// Client-side rate limiting for Choose button clicks
let chooseClickHistory = []; // Array of timestamps when Choose buttons were clicked
const CHOOSE_CLICK_WINDOW_MS = 10 * 1000; // 10 seconds
const MAX_CHOOSE_CLICKS = 3; // 3 clicks per window
let chooseButtonsDisabled = false; // Track if buttons are currently disabled due to rate limit

// Check if user has exceeded the choose button click rate limit
function isChooseRateLimited() {
  const now = Date.now();
  // Remove clicks older than the window
  chooseClickHistory = chooseClickHistory.filter(timestamp => now - timestamp < CHOOSE_CLICK_WINDOW_MS);
  return chooseClickHistory.length >= MAX_CHOOSE_CLICKS;
}

// Record a choose button click and check rate limit
function recordChooseClick() {
  const now = Date.now();
  chooseClickHistory.push(now);
  
  // Clean up old entries to keep only those within the window
  chooseClickHistory = chooseClickHistory.filter(ts => now - ts < CHOOSE_CLICK_WINDOW_MS);
  
  // Determine current usage
  const clickCount = chooseClickHistory.length;
  
  // If we've reached or exceeded the limit, visually disable buttons so the NEXT click is blocked
  if (clickCount >= MAX_CHOOSE_CLICKS) {
    chooseButtonsDisabled = true;
    updateChooseButtonStates();
  }
  
  // Return TRUE only if this click EXCEEDED the limit (i.e., would be the 4th or more in window)
  return clickCount > MAX_CHOOSE_CLICKS;
}

// Update the visual state of choose buttons based on rate limit status
function updateChooseButtonStates() {
  const chooseButtons = document.querySelectorAll('.choose-button');
  chooseButtons.forEach(button => {
    if (chooseButtonsDisabled) {
      // Disable and mark as rate-limit disabled
      button.disabled = true;
      button.dataset.rlDisabled = '1';
      button.style.opacity = '0.5';
      button.style.cursor = 'not-allowed';
      button.style.filter = 'grayscale(1)';
    } else {
      // Re-enable only buttons we previously disabled for rate limit
      if (button.dataset.rlDisabled === '1') {
        delete button.dataset.rlDisabled;
        button.disabled = false;
      }
      // Always clear visual styles regardless of disabled state to restore original look
      button.style.opacity = '';
      button.style.cursor = '';
      button.style.filter = '';
    }
  });
}

// Continuously check if rate limit should be lifted
function checkRateLimitRecovery() {
  if (chooseButtonsDisabled) {
    const now = Date.now();
    // Clean up old entries
    chooseClickHistory = chooseClickHistory.filter(timestamp => now - timestamp < CHOOSE_CLICK_WINDOW_MS);
    
    // If we're now below the limit, re-enable buttons
    if (chooseClickHistory.length < MAX_CHOOSE_CLICKS) {
      chooseButtonsDisabled = false;
      console.log('✅ Choose button rate limit lifted, buttons re-enabled');
      updateChooseButtonStates();
    }
  }
}

// Cached fetch for team metadata to reduce redundant API calls
async function fetchTeamMeta(teamId, forceRefresh = false) {
  const now = Date.now();
  const cached = teamMetaCache.get(teamId);
  
  // Return cached data if it's fresh and not forcing refresh
  if (!forceRefresh && cached && (now - cached.timestamp) < TEAM_META_CACHE_TTL) {
    return cached.data;
  }
  
  try {
    const response = await fetch(`/team-meta/${teamId}`);
    const data = await response.json();
    
    // Cache the result with timestamp
    teamMetaCache.set(teamId, {
      data,
      timestamp: now
    });
    
    return data;
  } catch (error) {
    console.warn(`Failed to fetch team-meta for ${teamId}:`, error);
    // Return cached data if available, even if stale
    if (cached) {
      return cached.data;
    }
    // Return default data if no cache available
    return { username: null, twitter_username: null, wins: 0, losses: 0, win_pct: 0 };
  }
}

// Invalidate cache entries for teams that just voted
function invalidateTeamMetaCache(teamId1, teamId2) {
  teamMetaCache.delete(teamId1);
  teamMetaCache.delete(teamId2);
}

// Turnstile widget management
let widgetId = null;
let pendingChallenges = 0; // Track concurrent challenges
let voteQueue = []; // Queue for failed votes
let processingQueue = false; // Prevent multiple queue processors
let voteProcessingLock = false; // Global lock for vote processing
let clickQueue = []; // Queue for user clicks when a vote is already processing
let currentVoteFunction = null; // Reference to the current matchup's vote function

// returns a Promise that resolves to a fresh captcha token
function getCaptchaToken() {
  return new Promise((resolve, reject) => {
    if (!turnstile || typeof turnstile.render !== 'function') {
      return reject(new Error('Turnstile not loaded'));
    }

    // Strict limit to prevent Cloudflare errors - only allow 1 concurrent challenge
    if (pendingChallenges > 0) {
      return reject(new Error('Too many concurrent challenges'));
    }

    pendingChallenges++;

    // Always reset the widget if it exists before executing
    if (widgetId) {
      try {
        turnstile.reset(widgetId);
        console.log('Widget reset successfully');
      } catch (e) {
        console.warn('Failed to reset widget, removing and recreating:', e);
        try { 
          turnstile.remove(widgetId); 
        } catch (removeErr) { 
          console.warn('Failed to remove widget:', removeErr);
        }
        widgetId = null;
      }
    }

    // Create new widget if needed
    if (!widgetId) {
      const container = document.getElementById('cf-container');
      if (!container) {
        pendingChallenges--;
        return reject(new Error('Turnstile container not found'));
      }
      
      try {
        widgetId = turnstile.render(container, {
          sitekey: window.TURNSTILE_SITE_KEY,
          action: 'vote', // Identifier for analytics
          execution: 'execute', // Only execute when explicitly called
          size: 'invisible', // Keep it invisible
          theme: 'auto', // Respect user's theme preference
          retry: 'auto', // Auto-retry on failure
          'retry-interval': 8000, // 8 second retry interval
          'refresh-expired': 'auto', // Auto-refresh expired tokens
          callback: () => {}, // Empty callback - we'll use execute's callback
          'expired-callback': () => {
            console.log('Turnstile token expired');
          },
          'error-callback': (error) => {
            console.error('Turnstile widget error:', error);
          },
          'timeout-callback': () => {
            console.warn('Turnstile challenge timed out');
          },
          'before-interactive-callback': () => {
            console.log('Turnstile entering interactive mode');
          },
          'after-interactive-callback': () => {
            console.log('Turnstile left interactive mode');
          },
          'unsupported-callback': () => {
            console.error('Turnstile not supported in this browser');
          }
        });
        console.log('New widget created:', widgetId);
      } catch (e) {
        pendingChallenges--;
        return reject(new Error('Failed to create Turnstile widget: ' + e.message));
      }
    }

    // Minimal delay for faster voting while ensuring widget stability
    setTimeout(() => {
      try {
        turnstile.execute(widgetId, {
          callback: (token) => {
            pendingChallenges--;
            if (!token) {
              console.warn('Empty token received');
              return reject(new Error('Empty Turnstile token'));
            }
            
            // Validate token length (max 2048 characters)
            if (token.length > 2048) {
              console.warn('Token too long:', token.length);
              return reject(new Error('Invalid token format'));
            }
            
            console.log('Turnstile token received successfully');
            resolve(token);
          },
          'error-callback': (error) => {
            pendingChallenges--;
            console.error('Turnstile execution error:', error);
            reject(new Error('Turnstile execution error: ' + error));
          }
        });
      } catch (e) {
        pendingChallenges--;
        console.error('Failed to execute Turnstile:', e);
        reject(new Error('Failed to execute Turnstile: ' + e.message));
      }
    }, 100); // Reduced from 250ms to 100ms for faster processing
  });
}

// Helper to process any queued clicks after a vote finishes
function processClickQueue() {
  console.log(`🔍 processClickQueue called - lock: ${voteProcessingLock}, queue: ${clickQueue.length}, function: ${!!currentVoteFunction}`);
  
  if (voteProcessingLock) {
    console.log(`⏸️ Click queue processing skipped - vote lock active`);
    return; // Wait until current vote fully released
  }
  if (clickQueue.length === 0) {
    console.log(`⏸️ Click queue processing skipped - no clicks queued`);
    return;
  }
  if (!currentVoteFunction) {
    console.log(`⏸️ Click queue processing skipped - no vote function available`);
    console.log(`🗑️ Clearing ${clickQueue.length} orphaned clicks`);
    clickQueue.length = 0; // Clear orphaned clicks
    return; // No active voting function available
  }

  // Process all queued clicks at once to prevent them being lost to UI updates
  const clicksToProcess = [...clickQueue]; // Copy the queue
  clickQueue.length = 0; // Clear the original queue
  
  console.log(`▶️ Processing ${clicksToProcess.length} queued clicks`);
  
      clicksToProcess.forEach((click, index) => {
      console.log(`▶️ Processing queued click ${index + 1}/${clicksToProcess.length}: ${click.winnerId} vs ${click.loserId}`);
      // Minimal stagger for faster processing while avoiding Turnstile overwhelm
      setTimeout(() => {
        const fn = click.voteFunc || currentVoteFunction;
        if (typeof fn === 'function') {
          fn(click.winnerId, click.loserId, click.isQueuedClick || true);
        } else {
          console.warn(`⚠️ Vote function unavailable for click ${index + 1}, skipping`);
        }
      }, index * 25); // Reduced from 60ms to 25ms for faster queue processing
    });
}

// Check for potential browser extension conflicts
function checkBrowserCompatibility() {
  // Check for multiple ethereum providers (wallet conflicts)
  if (window.ethereum && Object.getOwnPropertyDescriptor(window, 'ethereum')) {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'ethereum');
    if (!descriptor.configurable) {
      console.warn('⚠️ Multiple crypto wallet extensions detected - this may cause errors');
    }
  }
  
  // Check for ad blocker blocking Cloudflare resources
  fetch('https://static.cloudflareinsights.com/beacon.min.js', { mode: 'no-cors' })
    .catch(() => {
      console.warn('⚠️ Ad blocker detected - some Cloudflare features may be blocked');
    });
}

document.addEventListener("DOMContentLoaded", () => {
  // Check for potential compatibility issues
  checkBrowserCompatibility();
  
  // Pre-warm Turnstile so the first vote is instant
  setTimeout(() => {
    getCaptchaToken()
      .then(() => console.log('⚡ Turnstile pre-warm complete'))
      .catch(err => console.warn('Turnstile pre-warm failed', err));
  }, 500);
  
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

    // Show content now that auth check is complete
    document.body.classList.add('content-visible');
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
    // Show content now that auth check is complete
    document.body.classList.add('content-visible');
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

  // Gear button click handler - go directly to profile page
  if (gearBtn) {
    gearBtn.addEventListener('click', (e) => {
      e.preventDefault();
      window.location.href = 'profile.html';
    });
  }

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

  // Clear any previous vote function reference only if no clicks are pending
  if (clickQueue.length === 0) {
    console.log(`🔄 Clearing vote function - no pending clicks`);
    currentVoteFunction = null;
  } else {
    console.log(`⏸️ Preserving vote function - ${clickQueue.length} clicks pending`);
  }

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

  const sendVersusVote = async (winnerId, loserId, isQueuedClick = false) => {
    // Check client-side rate limit first (but only for new clicks, not queued ones)
    if (!isQueuedClick && (chooseButtonsDisabled || recordChooseClick())) {
      console.warn('🚫 Choose button rate limited, ignoring click');
      updateChooseButtonStates(); // Update button visual states
      return;
    }

    // Prevent rapid successive clicks on the same matchup (UI guard only)
    if (sendVersusVote.inProgress) {
      console.warn('Vote already in progress for this matchup, ignoring click');
      return;
    }

    // If a vote/network request is already in-flight, queue this click instead of sending
    if (voteProcessingLock) {
      console.log(`🔄 Vote currently processing – queuing click: ${winnerId} vs ${loserId}`);
      if (clickQueue.length < 5) {
        clickQueue.push({ winnerId, loserId, voteFunc: sendVersusVote, isQueuedClick: true });
        console.log(`📋 Click added to queue (queue length: ${clickQueue.length})`);
      } else {
        console.warn('Click queue full, discarding click');
      }
      // We STILL want to update the UI right away so the user gets feedback, but we
      // won't send the network request until the current vote finishes.  We fall
      // through and run the normal UI code, but skip the network section at the end.
    }

    // Disable both buttons immediately to prevent double-clicks after passing UI guard
    chooseBtn1.disabled = true;
    chooseBtn2.disabled = true;

    sendVersusVote.inProgress = true;

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
    
    // Show immediate winner/loser state
    if (winnerId === teamId1) {
      chooseBtn1.innerHTML = "<span>⬅️</span> Winner!";
      chooseBtn2.innerHTML = "Loser";
      ownerInfo1.classList.add('winner');
      ownerInfo2.classList.add('loser');
    } else {
      chooseBtn2.innerHTML = "Winner! <span>➡️</span>";
      chooseBtn1.innerHTML = "<span>⬅️</span> Loser";
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

    // OPTIMISTIC UPDATE: Fetch current stats (cached) and immediately show predicted results
    Promise.all([
      fetchTeamMeta(teamId1),
      fetchTeamMeta(teamId2)
    ]).then(([meta1, meta2]) => {
      // Create optimistic stats (predict the outcome of this vote)
      const optimisticMeta1 = { ...meta1 };
      const optimisticMeta2 = { ...meta2 };
      
      if (winnerId === teamId1) {
        // Team 1 wins, Team 2 loses
        optimisticMeta1.wins = (optimisticMeta1.wins || 0) + 1;
        optimisticMeta2.losses = (optimisticMeta2.losses || 0) + 1;
      } else {
        // Team 2 wins, Team 1 loses
        optimisticMeta2.wins = (optimisticMeta2.wins || 0) + 1;
        optimisticMeta1.losses = (optimisticMeta1.losses || 0) + 1;
      }

      // Recalculate win percentages with optimistic data
      const updateWinPct = (meta) => {
        const total = (meta.wins || 0) + (meta.losses || 0);
        if (total > 0) {
          meta.win_pct = Number(((meta.wins / total) * 100).toFixed(1));
        } else {
          meta.win_pct = 0;
        }
      };
      updateWinPct(optimisticMeta1);
      updateWinPct(optimisticMeta2);

      // Display optimistic results immediately
      ownerInfo1.innerHTML = `
        <div class="owner-stats">
          ${optimisticMeta1.username || 'Anonymous'}${optimisticMeta1.twitter_username ? ` | @${optimisticMeta1.twitter_username}` : ''} 
          | <strong>W:</strong> ${optimisticMeta1.wins || 0} | <strong>L:</strong> ${optimisticMeta1.losses || 0} | <strong>Win %:</strong> ${optimisticMeta1.win_pct || '0.0'}%
        </div>
      `;
      ownerInfo2.innerHTML = `
        <div class="owner-stats">
          ${optimisticMeta2.username || 'Anonymous'}${optimisticMeta2.twitter_username ? ` | @${optimisticMeta2.twitter_username}` : ''} 
          | <strong>W:</strong> ${optimisticMeta2.wins || 0} | <strong>L:</strong> ${optimisticMeta2.losses || 0} | <strong>Win %:</strong> ${optimisticMeta2.win_pct || '0.0'}%
        </div>
      `;

      // Note: "Next Matchup" button is now always visible (no need to create it here)

      // Increment local vote count optimistically
      if (currentUserId) {
        userVotesCount += 1;
      }
      
      // Clear progress flag immediately (UI is ready)
      sendVersusVote.inProgress = false;
    });

    // Show brief loading state while fetching current stats
    ownerInfo1.innerHTML = `<div class="owner-stats">Loading stats...</div>`;
    ownerInfo2.innerHTML = `<div class="owner-stats">Loading stats...</div>`;

    // Only submit to server if no vote is currently being processed; otherwise it was queued.
    if (!voteProcessingLock) {
      (async () => {
        try {
          // Set global lock to prevent concurrent vote processing
          voteProcessingLock = true;
          
          console.log(`🔐 Processing vote in background: ${winnerId} vs ${loserId}`);
          await submitVote(winnerId, loserId);
          console.log('✅ Vote successfully recorded in database');
          
          // Invalidate cached team metadata so fresh stats are fetched
          invalidateTeamMetaCache(winnerId, loserId);
          
        } catch (error) {
          console.error(`❌ Background vote processing failed:`, error);
          
          // Add to queue for retry
          voteQueue.push({ 
            winnerId, 
            loserId, 
            retries: 0,
            timestamp: Date.now()
          });
          console.log(`📋 Vote added to queue for retry (queue length: ${voteQueue.length})`);
          
          // Start processing the queue with shorter delays for faster voting
          const delay = error.message.includes('Too many concurrent challenges') ? 1500 : 500;
          setTimeout(() => processVoteQueue(), delay);
        } finally {
          // Always release the global lock
          console.log(`🔓 Releasing vote processing lock`);
          voteProcessingLock = false;
          // Process any queued clicks immediately when the lock is free
          console.log(`🔄 Processing click queue immediately`);
          processClickQueue();
        }
      })();
    }
  };

  // Store reference for click queue processing
  currentVoteFunction = sendVersusVote;

  chooseBtn1.onclick = () => sendVersusVote(teamId1, teamId2);
  chooseBtn2.onclick = () => sendVersusVote(teamId2, teamId1);

  // Place choose buttons at the bottom of each card
  card1.appendChild(chooseBtn1);
  card2.appendChild(chooseBtn2);

  versusWrapper.appendChild(card1);
  versusWrapper.appendChild(card2);
  
  // Update button states based on current rate limit status
  setTimeout(() => updateChooseButtonStates(), 0);

  // Add versus wrapper to outer container
  outerContainer.appendChild(versusWrapper);
  
  // Add "Next Matchup" button (always visible - can be used as "pass" button)
  const nextButton = document.createElement("button");
  nextButton.textContent = "Next Matchup →";
  nextButton.className = "next-button";
  nextButton.onclick = () => renderVersus();
  outerContainer.appendChild(nextButton);
  
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
      const usernameCell = row.username && row.username !== "-" 
        ? `<a href="voting-history.html?teamId=${row.id}" class="username-link">${row.username}</a>`
        : "-";
      tr.innerHTML = `<td>${viewBtn}</td><td>${usernameCell}</td><td>${row.tournament || "-"}</td><td>${row.wins}</td><td>${row.losses}</td><td>${winPct}%</td>`;
    } else {
      const usernameCell = row.username && row.username !== "-" 
        ? `<a href="profile.html?user=${encodeURIComponent(row.username)}" class="username-link">${row.username}</a>`
        : "-";
      tr.innerHTML = `<td>${usernameCell}</td><td>${row.wins}</td><td>${row.losses}</td><td>${winPct}%</td>`;
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

function populateVotingStats(stats) {
  const friendsTbody = document.getElementById('friends-tbody');
  const foesTbody = document.getElementById('foes-tbody');
  const noFriendsMsg = document.getElementById('no-friends');
  const noFoesMsg = document.getElementById('no-foes');

  // Helper to create a stats row
  function createStatsRow(voter) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(voter.name)}</td>
      <td>${voter.winRate}%</td>
      <td>${voter.wins}-${voter.losses}</td>
    `;
    return tr;
  }

  // Clear existing content
  friendsTbody.innerHTML = '';
  foesTbody.innerHTML = '';

  // Show/hide no data messages
  const hasData = stats.friends.length > 0 || stats.foes.length > 0;
  noFriendsMsg.style.display = stats.friends.length === 0 ? 'block' : 'none';
  noFoesMsg.style.display = stats.foes.length === 0 ? 'block' : 'none';

  // Populate friends
  stats.friends.forEach(friend => {
    friendsTbody.appendChild(createStatsRow(friend));
  });

  // Populate foes
  stats.foes.forEach(foe => {
    foesTbody.appendChild(createStatsRow(foe));
  });
}

// Update the loadProfile function to handle viewing own and other profiles
async function loadProfile() {
  // Get username from URL if present
  const urlParams = new URLSearchParams(window.location.search);
  const usernameToView = urlParams.get('user');
  
  try {
    // If viewing someone else's profile
    if (usernameToView) {
      const response = await fetch(`/profile/${encodeURIComponent(usernameToView)}`);
      
      if (response.status === 401) {
        // Not logged in - show login form
        showLoginRequired();
        return;
      }
      
      if (!response.ok) {
        throw new Error('Failed to load profile');
      }
      
      const data = await response.json();
      
      // Update profile header
      document.getElementById('display-name').textContent = data.user.display_name || data.user.username;
      document.getElementById('username').textContent = data.user.username;
      
      // Hide edit buttons and logout for other users' profiles
      const editDisplayNameBtn = document.querySelector('.edit-display-name');
      const logoutBtn = document.getElementById('logoutBtn');
      if (editDisplayNameBtn) editDisplayNameBtn.style.display = 'none';
      if (logoutBtn) logoutBtn.style.display = 'none';
      
      // Show only vote results tab for other users
      const uploadsSummary = document.getElementById('uploadsSummary');
      const voteResultsContent = document.getElementById('voteResultsContent');
      const tabUploads = document.getElementById('tabUploads');
      const tabResults = document.getElementById('tabResults');
      
      if (uploadsSummary) uploadsSummary.style.display = 'none';
      if (voteResultsContent) voteResultsContent.style.display = 'block';
      if (tabUploads) tabUploads.style.display = 'none';
      if (tabResults) {
        tabResults.style.display = 'block';
        tabResults.classList.add('active');
      }
      
      // Update voting stats
      if (data.votingStats) {
        populateVotingStats(data.votingStats);
      }
      
      // Show profile content
      document.getElementById('profileContent').style.display = 'block';
      document.getElementById('loginSection').style.display = 'none';
      
    } else {
      // Viewing own profile
      const response = await fetch('/my/profile');
      
      if (response.status === 401) {
        // Not logged in - show login form
        showLoginRequired();
        return;
      }
      
      if (!response.ok) {
        throw new Error('Failed to load profile');
      }
      
      const data = await response.json();
      
      // Update user info
      document.getElementById('display-name').textContent = data.user.display_name || data.user.twitter_username || data.user.email;
      document.getElementById('username').textContent = data.user.username;
      document.getElementById('twitter-username').textContent = data.user.twitter_username || 'Not connected';
      document.getElementById('login-method').textContent = data.user.login_method === 'twitter' ? 'Logged in via X (Twitter)' : 'Logged in via email';
      
      // Show edit buttons and logout for own profile
      const editDisplayNameBtn = document.querySelector('.edit-display-name');
      const logoutBtn = document.getElementById('logoutBtn');
      if (editDisplayNameBtn) editDisplayNameBtn.style.display = 'block';
      if (logoutBtn) logoutBtn.style.display = 'block';
      
      // Show both tabs for own profile
      const uploadsSummary = document.getElementById('uploadsSummary');
      const voteResultsContent = document.getElementById('voteResultsContent');
      const tabUploads = document.getElementById('tabUploads');
      const tabResults = document.getElementById('tabResults');
      
      if (uploadsSummary) uploadsSummary.style.display = 'block';
      if (voteResultsContent) voteResultsContent.style.display = 'none';
      if (tabUploads) {
        tabUploads.style.display = 'block';
        tabUploads.classList.add('active');
      }
      if (tabResults) {
        tabResults.style.display = 'block';
        tabResults.classList.remove('active');
      }
      
      // Update voting stats
      if (data.votingStats) {
        populateVotingStats(data.votingStats);
      }
      
      // Show profile content
      document.getElementById('profileContent').style.display = 'block';
      document.getElementById('loginSection').style.display = 'none';
    }
  } catch (err) {
    console.error('Error loading profile:', err);
    showError('Failed to load profile data');
  }
}

function showLoginRequired() {
  const loginSection = document.getElementById('loginSection');
  const profileContent = document.getElementById('profileContent');
  const uploadsSummary = document.getElementById('uploadsSummary');
  const voteResultsContent = document.getElementById('voteResultsContent');
  const tabUploads = document.getElementById('tabUploads');
  const tabResults = document.getElementById('tabResults');

  if (loginSection && profileContent) {
    loginSection.style.display = 'block';
    profileContent.style.display = 'none';
  }

  // Hide tabs when showing login
  if (uploadsSummary) uploadsSummary.style.display = 'none';
  if (voteResultsContent) voteResultsContent.style.display = 'none';
  if (tabUploads) tabUploads.style.display = 'none';
  if (tabResults) tabResults.style.display = 'none';

  // Set up login handlers for the profile page
  const profileLoginTwitterBtn = document.getElementById('profileLoginTwitterBtn');
  const profileLoginEmailForm = document.getElementById('profileLoginEmailForm');

  if (profileLoginTwitterBtn) {
    profileLoginTwitterBtn.addEventListener('click', () => {
      window.location = '/auth/twitter';
    });
  }

  if (profileLoginEmailForm) {
    profileLoginEmailForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('profileLoginEmail').value.trim();
      const password = document.getElementById('profileLoginPassword').value;
      
      if (!email || !password) {
        showLoginMessage('Please provide both email and password', 'error');
        return;
      }

      try {
        const res = await fetch('/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });

        if (res.ok) {
          // Refresh the page after successful login to load profile
          window.location.reload();
        } else {
          const err = await res.json().catch(() => ({}));
          showLoginMessage(err.error || 'Login failed', 'error');
        }
      } catch (error) {
        showLoginMessage('Login failed. Please try again.', 'error');
      }
    });
  }
}

function showError(message) {
  const errorDiv = document.createElement('div');
  errorDiv.className = 'error-message';
  errorDiv.textContent = message;
  
  // Remove any existing error messages
  const existingError = document.querySelector('.error-message');
  if (existingError) {
    existingError.remove();
  }
  
  // Insert at the top of the main content
  const mainContent = document.querySelector('main') || document.body;
  mainContent.insertBefore(errorDiv, mainContent.firstChild);
  
  // Auto-remove after 5 seconds
  setTimeout(() => {
    errorDiv.remove();
  }, 5000);
}

// Initialize profile page if we're on it
if (window.location.pathname.endsWith('profile.html')) {
  document.addEventListener('DOMContentLoaded', () => {
    loadProfile();
  });
}

// Vote queue processor
async function processVoteQueue() {
  if (processingQueue || voteQueue.length === 0 || voteProcessingLock) return;
  
  processingQueue = true;
  console.log(`📋 Processing vote queue (${voteQueue.length} votes pending)`);
  
  while (voteQueue.length > 0) {
    // Wait for any existing vote processing to complete (shorter wait)
    while (voteProcessingLock) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    const vote = voteQueue.shift();
    try {
      voteProcessingLock = true;
      console.log(`🔄 Retrying queued vote: ${vote.winnerId} vs ${vote.loserId}`);
      await submitVote(vote.winnerId, vote.loserId);
      console.log(`✅ Queued vote successfully processed`);
    } catch (error) {
      console.error(`❌ Queued vote failed:`, error);
      // Put it back in queue for later retry (but limit retries)
      if (vote.retries < 5) {
        vote.retries = (vote.retries || 0) + 1;
        voteQueue.push(vote);
        console.log(`🔄 Vote re-queued (retry ${vote.retries}/5)`);
      } else {
        console.error(`❌ Vote permanently failed after 5 retries`);
      }
    } finally {
      voteProcessingLock = false;
    }
    
    // Minimal delay between queue processing for faster voting
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  
  processingQueue = false;
  console.log(`✅ Vote queue processing complete`);
}

// Extracted vote submission function
async function submitVote(winnerId, loserId) {
  const captchaToken = await getCaptchaToken();
  
  const voteResponse = await fetch("/versus", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ winnerId, loserId, captcha: captchaToken }),
  });
  
  if (!voteResponse.ok) {
    const errorText = await voteResponse.text();
    throw new Error(`Vote failed (${voteResponse.status}): ${errorText}`);
  }
  
  return voteResponse;
}

// Debug functions for monitoring vote system
window.debugVoteSystem = () => {
  console.log('🔍 Vote System Debug Info:');
  console.log(`📋 Vote queue length: ${voteQueue.length}`);
  console.log(`👆 Click queue length: ${clickQueue.length}`);
  console.log(`🔄 Processing queue: ${processingQueue}`);
  console.log(`🔒 Vote processing lock: ${voteProcessingLock}`);
  console.log(`⚡ Pending challenges: ${pendingChallenges}`);
  console.log(`🎯 Widget ID: ${widgetId}`);
  console.log(`🎮 Current vote function: ${currentVoteFunction ? 'Available' : 'None'}`);
  if (voteQueue.length > 0) {
    console.log('📋 Queued votes:', voteQueue);
  }
  if (clickQueue.length > 0) {
    console.log('👆 Queued clicks:', clickQueue);
  }
};

// Periodically process the queue and reset stuck counters (safety net)
setInterval(() => {
  if (voteQueue.length > 0) {
    console.log(`🔔 Periodic queue check: ${voteQueue.length} votes pending`);
    processVoteQueue();
  }
  
  // Process click queue if there are pending clicks and no active processing
  if (clickQueue.length > 0 && !voteProcessingLock) {
    console.log(`🔔 Periodic click queue check: ${clickQueue.length} clicks pending`);
    processClickQueue();
  }
  
  // Check if rate limit should be lifted
  checkRateLimitRecovery();
  
  // Reset stuck pending challenges counter (safety net)
  if (pendingChallenges > 0 && !voteProcessingLock && !processingQueue) {
    console.warn(`🔧 Resetting stuck pending challenges counter: ${pendingChallenges} -> 0`);
    pendingChallenges = 0;
  }
}, 1000); // Check every 1 second for faster rate limit recovery
