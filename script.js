let teams = [];
let currentIndex = 0;
let userVotes = {};
let teamTournaments = {};
let currentMode = "upload"; // 'upload' | 'draft' | 'versus' | 'leaderboard'
let leaderboardType = "team"; // 'team' or 'user'
let leaderboardData = [];
let sortKey = "yes_pct";
let sortDir = "desc";

document.addEventListener("DOMContentLoaded", () => {
  // initial state: upload mode visible
  const uploadButton = document.getElementById("uploadButton");
  const csvUpload = document.getElementById("csvUpload");
  const usernameInput = document.getElementById("usernameInput");
  const uploadMessage = document.getElementById("uploadMessage");

  // Enable/disable file input and upload button based on username presence
  usernameInput.addEventListener("input", (e) => {
    const val = e.target.value.trim();
    csvUpload.disabled = !val;
    if (!val) {
      uploadButton.disabled = true;
      csvUpload.value = ""; // Clear file input if username is cleared
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

        if (data.message === "No new teams to add") {
          showUploadMessage("File processed - all teams were already in the database", "info");
        } else {
          showUploadMessage("Teams uploaded successfully!", "success");
        }
        // Refresh teams list regardless
        fetchTeams();
      })
      .catch(error => {
        showUploadMessage(error.message || "Failed to upload teams. Please try again.", "error");
        uploadButton.disabled = false;
      });
  });

  document.getElementById("modeUploadBtn").addEventListener("click", () => setMode("upload"));
  document.getElementById("modeDraftBtn").addEventListener("click", () => setMode("draft"));
  document.getElementById("modeVersusBtn").addEventListener("click", () => setMode("versus"));
  document.getElementById("modeLeaderboardBtn").addEventListener("click", () => setMode("leaderboard"));

  // Modal close button
  document.getElementById("modalCloseBtn").addEventListener("click", hideModal);

  // Ensure correct initial layout
  setMode("upload");
});

function showUploadMessage(message, type) {
  const messageEl = document.getElementById("uploadMessage");
  messageEl.textContent = message;
  messageEl.className = "upload-message";
  if (type) {
    messageEl.classList.add(type);
  }
}

