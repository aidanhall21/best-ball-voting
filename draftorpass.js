(function(){
  // Make page visible immediately so users don't stare at a blank screen
  document.body.classList.add('content-visible');

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

  // (Timer fallback no longer needed because we revealed the page immediately)

  // Load the main shared script that contains all voting logic
  loadScript('script.js', () => {
    try {
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
      // Then poll every 30 seconds like other pages
      setInterval(updateNotificationCount, 30000);
    }

    // === Attach UI event handlers that normally run in script.js DOMContentLoaded ===

    // 1) Notification bell toggle & dropdown
    const notificationBell = document.getElementById('notificationBell');
    const notificationDropdown = document.getElementById('notificationDropdown');
    if (notificationBell && notificationDropdown) {
      notificationBell.addEventListener('click', (e) => {
        e.stopPropagation();
        const isVisible = notificationDropdown.style.display !== 'none';
        notificationDropdown.style.display = isVisible ? 'none' : 'block';
        if (!isVisible) {
          loadNotifications();
        }
      });

      // Hide dropdown when clicking outside
      document.addEventListener('click', (e) => {
        if (!notificationDropdown.contains(e.target) && !notificationBell.contains(e.target)) {
          notificationDropdown.style.display = 'none';
        }
      });
    }

    // 2) Profile gear button → navigate to profile page
    const gearBtn = document.getElementById('userGear');
    if (gearBtn) {
      gearBtn.addEventListener('click', (e) => {
        e.preventDefault();
        window.location.href = 'profile.html';
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

            // Append link for opponent name at the end if opponent_team_id present
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
        console.log('Setting up mobile notification button handler');
        
        // Remove any existing handlers and set up our own
        const newBtn = mobileNotificationBtn.cloneNode(true);
        mobileNotificationBtn.parentNode.replaceChild(newBtn, mobileNotificationBtn);
        
        newBtn.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          console.log('Mobile notification button clicked');
          
          try {
            const authRes = await fetch('/me');
            const authData = await authRes.json();
            console.log('Auth check result:', authData.user ? 'logged in' : 'not logged in');
            
            if (authData.user) {
              console.log('User is logged in, showing notifications');
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
        console.log('Creating mobile notification overlay');
        overlay = createMobileNotificationOverlay();
        document.body.appendChild(overlay);
      }
      
      console.log('Showing notification overlay');
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
   * Quick auth check just for showing user controls
   */
  async function quickAuth(){
    try{
      const res=await fetch('/me');
      const json=await res.json();
      if(json.user){
        const bell=document.getElementById('notificationBell');
        if(bell) bell.style.display='inline-block';
        const gear=document.getElementById('userGear');
        if(gear) gear.style.display='inline-block';
        const userLabel=document.getElementById('userLabel');
        if(userLabel){
          const name=json.user.display_name||json.user.email||'User';
          userLabel.textContent=name;
        }
        
        // Setup mobile user controls
        const mobileUserInfo=document.getElementById('mobileUserInfo');
        if(mobileUserInfo) mobileUserInfo.style.display='block';
        
        const mobileNotificationBtn=document.getElementById('mobileNotificationBtn');
        if(mobileNotificationBtn) {
          mobileNotificationBtn.style.display='block';
          // Mobile notification handler is set up independently
        }
      }
    }catch(e){console.error('quickAuth failed',e);}
  }

  // Mobile menu functionality is handled by script.js to avoid conflicts
})(); 