const roles = ["top", "jungle", "mid", "adc", "support"];
const roleLabels = { top: "Top", jungle: "Jungle", mid: "Mid", adc: "ADC", support: "Support" };
const matchTypeLabels = { all: "All", scrim: "Scrim", official: "Official", unknown: "Unknown" };

let state = {
  games: [],
  teamName: "Nightbirds",
  storageMode: "server",
  selectedTeam: "",
  tab: "champions",
  banOwner: "ours",
  banPhase: "all",
  sidebarCollapsed: true,
  scrimSeries: []
};

const LOCAL_TEAM_NAME = "Nightbirds";
const LOCAL_DB_NAME = "scrim-draft-tracker";
const LOCAL_DB_VERSION = 1;
const LOCAL_STORE_NAME = "kv";
const CHAMPION_IMAGE_KEYS = {
  aurelionsol: "AurelionSol",
  belveth: "Belveth",
  chogath: "Chogath",
  drmundo: "DrMundo",
  jarvaniv: "JarvanIV",
  kaisa: "Kaisa",
  khazix: "Khazix",
  kogmaw: "KogMaw",
  ksante: "KSante",
  leblanc: "Leblanc",
  leesin: "LeeSin",
  masteryi: "MasterYi",
  missfortune: "MissFortune",
  monkeyking: "MonkeyKing",
  nunuwillump: "Nunu",
  reksai: "RekSai",
  renataglasc: "Renata",
  tahmkench: "TahmKench",
  twistedfate: "TwistedFate",
  velkoz: "Velkoz",
  wukong: "MonkeyKing",
  xinzhao: "XinZhao"
};

const el = {
  login: document.querySelector("#login"),
  app: document.querySelector("#app"),
  loginForm: document.querySelector("#login-form"),
  loginError: document.querySelector("#login-error"),
  logout: document.querySelector("#logout-button"),
  sidebarToggle: document.querySelector("#sidebar-toggle"),
  teamSelect: document.querySelector("#team-select"),
  opponentFilter: document.querySelector("#opponent-filter"),
  patchFilter: document.querySelector("#patch-filter"),
  matchTypeFilter: document.querySelector("#match-type-filter"),
  sideFilter: document.querySelector("#side-filter"),
  minGames: document.querySelector("#min-games"),
  laneColumns: document.querySelector("#lane-columns"),
  blindColumns: document.querySelector("#blind-columns"),
  banTable: document.querySelector("#ban-table"),
  gamesTable: document.querySelector("#games-table"),
  metricGames: document.querySelector("#metric-games"),
  metricWr: document.querySelector("#metric-wr"),
  metricPicks: document.querySelector("#metric-picks"),
  metricBans: document.querySelector("#metric-bans"),
  details: document.querySelector("#details"),
  detailsClose: document.querySelector("#details-close"),
  detailsContent: document.querySelector("#details-content"),
  seriesId: document.querySelector("#series-id"),
  pullSeriesButton: document.querySelector("#pull-series-button"),
  updateGridButton: document.querySelector("#update-grid-button"),
  fileListButton: document.querySelector("#file-list-button"),
  findScrimsButton: document.querySelector("#find-scrims-button"),
  pullNewScrimsButton: document.querySelector("#pull-new-scrims-button"),
  pullScrimLimit: document.querySelector("#pull-scrim-limit"),
  scrimList: document.querySelector("#scrim-list"),
  fileList: document.querySelector("#file-list"),
  gridStatus: document.querySelector("#grid-status"),
  localFile: document.querySelector("#local-file"),
  manualJson: document.querySelector("#manual-json"),
  importJsonButton: document.querySelector("#import-json-button"),
  importStatus: document.querySelector("#import-status"),
  demoDataButton: document.querySelector("#demo-data-button"),
  exportDataButton: document.querySelector("#export-data-button"),
  clearDataButton: document.querySelector("#clear-data-button")
};

bootstrap();

async function bootstrap() {
  bindEvents();
  try {
    const session = await api("/api/session");
    state.storageMode = "server";
    if (session.authenticated) {
      showApp();
      await loadState();
    } else {
      showLogin();
    }
  } catch {
    state.storageMode = "local";
    el.logout.textContent = "Local";
    el.logout.disabled = true;
    [el.pullSeriesButton, el.updateGridButton, el.fileListButton, el.findScrimsButton, el.pullNewScrimsButton, el.pullScrimLimit, el.seriesId].forEach((control) => {
      control.disabled = true;
    });
    el.gridStatus.textContent = "Static local mode: GRID API pulling is unavailable, use manual file import.";
    showApp();
    await loadState();
  }
}