function fetchTeams() {
  fetch("/teams")
    .then(res => res.json())
    .then(data => {
      teams = shuffle(data.teams);
      teamTournaments = data.tournaments || {};
      if (currentMode === "draft" && teams.length) {
        currentIndex = Math.floor(Math.random() * teams.length);
      } else {
        currentIndex = 0;
      }
      if (currentMode === "upload") return;
      if (currentMode === "draft") {
        renderDraft();
      } else if (currentMode === "versus") {
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

function setMode(mode) {
  currentMode = mode;
  document.getElementById("modeUploadBtn").classList.toggle("active", mode === "upload");
  document.getElementById("modeDraftBtn").classList.toggle("active", mode === "draft");
  document.getElementById("modeVersusBtn").classList.toggle("active", mode === "versus");
  document.getElementById("modeLeaderboardBtn").classList.toggle("active", mode === "leaderboard");
  const uploadPanel = document.querySelector(".upload-panel");
  const container = document.getElementById("teamsContainer");
  if (mode === "upload") {
    uploadPanel.style.display = "block";
    container.style.display = "none";
    container.innerHTML = "";
  } else {
    uploadPanel.style.display = "none";
    container.style.display = "block";
    if (mode === "leaderboard") {
      fetchLeaderboard();
    } else {
      fetchTeams();
    }
  }
}

// Helper to build a card element for a team
function buildTeamCard(teamId, players) {
  const card = document.createElement("div");
  card.className = "team-card";

  // Sort players by position predefined order then pick number
  const positionOrder = { QB: 0, RB: 1, WR: 2, TE: 3 };
  const playersSorted = [...players].sort((a, b) => {
    if (positionOrder[a.position] !== positionOrder[b.position]) {
      return positionOrder[a.position] - positionOrder[b.position];
    }
    return a.pick - b.pick;
  });

  // Track counts for summary
  const counts = {};

  const list = document.createElement("div");
  list.className = "player-list";

  // Build rows grouped by position, label total count once
  ["QB","RB","WR","TE"].forEach(pos => {
    const groupPlayers = playersSorted.filter(p => p.position === pos);
    if (!groupPlayers.length) return;

    counts[pos] = groupPlayers.length;

    groupPlayers.forEach((pl, idx) => {
      const row = document.createElement("div");
      row.className = "player-row";

      const bubble = document.createElement("div");
      bubble.className = "player-bubble";
      bubble.style.border = `2px solid ${getBorderColor(pl.position)}`;
      bubble.textContent = pl.name;

      row.appendChild(bubble);
      list.appendChild(row);
    });
  });

  // Add position count summary at bottom
  if (Object.keys(counts).length > 0) {
    const summary = document.createElement("div");
    summary.className = "position-summary";
    summary.textContent = ["QB", "RB", "WR", "TE"]
      .filter(pos => counts[pos])
      .map(pos => `${pos}${counts[pos]}`)
      .join(" | ");
    list.appendChild(summary);
  }

  card.appendChild(list);

  return card;
}

// Renamed existing renderTeam → renderDraft
function renderDraft() {
  const container = document.getElementById("teamsContainer");
  container.innerHTML = "";

  if (!teams.length) return;

  const [teamId, players] = teams[currentIndex];

  const card = buildTeamCard(teamId, players);

  // Voting UI (same as before)
  const voteSection = document.createElement("div");
  voteSection.className = "vote-buttons";

  const yesBtn = document.createElement("button");
  yesBtn.textContent = "👍 Draft";

  const noBtn = document.createElement("button");
  noBtn.textContent = "👎 Pass";

  const sendVote = (type) => {
    fetch("/vote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamId, voteType: type }),
    }).then(res => {
      if (handleRateLimit(res)) return;
      userVotes[teamId] = type;
      nextTeam();
    });
  };

  yesBtn.onclick = () => sendVote("yes");
  noBtn.onclick = () => sendVote("no");

  voteSection.appendChild(yesBtn);
  voteSection.appendChild(noBtn);
  card.appendChild(voteSection);

  container.appendChild(card);
}

function renderVersus() {
  const container = document.getElementById("teamsContainer");
  container.innerHTML = "";

  if (teams.length < 2) return;

  // Pick two distinct random indices
  let idx1 = Math.floor(Math.random() * teams.length);
  let idx2;
  do {
    idx2 = Math.floor(Math.random() * teams.length);
  } while (idx2 === idx1);

  const [teamId1, players1] = teams[idx1];
  const [teamId2, players2] = teams[idx2];

  const versusWrapper = document.createElement("div");
  versusWrapper.className = "versus-container";

  const card1 = buildTeamCard(teamId1, players1);
  const card2 = buildTeamCard(teamId2, players2);

  // Create center container for VS and buttons
  const centerContent = document.createElement("div");
  centerContent.className = "versus-center";

  const vsText = document.createElement("div");
  vsText.className = "versus-text";
  vsText.textContent = "VS";

  const buttonContainer = document.createElement("div");
  buttonContainer.className = "versus-buttons";

  // Add choose buttons under each card
  const chooseBtn1 = document.createElement("button");
  chooseBtn1.innerHTML = "<span>⬅️</span> Choose";
  chooseBtn1.className = "choose-button";

  const chooseBtn2 = document.createElement("button");
  chooseBtn2.innerHTML = "Choose <span>➡️</span>";
  chooseBtn2.className = "choose-button";

  const sendVersusVote = (winnerId, loserId) => {
    fetch("/versus", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ winnerId, loserId }),
    }).then(res => {
      if (handleRateLimit(res)) return;
      renderVersus();
    });
  };

  chooseBtn1.onclick = () => sendVersusVote(teamId1, teamId2);
  chooseBtn2.onclick = () => sendVersusVote(teamId2, teamId1);

  buttonContainer.appendChild(chooseBtn1);
  buttonContainer.appendChild(chooseBtn2);

  centerContent.appendChild(vsText);
  centerContent.appendChild(buttonContainer);

  versusWrapper.appendChild(card1);
  versusWrapper.appendChild(centerContent);
  versusWrapper.appendChild(card2);

  container.appendChild(versusWrapper);
}

// nextTeam function random selection
function nextTeam() {
  if (!teams.length) return;
  currentIndex = Math.floor(Math.random() * teams.length);
  renderDraft();
}

