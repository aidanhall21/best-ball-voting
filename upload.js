// Upload page JavaScript
document.addEventListener('DOMContentLoaded', () => {
  // Make page visible immediately; we'll tweak elements after auth check
  document.body.classList.add('content-visible');
  // Elements
  const uploadButton = document.getElementById('uploadButton');
  const loginTwitterBtn = document.getElementById('loginTwitterBtn');
  const signupTwitterBtn = document.getElementById('signupTwitterBtn');
  const loginEmailForm = document.getElementById('loginEmailForm');
  const signupEmailForm = document.getElementById('signupEmailForm');
  const logoutBtn = document.getElementById('logoutBtn');
  const forgotPasswordLink = document.getElementById('forgotPasswordLink');
  const csvUpload = document.getElementById('csvUpload');
  const usernameInput = document.getElementById('usernameInput');
  const uploadPanel = document.getElementById('uploadSection');
  const gearBtn = document.getElementById('userGear');
  const userMenu = document.getElementById('userMenu');
  const userLabel = document.getElementById('userLabel');
  const loginPanel = document.getElementById('loginPanel');
  const mobileMenuToggle = document.getElementById('mobileMenuToggle');
  const mobileNav = document.getElementById('mobileNav');
  const mobileUserInfo = document.getElementById('mobileUserInfo');


  // Mobile menu toggle
  mobileMenuToggle.addEventListener('click', () => {
    mobileNav.classList.toggle('active');
    mobileMenuToggle.classList.toggle('active');
  });

  // Close mobile menu when clicking on a link
  document.querySelectorAll('.mobile-nav-link').forEach(link => {
    link.addEventListener('click', () => {
      mobileNav.classList.remove('active');
      mobileMenuToggle.classList.remove('active');
    });
  });

  // File input overlay for disabled state
  const fileInputContainer = document.querySelector('.file-input-container');
  let fileInputOverlay;
  if (fileInputContainer) {
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
      display: 'none',
      zIndex: 2
    });
    
    fileInputOverlay.addEventListener('click', () => {
      showUploadMessage('Create a username to upload teams', 'error');
    });
    
    fileInputContainer.appendChild(fileInputOverlay);
  }

  // Helper to keep file input state & overlay in sync
  function updateFileInputState() {
    const needsUsername = currentUserId && usernameInput.style.display !== 'none';
    const hasUsername = !!usernameInput.value.trim();
    
    if (needsUsername && !hasUsername) {
      csvUpload.disabled = true;
      uploadButton.disabled = true;
      if (fileInputOverlay) {
        fileInputOverlay.style.display = 'block';
      }
    } else {
      const hasFile = csvUpload.files && csvUpload.files.length > 0;
      csvUpload.disabled = false;
      uploadButton.disabled = !hasFile;
      if (fileInputOverlay) {
        fileInputOverlay.style.display = 'none';
      }
    }
  }

  let currentUserId = null;

  // Auth check and UI update
  async function refreshAuth() {
    try {
      const res = await fetch('/me');
      const data = await res.json();
      const loggedIn = !!data.user;
      currentUserId = loggedIn ? data.user.id : null;

      if (loggedIn) {
        const hasDisplayName = !!(data.user.display_name && data.user.display_name.trim());
        const displayName = data.user.display_name || data.user.email || 'User';
        
        // Update desktop user controls
        userLabel.textContent = displayName;
        gearBtn.style.display = 'inline-block';
        
        // Show notification bell
        const notificationBell = document.getElementById('notificationBell');
        if (notificationBell) {
          notificationBell.style.display = 'inline-block';
          
          // Set up notification bell click handler
          notificationBell.addEventListener('click', (e) => {
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
        
        // Update mobile user controls
        mobileUserInfo.style.display = 'block';
        
        // Show mobile notification button
        const mobileNotificationBtn = document.getElementById('mobileNotificationBtn');
        if (mobileNotificationBtn) {
          mobileNotificationBtn.style.display = 'block';
          
          // Add click handler for mobile notifications
          mobileNotificationBtn.addEventListener('click', () => {
            showMobileNotifications();
          });
        }
        
        // Show upload section, hide login panel
        uploadPanel.style.display = 'block';
        loginPanel.style.display = 'none';
        
        // Show/hide username input based on whether user has display_name
        if (hasDisplayName) {
          usernameInput.style.display = 'none';
          csvUpload.disabled = false;
          uploadButton.disabled = !csvUpload.files.length;
        } else {
          usernameInput.style.display = 'block';
          usernameInput.placeholder = 'You must create a username to upload teams';
          const hasUsername = !!usernameInput.value.trim();
          csvUpload.disabled = !hasUsername;
          uploadButton.disabled = !csvUpload.files.length || !hasUsername;
        }
        
        usernameInput.disabled = false;
        uploadPanel.style.opacity = '1';
      } else {
        // Not logged in
        gearBtn.style.display = 'none';
        userMenu.style.display = 'none';
        mobileUserInfo.style.display = 'none';
        
        uploadPanel.style.display = 'none';
        loginPanel.style.display = 'block';
        
        usernameInput.disabled = true;
        csvUpload.disabled = true;
        uploadButton.disabled = true;
        updateFileInputState();
      }

      updateFileInputState();
      document.body.classList.add('content-visible');
    } catch (err) {
      console.error('Auth check failed:', err);
      document.body.classList.add('content-visible');
    }
  }

  // Tab switching
  const loginTab = document.getElementById('loginTab');
  const signupTab = document.getElementById('signupTab');
  const loginForm = document.getElementById('loginForm');
  const signupForm = document.getElementById('signupForm');

  loginTab.addEventListener('click', () => {
    loginTab.classList.add('active');
    signupTab.classList.remove('active');
    loginForm.style.display = 'block';
    signupForm.style.display = 'none';
  });

  signupTab.addEventListener('click', () => {
    signupTab.classList.add('active');
    loginTab.classList.remove('active');
    loginForm.style.display = 'none';
    signupForm.style.display = 'block';
  });

  // Show message helper
  function showLoginMessage(message, type = '') {
    const messageEl = document.getElementById('loginMessage');
    messageEl.textContent = message;
    messageEl.className = 'upload-message';
    if (type) messageEl.classList.add(type);
    messageEl.style.display = message ? 'block' : 'none';
  }

  function showUploadMessage(message, type = '') {
    const messageEl = document.getElementById('uploadMessage');
    messageEl.textContent = message;
    messageEl.className = 'upload-message';
    if (type) messageEl.classList.add(type);
    
    // Remove any existing CTA
    const existingCTA = document.getElementById('startVotingCTA');
    if (existingCTA) existingCTA.remove();

    // Add CTA button for successful uploads
    if (message && type === 'success') {
      const ctaBtn = document.createElement('button');
      ctaBtn.id = 'startVotingCTA';
      ctaBtn.className = 'start-voting-btn';
      ctaBtn.textContent = 'Start voting now! →';
      ctaBtn.addEventListener('click', () => {
        window.location.href = '/draftorpass';
      });
      messageEl.parentNode.insertBefore(ctaBtn, messageEl.nextSibling);
    }
  }

  // Twitter login buttons
  if (loginTwitterBtn) {
    loginTwitterBtn.addEventListener('click', () => {
      window.location.href = '/auth/twitter';
    });
  }

  if (signupTwitterBtn) {
    signupTwitterBtn.addEventListener('click', () => {
      window.location.href = '/auth/twitter';
    });
  }

  // Email login form
  if (loginEmailForm) {
    loginEmailForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const identifier = document.getElementById('loginEmail').value;
      const password = document.getElementById('loginPassword').value;

      const res = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, password })
      });

      if (res.ok) {
        await refreshAuth();
        showLoginMessage('', '');
      } else {
        const err = await res.json().catch(() => ({}));
        showLoginMessage(err.error || 'Login failed', 'error');
      }
    });
  }

  // Email signup form
  if (signupEmailForm) {
    signupEmailForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('signupUsername').value.trim();
      const email = document.getElementById('signupEmail').value.trim();
      const emailConfirm = document.getElementById('signupEmailConfirm').value.trim();
      const password = document.getElementById('signupPassword').value;
      const passwordConfirm = document.getElementById('signupPasswordConfirm').value;

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

  // Logout
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await fetch('/logout', { method: 'POST' });
      await refreshAuth();
      showLoginMessage('', '');
    });
  }



  // Forgot password
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

  // File upload functionality
  usernameInput.addEventListener('input', () => {
    updateFileInputState();
    showUploadMessage('', '');
  });

  csvUpload.addEventListener('change', (e) => {
    updateFileInputState();
  });

  uploadButton.addEventListener('click', () => {
    const file = csvUpload.files[0];
    const username = usernameInput.value.trim();

    if (!file) {
      showUploadMessage('Please select a file', 'error');
      return;
    }

    const formData = new FormData();
    formData.append('csv', file);
    if (username) {
      formData.append('username', username);
    }

    uploadButton.disabled = true;
    showUploadMessage('Uploading...', '');

    fetch('/upload', {
      method: 'POST',
      body: formData
    })
      .then(response => {
        if (!response.ok) {
          return response.json().then(err => {
            throw new Error(err.error || err.message || 'Upload failed');
          });
        }
        return response.json();
      })
      .then(data => {
        csvUpload.value = '';
        usernameInput.value = '';
        uploadButton.disabled = true;
        updateFileInputState();

        if (data.message === 'No new teams to add') {
          showUploadMessage('File processed - all teams were already in the database', 'info');
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
          showUploadMessage(data.message || 'Teams uploaded successfully!', 'success');
        }
      })
      .catch(error => {
        showUploadMessage(error.message || 'Failed to upload teams. Please try again.', 'error');
        uploadButton.disabled = false;
      });
  });

  // Profile button - go directly to profile page
  if (gearBtn) {
    gearBtn.addEventListener('click', (e) => {
      e.preventDefault();
      window.location.href = 'profile.html';
    });
  }

  // Close dropdowns when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.user-controls')) {
      if (userMenu) userMenu.style.display = 'none';
      const notificationDropdown = document.getElementById('notificationDropdown');
      if (notificationDropdown) notificationDropdown.style.display = 'none';
    }
  });

  // ===== Notification Helpers (desktop + mobile) =====

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
   * Update both desktop and mobile notification badges.
   */
  function updateNotificationBadge(count) {
    // Desktop badge
    const desktopBadge = document.getElementById('notificationBadge');
    if (desktopBadge) {
      if (count > 0) {
        desktopBadge.textContent = count > 99 ? '99+' : String(count);
        desktopBadge.style.display = 'inline';
      } else {
        desktopBadge.style.display = 'none';
      }
    }

    // Mobile badge
    const mobileBadge = document.getElementById('mobileNotificationBadge');
    if (mobileBadge) {
      if (count > 0) {
        mobileBadge.textContent = count > 99 ? '99+' : String(count);
        mobileBadge.style.display = 'inline';
      } else {
        mobileBadge.style.display = 'none';
      }
    }
  }

  /**
   * Fetch /notifications/count and refresh the badge.
   */
  async function updateNotificationCount() {
    try {
      const res = await fetch('/notifications/count');
      if (res.ok) {
        const data = await res.json();
        updateNotificationBadge(data.count || 0);
      }
    } catch (err) {
      console.error('Failed to update notification count:', err);
    }
  }

  /**
   * Mark ALL notifications as read without closing the dropdown.
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

  // Hook up "Mark all read" button once DOM is ready
  const markAllReadBtn = document.getElementById('markAllRead');
  if (markAllReadBtn) {
    markAllReadBtn.addEventListener('click', markAllNotificationsAsRead);
  }

  // Simple notification loading function
  window.loadNotifications = async function() {
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
      
      // Mark notifications as read when clicked
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
  };

  // ===== Mobile Notification Functions =====

  function showMobileNotifications() {
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
      // First, create the team link
      const teamLink = `<a href="voting-history.html?teamId=${notification.related_team_id}" style="color: #58a6ff; text-decoration: none;">your team</a>`;
      messageHTML = messageHTML.replace('your team', teamLink);
      
      // If we have opponent info, find and replace just the opponent name at the very end
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

    // Add click handlers for opponent links
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

    // Mark as read when clicked (but not when clicking links)
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

  // Kick off badge count polling every 30s while page is open
  updateNotificationCount();
  const notifPoll = setInterval(updateNotificationCount, 30000);

  // Initialize
  refreshAuth();
}); 