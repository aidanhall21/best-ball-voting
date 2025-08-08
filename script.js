// 👇 Disable noisy console logging in production builds
(function(){
  const meta = document.querySelector('meta[name="env"]');
  const env = meta ? meta.getAttribute('content') : (window.NODE_ENV || 'production');
  const isProd = env === 'production';
  const isLocalhost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  const suppressLogs = isProd && !isLocalhost && !window.DEBUG_LOGS;
  if (suppressLogs) {
    // Suppress only verbose logs; keep warn/error visible for troubleshooting
    ['log','info','debug'].forEach(fn => {
      console[fn] = () => {};
    });
  }
})();

let teams = [];
let currentIndex = 0;
let userVotes = {};
let teamTournaments = {};
let teamStrategies = {};
let currentMode = "upload"; // 'upload' | 'versus' | 'leaderboard'
let leaderboardType = "team"; // 'team' or 'user'
let leaderboardData = [];
let sortKey = "elo_rating"; // Default to Elo Rating (team view is default)
let sortDir = "desc";
let teamUsernames = {};
let teamUserIds = {}; // teamId -> user_id mapping
let currentUserId = null; // logged-in user id
let userVotesCount = 0;   // total versus votes cast by user
let myTeamIds = [];       // array of teamIds owned by current user
const MAX_LEADERBOARD_ROWS = 1000; // how many rows to actually render after sorting
let currentTournament = "";
let currentUsernameFilter = ""; // Username filter for team leaderboard
let leaderboardRawData = []; // unfiltered data cache