// fetchLeaderboard
function fetchLeaderboard() {
  const endpoint = leaderboardType === "team" ? "/leaderboard" : "/leaderboard/users";
  fetch(endpoint)
    .then(res => res.json())
    .then(data => {
      leaderboardData = data;
      sortAndRender();
    });
}

function sortAndRender() {
  const sorted = [...leaderboardData].sort((a, b) => {
    let aval = a[sortKey];
    let bval = b[sortKey];
    // numeric coercion
    aval = parseFloat(aval);
    bval = parseFloat(bval);
    if (sortDir === "asc") return aval - bval;
    return bval - aval;
  });
  renderLeaderboard(sorted);
}

// renderLeaderboard implementation
function renderLeaderboard(data) {
  const container = document.getElementById("teamsContainer");
  container.innerHTML = "";
  // switch buttons
  const switchDiv = document.createElement("div");
  switchDiv.className = "leaderboard-switch";
  const btnTeam = document.createElement("button");
  btnTeam.textContent = "By Team";
  btnTeam.classList.toggle("active", leaderboardType === "team");
  const btnUser = document.createElement("button");
  btnUser.textContent = "By User";
  btnUser.classList.toggle("active", leaderboardType === "user");
  btnTeam.onclick = () => { leaderboardType = "team"; fetchLeaderboard(); };
  btnUser.onclick = () => { 
    leaderboardType = "user"; 
    sortKey = "wins";
    sortDir = "desc";
    fetchLeaderboard(); 
  };
  switchDiv.appendChild(btnTeam);
  switchDiv.appendChild(btnUser);
  container.appendChild(switchDiv);

  const table = document.createElement("table");
  table.className = "leaderboard-table";

  const thead = document.createElement("thead");
  // First grouped header row
  const headerRow1 = document.createElement("tr");
  headerRow1.innerHTML = leaderboardType === "team" ? `
    <th rowspan="2">Team</th>
    <th rowspan="2">User</th>
    <th colspan="3">Draft or Pass</th>
    <th colspan="3">Versus</th>
  ` : `
    <th rowspan="2">User</th>
    <th colspan="3">Draft or Pass</th>
    <th colspan="3">Versus</th>
  `;
  // Second sub-header row
  const headerRow2 = document.createElement("tr");
  headerRow2.innerHTML = `
    <th>👍 Draft</th>
    <th>👎 Pass</th>
    <th>Draft %</th>
    <th>W</th>
    <th>L</th>
    <th>Win %</th>
  `;
  thead.appendChild(headerRow1);
  thead.appendChild(headerRow2);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  data.forEach(row=>{
    const tr = document.createElement("tr");
    const yesPct = (row.yes_pct || 0).toString();
    const winPct = (row.win_pct || 0).toString();

    if (leaderboardType === "team") {
      const viewBtn = `<button class="view-team-btn" data-id="${row.id}">View</button>`;
      tr.innerHTML = `<td>${viewBtn}</td><td>${row.username || "-"}</td><td>${row.yes_votes}</td><td>${row.no_votes}</td><td>${yesPct}%</td><td>${row.wins}</td><td>${row.losses}</td><td>${winPct}%</td>`;
    } else {
      tr.innerHTML = `<td>${row.username || "-"}</td><td>${row.yes_votes}</td><td>${row.no_votes}</td><td>${yesPct}%</td><td>${row.wins}</td><td>${row.losses}</td><td>${winPct}%</td>`;
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  container.appendChild(table);

  // event listeners for sort
  const headerCells = headerRow2.querySelectorAll("th");
  const keys = ["yes_votes","no_votes","yes_pct","wins","losses","win_pct"];
  headerCells.forEach((th, idx) => {
    th.style.cursor = "pointer";
    th.onclick = () => {
      const newKey = keys[idx];
      if (sortKey === newKey) {
        // If clicking same column, toggle direction
        sortDir = sortDir === "desc" ? "asc" : "desc";
      } else {
        // If clicking new column, default to descending
        sortKey = newKey;
        sortDir = "desc";
      }
      sortAndRender();
    };
  });

  // attach view button listeners if team view
  if (leaderboardType === "team") {
    container.querySelectorAll(".view-team-btn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const id = e.target.getAttribute("data-id");
        showTeamModal(id);
      });
    });
  }
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