function bindEvents() {
  const storedSidebar = localStorage.getItem("sidebar-collapsed");
  state.sidebarCollapsed = storedSidebar === null ? true : storedSidebar === "true";
  applySidebarState();

  el.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    el.loginError.textContent = "";
    try {
      await api("/api/login", {
        method: "POST",
        body: { password: new FormData(el.loginForm).get("password") }
      });
      showApp();
      await loadState();
    } catch (error) {
      el.loginError.textContent = error.message;
    }
  });

  el.logout.addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" });
    showLogin();
  });

  el.sidebarToggle.addEventListener("click", () => {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    localStorage.setItem("sidebar-collapsed", String(state.sidebarCollapsed));
    applySidebarState();
  });

  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      state.tab = button.dataset.tab;
      document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === button));
      document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === state.tab));
      render();
    });
  });

  [el.teamSelect, el.opponentFilter, el.patchFilter, el.matchTypeFilter, el.sideFilter, el.minGames].forEach((input) => {
    input.addEventListener("input", () => {
      state.selectedTeam = el.teamSelect.value;
      render();
    });
  });

  document.querySelectorAll("#ban-owner button").forEach((button) => {
    button.addEventListener("click", () => {
      state.banOwner = button.dataset.owner;
      document.querySelectorAll("#ban-owner button").forEach((item) => item.classList.toggle("active", item === button));
      render();
    });
  });

  document.querySelectorAll("#ban-phase button").forEach((button) => {
    button.addEventListener("click", () => {
      state.banPhase = button.dataset.phase;
      document.querySelectorAll("#ban-phase button").forEach((item) => item.classList.toggle("active", item === button));
      render();
    });
  });

  el.detailsClose.addEventListener("click", closeDetails);

  el.fileListButton.addEventListener("click", async () => {
    const seriesId = el.seriesId.value.trim();
    if (!seriesId) return;
    el.gridStatus.textContent = "Requesting GRID file list...";
    el.fileList.innerHTML = "";
    try {
      const data = await api(`/api/grid/file-list/${encodeURIComponent(seriesId)}`);
      renderFileList(data.files || []);
      el.gridStatus.textContent = `Found ${(data.files || []).length} file(s).`;
    } catch (error) {
      el.gridStatus.textContent = error.message;
    }
  });

  el.pullSeriesButton.addEventListener("click", async () => {
    const seriesId = el.seriesId.value.trim();
    if (!seriesId) return;
    el.gridStatus.textContent = "Pulling GRID series...";
    el.fileList.innerHTML = "";

    try {
      const result = await api(`/api/grid/pull-series/${encodeURIComponent(seriesId)}`, { method: "POST" });
      renderFileList(result.availableFiles || []);
      const fileCount = result.importedFiles?.length || 1;
      el.gridStatus.textContent = `Pulled ${fileCount} file(s). ${importMessage(result)}`;
      await loadState();
    } catch (error) {
      el.gridStatus.textContent = error.message;
    }
  });

  el.updateGridButton.addEventListener("click", async () => {
    el.gridStatus.textContent = "Updating pulled GRID series...";
    try {
      const result = await api("/api/grid/update-pulled-series", { method: "POST" });
      el.gridStatus.textContent = `Updated ${result.updatedSeries} series. ${importMessage(result)}`;
      await loadState();
    } catch (error) {
      el.gridStatus.textContent = error.message;
    }
  });

  el.findScrimsButton.addEventListener("click", async () => {
    el.gridStatus.textContent = "Finding NightBirds scrims...";
    try {
      const result = await api("/api/grid/scrims?first=50");
      state.scrimSeries = result.series || [];
      renderScrimList(result);
      el.gridStatus.textContent = `Found ${result.totalCount || state.scrimSeries.length} NightBirds scrim series. Showing ${state.scrimSeries.length}.`;
    } catch (error) {
      el.gridStatus.textContent = error.message;
    }
  });

  el.pullNewScrimsButton.addEventListener("click", async () => {
    const limit = Number(el.pullScrimLimit.value || 3);
    el.gridStatus.textContent = `Pulling newest ${limit} unpulled scrim(s)...`;
    try {
      const result = await api("/api/grid/pull-new-scrims", { method: "POST", body: { limit, pages: 3 } });
      el.gridStatus.textContent = `Pulled ${result.pulledSeries} scrim series. ${importMessage(result)}`;
      await loadState();
      const scrims = await api("/api/grid/scrims?first=50");
      state.scrimSeries = scrims.series || [];
      renderScrimList(scrims);
    } catch (error) {
      el.gridStatus.textContent = error.message;
    }
  });

  el.importJsonButton.addEventListener("click", async () => {
    try {
      const payload = JSON.parse(el.manualJson.value);
      const result = await importPayload("manual-json", payload);
      el.importStatus.textContent = importMessage(result);
      await loadState();
    } catch (error) {
      el.importStatus.textContent = error.message;
    }
  });

  el.localFile.addEventListener("change", async () => {
    const files = sortImportFiles(Array.from(el.localFile.files || []));
    if (files.length === 0) return;

    try {
      el.importStatus.textContent = `Importing ${files.length} file(s)...`;
      const results = [];
      const previews = [];

      for (const file of files) {
        const { payload, preview } = await readImportFile(file);
        previews.push(preview);
        const result = await importPayload(file.name, payload);
        results.push({ fileName: file.name, result });
      }

      el.manualJson.value = previews.join("\n\n");
      el.importStatus.textContent = importBatchMessage(results);
      await loadState();
    } catch (error) {
      el.importStatus.textContent = error.message;
    }
  });

  el.demoDataButton.addEventListener("click", async () => {
    el.manualJson.value = JSON.stringify(demoPayload(), null, 2);
    const result = await importPayload("demo-data", demoPayload());
    el.importStatus.textContent = importMessage(result);
    await loadState();
  });

  el.exportDataButton.addEventListener("click", () => {
    exportBackup();
  });

  el.clearDataButton.addEventListener("click", async () => {
    if (!confirm("Clear all imported games?")) return;
    await clearGames();
    await loadState();
    el.importStatus.textContent = "All imported games were cleared.";
  });
}

function applySidebarState() {
  el.app.classList.toggle("sidebar-collapsed", state.sidebarCollapsed);
  el.sidebarToggle.textContent = state.sidebarCollapsed ? ">" : "<";
  el.sidebarToggle.title = state.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar";
  el.sidebarToggle.setAttribute("aria-label", el.sidebarToggle.title);
}

function exportBackup() {
  const payload = {
    exportedAt: new Date().toISOString(),
    teamName: state.teamName,
    games: state.games
  };
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `scrim-draft-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function loadState() {
  const data = state.storageMode === "local"
    ? { teamName: LOCAL_TEAM_NAME, games: await readLocalGames() }
    : await api("/api/state");
  state.games = data.games || [];
  state.teamName = data.teamName || "Nightbirds";
  populateFilters();
  render();
}

function showLogin() {
  el.login.classList.remove("hidden");
  el.app.classList.add("hidden");
}

function showApp() {
  el.login.classList.add("hidden");
  el.app.classList.remove("hidden");
}

function populateFilters() {
  const teams = unique(state.games.flatMap((game) => game.teams.map((team) => team.name)));
  const currentTeam = state.selectedTeam || teams.find((team) => team.toLowerCase() === state.teamName.toLowerCase()) || teams[0] || state.teamName;
  fillSelect(el.teamSelect, teams.length ? teams : [currentTeam], currentTeam);

  const opponents = unique(state.games.flatMap((game) => {
    const ourTeam = findTeam(game, currentTeam);
    return game.teams.filter((team) => team.name !== ourTeam?.name).map((team) => team.name);
  }));
  fillSelect(el.opponentFilter, ["all", ...opponents], el.opponentFilter.value || "all", { all: "All" });

  const patches = unique(state.games.map((game) => game.patch).filter(Boolean));
  fillSelect(el.patchFilter, ["all", ...patches], el.patchFilter.value || "all", { all: "All" });

  const matchTypes = unique(state.games.map((game) => normalizeMatchType(game.matchType)).filter((value) => value !== "unknown"));
  fillSelect(el.matchTypeFilter, ["all", ...matchTypes, "unknown"], el.matchTypeFilter.value || "all", matchTypeLabels);

  state.selectedTeam = currentTeam;
}

function fillSelect(select, values, selected, labels = {}) {
  const oldValue = selected;
  select.innerHTML = values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(labels[value] || value)}</option>`).join("");
  select.value = values.includes(oldValue) ? oldValue : values[0] || "";
}

function render() {
  const context = getContext();
  renderMetrics(context);
  renderChampionPool(context);
  renderBans(context);
  renderBlindCounter(context);
  renderGames(context);
}

function getContext() {
  const teamName = el.teamSelect.value || state.selectedTeam;
  const opponent = el.opponentFilter.value || "all";
  const patch = el.patchFilter.value || "all";
  const matchType = el.matchTypeFilter.value || "all";
  const side = el.sideFilter.value || "all";

  const games = state.games
    .map((game) => {
      const our = findTeam(game, teamName);
      if (!our) return null;
      const enemy = game.teams.find((team) => team.id !== our.id) || game.teams.find((team) => team.name !== our.name);
      return { game, our, enemy };
    })
    .filter(Boolean)
    .filter(({ game, our, enemy }) => opponent === "all" || enemy?.name === opponent)
    .filter(({ game }) => patch === "all" || game.patch === patch)
    .filter(({ game }) => matchType === "all" || normalizeMatchType(game.matchType) === matchType)
    .filter(({ our }) => side === "all" || our.side === side);

  return { teamName, games, totalGames: games.length, minGames: Number(el.minGames.value || 1) };
}

