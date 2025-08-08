(function(){
  // Listen for auth state resolution from header.js
  document.addEventListener('authStateResolved', (event) => {
    const { isLoggedIn, user } = event.detail;
    // Auth state is already handled by header.js, content is already visible
  });

  // === Mobile Memory Management ===
  let isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  let voteCount = 0;
  let lastCleanup = Date.now();
  const MOBILE_CLEANUP_INTERVAL = 10; // Clean up every 10 votes on mobile
  const MOBILE_MEMORY_CHECK_INTERVAL = 30000; // Check memory every 30s on mobile

  // Mobile memory cleanup function
  function mobileMemoryCleanup() {
    if (!isMobile) return;
    
    try {
      // Force garbage collection if available
      if (window.gc) {
        window.gc();
      }
      
      // Clear any cached DOM references
      const unusedElements = document.querySelectorAll('.team-card:not(.active)');
      unusedElements.forEach(el => {
        if (el.parentNode) {
          el.parentNode.removeChild(el);
        }
      });
      
      // Clear vote queue if it's getting too large (mobile browsers struggle with large arrays)
      if (typeof voteQueue !== 'undefined' && voteQueue.length > 5) {
        console.warn('Vote queue getting large on mobile, clearing old entries');
        voteQueue.splice(0, voteQueue.length - 2); // Keep only last 2 votes
      }
      
      lastCleanup = Date.now();
    } catch (e) {
      console.error('Mobile cleanup failed:', e);
    }
  }

  // Memory monitoring for mobile
  if (isMobile) {
    setInterval(() => {
      // Check if we need cleanup
      if (voteCount > 0 && voteCount % MOBILE_CLEANUP_INTERVAL === 0) {
        mobileMemoryCleanup();
      }
      
      // Emergency cleanup if page has been running too long
      if (Date.now() - lastCleanup > 120000) { // 2 minutes
        console.warn('Emergency mobile cleanup triggered');
        mobileMemoryCleanup();
      }
    }, MOBILE_MEMORY_CHECK_INTERVAL);
  }

  // Utility to load external JS and run callback when ready
  function loadScript(src, cb) {
    const s = document.createElement('script');
    s.src = src + (src.includes('?') ? '' : ('?v=' + Date.now())); // cache-buster in dev
    s.async = false; // Preserve execution order
    s.onload = () => cb && cb();
    s.onerror = () => {
      console.error('Failed to load', src);
      // Reveal page with error message so user is not left on blank screen
      document.body.classList.add('content-visible');
      const container = document.getElementById('teamsContainer');
      if (container) {
        container.innerHTML = '<div class="error-message">⚠️ Failed to load voting logic. Please refresh or try again later.</div>';
      }
    };
    document.head.appendChild(s);
  }

  // Override vote submission for mobile optimization
  window.mobileVoteHandler = function(winnerId, loserId) {
    voteCount++;
    
    // Mobile-specific: Clear old DOM elements more aggressively
    if (isMobile && voteCount % 5 === 0) {
      const container = document.getElementById('teamsContainer');
      if (container) {
        // Clear and rebuild container to prevent DOM bloat
        const content = container.innerHTML;
        container.innerHTML = '';
        setTimeout(() => {
          container.innerHTML = content;
        }, 10);
      }
    }
    
    // Call original vote handler if available
    if (typeof submitVote === 'function') {
      return submitVote(winnerId, loserId);
    }
  };

  // (Timer fallback no longer needed because we revealed the page immediately)

  // Load the main shared script that contains all voting logic
  loadScript('script.js', () => {
    try {
      // Mobile-specific optimizations
      if (isMobile) {
        // Reduce polling frequency on mobile to save battery/memory
        const originalSetInterval = window.setInterval;
        window.setInterval = function(callback, delay) {
          // Increase intervals by 50% on mobile for battery/memory savings
          const mobileDelay = Math.max(delay * 1.5, delay);
          return originalSetInterval.call(this, callback, mobileDelay);
        };
        
        // Override fetchTeams to reduce memory usage on mobile
        const originalFetchTeams = window.fetchTeams;
        if (originalFetchTeams) {
          window.fetchTeams = function(force) {
            // On mobile, force cleanup before fetching new teams
            mobileMemoryCleanup();
            return originalFetchTeams.call(this, force);
          };
        }
      }

      // Check authentication status first
      if (typeof refreshAuth === 'function') {
        refreshAuth().then(() => {
          // After auth check, set mode and load data
          if (typeof setMode === 'function') {
            setMode('versus');
          } else if (typeof currentMode !== 'undefined') {
            currentMode = 'versus';
          }
          if (typeof fetchTeams === 'function') {
            fetchTeams(true); // force fresh fetch
          } else {
            console.warn('fetchTeams() not defined after loading script.js');
          }
          // Quick auth check to show user controls even if global refreshAuth is not exposed
          quickAuth();
        }).catch(e => {
          console.error('Auth check failed:', e);
          // Still try to load content even if auth fails
          if (typeof setMode === 'function') {
            setMode('versus');
          } else if (typeof currentMode !== 'undefined') {
            currentMode = 'versus';
          }
          if (typeof fetchTeams === 'function') {
            fetchTeams(true);
          }
          quickAuth();
        });
      } else {
        console.warn('refreshAuth() not defined after loading script.js');
        // Fallback: proceed without auth check
        if (typeof setMode === 'function') {
          setMode('versus');
        } else if (typeof currentMode !== 'undefined') {
          currentMode = 'versus';
        }
        if (typeof fetchTeams === 'function') {
          fetchTeams(true);
        }
        quickAuth();
      }
    } catch (e) {
      console.error('Initialization error after loading script.js:', e);
    }

    // --- Start notification polling (initial + every 30s) ---
    if (typeof updateNotificationCount === 'function') {
      // Run an immediate check so badge is fresh
      updateNotificationCount();
      // Then poll every 30 seconds like other pages (mobile gets longer intervals automatically)
      setInterval(updateNotificationCount, 30000);
    }

    // === Attach UI event handlers that normally run in script.js DOMContentLoaded ===
    
    const setupHeaderEventListeners = () => {

      // Setup mobile notifications after header is loaded
      setupMobileNotifications();

      // Setup mark all read button
      const markAllReadBtn = document.getElementById('markAllRead');
      if (markAllReadBtn) {
        markAllReadBtn.addEventListener('click', markAllNotificationsAsRead);
      }
    };

    // Wait for header to be loaded before setting up event listeners
    if (document.querySelector('.main-header')) {
      // Small delay to ensure DOM is fully updated
      setTimeout(setupHeaderEventListeners, 10);
    } else {
      document.addEventListener('headerLoaded', () => {
        // Small delay to ensure DOM is fully updated
        setTimeout(setupHeaderEventListeners, 10);
      });
    }

    // ===== Notification logic (adapted from upload.js) =====

    /**
     * Format a date into a relative time string like "2h ago"
     */
    function formatTimeAgo(date) {
      const now = new Date();
      const diffMs = now - date;
      const diffSecs = Math.floor(diffMs / 1000);
      const diffMins = Math.floor(diffSecs / 60);
      const diffHours = Math.floor(diffMins / 60);
      const diffDays = Math.floor(diffHours / 24);

      if (diffSecs < 60) return `${diffSecs}s ago`;
      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffHours < 24) return `${diffHours}h ago`;
      return `${diffDays}d ago`;
    }

    /**
     * Load notifications list into the dropdown.
     */
    async function loadNotifications() {
      const notificationList = document.getElementById('notificationList');
      if (!notificationList) return;

      try {
        notificationList.innerHTML = '<div class="loading">Loading notifications...</div>';

        const response = await fetch('/notifications');
        if (!response.ok) {
          throw new Error('Failed to load notifications');
        }

        const data = await response.json();
        const notifications = data.notifications || [];

        if (notifications.length === 0) {
          notificationList.innerHTML = '<div class="no-notifications">No notifications yet</div>';
          return;
        }

        notificationList.innerHTML = notifications.map(notification => {
          const timeAgo = formatTimeAgo(new Date(notification.created_at));

                  // Enhance versus_vote messages with links
        let msgHtml = notification.message;
        if (notification.type === 'versus_vote' && notification.related_team_id) {
          // Link "your team" to voting history
          msgHtml = msgHtml.replace('your team', `<a href="voting-history.html?teamId=${notification.related_team_id}" style="color:#58a6ff;text-decoration:none;">your team</a>`);

          // Check if this is a tournament notification and handle specially
          const isTournamentNotification = msgHtml.includes('Tournament Round');
          
          if (isTournamentNotification) {
            // Link "Tournament" word to tournament.html
            msgHtml = msgHtml.replace(/(\w+\s+)Tournament(\s+Round)/g, '$1<a href="tournament.html" style="color:#58a6ff;text-decoration:none;">Tournament</a>$2');
            
            // Handle opponent name - find opponent name before any vote count info
            if (notification.opponent_team_id) {
              const againstIdx = msgHtml.lastIndexOf('against ');
              if (againstIdx !== -1) {
                // Look for vote count pattern like "(3 more votes needed)" or "- YOU WON THE MATCHUP!"
                const afterAgainst = msgHtml.substring(againstIdx + 8);
                const voteCountMatch = afterAgainst.match(/^([^(]+?)(\s*\([^)]+\)|$|\s*-\s*[^)]+$)/);
                
                if (voteCountMatch) {
                  const opponentName = voteCountMatch[1].trim();
                  const voteCountPart = voteCountMatch[2] || '';
                  
                  if (opponentName) {
                    const before = msgHtml.substring(0, againstIdx + 8);
                    const oppLink = `<span class="desktop-opponent-link" data-team-id="${notification.opponent_team_id}" style="color:#58a6ff;cursor:pointer;text-decoration:none;">${opponentName}</span>`;
                    msgHtml = before + oppLink + voteCountPart;
                  }
                }
              }
            }
          } else {
            // Regular (non-tournament) notification - link entire opponent name
            if (notification.opponent_team_id) {
              const againstIdx = msgHtml.lastIndexOf('against ');
              if (againstIdx !== -1) {
                const before = msgHtml.substring(0, againstIdx + 8);
                const oppName = msgHtml.substring(againstIdx + 8);
                const oppLink = `<span class="desktop-opponent-link" data-team-id="${notification.opponent_team_id}" style="color:#58a6ff;cursor:pointer;text-decoration:none;">${oppName}</span>`;
                msgHtml = before + oppLink;
              }
            }
          }
        }

          return `
            <div class="notification-item ${notification.is_read ? 'read' : 'unread'}" data-id="${notification.id}">
              <div class="notification-message">${msgHtml}</div>
              <div class="notification-time">${timeAgo}</div>
            </div>
          `;
        }).join('');

        // Attach opponent link clicks to fetch username and navigate
        notificationList.querySelectorAll('.desktop-opponent-link').forEach(link => {
          link.addEventListener('click', async (e) => {
            e.stopPropagation();
            const teamId = link.getAttribute('data-team-id');
            if (!teamId) return;
            try {
              const res = await fetch(`/team-meta/${teamId}`);
              const meta = await res.json();
              if (meta && meta.username) {
                window.location.href = `profile.html?user=${encodeURIComponent(meta.username)}`;
              } else {
                window.location.href = `voting-history.html?teamId=${teamId}`;
              }
            } catch (err) {
              window.location.href = `voting-history.html?teamId=${teamId}`;
            }
          });
        });

        // Mark individual notification as read when clicked
        notificationList.querySelectorAll('.notification-item.unread').forEach(item => {
          item.addEventListener('click', async () => {
            const notificationId = item.dataset.id;
            try {
              await fetch('/notifications/read', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ notificationIds: [notificationId] })
              });
              item.classList.remove('unread');
              item.classList.add('read');
              await updateNotificationCount();
            } catch (error) {
              console.error('Failed to mark notification as read:', error);
            }
          });
        });

      } catch (error) {
        console.error('Error loading notifications:', error);
        notificationList.innerHTML = '<div class="error">Failed to load notifications</div>';
      }
    }

    /**
     * Mark all notifications as read.
     */
    async function markAllNotificationsAsRead() {
      try {
        const res = await fetch('/notifications/read-all', { method: 'POST' });
        if (res.ok) {
          updateNotificationBadge(0);
          await loadNotifications();
          // Give DB time then double-check count
          setTimeout(updateNotificationCount, 500);
        } else {
          console.error('Failed to mark all read:', res.status, res.statusText);
        }
      } catch (err) {
        console.error('markAllNotificationsAsRead error:', err);
      }
    }

    // Hook up "Mark all read" button
    const markAllReadBtn = document.getElementById('markAllRead');
    if (markAllReadBtn) {
      markAllReadBtn.addEventListener('click', markAllNotificationsAsRead);
    }

    // === Mobile Notification Setup - Independent Implementation ===
    // Since script.js functions are inside DOMContentLoaded and not globally available,
    // we'll implement mobile notifications independently
    
    function setupMobileNotifications() {
      const mobileNotificationBtn = document.getElementById('mobileNotificationBtn');
      if (mobileNotificationBtn) {
        
        // Remove any existing handlers and set up our own
        const newBtn = mobileNotificationBtn.cloneNode(true);
        mobileNotificationBtn.parentNode.replaceChild(newBtn, mobileNotificationBtn);
        
        newBtn.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          
          try {
            const authRes = await fetch('/me');
            const authData = await authRes.json();
            
            if (authData.user) {
              showMobileNotificationOverlay();
            } else {
              alert('Please log in to view notifications');
            }
          } catch (e) {
            console.error('Auth check failed:', e);
            alert('Please log in to view notifications');
          }
        });
      }
    }
    
    function showMobileNotificationOverlay() {
      let overlay = document.getElementById('mobileNotificationOverlay');
      if (!overlay) {
        overlay = createMobileNotificationOverlay();
        document.body.appendChild(overlay);
      }
      
      overlay.style.display = 'flex';
      document.body.style.overflow = 'hidden';
      loadMobileNotifications();
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
    
    function hideMobileNotifications() {
      const overlay = document.getElementById('mobileNotificationOverlay');
      if (overlay) {
        overlay.style.display = 'none';
        document.body.style.overflow = '';
      }
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

        // Mobile-specific: Clear DOM before rebuilding to prevent memory buildup
        notificationList.innerHTML = '';
        
        // Limit notifications on mobile to prevent memory issues
        const limitedNotifications = isMobile ? notifications.slice(0, 20) : notifications;
        
        limitedNotifications.forEach((notification, index) => {
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
      
      let messageHTML = notification.message;
      
      if (notification.type === 'versus_vote' && notification.related_team_id) {
        const teamLink = `<a href="voting-history.html?teamId=${notification.related_team_id}" style="color: #58a6ff; text-decoration: none;">your team</a>`;
        messageHTML = messageHTML.replace('your team', teamLink);
        
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
      
      item.innerHTML = `
        <div class="mobile-notification-message">${messageHTML}</div>
        <div class="mobile-notification-time">${timeAgo}</div>
      `;

      const opponentLinks = item.querySelectorAll('.mobile-opponent-link');
      opponentLinks.forEach(link => {
        link.addEventListener('click', async (e) => {
          e.stopPropagation();
          const teamId = link.getAttribute('data-team-id');
          if (teamId) {
            try {
              const res = await fetch(`/team-meta/${teamId}`);
              const meta = await res.json();
              if (meta.username) {
                window.location.href = `profile.html?user=${encodeURIComponent(meta.username)}`;
              } else {
                window.location.href = `voting-history.html?teamId=${teamId}`;
              }
            } catch (error) {
              console.error('Failed to fetch opponent info:', error);
              window.location.href = `voting-history.html?teamId=${teamId}`;
            }
          }
        });
      });

      item.addEventListener('click', async (e) => {
        if (e.target.tagName === 'A' || e.target.classList.contains('mobile-opponent-link')) {
          return;
        }
        
        if (!notification.is_read) {
          try {
            await fetch('/notifications/read', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ notificationIds: [parseInt(notification.id)] })
            });
            item.classList.remove('unread');
            item.classList.add('read');
            updateNotificationCount();
          } catch (error) {
            console.error('Failed to mark notification as read:', error);
          }
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
    
    function formatTimeAgo(date) {
      const now = new Date();
      const diffMs = now - date;
      const diffSecs = Math.floor(diffMs / 1000);
      const diffMins = Math.floor(diffSecs / 60);
      const diffHours = Math.floor(diffMins / 60);
      const diffDays = Math.floor(diffHours / 24);

      if (diffSecs < 60) return `${diffSecs}s ago`;
      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffHours < 24) return `${diffHours}h ago`;
      return `${diffDays}d ago`;
    }
    
    // Set up mobile notifications when authentication is confirmed
    setupMobileNotifications();
  });

  /**
   * Quick auth check using CSS classes for smooth transitions
   */
  async function quickAuth(){
    try{
      const res=await fetch('/me');
      const json=await res.json();
      if(json.user){
        // Add authenticated class to body for smooth CSS transitions
        document.body.classList.add('authenticated');
        
        const userLabel=document.getElementById('userLabel');
        if(userLabel){
          const name=json.user.display_name||json.user.email||'User';
          userLabel.textContent=name;
        }
      } else {
        // Remove authenticated class for CSS transitions
        document.body.classList.remove('authenticated');
      }
    }catch(e){console.error('quickAuth failed',e);}
  }

  // Mobile menu functionality is handled by script.js to avoid conflicts
})(); 