(function(){
  // Load the shared voting/rendering logic, then override specific hooks for Eliminator
  function loadScript(src, cb) {
    const s = document.createElement('script');
    s.src = src + (src.includes('?') ? '' : ('?v=' + Date.now()));
    s.async = false;
    s.onload = () => cb && cb();
    s.onerror = () => {
      console.error('Failed to load', src);
      const container = document.getElementById('teamsContainer');
      if (container) container.innerHTML = '<div class="error-message">Failed to load Eliminator logic.</div>';
    };
    document.head.appendChild(s);
  }

  // Small helper to fetch a fresh matchup from the server
  async function fetchEliminatorMatchup() {
    const res = await fetch('/api/eliminator/matchup');
    if (!res.ok) throw new Error('Failed to fetch Eliminator matchup');
    const data = await res.json();
    return data;
  }

  // Prefetch queue so Next Matchup is instant
  const PREFETCH_TARGET = 3;
  let prefetchQueue = [];
  let prefetching = false;
  const queuedIds = new Set();

  async function prefetchOne() {
    try {
      const m = await fetchEliminatorMatchup();
      if (m && m.draft_id && !queuedIds.has(m.draft_id)) {
        prefetchQueue.push(m);
        queuedIds.add(m.draft_id);
      }
    } catch (e) {
      console.warn('Eliminator prefetch failed:', e.message || e);
    }
  }

  async function ensurePrefetch(min = PREFETCH_TARGET) {
    if (prefetching) return;
    prefetching = true;
    try {
      while (prefetchQueue.length < min) {
        // eslint-disable-next-line no-await-in-loop
        await prefetchOne();
      }
    } finally {
      prefetching = false;
    }
  }

  loadScript('script.js', () => {
    // Keep references to originals
    const originalRenderVersus = window.renderVersus;

    // Override submitVote to be a no-op for Eliminator (no persistence)
    window.submitVote = async function() {
      // Simulate fast success to keep UI flow identical
      return new Promise(resolve => setTimeout(resolve, 50));
    };

    // Override renderVersus with a simplified renderer tailored for Eliminator
    window.renderVersus = async function() {
      const container = document.getElementById('teamsContainer');
      if (!container) return;
      // Use queued matchup if available; otherwise fetch one then render
      if (prefetchQueue.length === 0) {
        container.innerHTML = "<div class='loading-indicator'>Loading Eliminator matchup…</div>";
        await ensurePrefetch(1);
        if (prefetchQueue.length === 0) return;
      }

      try {
        // Consume one and top up in background
        const data = prefetchQueue.shift();
        if (data && data.draft_id) queuedIds.delete(data.draft_id);
        ensurePrefetch(PREFETCH_TARGET).catch(()=>{});
        const t = data.teams || [];
        if (!Array.isArray(t) || t.length < 2) {
          container.innerHTML = '<div class="error-message">Could not load two teams. Try again.</div>';
          return;
        }

        // Extract ids and players
        const [teamAId, teamAPlayers] = t[0];
        const [teamBId, teamBPlayers] = t[1];
        const matchupId = data.matchup_id || data.draft_id || null; // draft_id is the public id
        const usernames = data.usernames || {};

        // Clear and build layout mirroring the core renderer structure
        container.innerHTML = '';
        const outerContainer = document.createElement('div');
        outerContainer.className = 'versus-outer-container';

        const header = document.createElement('div');
        header.className = 'matchup-category-header';
        header.textContent = 'Eliminator';
        outerContainer.appendChild(header);

        const versusWrapper = document.createElement('div');
        versusWrapper.className = 'versus-container';

        const card1 = buildTeamCard(teamAId, teamAPlayers);
        const card2 = buildTeamCard(teamBId, teamBPlayers);

        // Owner boxes (hidden until vote) that will render directly above the Choose buttons
        const ownerBox1 = document.createElement('div');
        ownerBox1.className = 'owner-stats';
        ownerBox1.style.display = 'none';
        ownerBox1.style.marginTop = '8px';
        const ownerBox2 = document.createElement('div');
        ownerBox2.className = 'owner-stats';
        ownerBox2.style.display = 'none';
        ownerBox2.style.marginTop = '8px';

        const chooseBtn1 = document.createElement('button');
        chooseBtn1.innerHTML = "<span>⬅️</span> Choose";
        chooseBtn1.className = 'choose-button';
        const chooseBtn2 = document.createElement('button');
        chooseBtn2.innerHTML = "Choose <span>➡️</span>";
        chooseBtn2.className = 'choose-button';

        let nextButton;
        async function onChoose(winnerId, loserId) {
          // Guard: avoid double clicks
          if (chooseBtn1.disabled || chooseBtn2.disabled) return;

          // Immediate UI feedback
          const leftWins = winnerId === teamAId;
          const winnerBtn = leftWins ? chooseBtn1 : chooseBtn2;
          const loserBtn = leftWins ? chooseBtn2 : chooseBtn1;
          const winnerCard = leftWins ? card1 : card2;
          const loserCard = leftWins ? card2 : card1;

          winnerBtn.classList.add('selected');
          loserBtn.classList.add('disabled');
          winnerBtn.disabled = true;
          loserBtn.disabled = true;
          // Subtle visual emphasis
          loserCard.style.opacity = '0.65';
          // Reveal owners immediately
          ownerBox1.textContent = `Owner: ${usernames[teamAId] || 'Unknown'}`;
          ownerBox1.style.display = 'block';
          ownerBox2.textContent = `Owner: ${usernames[teamBId] || 'Unknown'}`;
          ownerBox2.style.display = 'block';
          if (nextButton) nextButton.style.display = 'block';

          try {
            const token = await getCaptchaToken();
            const resp = await fetch('/api/eliminator/vote', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                captcha: token,
                matchup_id: matchupId,
                winner_draft_entry_id: winnerId,
                loser_draft_entry_id: loserId
              })
            });
            if (!resp.ok) {
              const txt = await resp.text();
              console.warn('Eliminator vote failed:', resp.status, txt);
            }
          } catch (e) {
            console.warn('Eliminator vote error:', e);
          }
        }

        chooseBtn1.onclick = () => onChoose(teamAId, teamBId);
        chooseBtn2.onclick = () => onChoose(teamBId, teamAId);

        // Place owner boxes directly above Choose buttons
        card1.appendChild(ownerBox1);
        card1.appendChild(chooseBtn1);
        card2.appendChild(ownerBox2);
        card2.appendChild(chooseBtn2);

        versusWrapper.appendChild(card1);
        versusWrapper.appendChild(card2);
        outerContainer.appendChild(versusWrapper);

        // Next matchup button
        nextButton = document.createElement('button');
        nextButton.textContent = 'Next Matchup →';
        nextButton.className = 'next-button';
        nextButton.style.display = 'none';
        nextButton.onclick = () => window.renderVersus();
        outerContainer.appendChild(nextButton);

        container.appendChild(outerContainer);
      } catch (e) {
        console.error('Eliminator render failed:', e);
        container.innerHTML = '<div class="error-message">Failed to load Eliminator matchup. Please try again.</div>';
      }
    };

    // Kick off in versus mode and render first matchup
    if (typeof setMode === 'function') setMode('versus');
    // On this page, setMode may not exist; make sure container is visible
    const container = document.getElementById('teamsContainer');
    if (container) {
      container.style.display = 'block';
    }
    // Ensure page is visible
    document.body.classList.add('content-visible');
    // Warm up queue and then render first matchup
    ensurePrefetch(PREFETCH_TARGET).finally(() => window.renderVersus());
  });
})();