function renderMetrics(context) {
  const wins = context.games.filter(({ our }) => our.won).length;
  const uniquePicks = new Set(context.games.flatMap(({ our }) => our.picks.map((pick) => `${pick.role}:${pick.champion}`))).size;
  const uniqueBans = new Set(context.games.flatMap(({ our }) => our.bans.map((ban) => ban.champion))).size;
  el.metricGames.textContent = context.totalGames;
  el.metricWr.textContent = percent(wins, context.totalGames);
  el.metricPicks.textContent = uniquePicks;
  el.metricBans.textContent = uniqueBans;
}

function renderChampionPool(context) {
  const byRole = Object.fromEntries(roles.map((role) => [role, new Map()]));

  for (const entry of context.games) {
    for (const pick of entry.our.picks) {
      const role = roles.includes(pick.role) ? pick.role : "support";
      const key = pick.champion;
      const record = byRole[role].get(key) || { champion: key, championId: pick.championId, games: 0, wins: 0, matchups: new Map() };
      record.championId ||= pick.championId;
      const enemyPick = entry.enemy?.picks.find((candidate) => candidate.role === pick.role);
      record.games += 1;
      record.wins += entry.our.won ? 1 : 0;

      if (enemyPick) {
        const matchup = record.matchups.get(enemyPick.champion) || { champion: enemyPick.champion, championId: enemyPick.championId, games: 0, wins: 0 };
        matchup.championId ||= enemyPick.championId;
        matchup.games += 1;
        matchup.wins += entry.our.won ? 1 : 0;
        record.matchups.set(enemyPick.champion, matchup);
      }

      byRole[role].set(key, record);
    }
  }

  el.laneColumns.innerHTML = roles.map((role) => laneCard(role, [...byRole[role].values()], context, "champion")).join("");
  el.laneColumns.querySelectorAll("[data-champion]").forEach((row) => {
    row.addEventListener("click", () => openChampionDetails(row.dataset.role, row.dataset.champion, context));
  });
}

function laneCard(role, rows, context, mode) {
  const minGames = context.minGames;
  const showType = mode === "blind";
  const body = rows
    .filter((row) => row.games >= minGames)
    .sort((a, b) => b.games - a.games || b.wins / b.games - a.wins / a.games)
    .map((row) => `
      <div class="row clickable ${showType ? "with-extra compact" : ""}" data-role="${role}" data-champion="${escapeHtml(row.champion)}">
        <span class="champion-name" title="${escapeHtml(row.champion)}">${championIcon(row)}<span class="champion-label">${escapeHtml(row.champion)}</span></span>
        <span>${row.games}</span>
        <span class="${wrClass(row.wins, row.games)}">${percent(row.wins, row.games)}</span>
        ${showType ? `<span>${escapeHtml(row.mode)}</span>` : ""}
      </div>
    `).join("");

  return `
    <section class="lane-card">
      <h2>${roleLabels[role]}</h2>
      <div class="row header ${showType ? "with-extra compact" : ""}">
        <span title="Champion">${showType ? "C" : "Champion"}</span>
        <span title="Games">G</span>
        <span title="Win rate">WR</span>
        ${showType ? `<span title="Pick type">Type</span>` : ""}
      </div>
      ${body || `<div class="row ${showType ? "with-extra" : ""}"><span class="muted">No data</span><span></span><span></span>${showType ? "<span></span>" : ""}</div>`}
    </section>
  `;
}

function renderBans(context) {
  const owner = state.banOwner;
  const phase = state.banPhase;
  const bans = new Map();

  for (const entry of context.games) {
    const source = owner === "ours" ? entry.our : entry.enemy;
    for (const ban of source?.bans || []) {
      if (phase !== "all" && ban.phase !== phase) continue;
      const record = bans.get(ban.champion) || { champion: ban.champion, championId: ban.championId, games: 0, wins: 0 };
      record.championId ||= ban.championId;
      record.games += 1;
      record.wins += entry.our.won ? 1 : 0;
      bans.set(ban.champion, record);
    }
  }

  const rows = [...bans.values()].filter((row) => row.games >= context.minGames).sort((a, b) => b.games - a.games);
  el.banTable.innerHTML = `
    <div class="table-row header"><span>Champion</span><span>Ban count</span><span>Banrate</span><span>Game WR</span><span>Owner</span></div>
    ${rows.map((row) => `
      <div class="table-row">
        <span class="champion-name">${championIcon(row)}<span class="champion-label">${escapeHtml(row.champion)}</span></span>
        <span>${row.games}</span>
        <span>${percent(row.games, context.totalGames)}</span>
        <span class="${wrClass(row.wins, row.games)}">${percent(row.wins, row.games)}</span>
        <span>${owner === "ours" ? "Us" : "Enemy"}</span>
      </div>
    `).join("") || `<div class="table-row"><span class="muted">No ban data</span><span></span><span></span><span></span><span></span></div>`}
  `;
}

function renderBlindCounter(context) {
  const byRole = Object.fromEntries(roles.map((role) => [role, []]));
  const map = new Map();

  for (const entry of context.games) {
    for (const pick of entry.our.picks) {
      const enemyPick = entry.enemy?.picks.find((candidate) => candidate.role === pick.role);
      const mode = classifyPick(pick, enemyPick);
      const key = `${pick.role}:${pick.champion}:${mode}`;
      const record = map.get(key) || { champion: pick.champion, championId: pick.championId, role: pick.role, mode, games: 0, wins: 0 };
      record.championId ||= pick.championId;
      record.games += 1;
      record.wins += entry.our.won ? 1 : 0;
      map.set(key, record);
    }
  }

  for (const row of map.values()) {
    if (roles.includes(row.role)) byRole[row.role].push(row);
  }

  el.blindColumns.innerHTML = roles.map((role) => laneCard(role, byRole[role], context, "blind")).join("");
  el.blindColumns.querySelectorAll("[data-champion]").forEach((row) => {
    row.addEventListener("click", () => openChampionDetails(row.dataset.role, row.dataset.champion, context));
  });
}

function renderGames(context) {
  el.gamesTable.innerHTML = `
    <div class="table-row header"><span>Date</span><span>Opponent</span><span>Side</span><span>Result</span><span>Picks</span></div>
    ${context.games.map(({ game, our, enemy }) => `
      <div class="table-row">
        <span>${escapeHtml(formatDate(game.date))}</span>
        <span>${escapeHtml(enemy?.name || "Unknown")}</span>
        <span>${escapeHtml(our.side || "-")}</span>
        <span class="${our.won ? "pill good" : "pill bad"}">${our.won ? "Win" : "Loss"}</span>
        <span class="pick-strip">${our.picks.map((pick) => championChip(pick)).join("")}</span>
      </div>
    `).join("") || `<div class="table-row"><span class="muted">No games imported</span><span></span><span></span><span></span><span></span></div>`}
  `;
}

