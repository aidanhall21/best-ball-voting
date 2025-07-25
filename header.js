(function(){
  // Universal notification loading function that works on all pages
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
      
      // Helper function to format time ago
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
      
      notificationList.innerHTML = notifications.map(notification => {
        const timeAgo = formatTimeAgo(new Date(notification.created_at));
        const isRead = notification.is_read;

        // Enhance versus_vote messages with links
        let msgHtml = notification.message;
        if (notification.type === 'versus_vote' && notification.related_team_id) {
          // Link "your team" to voting history
          msgHtml = msgHtml.replace('your team', `<a href="voting-history.html?teamId=${notification.related_team_id}" style="color:#58a6ff;text-decoration:none;">your team</a>`);

          // Add opponent team link if available
          if (notification.opponent_team_id) {
            const againstIdx = msgHtml.lastIndexOf('against ');
            if (againstIdx !== -1) {
              const before = msgHtml.substring(0, againstIdx + 8);
              const after = msgHtml.substring(againstIdx + 8);
              msgHtml = before + `<a href="voting-history.html?teamId=${notification.opponent_team_id}" style="color:#58a6ff;text-decoration:none;">${after}</a>`;
            }
          }
        }

        return `
          <div class="notification-item ${isRead ? '' : 'unread'}" data-notification-id="${notification.id}">
            <div class="notification-content">
              <div class="notification-message">${msgHtml}</div>
              <div class="notification-time">${timeAgo}</div>
            </div>
            ${!isRead ? '<div class="notification-dot"></div>' : ''}
          </div>
        `;
      }).join('');
      
    } catch (err) {
      console.error('Error loading notifications:', err);
      notificationList.innerHTML = '<div class="no-notifications">Failed to load notifications</div>';
    }
  }

  // Make the function globally available
  window.loadNotifications = loadNotifications;

  // Universal notification count function that works on all pages
  async function updateNotificationCount() {
    try {
      const res = await fetch('/notifications/count');
      if (res.ok) {
        const data = await res.json();
        const count = data.count || 0;
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
  }

  // Make notification functions globally available
  window.updateNotificationCount = updateNotificationCount;
  window.updateNotificationBadge = updateNotificationBadge;

  async function loadHeader(){
    try{
      // Check authentication FIRST, before injecting header
      const authRes = await fetch('/me');
      const authData = await authRes.json();
      const isLoggedIn = !!authData.user;
      
      // Fetch header HTML
      const res = await fetch('/header.html', {cache:'no-store'});
      if(!res.ok) throw new Error('header fetch failed');
      const html = await res.text();
      const tpl = document.createElement('template');
      tpl.innerHTML = html.trim();
      const newHeader = tpl.content.firstElementChild;
      if(!newHeader) return;
      
      // Apply auth state BEFORE injecting header
      if (isLoggedIn) {
        document.body.classList.add('authenticated');
      } else {
        document.body.classList.remove('authenticated');
      }
      
      // Inject header with correct auth state
      const existing = document.querySelector('.main-header');
      if(existing){
        existing.replaceWith(newHeader);
      }else{
        document.body.insertAdjacentElement('afterbegin', newHeader);
      }
      
      // Highlight active nav link
      const path = window.location.pathname.replace(/\/$/, '') || '/';
      newHeader.querySelectorAll('.nav-link').forEach(a=>{
        const href = (a.getAttribute('href')||'').replace(/\/$/, '') || '/';
        if(href===path) a.classList.add('active');
      });
      
      // Verify elements exist for debugging
      const bell = newHeader.querySelector('#notificationBell');
      const profileBtn = newHeader.querySelector('#userGear');
      const dropdown = newHeader.querySelector('#notificationDropdown');
      const userMenu   = newHeader.querySelector('#userMenu');

      /* ----------------------------------------------------------
       *  Universal event listeners (work on every page)
       * --------------------------------------------------------*/
      // 1️⃣  Profile button – simple link to profile page
      if (profileBtn) {
        // If it is a <button>, convert the click into a link; if it is an <a>, the
        // default behaviour already works but we prevent duplicate navigation.
        profileBtn.addEventListener('click', (e) => {
          // Allow native anchor navigation when element is <a>
          if (profileBtn.tagName.toLowerCase() !== 'a') {
            e.preventDefault();
            window.location.href = '/profile.html';
          }
        });
      }

      // 2️⃣  Notification bell – toggle dropdown & load notifications
      if (bell && dropdown) {
        const toggleDropdown = (show) => {
          
          if (show) {
            dropdown.style.display = 'block';
            // Force high z-index and positioning to ensure visibility
            dropdown.style.zIndex = '9999';
            dropdown.style.position = 'absolute';
            dropdown.style.top = '100%';
            dropdown.style.right = '0';
          } else {
            dropdown.style.display = 'none';
          }
          
          
          if (show) {
            // Hide the profile menu if it is open
            if (userMenu) userMenu.style.display = 'none';
            // Load notifications if the helper is available in the page scope
            if (typeof window.loadNotifications === 'function') {
              window.loadNotifications();
            } else {
              console.warn('🔧 Header.js: loadNotifications not available');
            }
          }
        };

        bell.addEventListener('click', (e) => {
          e.stopPropagation();
          const currentlyVisible = dropdown.style.display !== 'none';
          toggleDropdown(!currentlyVisible);
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
          if (!dropdown.contains(e.target) && !bell.contains(e.target)) {
            toggleDropdown(false);
          }
        });
      } else {
        console.warn('🔧 Header.js: Bell or dropdown not found', { bell: !!bell, dropdown: !!dropdown });
      }
      
      // Show content immediately since auth state is already resolved
      document.body.classList.add('content-visible');
      
      // Dispatch events
      document.dispatchEvent(new CustomEvent('headerLoaded'));
      document.dispatchEvent(new CustomEvent('authStateResolved', { 
        detail: { isLoggedIn, user: authData.user } 
      }));
      
      // Start notification polling if user is logged in
      if (isLoggedIn) {
        // Initial count check
        updateNotificationCount();
        // Poll every 30 seconds
        setInterval(updateNotificationCount, 30000);
      }
      
    }catch(e){
      console.error('header.js error',e);
      // On error, assume not logged in
      document.body.classList.remove('authenticated');
      document.body.classList.add('content-visible');
      
      document.dispatchEvent(new CustomEvent('authStateResolved', { 
        detail: { isLoggedIn: false, user: null } 
      }));
    }
  }
  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded', loadHeader);
  }else{
    loadHeader();
  }
})(); 