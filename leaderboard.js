(function(){
  // Don't reveal page immediately - let header.js handle auth first

  function loadScript(src, cb){
    const s=document.createElement('script');
    s.src=src+(src.includes('?')?'':'?v='+Date.now());
    s.async=false;
    s.onload=()=>cb&&cb();
    s.onerror=()=>{
      console.error('Failed to load',src);
      const container=document.getElementById('teamsContainer');
      if(container){container.innerHTML='<div class="error-message">⚠️ Failed to load leaderboard. Try again later.</div>';}
    };
    document.head.appendChild(s);
  }

  loadScript('script.js', ()=>{
    try{
      // Wait for auth state to be resolved by header.js
      function initLeaderboard() {
        if (typeof setMode === 'function') {
          setMode('leaderboard');
        } else if (typeof currentMode !== 'undefined') {
          currentMode = 'leaderboard';
        }
        if(typeof fetchLeaderboard==='function'){
          fetchLeaderboard(true);
        }else{console.warn('fetchLeaderboard() not defined');}
      }
      
      // Listen for auth resolution from header.js
      document.addEventListener('authStateResolved', (event) => {
        const { isLoggedIn, user } = event.detail;
        
        // Set global auth state variables that script.js expects
        if (typeof currentUserId !== 'undefined') {
          currentUserId = isLoggedIn ? user.id : null;
        }
        
        // Initialize leaderboard after auth is resolved
        initLeaderboard();
      });
      
      // Fallback: if auth state was already resolved before this listener was added
      if (document.body.classList.contains('content-visible')) {
        setTimeout(initLeaderboard, 100);
      }
    }catch(e){console.error('init error',e);}

    // --- Start notification polling (immediate + every 30s) ---
    if (typeof updateNotificationCount === 'function') {
      updateNotificationCount();
      setInterval(updateNotificationCount, 30000);
    }

    // === Attach event handlers AFTER header is loaded ===
    document.addEventListener('headerLoaded', () => {
      // Small delay to ensure DOM is fully updated
      setTimeout(() => {
      
      // NOTE: Notification bell and profile button are now handled universally in header.js
      // No need to add duplicate event listeners here

      // Setup mobile notifications after header is loaded
      setupMobileNotifications();

      // Setup mark all read button
      const markAllReadBtn = document.getElementById('markAllRead');
      if (markAllReadBtn) {
        markAllReadBtn.addEventListener('click', markAllNotificationsAsRead);
      }
    }, 10);

    });

    // ===== Notification helpers (copied from other pages) =====

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

    async function loadNotifications() {
      const notificationList = document.getElementById('notificationList');
      if (!notificationList) return;

      try {
        notificationList.innerHTML = '<div class="loading">Loading notifications...</div>';
        const response = await fetch('/notifications');
        if (!response.ok) throw new Error('Failed to load notifications');
        const data = await response.json();
        const notifications = data.notifications || [];

        if (!notifications.length) {
          notificationList.innerHTML = '<div class="no-notifications">No notifications yet</div>';
          return;
        }

        notificationList.innerHTML = notifications.map(n => {
          const timeAgo = formatTimeAgo(new Date(n.created_at));

          let msgHtml = n.message;
          if (n.type === 'versus_vote' && n.related_team_id) {
            msgHtml = msgHtml.replace('your team', `<a href="voting-history.html?teamId=${n.related_team_id}" style="color:#58a6ff;text-decoration:none;">your team</a>`);
            if (n.opponent_team_id) {
              const idx = msgHtml.lastIndexOf('against ');
              if (idx !== -1) {
                const before = msgHtml.substring(0, idx + 8);
                const oppName = msgHtml.substring(idx + 8);
                const oppLink = `<span class="desktop-opponent-link" data-team-id="${n.opponent_team_id}" style="color:#58a6ff;cursor:pointer;text-decoration:none;">${oppName}</span>`;
                msgHtml = before + oppLink;
              }
            }
          }

          return `
            <div class="notification-item ${n.is_read ? 'read' : 'unread'}" data-id="${n.id}">
              <div class="notification-message">${msgHtml}</div>
              <div class="notification-time">${timeAgo}</div>
            </div>
          `;
        }).join('');

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

        notificationList.querySelectorAll('.notification-item.unread').forEach(item => {
          item.addEventListener('click', async () => {
            const id = item.dataset.id;
            try {
              await fetch('/notifications/read', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ notificationIds: [id] })
              });
              item.classList.remove('unread');
              item.classList.add('read');
              await updateNotificationCount();
            } catch (err) { console.error('mark read error', err); }
          });
        });
      } catch (err) {
        console.error('loadNotifications error', err);
        notificationList.innerHTML = '<div class="error">Failed to load notifications</div>';
      }
    }

    async function markAllNotificationsAsRead() {
      try {
        const res = await fetch('/notifications/read-all', { method: 'POST' });
        if (res.ok) {
          updateNotificationBadge(0);
          await loadNotifications();
          setTimeout(updateNotificationCount, 500);
        } else {
          console.error('mark all read failed', res.status);
        }
      } catch (err) {
        console.error('markAllNotificationsAsRead', err);
      }
    }

    // === Mobile Notification Setup - Independent Implementation ===
    function setupMobileNotifications() {
      const mobileNotificationBtn = document.getElementById('mobileNotificationBtn');
      if (mobileNotificationBtn) {
        
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
    
    // Use the same mobile notification functions as draftorpass.js
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

    // Mobile menu functionality is handled by script.js to avoid conflicts
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
})(); 