function openChampionDetails(role, champion, context) {
  const rows = [];
  const games = [];

  for (const entry of context.games) {
    const pick = entry.our.picks.find((candidate) => candidate.role === role && candidate.champion === champion);
    if (!pick) continue;
    const enemyPick = entry.enemy?.picks.find((candidate) => candidate.role === role);
    rows.push({ matchup: enemyPick?.champion || "Unknown", championId: enemyPick?.championId, won: entry.our.won });
    games.push({ ...entry, pick, enemyPick });
  }

  const matchupMap = new Map();
  for (const row of rows) {
    const record = matchupMap.get(row.matchup) || { matchup: row.matchup, championId: row.championId, games: 0, wins: 0 };
    record.championId ||= row.championId;
    record.games += 1;
    record.wins += row.won ? 1 : 0;
    matchupMap.set(row.matchup, record);
  }

  el.detailsContent.innerHTML = `
    <p class="eyebrow">${roleLabels[role]}</p>
    <h2 class="details-title">${championIcon(games[0]?.pick, "large")}${escapeHtml(champion)}</h2>
    <div class="metric-row">
      <div class="metric"><span>${games.length}</span><small>games</small></div>
      <div class="metric"><span>${percent(games.filter((item) => item.our.won).length, games.length)}</span><small>winrate</small></div>
    </div>
    <h2>Matchups</h2>
    <div class="data-table">
      <div class="table-row header"><span>Enemy</span><span>Games</span><span>WR</span><span>Type</span><span></span></div>
      ${[...matchupMap.values()].sort((a, b) => b.games - a.games).map((row) => `
        <div class="table-row">
          <span class="champion-name">${championIcon({ champion: row.matchup, championId: row.championId })}<span class="champion-label">${escapeHtml(row.matchup)}</span></span>
          <span>${row.games}</span>
          <span class="${wrClass(row.wins, row.games)}">${percent(row.wins, row.games)}</span>
          <span></span><span></span>
        </div>
      `).join("")}
    </div>
    <h2>Games</h2>
    <div class="data-table">
      <div class="table-row header"><span>Date</span><span>Opponent</span><span>Side</span><span>Result</span><span>Draft</span></div>
      ${games.map(({ game, our, enemy, pick, enemyPick }) => `
        <div class="table-row">
          <span>${escapeHtml(formatDate(game.date))}</span>
          <span>${escapeHtml(enemy?.name || "Unknown")}</span>
          <span>${escapeHtml(our.side || "-")}</span>
          <span class="${our.won ? "pill good" : "pill bad"}">${our.won ? "Win" : "Loss"}</span>
          <span class="draft-matchup">${championChip(pick)} vs ${enemyPick ? championChip(enemyPick) : "Unknown"} - ${escapeHtml(classifyPick(pick, enemyPick))}</span>
        </div>
      `).join("")}
    </div>
  `;
  el.details.classList.remove("hidden");
}

function closeDetails() {
  el.details.classList.add("hidden");
}

function renderFileList(files) {
  el.fileList.innerHTML = files.map((file) => `
    <div class="file-item">
      <strong>${escapeHtml(file.description || file.id || file.fileName)}</strong>
      <span class="muted">${escapeHtml(file.fileName || "")} ${escapeHtml(file.status || "")}</span>
      ${file.fullURL ? `<button data-url="${escapeHtml(file.fullURL)}" data-file-name="${escapeHtml(file.fileName || file.id || "")}">Import this file</button>` : ""}
    </div>
  `).join("");

  el.fileList.querySelectorAll("[data-url]").forEach((button) => {
    button.addEventListener("click", async () => {
      el.gridStatus.textContent = "Downloading and importing GRID file...";
      try {
        const result = await api("/api/grid/import-file", { method: "POST", body: { url: button.dataset.url, fileName: button.dataset.fileName } });
        el.gridStatus.textContent = importMessage(result);
        await loadState();
      } catch (error) {
        el.gridStatus.textContent = error.message;
      }
    });
  });
}

function renderScrimList(result) {
  const series = result.series || [];
  if (series.length === 0) {
    el.scrimList.innerHTML = `<div class="scrim-item muted">No scrims found.</div>`;
    return;
  }

  el.scrimList.innerHTML = series.map((item) => `
    <div class="scrim-item">
      <div>
        <strong>${escapeHtml(scrimTeams(item))}</strong>
        <span class="muted">${escapeHtml(formatDateTime(item.startTimeScheduled))} · ${escapeHtml(item.tournament?.name || "Scrim")}</span>
      </div>
      <div class="scrim-actions">
        <span class="${item.pulled ? "pill good" : "pill"}">${item.pulled ? "Pulled" : "New"}</span>
        <button class="ghost-button" data-scrim-id="${escapeHtml(item.id)}">Pull</button>
      </div>
    </div>
  `).join("");

  el.scrimList.querySelectorAll("[data-scrim-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      const seriesId = button.dataset.scrimId;
      el.seriesId.value = seriesId;
      el.gridStatus.textContent = `Pulling scrim ${seriesId}...`;
      try {
        const pullResult = await api(`/api/grid/pull-series/${encodeURIComponent(seriesId)}`, { method: "POST" });
        const fileCount = pullResult.importedFiles?.length || 1;
        el.gridStatus.textContent = `Pulled ${fileCount} file(s). ${importMessage(pullResult)}`;
        await loadState();
        const scrims = await api("/api/grid/scrims?first=50");
        state.scrimSeries = scrims.series || [];
        renderScrimList(scrims);
      } catch (error) {
        el.gridStatus.textContent = error.message;
      }
    });
  });
}

function scrimTeams(series) {
  return (series.teams || []).map((team) => team.name).filter(Boolean).join(" vs ") || `Series ${series.id}`;
}

function findTeam(game, teamName) {
  return game.teams.find((team) => team.name.toLowerCase() === String(teamName).toLowerCase()) || game.teams[0];
}

function classifyPick(pick, enemyPick) {
  if (!pick?.pickOrder || !enemyPick?.pickOrder) return "unknown";
  return pick.pickOrder < enemyPick.pickOrder ? "blind" : "counter";
}

function percent(value, total) {
  if (!total) return "0%";
  return `${Math.round((value / total) * 100)}%`;
}