// Global notification variables
let lastNotificationCount = 0;
let notificationPollingInterval = null;

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
  
  if (voteProcessingLock) {
    return; // Wait until current vote fully released
  }
  if (clickQueue.length === 0) {
    return;
  }
  if (!currentVoteFunction) {
    clickQueue.length = 0; // Clear orphaned clicks
    return; // No active voting function available
  }

  // Process all queued clicks at once to prevent them being lost to UI updates
  const clicksToProcess = [...clickQueue]; // Copy the queue
  clickQueue.length = 0; // Clear the original queue
  
  
      clicksToProcess.forEach((click, index) => {
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

// ---- Global Utility Functions ----

function formatTimeAgo(date) {
  const now = new Date();
  const diff = now - date;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
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
      showUploadMessage('Create a username to upload teams', 'error');
    });

    fileInputContainer.appendChild(fileInputOverlay);
  }

  // Helper to keep file input state & overlay in sync
  function updateFileInputState() {
    // Check if we're in a state where username is required
    const needsUsername = currentUserId && document.querySelector('#usernameInput').style.display !== 'none';
    const hasUsername = !!usernameInput.value.trim();
    
    if (needsUsername && !hasUsername) {
      // User needs to enter username first
      csvUpload.disabled = true;
      uploadButton.disabled = true;
      if (fileInputOverlay) {
        fileInputOverlay.style.display = 'block';
      }
    } else {
      // File input is enabled
      const hasFile = csvUpload.files && csvUpload.files.length > 0;
      csvUpload.disabled = false;
      uploadButton.disabled = !hasFile;
      if (fileInputOverlay) {
        fileInputOverlay.style.display = 'none';
      }
    }
  }

  // Mobile menu functionality
  function toggleMobileMenu() {
    if (!mobileMenu) return;
    const isActive = mobileMenu.classList.contains('active');
    if (isActive) {
      closeMobileMenuFunc();
    } else {
      openMobileMenuFunc();
    }
  }

  function openMobileMenuFunc() {
    if (mobileMenu) mobileMenu.classList.add('active');
    if (hamburgerBtn) hamburgerBtn.classList.add('active');
    document.body.style.overflow = 'hidden'; // Prevent background scrolling
  }

  function closeMobileMenuFunc() {
    if (mobileMenu) mobileMenu.classList.remove('active');
    if (hamburgerBtn) hamburgerBtn.classList.remove('active');
    document.body.style.overflow = ''; // Restore scrolling
  }

  // Mobile menu event listeners (only if elements exist)
  if (hamburgerBtn) {
    hamburgerBtn.addEventListener('click', toggleMobileMenu);
  }
  if (closeMobileMenu) {
    closeMobileMenu.addEventListener('click', closeMobileMenuFunc);
  }
  
  // Close mobile menu when clicking outside the menu content
  if (mobileMenu) {
    mobileMenu.addEventListener('click', (e) => {
      if (e.target === mobileMenu) {
        closeMobileMenuFunc();
      }
    });
  }



  // ---- Notification Event Handlers ----
  
  // Desktop notification bell click
  const notificationBell = document.getElementById('notificationBell');
  const notificationDropdown = document.getElementById('notificationDropdown');
  if (notificationBell && notificationDropdown) {
    notificationBell.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = notificationDropdown.style.display !== 'none';
      
      if (isVisible) {
        notificationDropdown.style.display = 'none';
      } else {
        // Hide user menu if open
        if (userMenu) userMenu.style.display = 'none';
        notificationDropdown.style.display = 'block';
        loadNotifications();
      }
    });
  }

  // Mark all read button
  const markAllReadBtn = document.getElementById('markAllRead');
  if (markAllReadBtn) {
    markAllReadBtn.addEventListener('click', markAllNotificationsAsRead);
  }

  // Mobile notification button
  const mobileNotificationBtn = document.getElementById('mobileNotificationBtn');
  if (mobileNotificationBtn) {
    mobileNotificationBtn.addEventListener('click', () => {
      showMobileNotifications();
    });
  }

  // Close dropdowns when clicking outside
  document.addEventListener('click', (e) => {
    if (notificationDropdown && 
        !notificationDropdown.contains(e.target) && 
        !notificationBell.contains(e.target)) {
      notificationDropdown.style.display = 'none';
    }
    
    if (userMenu && 
        !userMenu.contains(e.target) && 
        !gearBtn.contains(e.target)) {
      userMenu.style.display = 'none';
    }
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

      // Fetch notification count and update badge
      await updateNotificationCount();
    } else {
      userVotesCount = 0;
      // Hide notification UI when not logged in
      hideNotificationUI();
    }

    if (loggedIn) {
      const hasDisplayName = !!(data.user.display_name && data.user.display_name.trim());
      const displayName = data.user.display_name || data.user.email || 'User';
      
      // Update desktop user controls (get fresh references in case script was loaded dynamically)
      const userLabel = document.getElementById('userLabel');
      const gearBtn = document.getElementById('userGear');
      const userMenu = document.getElementById('userMenu');
      
      if (userLabel) userLabel.textContent = displayName;
      if (gearBtn) gearBtn.style.display = 'inline-block';
      if (userMenu) userMenu.style.display = 'none'; // Hide menu by default when logged in
      
      // Show notification bell on desktop
      const notificationBell = document.getElementById('notificationBell');
      if (notificationBell) {
        notificationBell.style.display = 'inline-block';
        
        // Set up notification bell click handler (remove any existing handlers first)
        const newNotificationBell = notificationBell.cloneNode(true);
        notificationBell.parentNode.replaceChild(newNotificationBell, notificationBell);
        
        newNotificationBell.addEventListener('click', (e) => {
          e.stopPropagation();
          const notificationDropdown = document.getElementById('notificationDropdown');
          const userMenu = document.getElementById('userMenu');
          
          if (notificationDropdown) {
            const isVisible = notificationDropdown.style.display !== 'none';
            notificationDropdown.style.display = isVisible ? 'none' : 'block';
            
            // Hide user menu if it's open
            if (userMenu) userMenu.style.display = 'none';
            
            // Load notifications when opening dropdown
            if (!isVisible && typeof loadNotifications === 'function') {
              loadNotifications();
            }
          }
        });
      }
      
      // Set up profile button click handler
      if (gearBtn) {
        // Remove any existing handlers first
        const newGearBtn = gearBtn.cloneNode(true);
        gearBtn.parentNode.replaceChild(newGearBtn, gearBtn);
        
        newGearBtn.addEventListener('click', (e) => {
          e.preventDefault();
          window.location.href = '/profile.html';
        });
      }
      
      // Update mobile user controls (get fresh references)
      const mobileUserInfo = document.getElementById('mobileUserInfo');
      
      if (mobileUserInfo) mobileUserInfo.style.display = 'block';
      
      // Show mobile notification button
      const mobileNotificationBtn = document.getElementById('mobileNotificationBtn');
      if (mobileNotificationBtn) {
        mobileNotificationBtn.style.display = 'block';
      }
      
      // Show upload section, hide login panel (only if these elements exist)
      const uploadSection = document.getElementById('uploadSection');
      const loginPanel = document.getElementById('loginPanel');
      const usernameInput = document.getElementById('usernameInput');
      const csvUpload = document.getElementById('csvUpload');
      const uploadButton = document.getElementById('uploadButton');
      
      if (uploadSection) uploadSection.style.display = 'block';
      if (loginPanel) loginPanel.style.display = 'none';
      
      // Show/hide username input based on whether user has display_name (only if elements exist)
      if (usernameInput && hasDisplayName) {
        usernameInput.style.display = 'none';
        if (usernameInput.previousElementSibling) {
          usernameInput.previousElementSibling.textContent = 'Add your drafts to the community vote pool';
        }
        // Enable file input since user has display_name
        if (csvUpload) csvUpload.disabled = false;
        if (uploadButton) uploadButton.disabled = !csvUpload.files.length;
      } else if (usernameInput) {
        usernameInput.style.display = 'block';
        usernameInput.placeholder = 'You must create a username to upload teams';
        if (usernameInput.previousElementSibling) {
          usernameInput.previousElementSibling.textContent = 'Add your drafts to the community vote pool';
        }
        // Disable file input until username is entered
        const hasUsername = !!usernameInput.value.trim();
        if (csvUpload) csvUpload.disabled = !hasUsername;
        if (uploadButton) uploadButton.disabled = !csvUpload.files.length || !hasUsername;
      }
      
      // Enable upload controls (only if elements exist)
      if (usernameInput) usernameInput.disabled = false;
      if (csvUpload) csvUpload.disabled = false; // Always enabled for logged-in users
      if (uploadButton && csvUpload) uploadButton.disabled = !csvUpload.files.length; // Only depends on file selection
      if (uploadSection) uploadSection.style.opacity = '1';
    } else {
      // Update desktop user controls (get fresh references and add null checks)
      const gearBtn = document.getElementById('userGear');
      const userMenu = document.getElementById('userMenu');
      
      if (gearBtn) gearBtn.style.display = 'none';
      if (userMenu) userMenu.style.display = 'none';
      
      // Update mobile user controls (get fresh references and add null checks)
      const mobileUserInfo = document.getElementById('mobileUserInfo');
      
      if (mobileUserInfo) mobileUserInfo.style.display = 'none';
      
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

  // ---- Notification Functions (now using global functions) ----

  function hideNotificationUI() {
    // Hide desktop notification UI
    const notificationBell = document.getElementById('notificationBell');
    const notificationDropdown = document.getElementById('notificationDropdown');
    if (notificationBell) notificationBell.style.display = 'none';
    if (notificationDropdown) notificationDropdown.style.display = 'none';

    // Hide mobile notification UI
    const mobileNotificationBtn = document.getElementById('mobileNotificationBtn');
    if (mobileNotificationBtn) mobileNotificationBtn.style.display = 'none';

    // Stop notification polling
    stopNotificationPolling();
  }

  async function loadNotifications() {
    const notificationList = document.getElementById('notificationList');
    if (!notificationList) return;

    notificationList.innerHTML = '<div class="loading">Loading notifications...</div>';

    try {
      const res = await fetch('/notifications');
      if (res.ok) {
        const data = await res.json();
        const notifications = data.notifications || [];
        
        if (notifications.length === 0) {
          notificationList.innerHTML = '<div class="no-notifications">No notifications yet</div>';
          return;
        }

        notificationList.innerHTML = '';
        notifications.forEach(notification => {
          const item = createNotificationItem(notification);
          notificationList.appendChild(item);
        });
      } else {
        notificationList.innerHTML = '<div class="no-notifications">Failed to load notifications</div>';
      }
    } catch (e) {
      console.error('Failed to load notifications:', e);
      notificationList.innerHTML = '<div class="no-notifications">Failed to load notifications</div>';
    }
  }

  function createNotificationItem(notification) {
    const item = document.createElement('div');
    item.className = `notification-item ${notification.is_read ? '' : 'unread'}`;
    item.dataset.notificationId = notification.id;

    const timeAgo = formatTimeAgo(new Date(notification.created_at));
    
    // Create enhanced notification message with links for versus votes
    let messageHTML = notification.message;
    
    if (notification.type === 'versus_vote' && notification.related_team_id) {
      // Link "your team" to voting history
      const teamLink = `<a href="voting-history.html?teamId=${notification.related_team_id}" style="color: #58a6ff; text-decoration: none;">your team</a>`;
      messageHTML = messageHTML.replace('your team', teamLink);
      
      // Check if this is a tournament notification and handle specially
      const isTournamentNotification = messageHTML.includes('Tournament Round');
      
      if (isTournamentNotification) {
        // Link "Tournament" word to tournament.html
        messageHTML = messageHTML.replace(/(\w+\s+)Tournament(\s+Round)/g, '$1<a href="tournament.html" style="color:#58a6ff;text-decoration:none;">Tournament</a>$2');
        
        // Handle opponent name - find opponent name before any vote count info
        if (notification.opponent_team_id) {
          const againstIndex = messageHTML.lastIndexOf('against ');
          if (againstIndex !== -1) {
            // Look for vote count pattern like "(3 more votes needed)" or "- YOU WON THE MATCHUP!"
            const afterAgainst = messageHTML.substring(againstIndex + 8);
            const voteCountMatch = afterAgainst.match(/^([^(]+?)(\s*\([^)]+\)|$|\s*-\s*[^)]+$)/);
            
            if (voteCountMatch) {
              const opponentName = voteCountMatch[1].trim();
              const voteCountPart = voteCountMatch[2] || '';
              
              if (opponentName) {
                const beforeAgainst = messageHTML.substring(0, againstIndex + 8);
                const opponentLink = `<span class="opponent-link" data-team-id="${notification.opponent_team_id}" style="color: #58a6ff; cursor: pointer; text-decoration: underline;">${opponentName}</span>`;
                messageHTML = beforeAgainst + opponentLink + voteCountPart;
              }
            }
          }
        }
      } else {
        // Regular (non-tournament) notification - link entire opponent name
        if (notification.opponent_team_id) {
          // Find the last occurrence of "against " and everything after it should be the opponent name
          const againstIndex = messageHTML.lastIndexOf('against ');
          if (againstIndex !== -1) {
            const beforeAgainst = messageHTML.substring(0, againstIndex + 8); // Keep "against "
            const opponentName = messageHTML.substring(againstIndex + 8); // Everything after "against "
            
            if (opponentName.trim()) {
              const opponentLink = `<span class="opponent-link" data-team-id="${notification.opponent_team_id}" style="color: #58a6ff; cursor: pointer; text-decoration: underline;">${opponentName}</span>`;
              messageHTML = beforeAgainst + opponentLink;
            }
          }
        }
      }
    }
    
    item.innerHTML = `
      <div class="notification-message">${messageHTML}</div>
      <div class="notification-time">${timeAgo}</div>
    `;

    // Add click handlers for opponent links
    const opponentLinks = item.querySelectorAll('.opponent-link');
    opponentLinks.forEach(link => {
      link.addEventListener('click', async (e) => {
        e.stopPropagation();
        const teamId = link.getAttribute('data-team-id');
        if (teamId) {
          // Fetch team metadata to get the opponent's username
          try {
            const meta = await fetchTeamMeta(teamId);
            if (meta.username) {
              // Navigate to the opponent's profile page
              window.location.href = `profile.html?user=${encodeURIComponent(meta.username)}`;
            } else {
              // Fallback: show team modal if no username available
              showTeamModal(teamId);
            }
          } catch (error) {
            console.error('Failed to fetch opponent info:', error);
            // Fallback: show team modal on error
            showTeamModal(teamId);
          }
        }
      });
    });

    // Mark as read when clicked (but not when clicking links)
    item.addEventListener('click', async (e) => {
      // Don't mark as read if user clicked on a link
      if (e.target.tagName === 'A' || e.target.classList.contains('opponent-link')) {
        return;
      }
      
      if (!notification.is_read) {
        await markNotificationAsRead(notification.id);
        item.classList.remove('unread');
        await updateNotificationCount(); // Refresh count
      }
    });

    return item;
  }



  async function markAllNotificationsAsRead() {
    try {
      const res = await fetch('/notifications/read-all', {
        method: 'POST'
      });
      if (res.ok) {
        // Immediately update the badge to 0 for instant feedback
        updateNotificationBadge(0);
        
        // Refresh the notification list and count
        await loadNotifications();
        
        // Wait a moment for database to update, then refresh count
        setTimeout(async () => {
          await updateNotificationCount();
        }, 500);
      } else {
        console.error('Failed to mark all notifications as read:', res.status, res.statusText);
      }
    } catch (e) {
      console.error('Failed to mark all notifications as read:', e);
    }
  }

  // ---- Real-time Notification Updates ----

  function startNotificationPolling() {
    // Clear any existing polling
    if (notificationPollingInterval) {
      clearInterval(notificationPollingInterval);
    }

    // Only poll if user is logged in
    if (!currentUserId) return;

    // Poll every 30 seconds
    notificationPollingInterval = setInterval(async () => {
      if (currentUserId) {
        await checkForNewNotifications();
      } else {
        // Stop polling if user logged out
        stopNotificationPolling();
      }
    }, 30000);
  }

  function stopNotificationPolling() {
    if (notificationPollingInterval) {
      clearInterval(notificationPollingInterval);
      notificationPollingInterval = null;
    }
  }

  async function checkForNewNotifications() {
    try {
      const res = await fetch('/notifications/count');
      if (res.ok) {
        const data = await res.json();
        const currentCount = data.count || 0;
        
        // Show a subtle notification if count increased
        if (currentCount > lastNotificationCount && lastNotificationCount > 0) {
          showNewNotificationToast(currentCount - lastNotificationCount);
        }
        
        lastNotificationCount = currentCount;
        updateNotificationBadge(currentCount);
        
        // If notification dropdown is open, refresh the list
        const dropdown = document.getElementById('notificationDropdown');
        if (dropdown && dropdown.style.display !== 'none') {
          await loadNotifications();
        }

        // If mobile notification overlay is open, refresh the list
        const mobileOverlay = document.getElementById('mobileNotificationOverlay');
        if (mobileOverlay && mobileOverlay.style.display !== 'none') {
          await loadMobileNotifications();
        }
      }
    } catch (e) {
      console.error('Failed to check for new notifications:', e);
    }
  }

  function showNewNotificationToast(newCount) {
    // Create a subtle toast notification
    const toast = document.createElement('div');
    toast.className = 'notification-toast';
    toast.textContent = `${newCount} new notification${newCount > 1 ? 's' : ''}`;
    
    // Add toast styles
    toast.style.cssText = `
      position: fixed;
      top: 80px;
      right: 20px;
      background: #238636;
      color: white;
      padding: 12px 16px;
      border-radius: 6px;
      font-size: 14px;
      z-index: 9999;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      animation: slideIn 0.3s ease-out;
    `;

    document.body.appendChild(toast);

    // Remove toast after 3 seconds
    setTimeout(() => {
      toast.style.animation = 'slideOut 0.3s ease-in';
      setTimeout(() => {
        if (toast.parentNode) {
          toast.parentNode.removeChild(toast);
        }
      }, 300);
    }, 3000);
  }

  function showLoginMessage(msg, type) {
    loginMessageEl.textContent = msg;
    loginMessageEl.style.display = msg ? 'block' : 'none';
    loginMessageEl.className = 'upload-message';
    if (type) loginMessageEl.classList.add(type);
  }

  // Event: Twitter login
  if (loginTwitterBtn) {
    loginTwitterBtn.addEventListener('click', () => {
      window.location = '/auth/twitter';
    });
  }

  // Event: Twitter signup (same as login)
  const signupTwitterBtn = document.getElementById('signupTwitterBtn');
  if (signupTwitterBtn) {
    signupTwitterBtn.addEventListener('click', () => {
      window.location = '/auth/twitter';
    });
  }

  // Tab switching
  const loginTab = document.getElementById('loginTab');
  if (loginTab) {
    loginTab.addEventListener('click', () => {
      setAuthTab('login');
    });
  }
  
  const signupTab = document.getElementById('signupTab');
  if (signupTab) {
    signupTab.addEventListener('click', () => {
      setAuthTab('signup');
    });
  }

  function setAuthTab(tab) {
    const loginTab = document.getElementById('loginTab');
    const signupTab = document.getElementById('signupTab');
    const loginForm = document.getElementById('loginForm');
    const signupForm = document.getElementById('signupForm');
    
    if (tab === 'login') {
      loginTab.classList.add('active');
      signupTab.classList.remove('active');
      loginForm.style.display = '';
      signupForm.style.display = 'none';
    } else {
      loginTab.classList.remove('active');
      signupTab.classList.add('active');
      loginForm.style.display = 'none';
      signupForm.style.display = '';
    }
    // Clear any previous messages when switching tabs
    showLoginMessage('', '');
  }

  // Event: Email login
  if (loginEmailForm) {
    loginEmailForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('loginEmail').value.trim();
      const password = document.getElementById('loginPassword').value;
      if (!email || !password) return;
      const res = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: email, password })
      });
      if (res.ok) {
        await refreshAuth();
      } else {
        const err = await res.json().catch(() => ({}));
        showLoginMessage(err.error || 'Login failed', 'error');
      }
    });
  }

  // Event: Email signup
  const signupEmailForm = document.getElementById('signupEmailForm');
  if (signupEmailForm) {
    signupEmailForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('signupUsername').value.trim();
      const email = document.getElementById('signupEmail').value.trim();
      const password = document.getElementById('signupPassword').value;
      const passwordConfirm = document.getElementById('signupPasswordConfirm').value;
      const emailConfirm = document.getElementById('signupEmailConfirm').value.trim();
      
      // Validation
      if (!username || !email || !emailConfirm || !password || !passwordConfirm) {
        showLoginMessage('All fields are required', 'error');
        return;
      }
      if (email !== emailConfirm) {
        showLoginMessage('Emails do not match', 'error');
        return;
      }
      
      if (password !== passwordConfirm) {
        showLoginMessage('Passwords do not match', 'error');
        return;
      }
      
      if (password.length < 6) {
        showLoginMessage('Password must be at least 6 characters', 'error');
        return;
      }
      
      const res = await fetch('/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, emailConfirm, password })
      });
      
      if (res.ok) {
        // automatically log in after register
        const loginRes = await fetch('/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier: email, password })
        });
        if (loginRes.ok) {
          await refreshAuth();
          showLoginMessage('Account created successfully!', 'success');
        } else {
          showLoginMessage('Account created but auto login failed. Please try logging in.', 'error');
        }
      } else {
        const err = await res.json().catch(() => ({}));
        showLoginMessage(err.error || 'Registration failed', 'error');
      }
    });
  }

  // Event: logout (button inside menu now)
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      await fetch('/logout', { method: 'POST' });
      await refreshAuth();
      showLoginMessage('', '');
    });
  }

  // Event: Forgot password
  if (forgotPasswordLink) {
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
  }

  // Check auth on load and then set initial mode once we know auth state
  refreshAuth().then(() => {
    // Show content now that auth check is complete
    document.body.classList.add('content-visible');
    // Ensure correct initial layout after auth status is known
    setMode("landing");

    // Start periodic notification checking for logged-in users
    startNotificationPolling();
  });

  // Enable/disable file input and upload button based on file selection and username
  if (usernameInput) {
    usernameInput.addEventListener("input", (e) => {
      updateFileInputState();
      // Clear any previous warning once typing starts
      showUploadMessage('', '');
    });
  }

  // Enable/disable upload button based on file selection
  if (csvUpload) {
    csvUpload.addEventListener("change", (e) => {
      uploadButton.disabled = !e.target.files.length;
    });
  }

  // Handle file upload when button is clicked
  if (uploadButton) {
    uploadButton.addEventListener("click", () => {
    const file = csvUpload.files[0];
    const username = usernameInput.value.trim(); // Optional now

    if (!file) {
      showUploadMessage("Please select a file", "error");
      return;
    }

    const formData = new FormData();
    formData.append("csv", file);
    if (username) {
      formData.append("username", username);
    }
    // If no username provided, backend will use account display_name

    uploadButton.disabled = true;
    showUploadMessage("Uploading...", "");

    fetch("/upload", {
      method: "POST",
      body: formData
    })
      .then(response => {
        if (!response.ok) {
          return response.json().then(err => {
            throw new Error(err.error || err.message || "Upload failed");
          });
        }
        return response.json();
      })
      .then(data => {
        // Clear inputs after any successful upload attempt
        csvUpload.value = "";
        usernameInput.value = "";
        uploadButton.disabled = true; // Disabled until new file selected
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
  }

  // Gear button click handler - go directly to profile page
  if (gearBtn) {
    gearBtn.addEventListener('click', (e) => {
      e.preventDefault();
      window.location.href = 'profile.html';
    });
  }

  function setMode(mode) {
    currentMode = mode;
    
    const landingSection = document.getElementById('landingSection');

    // Toggle landing visibility
    if (landingSection) {
      landingSection.style.display = (mode === 'landing') ? 'block' : 'none';
    }
    
    // Update desktop navigation buttons (none active for landing)
    document.getElementById("modeUploadBtn").classList.toggle("active", mode === "upload");
    document.getElementById("modeVersusBtn").classList.toggle("active", mode === "versus");
    document.getElementById("modeLeaderboardBtn").classList.toggle("active", mode === "leaderboard");
    
    // Update mobile navigation buttons
    document.getElementById("mobileUploadBtn").classList.toggle("active", mode === "upload");
    document.getElementById("mobileVersusBtn").classList.toggle("active", mode === "versus");
    document.getElementById("mobileLeaderboardBtn").classList.toggle("active", mode === "leaderboard");
    
    const container = document.getElementById("teamsContainer");
    const uploadPanel = document.querySelector('.upload-panel');
    
    // For landing mode, hide heavy app content and exit early
    if (mode === 'landing') {
      if (uploadPanel) uploadPanel.style.display = 'none';
      if (container) container.style.display = 'none';
      closeMobileMenuFunc();
      return;
    }
    
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

  // Landing CTA buttons (hero section)
  const ctaVoteBtn = document.getElementById('ctaVoteBtn');
  if (ctaVoteBtn) {
    ctaVoteBtn.addEventListener('click', () => setMode('versus'));
  }

  const ctaUploadBtn = document.getElementById('ctaUploadBtn');
  if (ctaUploadBtn) {
    ctaUploadBtn.addEventListener('click', () => setMode('upload'));
  }
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
      teamStrategies = data.strategies || {};
      
      // Pre-compute tournament groups for performance  
      window.cachedTourGroups = {};
      teams.forEach(([tid]) => {
        const tour = teamTournaments[tid];
        if (!tour) return;
        if (!window.cachedTourGroups[tour]) window.cachedTourGroups[tour] = [];
        window.cachedTourGroups[tour].push(tid);
      });
      
      // NEW: Handle stack filtering metadata and pre-compute candidates
      if (data.stackFilters) {
        window.stackFilters = data.stackFilters;
        
        // Pre-compute team candidates for performance
        window.precomputedCandidates = {
          team1: [],
          team2: [],
          general: []
        };
        
        if (data.stackFilters.team1Stack || data.stackFilters.team2Stack || data.stackFilters.team1Player || data.stackFilters.team2Player || data.stackFilters.team1Strategy || data.stackFilters.team2Strategy) {
          let totalTeams = 0;
          let team1Matches = 0;
          let team2Matches = 0;
          let generalMatches = 0;
          
          const hasTeam1Filters = data.stackFilters.team1Stack || data.stackFilters.team1Player || data.stackFilters.team1Strategy;
          const hasTeam2Filters = data.stackFilters.team2Stack || data.stackFilters.team2Player || data.stackFilters.team2Strategy;
          
          teams.forEach(teamEntry => {
            const [teamId, playersArray, metadata] = teamEntry;
            totalTeams++;
            
            // Check team1 requirements (stack and/or player)
            let matchesTeam1 = true;
            if (data.stackFilters.team1Stack) {
              matchesTeam1 = matchesTeam1 && (
                (metadata && metadata.matchesTeam1Stack) ||
                playersArray.some(player => 
                  player && player.team === data.stackFilters.team1Stack && player.stack === 'primary'
                )
              );
            }
            if (data.stackFilters.team1Player) {
              matchesTeam1 = matchesTeam1 && (
                (metadata && metadata.matchesTeam1Player) ||
                playersArray.some(player => 
                  player && player.name === data.stackFilters.team1Player
                )
              );
            }
            if (data.stackFilters.team1Strategy) {
              matchesTeam1 = matchesTeam1 && (
                (metadata && metadata.matchesTeam1Strategy) ||
                (teamStrategies[teamId] && teamStrategies[teamId][data.stackFilters.team1Strategy] === 1)
              );
            }
            
            // Check team2 requirements (stack and/or player)
            let matchesTeam2 = true;
            if (data.stackFilters.team2Stack) {
              matchesTeam2 = matchesTeam2 && (
                (metadata && metadata.matchesTeam2Stack) ||
                playersArray.some(player => 
                  player && player.team === data.stackFilters.team2Stack && player.stack === 'primary'
                )
              );
            }
            if (data.stackFilters.team2Player) {
              matchesTeam2 = matchesTeam2 && (
                (metadata && metadata.matchesTeam2Player) ||
                playersArray.some(player => 
                  player && player.name === data.stackFilters.team2Player
                )
              );
            }
            if (data.stackFilters.team2Strategy) {
              matchesTeam2 = matchesTeam2 && (
                (metadata && metadata.matchesTeam2Strategy) ||
                (teamStrategies[teamId] && teamStrategies[teamId][data.stackFilters.team2Strategy] === 1)
              );
            }
            
            // Categorize teams
            if (hasTeam1Filters && matchesTeam1) {
              window.precomputedCandidates.team1.push(teamEntry);
              team1Matches++;
            }
            if (hasTeam2Filters && matchesTeam2) {
              window.precomputedCandidates.team2.push(teamEntry);
              team2Matches++;
            }
            if ((!hasTeam1Filters || !matchesTeam1) && (!hasTeam2Filters || !matchesTeam2)) {
              window.precomputedCandidates.general.push(teamEntry);
              generalMatches++;
            }
          });
          
          
        }
      } else {
        window.stackFilters = null;
        window.precomputedCandidates = null;
      }
      
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
      // NEW: vote totals map (wins & losses)
      if (data.totals) {
        teamVoteTotals = {};
        Object.entries(data.totals).forEach(([tid, t]) => {
          teamVoteTotals[tid] = (t.wins || 0) + (t.losses || 0);
        });
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

function getBorderColor(position, tournamentName = "") {
  // Special case: In "Rookies and Sophomores" tournament, treat TE same as WR (yellow)
  if (tournamentName === "Rookies and Sophomores" && position === "TE") {
    return "#facc15"; // WR color (yellow)
  }
  
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
  if (tourName === "Rookies and Sophomores") return "Rookies & Sophomores";
  if (tourName === "Badge Bros Brawl") return "Badge Bros Brawl";
  if (preDraftNames.includes(tourName)) return "Pre Draft";
  return "Post Draft";
}

function buildTeamCard(teamId, players) {
  const card = document.createElement("div");
  card.className = "team-card";

  // Get tournament name for this team to handle special position color rules
  const tournamentName = teamTournaments[teamId] || "";

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
      bubble.style.border = `2px solid ${getBorderColor(pl.position, tournamentName)}`;

      row.appendChild(bubble);
      list.appendChild(row);
    });
  });

  card.appendChild(list);
  return card;
}

// Draft-vs-Draft matchup renderer (now async so we can look up team-meta on demand)
async function renderVersus() {
  const renderStart = performance.now();
  console.log('🔄 Starting renderVersus...');
  
  const container = document.getElementById("teamsContainer");
  container.innerHTML = "";

  // Clear any previous vote function reference only if no clicks are pending
  if (clickQueue.length === 0) {
    currentVoteFunction = null;
  }

  // Declare here so it is in scope for sendVersusVote
  let nextButton; // will be created later and shown after a successful vote

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

  // Debug: log include-my-team calculation

  // Create outer container for everything
  const outerContainer = document.createElement("div");
  outerContainer.className = "versus-outer-container";

  // Create versus container just for the cards
  const versusWrapper = document.createElement("div");
  versusWrapper.className = "versus-container";

  // Use cached tournament groups for performance, with fallback
  const startTime = performance.now();
  let tourGroups = window.cachedTourGroups;
  if (!tourGroups) {
    console.log('Building tourGroups from scratch (cache miss)');
    // Fallback: build tourGroups if not cached (shouldn't happen often)
    tourGroups = {};
    teams.forEach(([tid]) => {
      const tour = teamTournaments[tid];
      if (!tour) return;
      if (!tourGroups[tour]) tourGroups[tour] = [];
      tourGroups[tour].push(tid);
    });
  } else {
    console.log('Using cached tourGroups');
  }
  console.log(`TourGroups setup took: ${performance.now() - startTime}ms`);

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
  
  const teamSelectionStart = performance.now();
  console.log('🎯 Starting team selection...');

  /*
   * ===== Weighted vote-bucket selection (after "include my team" check) =====
   * If we still don't have a first team picked, choose it based on total
   * community votes the lineup has received so far.  Buckets & weights:
   *   • 35% – 0 votes
   *   • 35% – 1–5 votes
   *   • 20% – 6–10 votes
   *   •  5% – >10 votes
   * (The remaining 5% probability is reserved for the "my team" logic above.)
   */

  // Helper: determine bucket name from total votes
  const getBucket = (total) => {
    if (total === 0) return "ZERO";           // 0-0
    if (total <= 5)  return "ONE_FIVE";       // 1-5
    if (total <= 10) return "SIX_TEN";        // 6-10
    return "OVER_TEN";                        // >10
  };

  // Helper: pick a bucket according to weights
  const pickRandomBucket = () => {
    const r = Math.random();
    if (r < 0.30) return "ZERO";             // 35%
    if (r < 0.60) return "ONE_FIVE";         // next 35%
    if (r < 0.85) return "SIX_TEN";          // next 20%
    return "OVER_TEN";                        // 5% (0.90–0.95); any value ≥0.95 falls through later
  };

  // Helper: find a random team that lives in the desired bucket.  We iterate
  // through the shuffled team list until we find a match.  If none is found
  // we return null so the legacy fallback can run.
  const pickTeamInBucket = async (bucketName) => {
    const shuffledTeams = shuffle([...teams]); // reuse existing shuffle helper
    for (const [tid] of shuffledTeams) {
      try {
        let totalVotes;
        if (teamVoteTotals[tid] !== undefined) {
          totalVotes = teamVoteTotals[tid];
        } else {
          const meta = await fetchTeamMeta(tid); // cached; fast after first hit
          totalVotes = (meta.wins || 0) + (meta.losses || 0);
          teamVoteTotals[tid] = totalVotes; // cache for future
        }
        if (getBucket(totalVotes) === bucketName) {
          return tid;
        }
      } catch (_) { /* ignore and keep searching */ }
    }
    return null; // bucket empty
  };

  // Helper: pick a team *from a provided list* that matches a bucket
  const pickTeamInBucketFromList = async (bucketName, idList) => {
    console.log(`🔧 pickTeamInBucketFromList: searching ${idList.length} teams for bucket ${bucketName}`);
    const funcStart = performance.now();
    let apiCalls = 0;
    let teamsChecked = 0;
    
    const shuffleStart = performance.now();
    const shuffled = shuffle([...idList]);
    console.log(`🔧 Shuffling ${idList.length} teams took ${performance.now() - shuffleStart}ms`);
    for (const tid of shuffled) {
      teamsChecked++;
      try {
        let totalVotes;
        if (teamVoteTotals[tid] !== undefined) {
          totalVotes = teamVoteTotals[tid];
        } else {
          apiCalls++;
          const metaStart = performance.now();
          const meta = await fetchTeamMeta(tid);
          console.log(`🔧 fetchTeamMeta #${apiCalls} took ${performance.now() - metaStart}ms`);
          totalVotes = (meta.wins || 0) + (meta.losses || 0);
          teamVoteTotals[tid] = totalVotes;
        }
        if (getBucket(totalVotes) === bucketName) {
          console.log(`🔧 Found match after checking ${teamsChecked} teams, ${apiCalls} API calls in ${performance.now() - funcStart}ms`);
          return tid;
        }
      } catch (_) { /* skip */ }
    }
    console.log(`🔧 No match found after checking ${teamsChecked} teams, ${apiCalls} API calls in ${performance.now() - funcStart}ms`);
    return null;
  };

    // ===== NEW: Stack/Player-based team selection (optimized with pre-computed candidates) =====
  // If filters are active, use pre-computed candidates for fast selection
  if (window.precomputedCandidates && (window.stackFilters.team1Stack || window.stackFilters.team2Stack || window.stackFilters.team1Player || window.stackFilters.team2Player || window.stackFilters.team1Strategy || window.stackFilters.team2Strategy)) {
    console.log('🔍 Using filtered team selection...');
    
    // Try to find team1 with required filters
    if ((window.stackFilters.team1Stack || window.stackFilters.team1Player || window.stackFilters.team1Strategy) && !teamId1 && window.precomputedCandidates.team1.length > 0) {
      const team1Start = performance.now();
      console.log(`🔍 Selecting team1 from ${window.precomputedCandidates.team1.length} candidates...`);
      const targetBucket = pickRandomBucket();
      let metaFetches = 0;
      for (const [tid, teamData] of shuffle(window.precomputedCandidates.team1)) {
        try {
          let totalVotes = teamVoteTotals[tid];
          if (totalVotes === undefined) {
            metaFetches++;
            const metaStart = performance.now();
            const meta = await fetchTeamMeta(tid);
            console.log(`📊 fetchTeamMeta took ${performance.now() - metaStart}ms`);
            totalVotes = (meta.wins || 0) + (meta.losses || 0);
            teamVoteTotals[tid] = totalVotes;
          }
          if (getBucket(totalVotes) === targetBucket) {
            teamId1 = tid;
            break;
          }
        } catch (_) { /* skip */ }
      }
      // If no team matches the bucket, just pick any team with the stack
      if (!teamId1) {
        teamId1 = randElem(window.precomputedCandidates.team1)[0];
      }
      console.log(`🔍 Team1 selection completed in ${performance.now() - team1Start}ms (${metaFetches} API calls)`);
    }
  }

  // Only run normal team1 selection if no team1 filters are defined
  if (!teamId1 && !window.stackFilters?.team1Stack && !window.stackFilters?.team1Player && !window.stackFilters?.team1Strategy) {
    const targetBucket = pickRandomBucket();
    teamId1 = await pickTeamInBucket(targetBucket);
  }

  // Only run normal team2 selection if no team2 filters are defined
  // If we successfully picked teamId1 via buckets, choose teamId2 respecting
  // the existing tournament / different-user rules.  Otherwise fall through
  // to the legacy random-tournament logic below.
  if (teamId1 && !teamId2 && !window.stackFilters?.team2Stack && !window.stackFilters?.team2Player && !window.stackFilters?.team2Strategy) {
    const team2Start = performance.now();
    console.log('🔍 Starting team2 selection...');
    const tour = teamTournaments[teamId1];
    let list = (tour && tourGroups[tour]) ? tourGroups[tour] : [];
    
    // If team1 was selected via filters and we have precomputed candidates, 
    // restrict team2 selection to the general pool (teams that don't match team1 filters)
    if (window.precomputedCandidates && (window.stackFilters?.team1Stack || window.stackFilters?.team1Player || window.stackFilters?.team1Strategy)) {
      // Convert to Set for O(1) lookups instead of O(n) - MAJOR PERFORMANCE OPTIMIZATION
      const generalTeamIds = window.precomputedCandidates.general.map(([tid]) => tid);
      const generalTeamSet = new Set(generalTeamIds);
      const filteredList = list.filter(id => generalTeamSet.has(id));
      // Only use filtered list if it's not empty, otherwise fall back to original list
      if (filteredList.length > 0) {
        list = filteredList;
      }
    }
    
    const filterStart = performance.now();
    const team1UserId = teamUserIds[teamId1] || null;
    const differentUserTeams = list.filter(id => id !== teamId1 && (teamUserIds[id] || null) !== team1UserId);
    console.log(`🔍 Filtering ${list.length} teams took ${performance.now() - filterStart}ms`);
    console.log(`🔍 Found ${differentUserTeams.length} different-user teams for team2`);
    if (differentUserTeams.length) {
      const bucket2 = pickRandomBucket();
      const bucketStart = performance.now();
      console.log(`🔍 Calling pickTeamInBucketFromList with bucket: ${bucket2}`);
      
      // For large team lists, skip bucket matching to avoid performance issues
      if (differentUserTeams.length > 5000) {
        console.log('🚀 Using fast selection for large team list');
        const randStart = performance.now();
        teamId2 = randElem(differentUserTeams);
        const randEnd = performance.now();
        console.log(`🚀 randElem took ${randEnd - randStart}ms`);
        const logStart = performance.now();
        console.log(`🚀 console.log delay check: ${performance.now() - logStart}ms`);
      } else {
        teamId2 = await pickTeamInBucketFromList(bucket2, differentUserTeams) || randElem(differentUserTeams);
      }
      console.log(`🔍 pickTeamInBucketFromList took ${performance.now() - bucketStart}ms`);
    }
    const finalStart = performance.now();
    console.log(`🔍 About to log completion time...`);
    console.log(`🔍 Team2 selection completed in ${performance.now() - team2Start}ms`);
    console.log(`🔍 Final console.log took ${performance.now() - finalStart}ms`);
  }

  // ---- Fallback to original random selection if we didn't get valid ids ----
  const eligibleTours = Object.entries(tourGroups).filter(([tour, tlist]) => {
    const usernamesSet = new Set(tlist.map(id => teamUsernames[id] || "__anon__"));
    return usernamesSet.size >= 2;
  });

  // Fallback logic - only select teams that don't have filter requirements
  if (!teamId1 || (!teamId2 && !window.stackFilters?.team2Stack && !window.stackFilters?.team2Player && !window.stackFilters?.team2Strategy)) {
    if (eligibleTours.length) {
      const [tour, list] = weightedTournamentSelect(eligibleTours);
      
      // Only set teamId1 if not already set by filter logic
      if (!teamId1 && !window.stackFilters?.team1Stack && !window.stackFilters?.team1Player && !window.stackFilters?.team1Strategy) {
        teamId1 = randElem(list);
      }
      
      // Only set teamId2 if not already set by filter logic and no team2 filters required
      if (!teamId2 && !window.stackFilters?.team2Stack && !window.stackFilters?.team2Player && !window.stackFilters?.team2Strategy && teamId1) {
        const user1 = teamUsernames[teamId1] || "__anon__";
        let differentUserTeams = list.filter(id => id !== teamId1 && (teamUsernames[id] || "__anon__") !== user1);
        
        // If team1 was selected via filters, restrict team2 to general pool
        if (window.precomputedCandidates && (window.stackFilters?.team1Stack || window.stackFilters?.team1Player || window.stackFilters?.team1Strategy)) {
          const generalTeamIds = window.precomputedCandidates.general.map(([tid]) => tid);
          const filteredTeams = differentUserTeams.filter(id => generalTeamIds.includes(id));
          // Only use filtered teams if we have some, otherwise fall back to original list
          if (filteredTeams.length > 0) {
            differentUserTeams = filteredTeams;
          }
        }
        
        if (differentUserTeams.length) {
          const bucket2 = pickRandomBucket();
          teamId2 = await pickTeamInBucketFromList(bucket2, differentUserTeams) || randElem(differentUserTeams);
        }
      }
    } else {
      // ultimate fallback: any two distinct random teams (only if no filter requirements)
      if (!teamId1 && !window.stackFilters?.team1Stack && !window.stackFilters?.team1Player && !window.stackFilters?.team1Strategy) {
        let idx1 = Math.floor(Math.random() * teams.length);
        teamId1 = teams[idx1][0];
      }
      
      if (!teamId2 && !window.stackFilters?.team2Stack && !window.stackFilters?.team2Player && !window.stackFilters?.team2Strategy && teamId1) {
        let idx2;
        do {
          idx2 = Math.floor(Math.random() * teams.length);
        } while (teams[idx2][0] === teamId1);
        teamId2 = teams[idx2][0];
      }
    }
  }

  // ===== NEW: Team2 filter selection (after team1 is determined) =====
  // Handle case where only team2 filters are defined, or team2 filters are defined and team1 was selected normally
  if (window.precomputedCandidates && (window.stackFilters.team2Stack || window.stackFilters.team2Player || window.stackFilters.team2Strategy) && teamId1 && window.precomputedCandidates.team2.length > 0) {
    const tour = teamTournaments[teamId1];
    const list = (tour && tourGroups[tour]) ? tourGroups[tour] : teams.map(([tid]) => tid);
    
    // Filter pre-computed team2 candidates by tournament and user constraints
    const validTeam2Candidates = window.precomputedCandidates.team2.filter(([tid]) => 
      tid !== teamId1 && 
      list.includes(tid) &&
      (teamUserIds[tid] || null) !== (teamUserIds[teamId1] || null)
    );
    
    if (validTeam2Candidates.length > 0) {
      const targetBucket = pickRandomBucket();
      let foundTeam2 = false;
      
      for (const [tid, teamData] of shuffle(validTeam2Candidates)) {
        try {
          let totalVotes = teamVoteTotals[tid];
          if (totalVotes === undefined) {
            const meta = await fetchTeamMeta(tid);
            totalVotes = (meta.wins || 0) + (meta.losses || 0);
            teamVoteTotals[tid] = totalVotes;
          }
          if (getBucket(totalVotes) === targetBucket) {
            teamId2 = tid;
            foundTeam2 = true;
            break;
          }
        } catch (_) { /* skip */ }
      }
      
      // If no team matches the bucket, just pick any team with the stack
      if (!foundTeam2) {
        teamId2 = randElem(validTeam2Candidates)[0];
      }
    }
  }

  // Final debug for the matchup that will be displayed

  console.log(`🎯 Team selection completed in ${performance.now() - teamSelectionStart}ms`);
  
  // Check if we have valid team IDs
  if (!teamId1 || !teamId2) {
    console.error(`Invalid team selection: teamId1=${teamId1}, teamId2=${teamId2}`);
    showError('Failed to find two teams for matchup. Please refresh and try again.');
    return;
  }

  // Retrieve players arrays
  const team1Entry = teams.find(([id]) => id === teamId1);
  const team2Entry = teams.find(([id]) => id === teamId2);
  
  if (!team1Entry || !team2Entry) {
    console.error(`Could not find team data: team1Entry=${!!team1Entry}, team2Entry=${!!team2Entry}`);
    showError('Failed to load team data. Please refresh and try again.');
    return;
  }
  
  const players1 = team1Entry[1];
  const players2 = team2Entry[1];

  const cardBuildStart = performance.now();
  console.log('🃏 Building team cards...');
  const card1 = buildTeamCard(teamId1, players1);
  const card2 = buildTeamCard(teamId2, players2);
  console.log(`🃏 Team cards built in ${performance.now() - cardBuildStart}ms`);

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
      if (clickQueue.length < 5) {
        clickQueue.push({ winnerId, loserId, voteFunc: sendVersusVote, isQueuedClick: true });
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

    // Update skip matchup text if we're on the home page
    if (window.location.pathname.endsWith('/')) {
      const skipMatchupLink = document.querySelector('.skip-matchup');
      if (skipMatchupLink) {
        skipMatchupLink.textContent = 'Continue voting';
      }
    }

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
      
      // Calculate current total matches for each team (before this vote)
      const team1Matches = (meta1.wins || 0) + (meta1.losses || 0);
      const team2Matches = (meta2.wins || 0) + (meta2.losses || 0);
      
      // Get current user ID for vote weight calculation
      const voterId = currentUserId;
      
      // Calculate vote weight based on team ownership
      const voteWeight = calculateVoteWeightClient(voterId, 
        teamUserIds[teamId1], teamUserIds[teamId2]);
      
      // Calculate new ELO ratings optimistically
      const currentElo1 = optimisticMeta1.elo_rating || STARTING_ELO;
      const currentElo2 = optimisticMeta2.elo_rating || STARTING_ELO;
      
      let newEloRatings;
      if (winnerId === teamId1) {
        // Team 1 wins, Team 2 loses
        optimisticMeta1.wins = (optimisticMeta1.wins || 0) + 1;
        optimisticMeta2.losses = (optimisticMeta2.losses || 0) + 1;
        
        newEloRatings = calculateNewEloRatingsClient(
          currentElo1, currentElo2, voteWeight, team1Matches, team2Matches
        );
        optimisticMeta1.elo_rating = newEloRatings.winnerNewElo;
        optimisticMeta2.elo_rating = newEloRatings.loserNewElo;
        
        // Calculate ELO changes (deltas)
        optimisticMeta1.elo_delta = newEloRatings.winnerNewElo - currentElo1;
        optimisticMeta2.elo_delta = newEloRatings.loserNewElo - currentElo2;
      } else {
        // Team 2 wins, Team 1 loses
        optimisticMeta2.wins = (optimisticMeta2.wins || 0) + 1;
        optimisticMeta1.losses = (optimisticMeta1.losses || 0) + 1;
        
        newEloRatings = calculateNewEloRatingsClient(
          currentElo2, currentElo1, voteWeight, team2Matches, team1Matches
        );
        optimisticMeta1.elo_rating = newEloRatings.loserNewElo;
        optimisticMeta2.elo_rating = newEloRatings.winnerNewElo;
        
        // Calculate ELO changes (deltas)
        optimisticMeta1.elo_delta = newEloRatings.loserNewElo - currentElo1;
        optimisticMeta2.elo_delta = newEloRatings.winnerNewElo - currentElo2;
      }
      
      // Calculate new percentiles for color coding (approximation)
      optimisticMeta1.percentile = calculateOptimisticPercentile(optimisticMeta1.elo_rating);
      optimisticMeta2.percentile = calculateOptimisticPercentile(optimisticMeta2.elo_rating);

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

      // --- NEW: Update tournament labels with ELO rating boxes (including deltas) ---
      const label1 = card1.querySelector('.tournament-label');
      if (label1) {
        const ratingBox = formatEloRatingBoxWithDelta(
          optimisticMeta1.elo_rating || 1500, 
          optimisticMeta1.percentile || 0.5,
          optimisticMeta1.elo_delta
        );
        label1.innerHTML = `
          <div class="tournament-rating">${ratingBox}</div>
          <div class="tournament-name">${tournamentName1}</div>
        `;
      }
      const label2 = card2.querySelector('.tournament-label');
      if (label2) {
        const ratingBox = formatEloRatingBoxWithDelta(
          optimisticMeta2.elo_rating || 1500, 
          optimisticMeta2.percentile || 0.5,
          optimisticMeta2.elo_delta
        );
        label2.innerHTML = `
          <div class="tournament-rating">${ratingBox}</div>
          <div class="tournament-name">${tournamentName2}</div>
        `;
      }

      // Reveal the "Next Matchup" button now that a vote has been made
      if (nextButton && !window.location.pathname.endsWith('/')) {
        nextButton.style.display = 'block';
      }

      // Note: "Next Matchup" button is now revealed only after voting

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
          
          await submitVote(winnerId, loserId);
          
          // Invalidate cached team metadata so fresh stats are fetched
          invalidateTeamMetaCache(winnerId, loserId);
          
          // Refresh Recent Votes widget if available (for homepage)
          if (typeof window.refreshRecentVotes === 'function') {
            window.refreshRecentVotes();
          }
          
        } catch (error) {
          console.error(`❌ Background vote processing failed:`, error);
          
          // Add to queue for retry
          voteQueue.push({ 
            winnerId, 
            loserId, 
            retries: 0,
            timestamp: Date.now()
          });
          
          // Start processing the queue with shorter delays for faster voting
          const delay = error.message.includes('Too many concurrent challenges') ? 1500 : 500;
          setTimeout(() => processVoteQueue(), delay);
        } finally {
          // Always release the global lock
          voteProcessingLock = false;
          // Process any queued clicks immediately when the lock is free
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
  
  // Create "Next Matchup" button but only show it on the main draftorpass page
  console.log('Current pathname:', window.location.pathname); // Debug
  if (!window.location.pathname.endsWith('/')) {
    nextButton = document.createElement("button");
    nextButton.textContent = "Next Matchup →";
    nextButton.className = "next-button";
    nextButton.style.display = "none"; // initially hidden
    nextButton.onclick = async (e) => {
      console.log('🔘 Next Matchup button clicked');
      const clickStart = performance.now();
      
      // Show loading state
      const originalText = nextButton.textContent;
      nextButton.textContent = "Loading next matchup...";
      nextButton.disabled = true;
      console.log('🔄 Loading state applied');
      
      try {
        await renderVersus();
        console.log(`🔘 Button click completed in ${performance.now() - clickStart}ms`);
      } catch (error) {
        console.error('Error loading next matchup:', error);
        // Restore button if there's an error
        nextButton.textContent = originalText;
        nextButton.disabled = false;
      }
    };
    outerContainer.appendChild(nextButton);
  }
  
  // Add outer container to main container
  container.appendChild(outerContainer);
  
  // Reset loading state on next button if it exists (from previous matchup)
  const existingNextButton = document.querySelector('.next-button');
  if (existingNextButton) {
    existingNextButton.textContent = "Next Matchup →";
    existingNextButton.disabled = false;
    existingNextButton.style.display = 'none'; // Hide until after voting
  }
  
  console.log(`✅ renderVersus completed in ${performance.now() - renderStart}ms`);
}

// fetchLeaderboard
function fetchLeaderboard(force = false) {
  // Use Elo rating keys for sorting
  const expectedRatingKey = leaderboardType === "team" ? "elo_rating" : "avg_elo";
  
  if (sortKey !== expectedRatingKey) {
    sortKey = expectedRatingKey;
    sortDir = "desc";
  }

  // Don't reuse cached data when forcing refresh
  if (!force && leaderboardType === "team" && leaderboardRawData.length && leaderboardRawData[0]?.id !== undefined) {
    leaderboardData = leaderboardRawData;
    sortAndRender();
    return;
  }

  // Always use Elo endpoints
  let endpoint;
  if (leaderboardType === "team") {
    endpoint = "/api/leaderboard/elo";
  } else {
    endpoint = "/api/leaderboard/elo/users";
  }
  
  if (currentTournament) {
    endpoint += `?tournament=${encodeURIComponent(currentTournament)}`;
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
      
      // default single-column numeric sort with proper null/undefined handling
      let aval = a[sortKey];
      let bval = b[sortKey];
      
      // Handle null/undefined values - treat them as 0 for sorting
      aval = (aval === null || aval === undefined) ? 0 : parseFloat(aval);
      bval = (bval === null || bval === undefined) ? 0 : parseFloat(bval);
      
      // Handle NaN values (just in case parseFloat fails)
      if (isNaN(aval)) aval = 0;
      if (isNaN(bval)) bval = 0;
      
      if (sortDir === "asc") return aval - bval;
      return bval - aval;
    });
  renderLeaderboard(sorted.slice(0, MAX_LEADERBOARD_ROWS));
}

// renderLeaderboard implementation
function renderLeaderboard(data) {
  const container = document.getElementById("teamsContainer");
  // Remove any previous loading indicators or leftover content before initial render
  if (!container.dataset.lbInitialized) {
    container.innerHTML = "";
    container.dataset.lbInitialized = "1";
  }

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
      sortKey = "elo_rating"; // Default to Elo Rating for team view
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
      sortKey = "avg_elo"; // Default to Elo Rating for user view
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
        // Add loading placeholder to maintain dropdown width
        const loadingOpt = document.createElement("option");
        loadingOpt.value = "";
        loadingOpt.textContent = "Loading tournaments...";
        loadingOpt.disabled = true;
        tournamentSelect.appendChild(loadingOpt);
        
        fetch("/tournaments")
          .then(res => res.json())
          .then(tournaments => {
            // Remove loading placeholder
            tournamentSelect.removeChild(loadingOpt);
            
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
          })
          .catch(error => {
            console.error('Failed to fetch tournaments:', error);
            // Remove loading placeholder on error
            if (tournamentSelect.contains(loadingOpt)) {
              tournamentSelect.removeChild(loadingOpt);
            }
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
    <th class="sortable">Draftr Rating</th>
    <th>User</th>
    <th>Contest</th>
    <th class="sortable">W</th>
    <th class="sortable">L</th>
    <th class="sortable">Win %</th>
  ` : `
    <th class="sortable">Draftr Rating</th>
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
      
      const ratingDisplay = formatEloRatingBox(row.elo_rating, row.percentile);
      
      tr.innerHTML = `<td>${viewBtn}</td><td>${ratingDisplay}</td><td>${usernameCell}</td><td>${row.tournament || "-"}</td><td>${row.wins}</td><td>${row.losses}</td><td>${winPct}%</td>`;
    } else {
      const usernameCell = row.username && row.username !== "-" 
        ? `<a href="profile.html?user=${encodeURIComponent(row.username)}" class="username-link">${row.username}</a>`
        : "-";
      
      const ratingDisplay = formatEloRatingBox(row.avg_elo, row.percentile, true); // true indicates user rating
      
      tr.innerHTML = `<td>${ratingDisplay}</td><td>${usernameCell}</td><td>${row.wins}</td><td>${row.losses}</td><td>${winPct}%</td>`;
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  tableContainer.appendChild(table);

  // Make W, L, Win% sortable
  const headerCells = headerRow.querySelectorAll("th");
  const ratingKey = leaderboardType === "team" ? "elo_rating" : "avg_elo";
  
  const sortableKeys = leaderboardType === "team" 
    ? [null, ratingKey, null, null, "wins", "losses", "win_pct"] // Team view: Team, Rating, User, Contest, W, L, Win%
    : [ratingKey, null, "wins", "losses", "win_pct"];            // User view: Rating, User, W, L, Win%
  headerCells.forEach((th, idx) => {
    const key = sortableKeys[idx];
    if (!key) return; // skip non-sortable columns
    
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

  container.appendChild(tableContainer);

  // Attach simple popup to View buttons (team view only)
  if (leaderboardType === "team") {
    tableContainer.querySelectorAll(".view-team-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const id = btn.getAttribute("data-id");
        try {
          const res = await fetch(`/team/${id}`);
          if (!res.ok) throw new Error('Failed to load team');
          const players = await res.json();

          // Re-use existing buildTeamCard logic to create markup, then extract just the player list
          const card = buildTeamCard(id, players);
          const list = card.querySelector('.player-list');
          if (list) {
            // Detach list from card to avoid unnecessary wrappers
            const clonedList = list.cloneNode(true);
            showSimplePopup(clonedList);
          } else {
            showSimplePopup('Unable to render team');
          }
        } catch (err) {
          console.error('View load error', err);
          showSimplePopup('Error loading team');
        }
      });
    });
  }
}

function hideModal() {
  const existingModal = document.querySelector('.modal-overlay');
  if (existingModal) {
    existingModal.remove();
  }
}

function showTeamModal(teamId) {
  fetch(`/team/${teamId}`)
    .then(res => res.json())
    .then(players => {
      // Remove any existing modal
      const existingModal = document.querySelector('.modal-overlay');
      if (existingModal) {
        existingModal.remove();
      }
      
      // Create modal and append directly to body to avoid transform containment issues
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'modal-overlay';
      modalOverlay.style.display = 'flex';
      modalOverlay.style.position = 'fixed';
      modalOverlay.style.top = '0';
      modalOverlay.style.left = '0';
      modalOverlay.style.width = '100vw';
      modalOverlay.style.height = '100vh';
      modalOverlay.style.zIndex = '1000';
      
      const modalContent = document.createElement('div');
      modalContent.className = 'modal-content';
      
      const modalClose = document.createElement('div');
      modalClose.className = 'modal-close';
      modalClose.innerHTML = '<button id="modalCloseBtn">✖</button>';
      
      const modalBody = document.createElement('div');
      modalBody.id = 'modalBody';
      
      const card = buildTeamCard(teamId, players);
      modalBody.appendChild(card);
      
      modalContent.appendChild(modalClose);
      modalContent.appendChild(modalBody);
      modalOverlay.appendChild(modalContent);
      
      // Append directly to body to avoid transform containment
      document.body.appendChild(modalOverlay);
      
      // Add event listeners
      modalClose.querySelector('#modalCloseBtn').addEventListener('click', () => {
        modalOverlay.remove();
      });
      
      modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) {
          modalOverlay.remove();
        }
      });
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
          body: JSON.stringify({ identifier: email, password })
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
  
  while (voteQueue.length > 0) {
    // Wait for any existing vote processing to complete (shorter wait)
    while (voteProcessingLock) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    const vote = voteQueue.shift();
    try {
      voteProcessingLock = true;
      await submitVote(vote.winnerId, vote.loserId);
      
      // Refresh Recent Votes widget if available (for homepage)
      if (typeof window.refreshRecentVotes === 'function') {
        window.refreshRecentVotes();
      }
    } catch (error) {
      console.error(`❌ Queued vote failed:`, error);
      // Put it back in queue for later retry (but limit retries)
      if (vote.retries < 5) {
        vote.retries = (vote.retries || 0) + 1;
        voteQueue.push(vote);
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
}

// Extracted vote submission function
async function submitVote(winnerId, loserId) {
  let captchaToken;
  try {
    captchaToken = await getCaptchaToken();
  } catch (err) {
    console.error('❌ Unable to obtain Turnstile token – aborting vote:', err);
    throw err; // Bail early so we never hit the server
  }

  // Extra guard – if we somehow got here without a token, stop.
  if (!captchaToken) {
    console.warn('🚫 No captcha token available, vote not sent');
    throw new Error('Captcha token unavailable');
  }

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

// Periodically process the queue and reset stuck counters (safety net)
setInterval(() => {
  if (voteQueue.length > 0) {
    processVoteQueue();
  }
  
  // Process click queue if there are pending clicks and no active processing
  if (clickQueue.length > 0 && !voteProcessingLock) {
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

// ---- Global Notification Functions (shared by desktop and mobile) ----

async function markNotificationAsRead(notificationId) {
  try {
    await fetch('/notifications/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notificationIds: [notificationId] })
    });
  } catch (e) {
    console.error('Failed to mark notification as read:', e);
  }
}

async function updateNotificationCount() {
  try {
    const res = await fetch('/notifications/count');
    if (res.ok) {
      const data = await res.json();
      const count = data.count || 0;
      if (typeof lastNotificationCount !== 'undefined') {
        lastNotificationCount = count; // Store for polling comparison
      }
      updateNotificationBadge(count);
    } else {
      console.error('Failed to fetch notification count:', res.status, res.statusText);
    }
  } catch (e) {
    console.error('Failed to fetch notification count:', e);
  }
}

function updateNotificationBadge(count) {
  // Update desktop badge
  const badge = document.getElementById('notificationBadge');
  if (badge) {
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : count.toString();
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
  }

  // Update mobile badge
  const mobileBadge = document.getElementById('mobileNotificationBadge');
  if (mobileBadge) {
    if (count > 0) {
      mobileBadge.textContent = `${count > 99 ? '99+' : count}`;
      mobileBadge.style.display = 'inline';
    } else {
      mobileBadge.style.display = 'none';
    }
  }

  // Update hamburger button notification dot
  const hamburgerBtn = document.getElementById('hamburgerBtn');
  if (hamburgerBtn) {
    let notificationDot = hamburgerBtn.querySelector('.hamburger-notification-dot');
    if (count > 0) {
      if (!notificationDot) {
        notificationDot = document.createElement('div');
        notificationDot.className = 'hamburger-notification-dot';
        hamburgerBtn.appendChild(notificationDot);
      }
    } else {
      if (notificationDot) {
        notificationDot.remove();
      }
    }
  }
}

// Helper to determine rating tier and return appropriate CSS class
function getRatingTierClass(rating) {
  if (!rating || rating === 0) return 'tier-none';
  if (rating < 60) return 'tier-low';      // 0-59: Red
  if (rating < 70) return 'tier-below';    // 60-69: Orange  
  if (rating < 80) return 'tier-average';  // 70-79: Yellow
  if (rating < 90) return 'tier-good';     // 80-89: Green
  return 'tier-elite';                     // 90-99: Blue
}

// Helper to format rating in a colored box
function formatRatingBox(rating) {
  if (!rating || rating === 0) return '<span class="rating-box tier-none">-</span>';
  const tierClass = getRatingTierClass(rating);
  return `<span class="rating-box ${tierClass}">${Math.round(rating)}</span>`;
}

// Helper to format Elo rating with percentile-based coloring
function formatEloRatingBox(eloRating, percentile, isUserRating = false) {
  if (!eloRating || eloRating === 0) return '<span class="rating-box tier-none">-</span>';
  
  // Use percentile directly to determine color tier
  const tierClass = isUserRating ? getUserPercentileTierClass(percentile) : getTeamPercentileTierClass(percentile);
  
  return `<span class="rating-box ${tierClass}">${Math.round(eloRating)}</span>`;
}

// ---- ELO Rating Calculation Functions (Client-side) ----
const STARTING_ELO = 1500.0;
const BASE_K_FACTOR = 128.0;

function calculateVoteWeightClient(voterId, winnerUserId, loserUserId) {
  if (!voterId) return 1.0;
  
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

function calculateExpectedScoreClient(ratingA, ratingB) {
  return 1.0 / (1.0 + Math.pow(10, (ratingB - ratingA) / 400.0));
}

function calculateAdaptiveKFactorClient(baseK, voteWeight, matchesPlayed) {
  // Weight adjustment: higher weight = higher K-factor
  const weightMultiplier = voteWeight;
  
  // Experience adjustment: fewer matches = higher K-factor
  const experienceFactor = Math.max(0.5, 1.0 - (matchesPlayed / 200.0));
  
  return baseK * weightMultiplier * experienceFactor;
}

function calculateNewEloRatingsClient(winnerElo, loserElo, voteWeight, winnerMatches, loserMatches) {
  // Calculate expected scores
  const winnerExpected = calculateExpectedScoreClient(winnerElo, loserElo);
  const loserExpected = 1.0 - winnerExpected;
  
  // Calculate adaptive K-factors
  const winnerK = calculateAdaptiveKFactorClient(BASE_K_FACTOR, voteWeight, winnerMatches);
  const loserK = calculateAdaptiveKFactorClient(BASE_K_FACTOR, voteWeight, loserMatches);
  
  // Update ELO ratings
  const winnerNewElo = winnerElo + winnerK * (1.0 - winnerExpected);
  const loserNewElo = loserElo + loserK * (0.0 - loserExpected);
  
  return {
    winnerNewElo: Math.round(winnerNewElo),
    loserNewElo: Math.round(loserNewElo)
  };
}

function calculateOptimisticPercentile(newElo, minElo = 800, maxElo = 2200) {
  // Simple percentile approximation for immediate display
  // In a real system, this would use the actual global distribution
  if (maxElo === minElo) return 0.5;
  return Math.max(0, Math.min(1, (newElo - minElo) / (maxElo - minElo)));
}

// Helper to format ELO rating with delta change
function formatEloRatingBoxWithDelta(eloRating, percentile, eloDelta) {
  if (!eloRating || eloRating === 0) return '<span class="rating-box tier-none">-</span>';
  
  // Use percentile directly to determine color tier
  const tierClass = getPercentileTierClass(percentile);
  
  // Format the rating box
  const ratingBox = `<span class="rating-box ${tierClass}">${Math.round(eloRating)}</span>`;
  
  // Format the delta with appropriate sign and color (outside the rating box)
  let deltaDisplay = '';
  if (eloDelta !== undefined && eloDelta !== 0) {
    const deltaSign = eloDelta > 0 ? '+' : '';
    const deltaClass = eloDelta > 0 ? 'elo-delta-positive' : 'elo-delta-negative';
    deltaDisplay = ` <span class="${deltaClass}">(${deltaSign}${Math.round(eloDelta)})</span>`;
  }
  
  return `${deltaDisplay}${ratingBox}`;
}

// Helper to determine color tier from percentile for team ratings
function getTeamPercentileTierClass(percentile) {
  if (percentile < 0.10) {
    return 'tier-bottom';   // 0-10%: Dark Red
  } else if (percentile < 0.30) {
    return 'tier-low';      // 10-30%: Red
  } else if (percentile < 0.50) {
    return 'tier-below';    // 30-50%: Orange
  } else if (percentile < 0.70) {
    return 'tier-average';  // 50-70%: Yellow
  } else if (percentile < 0.90) {
    return 'tier-good';     // 70-90%: Green
  } else {
    return 'tier-elite';    // 90-100%: Blue
  }
}

// Helper to determine color tier from percentile for user ratings (more generous tiers)
function getUserPercentileTierClass(percentile) {
  if (percentile < 0.2) {
    return 'tier-bottom';   // 0-5%: Dark Red
  } else if (percentile < 0.4) {
    return 'tier-low';      // 5-20%: Red
  } else if (percentile < 0.60) {
    return 'tier-average';  // 40-60%: Yellow
  } else if (percentile < 0.8) {
    return 'tier-good';     // 60-85%: Green
  } else {
    return 'tier-elite';    // 85-100%: Blue
  }
}

// Legacy function for backward compatibility - defaults to team rating tiers
function getPercentileTierClass(percentile) {
  return getTeamPercentileTierClass(percentile);
}

// ---- Mobile Notification Functions ----

function showMobileNotifications() {
  // Check if user is logged in first
  if (!currentUserId) {
    console.warn('User not logged in, cannot show notifications');
    alert('Please log in to view notifications');
    return;
  }

  // Create mobile notification overlay if it doesn't exist
  let overlay = document.getElementById('mobileNotificationOverlay');
  if (!overlay) {
    overlay = createMobileNotificationOverlay();
    document.body.appendChild(overlay);
  }
  
  // Show the overlay
  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden'; // Prevent background scrolling
  
  // Load notifications
  loadMobileNotifications();
}

function hideMobileNotifications() {
  const overlay = document.getElementById('mobileNotificationOverlay');
  if (overlay) {
    overlay.style.display = 'none';
    document.body.style.overflow = ''; // Restore scrolling
  }
}

function createMobileNotificationOverlay() {
  const overlay = document.createElement('div');
  overlay.id = 'mobileNotificationOverlay';
  overlay.className = 'mobile-notification-overlay';
  
  overlay.innerHTML = `
    <div class="mobile-notification-content">
      <div class="mobile-notification-header">
        <h3>Notifications</h3>
        <div class="mobile-notification-actions">
          <button id="mobileMarkAllRead" class="mobile-mark-all-read-btn">Mark all read</button>
          <button id="closeMobileNotifications" class="mobile-close-notifications-btn">✖</button>
        </div>
      </div>
      <div id="mobileNotificationList" class="mobile-notification-list">
        <div class="loading">Loading notifications...</div>
      </div>
    </div>
  `;

  // Add event listeners
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      hideMobileNotifications();
    }
  });

  overlay.querySelector('#closeMobileNotifications').addEventListener('click', hideMobileNotifications);
  overlay.querySelector('#mobileMarkAllRead').addEventListener('click', markAllNotificationsAsReadMobile);
  
  return overlay;
}

async function loadMobileNotifications() {
  const notificationList = document.getElementById('mobileNotificationList');
  if (!notificationList) return;

  notificationList.innerHTML = '<div class="loading">Loading notifications...</div>';

  try {
    const res = await fetch('/notifications');
    
    if (!res.ok) {
      if (res.status === 401) {
        notificationList.innerHTML = '<div class="no-notifications">Please log in to view notifications</div>';
      } else {
        notificationList.innerHTML = `<div class="no-notifications">Failed to load notifications (${res.status})</div>`;
      }
      return;
    }

    const data = await res.json();
    const notifications = data.notifications || [];
    
    if (notifications.length === 0) {
      notificationList.innerHTML = '<div class="no-notifications">No notifications yet</div>';
      return;
    }

    notificationList.innerHTML = '';
    notifications.forEach((notification, index) => {
      try {
        const item = createMobileNotificationItem(notification);
        notificationList.appendChild(item);
      } catch (itemError) {
        console.error(`Error creating mobile notification item ${index}:`, itemError);
      }
    });
  } catch (e) {
    console.error('Failed to load mobile notifications:', e);
    notificationList.innerHTML = `<div class="no-notifications">Network error: ${e.message}</div>`;
  }
}

function createMobileNotificationItem(notification) {
  const item = document.createElement('div');
  item.className = `mobile-notification-item ${notification.is_read ? '' : 'unread'}`;
  item.dataset.notificationId = notification.id;

  const timeAgo = formatTimeAgo(new Date(notification.created_at));
  
  // Create enhanced notification message with links for versus votes
  let messageHTML = notification.message;
  
  if (notification.type === 'versus_vote' && notification.related_team_id) {
    // Link "your team" to voting history
    const teamLink = `<a href="voting-history.html?teamId=${notification.related_team_id}" style="color: #58a6ff; text-decoration: none;">your team</a>`;
    messageHTML = messageHTML.replace('your team', teamLink);
    
    // Check if this is a tournament notification and handle specially
    const isTournamentNotification = messageHTML.includes('Tournament Round');
    
    if (isTournamentNotification) {
      // Link "Tournament" word to tournament.html
      messageHTML = messageHTML.replace(/(\w+\s+)Tournament(\s+Round)/g, '$1<a href="tournament.html" style="color:#58a6ff;text-decoration:none;">Tournament</a>$2');
      
      // Handle opponent name - find opponent name before any vote count info
      if (notification.opponent_team_id) {
        const againstIndex = messageHTML.lastIndexOf('against ');
        if (againstIndex !== -1) {
          // Look for vote count pattern like "(3 more votes needed)" or "- YOU WON THE MATCHUP!"
          const afterAgainst = messageHTML.substring(againstIndex + 8);
          const voteCountMatch = afterAgainst.match(/^([^(]+?)(\s*\([^)]+\)|$|\s*-\s*[^)]+$)/);
          
          if (voteCountMatch) {
            const opponentName = voteCountMatch[1].trim();
            const voteCountPart = voteCountMatch[2] || '';
            
            if (opponentName) {
              const beforeAgainst = messageHTML.substring(0, againstIndex + 8);
              const opponentLink = `<span class="mobile-opponent-link" data-team-id="${notification.opponent_team_id}" style="color: #58a6ff; cursor: pointer; text-decoration: underline;">${opponentName}</span>`;
              messageHTML = beforeAgainst + opponentLink + voteCountPart;
            }
          }
        }
      }
    } else {
      // Regular (non-tournament) notification - link entire opponent name
      if (notification.opponent_team_id) {
        const againstIndex = messageHTML.lastIndexOf('against ');
        if (againstIndex !== -1) {
          const beforeAgainst = messageHTML.substring(0, againstIndex + 8);
          const opponentName = messageHTML.substring(againstIndex + 8);
          
          if (opponentName.trim()) {
            const opponentLink = `<span class="mobile-opponent-link" data-team-id="${notification.opponent_team_id}" style="color: #58a6ff; cursor: pointer; text-decoration: underline;">${opponentName}</span>`;
            messageHTML = beforeAgainst + opponentLink;
          }
        }
      }
    }
  }
  
  item.innerHTML = `
    <div class="mobile-notification-message">${messageHTML}</div>
    <div class="mobile-notification-time">${timeAgo}</div>
  `;

  // Add click handlers for opponent links
  const opponentLinks = item.querySelectorAll('.mobile-opponent-link');
  opponentLinks.forEach(link => {
    link.addEventListener('click', async (e) => {
      e.stopPropagation();
      const teamId = link.getAttribute('data-team-id');
      if (teamId) {
        try {
          // Check if fetchTeamMeta function is available
          if (typeof fetchTeamMeta === 'function') {
            const meta = await fetchTeamMeta(teamId);
            if (meta.username) {
              window.location.href = `profile.html?user=${encodeURIComponent(meta.username)}`;
            } else {
              // Check if showTeamModal function is available, otherwise navigate to voting history
              if (typeof showTeamModal === 'function') {
                showTeamModal(teamId);
              } else {
                window.location.href = `voting-history.html?teamId=${teamId}`;
              }
            }
          } else {
            // Fallback: navigate to voting history page
            window.location.href = `voting-history.html?teamId=${teamId}`;
          }
        } catch (error) {
          console.error('Failed to fetch opponent info:', error);
          // Fallback: navigate to voting history page
          window.location.href = `voting-history.html?teamId=${teamId}`;
        }
      }
    });
  });

  // Mark as read when clicked (but not when clicking links)
  item.addEventListener('click', async (e) => {
    if (e.target.tagName === 'A' || e.target.classList.contains('mobile-opponent-link')) {
      return;
    }
    
    if (!notification.is_read) {
      await markNotificationAsRead(notification.id);
      item.classList.remove('unread');
      await updateNotificationCount();
    }
  });

  return item;
}

async function markAllNotificationsAsReadMobile() {
  try {
    const res = await fetch('/notifications/read-all', {
      method: 'POST'
    });
    if (res.ok) {
      // Immediately update the badge to 0 for instant feedback
      updateNotificationBadge(0);
      
      // Reload the notification list
      await loadMobileNotifications();
      
      // Wait a moment for database to update, then refresh count
      setTimeout(async () => {
        await updateNotificationCount();
      }, 500);
    } else {
      console.error('Failed to mark all mobile notifications as read:', res.status, res.statusText);
    }
  } catch (e) {
    console.error('Failed to mark all mobile notifications as read:', e);
  }
}

// ===============================================
// Mobile Menu Functionality
// ===============================================
function initMobileMenu() {
  const mobileMenuToggle = document.getElementById('mobileMenuToggle');
  const mobileNav = document.getElementById('mobileNav');


  if (mobileMenuToggle && mobileNav) {
    
    // Remove any existing listeners to avoid duplicates
    mobileMenuToggle.onclick = null;
    
    mobileMenuToggle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      // Use class-based toggling instead of inline styles
      const isCurrentlyActive = mobileNav.classList.contains('active');
      
      
      if (isCurrentlyActive) {
        mobileNav.classList.remove('active');
        mobileMenuToggle.classList.remove('active');
      } else {
        mobileNav.classList.add('active');
        mobileMenuToggle.classList.add('active');
      }
    });

    // Close mobile nav when clicking outside
    document.addEventListener('click', (e) => {
      if (!mobileMenuToggle.contains(e.target) && !mobileNav.contains(e.target)) {
        mobileNav.classList.remove('active');
        mobileMenuToggle.classList.remove('active');
      }
    });
  } else {
    console.error('Mobile menu elements not found:', { mobileMenuToggle, mobileNav });
  }
}

// Initialize when header is loaded
function initMobileMenuWhenReady() {
  if (document.getElementById('mobileMenuToggle')) {
    initMobileMenu();
  } else {
    document.addEventListener('headerLoaded', initMobileMenu);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initMobileMenuWhenReady);
} else {
  initMobileMenuWhenReady();
}

// Ensure mobile notifications are fully set up once header is injected (in case refreshAuth ran before header loaded)
document.addEventListener('headerLoaded', () => {
  // Re-run setup to attach handler to fresh DOM elements
  if (typeof setupMobileNotifications === 'function') {
    setupMobileNotifications();
  }
});

// === Simple center-screen popup used by leaderboard "View" buttons ===
function showSimplePopup(content = "This is a popup") {
  // Remove any existing popup first
  const existing = document.querySelector('.simple-popup-overlay');
  if (existing) existing.remove();

  // Create overlay that always covers the viewport regardless of scrolling
  const overlay = document.createElement('div');
  overlay.className = 'simple-popup-overlay';
  Object.assign(overlay.style, {
    position: 'fixed',      // lock to viewport
    inset: '0',             // shorthand for top/right/bottom/left 0
    background: 'rgba(0,0,0,0.6)',
    display: 'grid',        // grid makes centering trivial
    placeItems: 'center',   // center both horizontally & vertically
    zIndex: 9999            // very high to sit above other fixed elements
  });

  // Create popup box
  const box = document.createElement('div');
  Object.assign(box.style, {
    background: '#0d1117',
    color: '#f0f6fc',
    padding: '24px 32px',
    borderRadius: '8px',
    fontSize: '18px',
    maxWidth: window.innerWidth <= 768 ? '98vw' : '95vw',
    width: window.innerWidth <= 768 ? 'auto' : '600px',
    textAlign: 'center',
    boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
    fontFamily: "'Söhne', 'Inter', sans-serif"
  });

  // Inject content
  if (content instanceof Node) {
    // Add CSS to make player-bubble fill full width in popup
    const style = document.createElement('style');
    style.textContent = `
      .simple-popup-overlay .player-list {
        width: 100%;
        display: flex;
        flex-direction: column;
        gap: 2px;
        align-items: center;
      }
      .simple-popup-overlay .player-row {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        width: 100%;
        padding: 0 16px;
      }
      .simple-popup-overlay .player-bubble {
        width: 100% !important;
        max-width: none !important;
        margin: 0 48px;
      }
      @media (max-width: 768px) {
        .simple-popup-overlay .player-row {
          padding: 0 12px;
        }
        .simple-popup-overlay .player-bubble {
          width: 100% !important;
          margin: 0 6px;
        }
      }
    `;
    document.head.appendChild(style);
    box.appendChild(content);
  } else if (content) {
    box.textContent = String(content);
  }

  // Prevent click propagation inside the box (so clicking text doesn't close it)
  box.addEventListener('click', (e) => e.stopPropagation());

  // Close popup when overlay area outside box is clicked
  overlay.addEventListener('click', () => overlay.remove());

  overlay.appendChild(box);
  // Append to <html> instead of <body> to avoid transforms on body affecting fixed positioning
  (document.documentElement || document.body).appendChild(overlay);
}

// Fix for special banner link - ensure it works despite document-level event listeners
document.addEventListener('DOMContentLoaded', () => {
  const specialBannerLink = document.getElementById('specialBannerLink');
  if (specialBannerLink) {
    specialBannerLink.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      window.location.href = '/tournament';
    });
  }
});
