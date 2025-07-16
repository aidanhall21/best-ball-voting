(function () {
  // Lightweight analytics for unique visitors & session time
  const VISITOR_KEY = 'visitor_id';
  const SESSION_KEY = 'session_id';
  const SESSION_START_KEY = 'session_start';
  const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30-minute inactivity window

  // Get or create persistent visitor id
  let visitorId = localStorage.getItem(VISITOR_KEY);
  if (!visitorId) {
    visitorId = (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2);
    localStorage.setItem(VISITOR_KEY, visitorId);
  }

  // Helper to start a brand-new session
  function newSession() {
    const sid = (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2);
    sessionStorage.setItem(SESSION_KEY, sid);
    sessionStorage.setItem(SESSION_START_KEY, String(Date.now()));
    return sid;
  }

  let sessionId = sessionStorage.getItem(SESSION_KEY);
  let sessionStart = parseInt(sessionStorage.getItem(SESSION_START_KEY) || '0', 10);
  if (!sessionId || (Date.now() - sessionStart) > SESSION_TIMEOUT_MS) {
    sessionId = newSession();
    sessionStart = Date.now();
  }

  const t0 = performance.now();
  let duplicateGuard = false; // prevents back-to-back duplicates (e.g. visibility + unload)

  // ---- Inactivity handling (5-minute idle window) ----
  const IDLE_LIMIT = 5 * 60 * 1000; // ms
  let lastActivity = Date.now();

  // Update lastActivity on any user interaction
  let activityDebounce;
  ['mousemove','keydown','scroll','touchstart','click'].forEach(evt =>
    addEventListener(evt, () => {
      clearTimeout(activityDebounce);
      activityDebounce = setTimeout(() => {
        const now = Date.now();
        // If user was idle and we already sent a segment, start a new one
        if (now - lastActivity > IDLE_LIMIT) {
          // reset timer for new engaged segment
          startNewSegment();
        }
        lastActivity = now;
      }, 100);
    }, { passive: true })
  );

  function startNewSegment() {
    // reset performance baseline so future duration is only active time
    window.__segmentStart = performance.now();
  }

  window.__segmentStart = t0;

  // Periodically check for idle state (every 60 s)
  const idleCheckInterval = setInterval(() => {
    if (Date.now() - lastActivity > IDLE_LIMIT) {
      sendUsage(); // will dedupe via duplicateGuard
      // after sending we prepare for next potential segment
      startNewSegment();
      // advance lastActivity so we don't keep firing every minute while idle
      lastActivity = Date.now();
    }
  }, 60 * 1000);

  function sendUsage() {
    if (duplicateGuard) return;
    duplicateGuard = true;
    setTimeout(() => duplicateGuard = false, 2000); // allow future segments after 2s

    const duration = Math.round(performance.now() - (window.__segmentStart || t0));
    // Ignore very short stays (<100 ms) which are often prerender/prefetch noise
    if (duration < 100) return;
    // Use navigator.sendBeacon so it fires reliably during unload
    try {
      const blob = new Blob([JSON.stringify({
        visitorId,
        sessionId,
        durationMs: duration,
        page: location.pathname
      })], { type: 'application/json' });
      navigator.sendBeacon('/usage', blob);
    } catch (e) {
      // Fallback to fetch if sendBeacon unsupported
      fetch('/usage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitorId, sessionId, durationMs: duration, page: location.pathname }),
        keepalive: true
      });
    }
  }

  // Send when the page/tab is about to be hidden or closed
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      sendUsage();
    }
  });
  window.addEventListener('beforeunload', () => {
    clearInterval(idleCheckInterval);
    sendUsage();
  });

  // ===============================================
  // Mobile Menu Functionality
  // ===============================================
  const mobileMenuToggle = document.getElementById('mobileMenuToggle');
  const mobileNav = document.getElementById('mobileNav');

  if (mobileMenuToggle && mobileNav) {
    mobileMenuToggle.addEventListener('click', () => {
      mobileNav.style.display = mobileNav.style.display === 'flex' ? 'none' : 'flex';
      mobileMenuToggle.classList.toggle('active');
    });

    // Close mobile nav when clicking outside
    document.addEventListener('click', (e) => {
      if (!mobileMenuToggle.contains(e.target) && !mobileNav.contains(e.target)) {
        mobileNav.style.display = 'none';
        mobileMenuToggle.classList.remove('active');
      }
    });
  }
})(); 