function wrClass(wins, games) {
  const rate = games ? wins / games : 0;
  return `pill ${rate >= 0.55 ? "good" : rate <= 0.45 ? "bad" : ""}`;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

async function importPayload(sourceName, payload) {
  if (state.storageMode !== "local") {
    return api("/api/import", { method: "POST", body: { sourceName, payload } });
  }

  const roleAssignments = extractRiotRoleAssignments(payload);
  const pickOrderAssignments = extractRiotPickOrderAssignments(payload);
  const riotPatch = extractRiotPatch(payload);
  const riotMatchType = extractRiotMatchType(payload);
  const currentGames = await readLocalGames();

  if (roleAssignments.length > 0 || pickOrderAssignments.length > 0) {
    const result = applyRiotAssignments(currentGames, mergeRiotAssignments(roleAssignments, pickOrderAssignments), { patch: riotPatch, matchType: riotMatchType });
    await writeLocalGames(result.games);
    return {
      importedGames: 0,
      updatedGames: result.updatedGames,
      matchedPicks: result.matchedPicks,
      updatedPicks: result.updatedPicks,
      updatedPickOrders: result.updatedPickOrders,
      updatedPatches: result.updatedPatches,
      updatedMatchTypes: result.updatedMatchTypes,
      warnings: result.warnings,
      totalGames: result.games.length
    };
  }

  const imported = normalizeLocalImport(payload, sourceName);
  const games = upsertGames(currentGames, imported.games);
  await writeLocalGames(games);
  return {
    importedGames: imported.games.length,
    warnings: imported.warnings,
    totalGames: games.length
  };
}

async function clearGames() {
  if (state.storageMode === "local") {
    await writeLocalGames([]);
    return;
  }
  await api("/api/games", { method: "DELETE" });
}

async function readImportFile(file) {
  if (isRiotEventsFile(file.name, "")) {
    const payload = await parseRiotEventsFile(file);
    return {
      payload,
      preview: `${file.name} loaded (${Math.round(file.size / 1024 / 1024)} MB). Extracted champ_select and game_info only.`
    };
  }

  const text = await file.text();
  const payload = parseImportText(text, file.name);
  return { payload, preview: importPreview(file, text, payload) };
}

async function parseRiotEventsFile(file) {
  if (!file.stream || !window.TextDecoder) {
    return parseRiotEventsSnapshot(await file.text());
  }

  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let champSelect = null;
  let gameInfo = null;

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      ({ champSelect, gameInfo } = readRiotSnapshotLine(line, champSelect, gameInfo));
      if (champSelect && gameInfo) {
        await reader.cancel();
        return [champSelect, gameInfo];
      }
    }

    if (done) break;
  }

  if (buffer.trim()) {
    ({ champSelect, gameInfo } = readRiotSnapshotLine(buffer.trim(), champSelect, gameInfo));
  }
  if (champSelect && gameInfo) return [champSelect, gameInfo];
  if (gameInfo) return [gameInfo];
  throw new Error("Riot events file did not contain a game_info row.");
}

function importMessage(result) {
  const parts = [`Imported ${result.importedGames} game(s).`];
  if (result.matchedPicks) parts.push(`Matched ${result.matchedPicks} pick(s).`);
  if (result.updatedPicks) parts.push(`Updated roles on ${result.updatedPicks} pick(s).`);
  if (result.updatedPickOrders) parts.push(`Updated pick order on ${result.updatedPickOrders} pick(s).`);
  if (result.updatedPatches) parts.push(`Updated patch on ${result.updatedPatches} game(s).`);
  if (result.updatedMatchTypes) parts.push(`Updated match type on ${result.updatedMatchTypes} game(s).`);
  parts.push(`Total stored: ${result.totalGames}.`);
  if (result.warnings?.length) parts.push(`Warnings: ${result.warnings.join(" ")}`);
  return parts.join(" ");
}

function importBatchMessage(results) {
  const importedGames = results.reduce((sum, item) => sum + (item.result.importedGames || 0), 0);
  const matchedPicks = results.reduce((sum, item) => sum + (item.result.matchedPicks || 0), 0);
  const updatedPicks = results.reduce((sum, item) => sum + (item.result.updatedPicks || 0), 0);
  const updatedPickOrders = results.reduce((sum, item) => sum + (item.result.updatedPickOrders || 0), 0);
  const updatedPatches = results.reduce((sum, item) => sum + (item.result.updatedPatches || 0), 0);
  const updatedMatchTypes = results.reduce((sum, item) => sum + (item.result.updatedMatchTypes || 0), 0);
  const totalGames = results.at(-1)?.result.totalGames || 0;
  const warnings = results.flatMap((item) => item.result.warnings || []);
  const fileNames = results.map((item) => item.fileName).join(", ");
  const parts = [`Imported ${results.length} file(s): ${fileNames}.`, `Added ${importedGames} game(s).`];
  if (matchedPicks) parts.push(`Matched ${matchedPicks} pick(s).`);
  if (updatedPicks) parts.push(`Updated roles on ${updatedPicks} pick(s).`);
  if (updatedPickOrders) parts.push(`Updated pick order on ${updatedPickOrders} pick(s).`);
  if (updatedPatches) parts.push(`Updated patch on ${updatedPatches} game(s).`);
  if (updatedMatchTypes) parts.push(`Updated match type on ${updatedMatchTypes} game(s).`);
  parts.push(`Total stored: ${totalGames}.`);
  if (warnings.length) parts.push(`Warnings: ${warnings.join(" ")}`);
  return parts.join(" ");
}

function importPreview(file, text, payload) {
  if (text.length > 1_000_000) {
    return `${file.name} loaded (${Math.round(text.length / 1024 / 1024)} MB). Preview skipped for performance.`;
  }
  return `// ${file.name}\n${JSON.stringify(payload, null, 2)}`;
}

function sortImportFiles(files) {
  return files.sort((a, b) => importPriority(a.name) - importPriority(b.name) || a.name.localeCompare(b.name));
}

function importPriority(fileName) {
  const name = fileName.toLowerCase();
  if (name.includes("end_state") && name.includes("grid")) return 0;
  if (name.includes("summary") && name.includes("riot")) return 1;
  if (name.includes("details") && name.includes("riot")) return 2;
  if (name.includes("events") && name.includes("grid")) return 3;
  if (name.includes("events") && name.includes("riot")) return 4;
  return 5;
}

function parseImportText(text, fileName = "") {
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`${fileName || "Selected file"} is empty.`);
  const lowerFileName = fileName.toLowerCase();

  if (lowerFileName.endsWith(".jsonl")) {
    if (isRiotEventsFile(fileName, trimmed)) return parseRiotEventsSnapshot(trimmed);
    return trimmed.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    if (isRiotEventsFile(fileName, trimmed)) return parseRiotEventsSnapshot(trimmed);
    return trimmed.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  }
}

function isRiotEventsFile(fileName, text) {
  const name = fileName.toLowerCase();
  return (name.includes("riot") && name.includes("events")) || text.includes('"rfc461Schema":"champ_select"');
}

function parseRiotEventsSnapshot(text) {
  let champSelect = null;
  let gameInfo = null;
  let start = 0;

  while (start < text.length) {
    const end = text.indexOf("\n", start);
    const lineEnd = end === -1 ? text.length : end;
    const line = text.slice(start, lineEnd).trim();
    start = lineEnd + 1;

    ({ champSelect, gameInfo } = readRiotSnapshotLine(line, champSelect, gameInfo));

    if (champSelect && gameInfo) return [champSelect, gameInfo];
    if (end === -1) break;
  }

  if (gameInfo) return [gameInfo];
  throw new Error("Riot events file did not contain a game_info row.");
}

function readRiotSnapshotLine(line, champSelect, gameInfo) {
  if (!line) return { champSelect, gameInfo };

  if (!champSelect && line.includes('"rfc461Schema":"champ_select"')) {
    const row = JSON.parse(line);
    if ([...(row.teamOne || []), ...(row.teamTwo || [])].some((participant) => participant.pickTurn)) {
      champSelect = row;
    }
  }

  if (!gameInfo && line.includes('"rfc461Schema":"game_info"')) {
    gameInfo = JSON.parse(line);
  }

  return { champSelect, gameInfo };
}

function normalizeLocalImport(payload, sourceName) {
  const warnings = [];
  const gridGames = normalizeGridPayload(payload, sourceName, warnings);
  if (gridGames.length > 0) return { games: gridGames, warnings };

  const gamesInput = Array.isArray(payload) ? payload : payload.games || payload.series || payload.matches || [payload];
  const games = gamesInput.map((item) => normalizeGenericGame(item, sourceName, warnings)).filter(Boolean);
  if (games.length === 0) warnings.push("No games were detected.");
  return { games, warnings };
}

function normalizeGridPayload(payload, sourceName, warnings) {
  const seriesStates = collectGridSeriesStates(payload);
  return seriesStates.flatMap((seriesState) => normalizeGridSeriesState(seriesState, sourceName, warnings));
}

function collectGridSeriesStates(payload) {
  if (!payload) return [];
  if (payload.seriesState?.games) return [payload.seriesState];
  if (Array.isArray(payload?.files)) return payload.files.flatMap((file) => collectGridSeriesStates(file.payload));
  if (Array.isArray(payload)) return payload.flatMap((item) => collectGridSeriesStates(item));
  return [];
}

function normalizeGridSeriesState(seriesState, sourceName, warnings) {
  const seriesTeamsById = new Map((seriesState.teams || []).map((team) => [String(team.id), team]));
  const games = [];

  for (const gameState of seriesState.games || []) {
    if (!gameState?.teams?.length) continue;

    const draftActions = normalizeGridDraftActions(gameState.draftActions || []);
    const teams = gameState.teams.map((team, teamIndex) => {
      const seriesTeam = seriesTeamsById.get(String(team.id)) || {};
      const side = normalizeSide(team.side || (teamIndex === 0 ? "blue" : "red"));
      const picks = (team.players || []).map((player, playerIndex) => {
        const champion = readChampion(player.character || player.champion);
        if (!champion) return null;
        const pickAction = draftActions.find((action) =>
          action.type === "pick" &&
          action.teamId === String(team.id) &&
          championKey(action.champion) === championKey(champion)
        );
        return {
          champion,
          role: normalizeRole(player.role || player.lane || player.playerRole || roleFromIndex(playerIndex)),
          player: player.name || "",
          pickOrder: pickAction?.order ?? null,
          side
        };
      }).filter(Boolean);

      return {
        id: String(team.id),
        name: team.name || seriesTeam.name || `Team ${teamIndex + 1}`,
        side,
        won: Boolean(team.won),
        score: team.score ?? null,
        picks,
        bans: draftActions
          .filter((action) => action.type === "ban" && action.teamId === String(team.id))
          .map((action) => ({
            champion: action.champion,
            phase: normalizePhase(null, action.order),
            order: action.order,
            side
          }))
      };
    });

    if (teams.every((team) => team.picks.length === 0)) {
      warnings.push(`GRID game ${gameState.id || gameState.sequenceNumber || sourceName} had no final champion assignments.`);
      continue;
    }

    games.push({
      id: String(gameState.id || `${seriesState.id || sourceName}-game-${gameState.sequenceNumber || games.length + 1}`),
      sourceName,
      date: gameState.startedAt || seriesState.startedAt || "",
      patch: normalizePatchVersion(gameState.gameVersion || gameState.patch || gameState.version || seriesState.gameVersion || seriesState.patch || seriesState.version),
      matchType: inferGridMatchType(seriesState, gameState),
      tournament: seriesState.tournament?.name || "",
      map: readName(gameState.map) || "",
      teams,
      draftActions,
      rawImportedAt: new Date().toISOString()
    });
  }

  return games;
}

function normalizeGridDraftActions(actions) {
  return actions
    .map((action, index) => {
      const order = numberOrNull(action.sequenceNumber ?? action.order ?? index + 1);
      const type = String(action.type || "").toLowerCase();
      const actionType = type.includes("ban") ? "ban" : type.includes("pick") ? "pick" : "";
      const champion = readChampion(action.draftable || action.champion || action.character);
      const teamId = String(action.drafter?.id || action.teamId || "");
      if (!order || !actionType || !champion || !teamId) return null;
      return { order, type: actionType, teamId, side: "", champion, phase: normalizePhase(null, order) };
    })
    .filter(Boolean)
    .sort((a, b) => a.order - b.order);
}

function normalizeGenericGame(input, sourceName, warnings) {
  if (!input || typeof input !== "object") return null;
  const teams = normalizeGenericTeams(input);
  if (teams.length === 0) {
    warnings.push(`Skipped ${input.id || sourceName}: no teams found.`);
    return null;
  }
  return {
    id: String(input.id || input.gameId || input.matchId || input.seriesId || `import-${Date.now()}-${Math.random()}`),
    sourceName,
    date: input.date || input.startedAt || input.startTime || input.createdAt || "",
    patch: normalizePatchVersion(input.patch || input.gameVersion || input.version),
    matchType: normalizeMatchType(input.matchType || inferRiotMatchType(input)),
    tournament: readName(input.tournament) || input.tournamentName || "",
    map: readName(input.map) || input.mapName || "",
    teams,
    draftActions: [],
    rawImportedAt: new Date().toISOString()
  };
}

function normalizeGenericTeams(input) {
  const source = input.teams || input.participants || input.sides || [];
  if (!Array.isArray(source)) return [];
  return source.map((team, index) => {
    const base = team.baseInfo || team.team || team;
    const side = normalizeSide(team.side || team.color || (index === 0 ? "blue" : "red"));
    return {
      id: String(base.id || team.id || team.teamId || side || index),
      name: base.name || team.name || team.teamName || `Team ${index + 1}`,
      side,
      won: Boolean(team.won ?? team.isWinner ?? team.winner ?? false),
      score: team.score ?? null,
      picks: normalizeGenericPicks(team, side),
      bans: normalizeGenericBans(team, side)
    };
  });
}

function normalizeGenericPicks(team, side) {
  const source = team.picks || team.champions || team.selectedChampions || team.players || [];
  if (!Array.isArray(source)) return [];
  return source.map((entry, index) => {
    const champion = readChampion(entry.champion || entry.character || entry.entity || entry.pick || entry);
    if (!champion) return null;
    return {
      champion,
      role: normalizeRole(entry.role || entry.position || entry.lane || entry.playerRole || roleFromIndex(index)),
      player: readName(entry.player) || entry.playerName || entry.name || "",
      pickOrder: numberOrNull(entry.pickOrder ?? entry.order ?? entry.sequenceNumber),
      side
    };
  }).filter(Boolean);
}

function normalizeGenericBans(team, side) {
  const source = team.bans || team.draft?.bans || team.bannedChampions || [];
  if (!Array.isArray(source)) return [];
  return source.map((entry, index) => {
    const champion = readChampion(entry.champion || entry.character || entry.entity || entry.ban || entry);
    if (!champion) return null;
    const order = numberOrNull(entry.order ?? entry.banOrder ?? entry.sequenceNumber ?? index + 1);
    return { champion, phase: normalizePhase(entry.phase || entry.banPhase, order), order, side };
  }).filter(Boolean);
}

function extractRiotRoleAssignments(payload) {
  const rows = Array.isArray(payload) ? payload : [payload];
  const assignmentsByKey = new Map();
  for (const row of rows) {
    const participants = Array.isArray(row?.participants) ? row.participants : [];
    for (const participant of participants) {
      const role = normalizeRole(participant.positionAssignedByMatchmaking || participant.role || participant.position || participant.lane);
      const player = cleanRiotPlayerName(
        participant.summonerName ||
        participant.playerName ||
        participant.riotIdGameName ||
        participant.riotId?.displayName ||
        participant.name ||
        participant.displayName
      );
      const champion = readChampion(participant.championName || participant.champion || participant.character);
      if (!player || role === "unknown") continue;
      assignmentsByKey.set(playerKey(player), {
        player,
        champion,
        championId: numberOrNull(participant.championId ?? participant.championID),
        championKey: championKey(champion),
        role,
        puuid: participant.puuid || "",
        teamId: String(participant.teamID || participant.teamId || "")
      });
    }
  }
  return [...assignmentsByKey.values()];
}

function extractRiotPickOrderAssignments(payload) {
  const rows = Array.isArray(payload) ? payload : [payload];
  const assignmentsByKey = new Map();
  for (const row of rows) {
    const participants = [...(row?.teamOne || []), ...(row?.teamTwo || [])];
    for (const participant of participants) {
      const player = cleanRiotPlayerName(
        participant.summonerName ||
        participant.playerName ||
        participant.riotIdGameName ||
        participant.riotId?.displayName ||
        participant.gameName ||
        participant.displayName
      );
      const pickOrder = numberOrNull(participant.pickTurn);
      if (!player || !pickOrder) continue;
      assignmentsByKey.set(playerKey(player), { player, pickOrder, puuid: participant.puuid || "" });
    }
  }
  return [...assignmentsByKey.values()];
}

function extractRiotPatch(payload) {
  const rows = Array.isArray(payload) ? payload : [payload];
  for (const row of rows) {
    const patch = normalizePatchVersion(row?.gameVersion || row?.game_version || row?.game?.gameVersion || row?.metadata?.gameVersion);
    if (patch) return patch;
  }
  return "";
}

function extractRiotMatchType(payload) {
  const rows = Array.isArray(payload) ? payload : [payload];
  for (const row of rows) {
    const matchType = inferRiotMatchType(row);
    if (matchType !== "unknown") return matchType;
  }
  return "unknown";
}

function mergeRiotAssignments(roleAssignments, pickOrderAssignments) {
  const byPlayer = new Map();
  for (const assignment of [...roleAssignments, ...pickOrderAssignments]) {
    const key = playerKey(assignment.player);
    byPlayer.set(key, { ...(byPlayer.get(key) || {}), ...assignment });
  }
  return [...byPlayer.values()];
}

function applyRiotAssignments(games, assignments, metadata = {}) {
  const riotPatch = metadata.patch || "";
  const riotMatchType = normalizeMatchType(metadata.matchType);
  const byPlayer = new Map(assignments.map((assignment) => [playerKey(assignment.player), assignment]));
  const byChampion = new Map(assignments.filter((assignment) => assignment.championKey).map((assignment) => [assignment.championKey, assignment]));
  const warnings = [];
  let matchedPicks = 0;
  let updatedPicks = 0;
  let updatedPickOrders = 0;
  let updatedPatches = 0;
  let updatedMatchTypes = 0;
  const updatedGameIds = new Set();

  const nextGames = games.map((game) => {
    let gameChanged = false;
    let gameMatchedPicks = 0;
    const teams = (game.teams || []).map((team) => {
      let teamChanged = false;
      const picks = (team.picks || []).map((pick) => {
        const assignment = byPlayer.get(playerKey(pick.player)) || byChampion.get(championKey(pick.champion));
        if (!assignment) return pick;
        matchedPicks += 1;
        gameMatchedPicks += 1;

        const nextPick = { ...pick };
        let pickChanged = false;
        if (assignment.role && pick.role !== assignment.role) {
          nextPick.role = assignment.role;
          nextPick.roleSource = "riot-roles";
          updatedPicks += 1;
          pickChanged = true;
        }
        if (assignment.championId && pick.championId !== assignment.championId) {
          nextPick.championId = assignment.championId;
          pickChanged = true;
        }
        if (assignment.pickOrder && pick.pickOrder !== assignment.pickOrder) {
          nextPick.pickOrder = assignment.pickOrder;
          nextPick.pickOrderSource = "riot-champ-select";
          updatedPickOrders += 1;
          pickChanged = true;
        }
        if (!pickChanged) return pick;
        teamChanged = true;
        gameChanged = true;
        return nextPick;
      });
      return teamChanged ? { ...team, picks } : team;
    });

    if (riotPatch && gameMatchedPicks > 0 && game.patch !== riotPatch) {
      updatedPatches += 1;
      gameChanged = true;
    }
    if (riotMatchType !== "unknown" && gameMatchedPicks > 0 && normalizeMatchType(game.matchType) !== riotMatchType) {
      updatedMatchTypes += 1;
      gameChanged = true;
    }

    if (!gameChanged) return game;
    updatedGameIds.add(game.id);
    return {
      ...game,
      patch: riotPatch && gameMatchedPicks > 0 ? riotPatch : game.patch,
      matchType: riotMatchType !== "unknown" && gameMatchedPicks > 0 ? riotMatchType : normalizeMatchType(game.matchType),
      teams,
      roleUpdatedAt: new Date().toISOString()
    };
  });

  if (matchedPicks === 0) warnings.push("Riot data was detected, but no stored picks matched. Import the GRID post-state first.");
  return { games: nextGames, updatedGames: updatedGameIds.size, matchedPicks, updatedPicks, updatedPickOrders, updatedPatches, updatedMatchTypes, warnings };
}

function upsertGames(existingGames, newGames) {
  const byId = new Map(existingGames.map((game) => [game.id, game]));
  for (const game of newGames) byId.set(game.id, game);
  return [...byId.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function readChampion(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.name || value.displayName || value.id || value.key || "";
}

function readName(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.name || value.nameShortened || value.id || "";
}

function normalizeRole(value) {
  const role = String(value || "").toLowerCase();
  if (["top", "jungle", "mid", "adc", "support"].includes(role)) return role;
  if (role.includes("jun")) return "jungle";
  if (role.includes("middle") || role.includes("mid")) return "mid";
  if (role.includes("bot") || role.includes("marksman") || role.includes("carry")) return "adc";
  if (role.includes("sup") || role.includes("util")) return "support";
  return role || "unknown";
}

function roleFromIndex(index) {
  return roles[index] || "unknown";
}

function normalizeSide(value) {
  const side = String(value || "").toLowerCase();
  if (side.includes("blue") || side.includes("home")) return "blue";
  if (side.includes("red") || side.includes("away")) return "red";
  return side;
}

function inferGridMatchType(seriesState, gameState) {
  const links = [...(seriesState?.externalLinks || []), ...(gameState?.externalLinks || [])];
  if (links.some((link) => String(link.dataProvider?.name || "").toLowerCase() === "lol")) return "official";
  return "unknown";
}

function inferRiotMatchType(row) {
  const gameName = String(row?.gameName || "").toLowerCase();
  if (gameName.includes("scrim")) return "scrim";
  if (/^\d+\|game\d+$/i.test(gameName)) return "official";
  return "unknown";
}

function normalizeMatchType(value) {
  const matchType = String(value || "").toLowerCase();
  if (matchType.includes("scrim")) return "scrim";
  if (matchType.includes("official") || matchType.includes("competitive") || matchType.includes("esport") || matchType.includes("tournament")) return "official";
  return "unknown";
}

function normalizePhase(value, order) {
  const phase = String(value || "").toLowerCase();
  if (phase.includes("second") || phase.includes("2")) return "second";
  if (phase.includes("first") || phase.includes("1")) return "first";
  if (order && order > 6) return "second";
  return "first";
}

function normalizePatchVersion(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}` : raw;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanRiotPlayerName(value) {
  return String(value || "").replace(/^(SC|NBS|NB|SKILLCAMP|NIGHTBIRDS)\s+/i, "").trim();
}

function playerKey(value) {
  return cleanRiotPlayerName(value).toLowerCase();
}

function championKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function championIcon(entity, size = "small") {
  const src = championImageUrl(entity);
  if (!src) return "";
  const className = size === "large" ? "champion-icon large" : "champion-icon";
  return `<img class="${className}" src="${escapeHtml(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`;
}

function championChip(pick) {
  if (!pick?.champion) return "";
  return `
    <span class="champion-chip" title="${escapeHtml(pick.champion)}">
      ${championIcon(pick)}
      <span>${escapeHtml(pick.champion)}</span>
    </span>
  `;
}

function championImageUrl(entity) {
  if (!entity) return "";
  const championId = numberOrNull(entity.championId);
  if (championId) {
    return `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-icons/${championId}.png`;
  }

  const champion = entity.champion || entity.matchup || "";
  const key = championImageKey(champion);
  return key ? `https://ddragon.leagueoflegends.com/cdn/img/champion/tiles/${key}_0.jpg` : "";
}

function championImageKey(champion) {
  const key = championKey(champion);
  if (!key || key === "unknown") return "";
  return CHAMPION_IMAGE_KEYS[key] || key.charAt(0).toUpperCase() + key.slice(1);
}

async function readLocalGames() {
  const db = await openLocalDb();
  return getLocalValue(db, "games", []);
}

async function writeLocalGames(games) {
  const db = await openLocalDb();
  await setLocalValue(db, "games", games);
}

function openLocalDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LOCAL_DB_NAME, LOCAL_DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(LOCAL_STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getLocalValue(db, key, fallback) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(LOCAL_STORE_NAME, "readonly");
    const request = transaction.objectStore(LOCAL_STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result ?? fallback);
    request.onerror = () => reject(request.error);
  });
}

function setLocalValue(db, key, value) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(LOCAL_STORE_NAME, "readwrite");
    const request = transaction.objectStore(LOCAL_STORE_NAME).put(value, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);
}

function demoPayload() {
  return {
    games: [
      {
        id: "demo-1",
        date: "2026-06-04T15:31:00Z",
        patch: "25.11",
        tournament: "League of Legends Scrims",
        teams: [
          {
            id: "nightbirds",
            name: "Nightbirds",
            side: "red",
            won: true,
            picks: [
              { role: "top", champion: "Rumble", player: "Top", pickOrder: 4 },
              { role: "jungle", champion: "Aatrox", player: "Jungle", pickOrder: 7 },
              { role: "mid", champion: "Ryze", player: "Mid", pickOrder: 3 },
              { role: "adc", champion: "Yunara", player: "ADC", pickOrder: 9 },
              { role: "support", champion: "Rakan", player: "Support", pickOrder: 10 }
            ],
            bans: [
              { champion: "Vi", phase: "first", order: 2 },
              { champion: "Orianna", phase: "first", order: 4 },
              { champion: "Alistar", phase: "first", order: 6 },
              { champion: "K'Sante", phase: "second", order: 7 },
              { champion: "Ezreal", phase: "second", order: 9 }
            ]
          },
          {
            id: "skillcamp",
            name: "Skillcamp",
            side: "blue",
            won: false,
            picks: [
              { role: "top", champion: "Sion", player: "Top", pickOrder: 5 },
              { role: "jungle", champion: "Wukong", player: "Jungle", pickOrder: 2 },
              { role: "mid", champion: "Azir", player: "Mid", pickOrder: 6 },
              { role: "adc", champion: "Ezreal", player: "ADC", pickOrder: 1 },
              { role: "support", champion: "Nautilus", player: "Support", pickOrder: 8 }
            ],
            bans: [
              { champion: "Ambessa", phase: "first", order: 1 },
              { champion: "Jarvan IV", phase: "first", order: 3 },
              { champion: "Neeko", phase: "first", order: 5 },
              { champion: "Corki", phase: "second", order: 8 },
              { champion: "Jhin", phase: "second", order: 10 }
            ]
          }
        ]
      },
      {
        id: "demo-2",
        date: "2026-06-04T16:34:00Z",
        patch: "25.11",
        tournament: "League of Legends Scrims",
        teams: [
          {
            id: "nightbirds",
            name: "Nightbirds",
            side: "blue",
            won: false,
            picks: [
              { role: "top", champion: "K'Sante", player: "Top", pickOrder: 1 },
              { role: "jungle", champion: "Aatrox", player: "Jungle", pickOrder: 5 },
              { role: "mid", champion: "Ryze", player: "Mid", pickOrder: 8 },
              { role: "adc", champion: "Ezreal", player: "ADC", pickOrder: 3 },
              { role: "support", champion: "Rell", player: "Support", pickOrder: 9 }
            ],
            bans: [
              { champion: "Vi", phase: "first", order: 1 },
              { champion: "Orianna", phase: "first", order: 3 },
              { champion: "Yone", phase: "first", order: 5 },
              { champion: "Alistar", phase: "second", order: 8 },
              { champion: "Sion", phase: "second", order: 10 }
            ]
          },
          {
            id: "skillcamp",
            name: "Skillcamp",
            side: "red",
            won: true,
            picks: [
              { role: "top", champion: "Ornn", player: "Top", pickOrder: 10 },
              { role: "jungle", champion: "Vi", player: "Jungle", pickOrder: 4 },
              { role: "mid", champion: "Ahri", player: "Mid", pickOrder: 2 },
              { role: "adc", champion: "Kai'Sa", player: "ADC", pickOrder: 6 },
              { role: "support", champion: "Nautilus", player: "Support", pickOrder: 7 }
            ],
            bans: [
              { champion: "Rumble", phase: "first", order: 2 },
              { champion: "Wukong", phase: "first", order: 4 },
              { champion: "Neeko", phase: "first", order: 6 },
              { champion: "Corki", phase: "second", order: 7 },
              { champion: "Jhin", phase: "second", order: 9 }
            ]
          }
        ]
      }
    ]
  };
}
