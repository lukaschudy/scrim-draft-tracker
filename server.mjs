import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const APP_DATA_DIR = path.join(__dirname, "data", "app");
const GAMES_PATH = path.join(APP_DATA_DIR, "games.json");
const PULLS_PATH = path.join(APP_DATA_DIR, "grid-pulls.json");
const RAW_IMPORT_DIR = path.join(APP_DATA_DIR, "raw");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

loadDotEnv();
ensureDataFiles();

const PORT = Number(process.env.PORT || 4173);
const PASSWORD = process.env.COACHING_PASSWORD || "coach";
const TEAM_NAME = process.env.COACHING_TEAM_NAME || "Nightbirds";
const GRID_TEAM_ID = process.env.GRID_TEAM_ID || "54472";
const GRID_TITLE_ID = process.env.GRID_TITLE_ID || "3";
const GRID_SCRIMS_FROM = process.env.GRID_SCRIMS_FROM || "2026-03-25T00:00:00Z";
const SESSION_SECRET = process.env.SESSION_SECRET || randomBytes(32).toString("hex");

const server = http.createServer(async (req, res) => {
  try {
    if (req.url?.startsWith("/api/")) {
      await handleApi(req, res);
      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Internal server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Coaching tool running at http://localhost:${PORT}`);
});

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readJsonBody(req);
    if (!body.password || body.password !== PASSWORD) {
      sendJson(res, 401, { error: "Wrong password" });
      return;
    }

    setSessionCookie(res);
    sendJson(res, 200, { ok: true, teamName: TEAM_NAME });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/session") {
    sendJson(res, 200, { authenticated: isAuthenticated(req), teamName: TEAM_NAME });
    return;
  }

  if (!isAuthenticated(req)) {
    sendJson(res, 401, { error: "Login required" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    sendJson(res, 200, {
      teamName: TEAM_NAME,
      games: readGames(),
      grid: {
        endpoint: process.env.GRID_ENDPOINT || "https://api.grid.gg/central-data/graphql",
        apiBase: process.env.GRID_API_BASE || "https://api.grid.gg",
        hasApiKey: Boolean(process.env.GRID_API_KEY)
      },
      pulledSeries: readPulledSeries()
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/import") {
    const body = await readJsonBody(req, 200_000_000);
    const result = importPayloadToStore(body.payload ?? body, body.sourceName || "manual import");
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/api/games") {
    writeGames([]);
    sendJson(res, 200, { ok: true, totalGames: 0 });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/grid/health") {
    const result = await gridGraphql("query GridHealth { __typename }");
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/grid/file-list/")) {
    const seriesId = decodeURIComponent(url.pathname.replace("/api/grid/file-list/", ""));
    const result = await gridRest(`/file-download/list/${seriesId}`);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/grid/pull-series/")) {
    const seriesId = decodeURIComponent(url.pathname.replace("/api/grid/pull-series/", ""));
    const result = await pullGridSeries(seriesId);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/grid/scrims") {
    const first = clampInt(url.searchParams.get("first"), 1, 50, 50);
    const pages = clampInt(url.searchParams.get("pages"), 1, 30, 1);
    const result = await findGridScrims({
      first,
      pages,
      after: url.searchParams.get("after") || null,
      from: normalizeGridDateTime(url.searchParams.get("from") || GRID_SCRIMS_FROM)
    });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/grid/pull-new-scrims") {
    const body = await readJsonBody(req);
    const limit = clampInt(body.limit, 1, 1000, 3);
    const pages = clampInt(body.pages, 1, 30, 3);
    const result = await pullNewGridScrims({ limit, pages, from: normalizeGridDateTime(body.from || GRID_SCRIMS_FROM) });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/grid/update-pulled-series") {
    const result = await updatePulledGridSeries();
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/grid/import-file") {
    const body = await readJsonBody(req);
    if (!body.url || typeof body.url !== "string") {
      sendJson(res, 400, { error: "Missing GRID file URL" });
      return;
    }

    const filePayload = await gridDownloadPayload(body.url, body.fileName || "");
    const result = importPayloadToStore(filePayload, body.fileName || body.url);
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestedPath));

  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
    sendText(res, 404, "Not found");
    return;
  }

  const ext = path.extname(filePath);
  res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
  res.end(readFileSync(filePath));
}

function normalizeImport(payload, sourceName, context = {}) {
  const warnings = [];
  const gridGames = normalizeGridPayload(payload, sourceName, warnings, context);
  if (gridGames.length > 0) {
    return { games: gridGames, warnings };
  }

  const gamesInput = Array.isArray(payload) ? payload : payload.games || payload.series || payload.matches || [payload];
  const games = [];

  for (const item of gamesInput) {
    const game = normalizeGame(item, sourceName, warnings);
    if (game) games.push(game);
  }

  if (games.length === 0) {
    warnings.push("No games were detected. Use a payload with a games array, or paste a GRID post-game state once file access works.");
  }

  return { games, warnings };
}

function importPayloadToStore(payload, sourceName, context = {}) {
  const importContext = context.assignments?.length ? context : buildImportContext(payloadListForImport(payload));
  const roleAssignments = extractRiotRoleAssignments(payload);
  const pickOrderAssignments = extractRiotPickOrderAssignments(payload);
  const riotPatch = extractRiotPatch(payload);
  const riotMatchType = extractRiotMatchType(payload);
  const hasGridState = collectGridSeriesStates(payload).length > 0;

  if (!hasGridState && (roleAssignments.length > 0 || pickOrderAssignments.length > 0)) {
    const result = applyRiotAssignments(readGames(), mergeRiotAssignments(roleAssignments, pickOrderAssignments), { patch: riotPatch, matchType: riotMatchType });
    writeGames(result.games);
    saveRawImport({
      sourceName,
      riotPatch,
      riotMatchType,
      roleAssignments,
      pickOrderAssignments,
      updatedGames: result.updatedGames,
      updatedPicks: result.updatedPicks,
      updatedPickOrders: result.updatedPickOrders,
      updatedPatches: result.updatedPatches,
      updatedMatchTypes: result.updatedMatchTypes
    }, sourceName);

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

  const imported = normalizeImport(payload, sourceName, importContext);
  const games = upsertGames(readGames(), imported.games);
  writeGames(games);
  saveRawImport(payload, sourceName);

  return {
    importedGames: imported.games.length,
    updatedGames: 0,
    matchedPicks: 0,
    updatedPicks: 0,
    updatedPickOrders: 0,
    updatedPatches: 0,
    updatedMatchTypes: 0,
    warnings: imported.warnings,
    totalGames: games.length
  };
}

function normalizeGridPayload(payload, sourceName, warnings, context = {}) {
  const seriesStates = collectGridSeriesStates(payload);
  return seriesStates.flatMap((seriesState) => normalizeGridSeriesState(seriesState, sourceName, warnings, context));
}

function collectGridSeriesStates(payload) {
  if (!payload) return [];

  if (payload.seriesState?.games) {
    return [payload.seriesState];
  }

  if (Array.isArray(payload?.files)) {
    return payload.files.flatMap((file) => collectGridSeriesStates(file.payload));
  }

  if (Array.isArray(payload) && payload.some((row) => row?.events)) {
    const latest = latestSeriesStateFromGridEvents(payload);
    return latest ? [latest] : [];
  }

  if (Array.isArray(payload)) {
    return payload.flatMap((item) => collectGridSeriesStates(item));
  }

  return [];
}

function latestSeriesStateFromGridEvents(rows) {
  let latest = null;

  for (const row of rows) {
    for (const event of row.events || []) {
      if (event.seriesState?.games?.length) {
        latest = event.seriesState;
      }
      if (event.target?.state?.games?.length) {
        latest = event.target.state;
      }
    }
  }

  return latest;
}

function normalizeGridSeriesState(seriesState, sourceName, warnings, context = {}) {
  const seriesTeamsById = new Map((seriesState.teams || []).map((team) => [String(team.id), team]));
  const assignmentsByPlayer = new Map((context.assignments || []).map((assignment) => [playerKey(assignment.player), assignment]));
  const games = [];

  for (const gameState of seriesState.games || []) {
    if (!gameState?.teams?.length) continue;

    const draftActions = normalizeGridDraftActions(gameState.draftActions || []);
    const teams = gameState.teams.map((team, teamIndex) => {
      const seriesTeam = seriesTeamsById.get(String(team.id)) || {};
      const side = normalizeSide(team.side || sideFromTeamIndex(teamIndex));
      const picks = (team.players || []).map((player, playerIndex) => {
        const assignment = assignmentsByPlayer.get(playerKey(player.name));
        const champion = readChampion(player.character || player.champion) || assignment?.champion || "";
        if (!champion) return null;

        const pickAction = draftActions.find((action) =>
          action.type === "pick" &&
          action.teamId === String(team.id) &&
          action.champion.toLowerCase() === champion.toLowerCase()
        );

        return {
          champion,
          championId: assignment?.championId || null,
          role: normalizeRole(getPlayerRoleOverride(player.name, team.name || seriesTeam.name) || assignment?.role || player.role || player.lane || player.playerRole || roleFromIndex(playerIndex)),
          player: player.name || "",
          pickOrder: pickAction?.order ?? assignment?.pickOrder ?? null,
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

    const gridMatchType = inferGridMatchType(seriesState, gameState);
    games.push({
      id: String(gameState.id || `${seriesState.id || sourceName}-game-${gameState.sequenceNumber || games.length + 1}`),
      sourceName,
      date: gameState.startedAt || seriesState.startedAt || "",
      patch: normalizePatchVersion(gameState.gameVersion || gameState.patch || gameState.version || seriesState.gameVersion || seriesState.patch || seriesState.version || context.patch),
      matchType: gridMatchType !== "unknown" ? gridMatchType : normalizeMatchType(context.matchType),
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

      return {
        order,
        type: actionType,
        teamId,
        side: "",
        champion,
        phase: normalizePhase(null, order)
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.order - b.order);
}

function normalizeGame(input, sourceName, warnings) {
  if (!input || typeof input !== "object") return null;

  const teams = normalizeTeams(input);
  if (teams.length === 0) {
    warnings.push(`Skipped ${input.id || sourceName}: no teams found.`);
    return null;
  }

  const id = String(input.id || input.gameId || input.matchId || input.seriesId || input.series?.id || `import-${Date.now()}-${Math.random()}`);
  const draftActions = normalizeDraftActions(input);

  if (draftActions.length > 0) {
    applyDraftOrders(teams, draftActions);
  }

  return {
    id,
    sourceName,
    date: input.date || input.startedAt || input.startTimeScheduled || input.startTime || input.createdAt || "",
    patch: normalizePatchVersion(input.patch || input.gameVersion || input.version),
    matchType: normalizeMatchType(input.matchType || inferRiotMatchType(input)),
    tournament: readName(input.tournament) || input.tournamentName || "",
    map: readName(input.map) || input.mapName || "",
    teams,
    draftActions,
    rawImportedAt: new Date().toISOString()
  };
}

function normalizeTeams(input) {
  const teamCandidates = input.teams || input.participants || input.sides || input.game?.teams || input.seriesState?.teams || [];
  if (!Array.isArray(teamCandidates)) return [];

  return teamCandidates.map((team, index) => {
    const base = team.baseInfo || team.team || team;
    const side = normalizeSide(team.side || team.color || team.alignment || (index === 0 ? "blue" : "red"));
    const picks = normalizePicks(team, side);
    const bans = normalizeBans(team, side);

    return {
      id: String(base.id || team.id || team.teamId || side || index),
      name: base.name || team.name || team.teamName || `Team ${index + 1}`,
      side,
      won: Boolean(team.won ?? team.isWinner ?? team.winner ?? false),
      score: team.score ?? null,
      picks,
      bans
    };
  });
}

function normalizePicks(team, side) {
  const direct = team.picks || team.champions || team.selectedChampions || team.draft?.picks;
  const players = team.players || team.lineup || team.roster;
  const source = Array.isArray(direct) && direct.length ? direct : players || [];

  if (!Array.isArray(source)) return [];

  return source
    .map((entry, index) => {
      const champion = readChampion(entry.champion || entry.character || entry.entity || entry.pick || (typeof entry === "string" ? entry : ""));
      if (!champion) return null;

      return {
        champion,
        role: normalizeRole(entry.role || entry.position || entry.lane || entry.playerRole || roleFromIndex(index)),
        player: readName(entry.player) || entry.playerName || entry.name || "",
        pickOrder: numberOrNull(entry.pickOrder ?? entry.order ?? entry.sequenceNumber),
        side
      };
    })
    .filter(Boolean);
}

function normalizeBans(team, side) {
  const source = team.bans || team.draft?.bans || team.bannedChampions || [];
  if (!Array.isArray(source)) return [];

  return source
    .map((entry, index) => {
      const champion = readChampion(entry.champion || entry.character || entry.entity || entry.ban || entry);
      if (!champion) return null;

      const order = numberOrNull(entry.order ?? entry.banOrder ?? entry.sequenceNumber ?? index + 1);
      return {
        champion,
        phase: normalizePhase(entry.phase || entry.banPhase, order),
        order,
        side
      };
    })
    .filter(Boolean);
}

function normalizeDraftActions(input) {
  const source = input.draftActions || input.draft?.actions || input.actions || input.pickBanActions || [];
  if (!Array.isArray(source)) return [];

  return source
    .map((action, index) => {
      const type = String(action.type || action.actionType || action.kind || "").toLowerCase();
      const actionType = type.includes("ban") ? "ban" : type.includes("pick") ? "pick" : "";
      const champion = readChampion(action.champion || action.character || action.entity || action);
      if (!actionType || !champion) return null;

      const order = numberOrNull(action.order ?? action.sequenceNumber ?? action.actionOrder ?? index + 1);
      return {
        order,
        type: actionType,
        teamId: String(action.teamId || action.team?.id || action.side || ""),
        side: normalizeSide(action.side || action.teamSide || ""),
        champion,
        phase: normalizePhase(action.phase, order)
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}

function applyDraftOrders(teams, actions) {
  for (const team of teams) {
    for (const pick of team.picks) {
      const action = actions.find((item) =>
        item.type === "pick" &&
        item.champion.toLowerCase() === pick.champion.toLowerCase() &&
        (item.teamId === team.id || item.side === team.side || !item.teamId)
      );
      if (action) pick.pickOrder = action.order;
    }

    for (const ban of team.bans) {
      const action = actions.find((item) =>
        item.type === "ban" &&
        item.champion.toLowerCase() === ban.champion.toLowerCase() &&
        (item.teamId === team.id || item.side === team.side || !item.teamId)
      );
      if (action) {
        ban.order = action.order;
        ban.phase = action.phase;
      }
    }
  }
}

function upsertGames(existingGames, newGames) {
  const byId = new Map(existingGames.map((game) => [game.id, game]));
  for (const game of newGames) byId.set(game.id, game);
  return [...byId.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function extractRiotRoleAssignments(payload) {
  const rows = Array.isArray(payload) ? payload : [payload];
  const assignmentsByKey = new Map();

  for (const row of rows) {
    if (Array.isArray(row?.files)) {
      for (const assignment of row.files.flatMap((file) => extractRiotRoleAssignments(file.payload))) {
        assignmentsByKey.set(playerKey(assignment.player), assignment);
      }
    }

    if (Array.isArray(row?.roleAssignments)) {
      for (const assignment of row.roleAssignments) {
        if (assignment?.player) assignmentsByKey.set(playerKey(assignment.player), assignment);
      }
    }

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

      const assignment = {
        player,
        champion,
        championId: numberOrNull(participant.championId ?? participant.championID),
        championKey: championKey(champion),
        participantId: String(participant.participantID || participant.participantId || ""),
        puuid: participant.puuid || "",
        role,
        teamId: String(participant.teamID || participant.teamId || "")
      };
      assignmentsByKey.set(playerKey(player), assignment);
    }
  }

  return [...assignmentsByKey.values()];
}

function extractRiotPickOrderAssignments(payload) {
  const rows = Array.isArray(payload) ? payload : [payload];
  const assignmentsByKey = new Map();

  for (const row of rows) {
    if (Array.isArray(row?.files)) {
      for (const assignment of row.files.flatMap((file) => extractRiotPickOrderAssignments(file.payload))) {
        assignmentsByKey.set(playerKey(assignment.player), assignment);
      }
    }

    if (Array.isArray(row?.pickOrderAssignments)) {
      for (const assignment of row.pickOrderAssignments) {
        if (assignment?.player) assignmentsByKey.set(playerKey(assignment.player), assignment);
      }
    }

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

      assignmentsByKey.set(playerKey(player), {
        player,
        pickOrder,
        puuid: participant.puuid || ""
      });
    }
  }

  return [...assignmentsByKey.values()];
}

function extractRiotPatch(payload) {
  const rows = Array.isArray(payload) ? payload : [payload];
  for (const row of rows) {
    if (Array.isArray(row?.files)) {
      const patch = extractRiotPatch(row.files.map((file) => file.payload));
      if (patch) return patch;
    }
    if (row?.riotPatch) return row.riotPatch;
    const patch = normalizePatchVersion(row?.gameVersion || row?.game_version || row?.game?.gameVersion || row?.metadata?.gameVersion);
    if (patch) return patch;
  }
  return "";
}

function extractRiotMatchType(payload) {
  const rows = Array.isArray(payload) ? payload : [payload];
  for (const row of rows) {
    if (Array.isArray(row?.files)) {
      const matchType = extractRiotMatchType(row.files.map((file) => file.payload));
      if (matchType !== "unknown") return matchType;
    }
    if (row?.riotMatchType) return normalizeMatchType(row.riotMatchType);
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
  const assignmentChampionKeys = new Set(assignments.map((assignment) => assignment.championKey).filter(Boolean));
  const warnings = [];
  let updatedPicks = 0;
  let updatedPickOrders = 0;
  let updatedPatches = 0;
  let updatedMatchTypes = 0;
  let matchedPicks = 0;
  const updatedGameIds = new Set();

  const nextGames = games.map((game) => {
    const gameScore = scoreGameForRiotAssignments(game, byPlayer, assignmentChampionKeys);
    if (!shouldApplyRiotAssignments(gameScore, assignments)) return game;

    let gameChanged = false;
    let gameMatchedPicks = 0;
    const teams = (game.teams || []).map((team) => {
      let teamChanged = false;
      const picks = (team.picks || []).map((pick) => {
        const pickChampionKey = championKey(pick.champion);
        const playerAssignment = byPlayer.get(playerKey(pick.player));
        const playerAssignmentMatches = playerAssignment && (
          !playerAssignment.championKey ||
          playerAssignment.championKey === pickChampionKey ||
          championLooksInvalid(pick.champion, pick.player)
        );
        const assignment = playerAssignmentMatches ? playerAssignment : byChampion.get(pickChampionKey);
        if (!assignment) return pick;

        matchedPicks += 1;
        gameMatchedPicks += 1;
        const nextPick = { ...pick };
        let pickChanged = false;

        if (assignment.champion && championLooksInvalid(nextPick.champion, nextPick.player)) {
          nextPick.champion = assignment.champion;
          pickChanged = true;
        }

        if (assignment.role && pick.role !== assignment.role) {
          nextPick.role = assignment.role;
          nextPick.roleSource = "riot-roles";
          updatedPicks += 1;
          pickChanged = true;
        }

        const nextChampionKey = championKey(nextPick.champion);
        const assignmentMatchesChampion = !assignment.championKey || assignment.championKey === nextChampionKey;

        if (assignment.championId && assignmentMatchesChampion && pick.championId !== assignment.championId) {
          nextPick.championId = assignment.championId;
          pickChanged = true;
        }

        if (assignment.pickOrder && assignmentMatchesChampion && pick.pickOrder !== assignment.pickOrder) {
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
      gameChanged = true;
      updatedPatches += 1;
    }
    if (riotMatchType !== "unknown" && gameMatchedPicks > 0 && normalizeMatchType(game.matchType) !== riotMatchType) {
      gameChanged = true;
      updatedMatchTypes += 1;
    }

    if (gameChanged) {
      updatedGameIds.add(game.id);
      return {
        ...game,
        patch: riotPatch && gameMatchedPicks > 0 ? riotPatch : game.patch,
        matchType: riotMatchType !== "unknown" && gameMatchedPicks > 0 ? riotMatchType : normalizeMatchType(game.matchType),
        teams,
        roleUpdatedAt: new Date().toISOString()
      };
    }
    return game;
  });

  if (matchedPicks === 0) {
    warnings.push("Riot role data was detected, but no stored picks matched. Import the GRID post series state first, then import the Riot livestats file for that game.");
  }

  return {
    games: nextGames,
    updatedGames: updatedGameIds.size,
    matchedPicks,
    updatedPicks,
    updatedPickOrders,
    updatedPatches,
    updatedMatchTypes,
    warnings
  };
}

function scoreGameForRiotAssignments(game, byPlayer, assignmentChampionKeys) {
  let championMatches = 0;
  let playerMatches = 0;

  for (const team of game.teams || []) {
    for (const pick of team.picks || []) {
      if (assignmentChampionKeys.has(championKey(pick.champion))) championMatches += 1;
      if (byPlayer.has(playerKey(pick.player))) playerMatches += 1;
    }
  }

  return { championMatches, playerMatches };
}

function shouldApplyRiotAssignments(score, assignments) {
  const championAssignmentCount = assignments.filter((assignment) => assignment.championKey).length;
  if (championAssignmentCount > 0) {
    return score.championMatches >= Math.min(5, championAssignmentCount);
  }
  return score.playerMatches >= Math.min(8, assignments.length);
}

function championLooksInvalid(champion, player) {
  const key = championKey(champion);
  return !key || key === "unknown" || key === playerKey(player);
}

function cleanInvalidChampionGames(games) {
  return games.filter((game) => !hasMostlyInvalidChampionNames(game));
}

function hasMostlyInvalidChampionNames(game) {
  const picks = (game.teams || []).flatMap((team) => team.picks || []);
  if (picks.length === 0) return false;
  const invalidPicks = picks.filter((pick) => championLooksInvalid(pick.champion, pick.player));
  return invalidPicks.length >= Math.max(5, Math.ceil(picks.length * 0.5));
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
  if (role.includes("middle")) return "mid";
  if (role.includes("mid")) return "mid";
  if (role.includes("bot") || role.includes("marksman") || role.includes("carry")) return "adc";
  if (role.includes("sup") || role.includes("util")) return "support";
  return role || "unknown";
}

function cleanRiotPlayerName(value) {
  return String(value || "")
    .replace(/^(SC|NBS|NB|SKILLCAMP|NIGHTBIRDS)\s+/i, "")
    .trim();
}

function playerKey(value) {
  return cleanRiotPlayerName(value).toLowerCase();
}

function championKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function roleFromIndex(index) {
  return ["top", "jungle", "mid", "adc", "support"][index] || "unknown";
}

function getPlayerRoleOverride(playerName, teamName = "") {
  const raw = process.env.COACHING_PLAYER_ROLES || "";
  if (!raw || !playerName) return "";

  const playerKey = playerName.toLowerCase();
  const teamPlayerKey = `${teamName}/${playerName}`.toLowerCase();

  for (const entry of raw.split(",")) {
    const [rawKey, rawRole] = entry.split(":").map((part) => part?.trim());
    if (!rawKey || !rawRole) continue;

    const key = rawKey.toLowerCase();
    if (key === playerKey || key === teamPlayerKey) return rawRole;
  }

  return "";
}

function sideFromTeamIndex(index) {
  return index === 0 ? "blue" : "red";
}

function normalizeSide(value) {
  const side = String(value || "").toLowerCase();
  if (side.includes("blue")) return "blue";
  if (side.includes("red")) return "red";
  if (side.includes("home")) return "blue";
  if (side.includes("away")) return "red";
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

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function normalizeGridDateTime(value) {
  const raw = String(value || "").trim();
  if (!raw) return GRID_SCRIMS_FROM;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T00:00:00Z`;
  return raw;
}

async function gridGraphql(query, variables = {}) {
  const response = await fetch(process.env.GRID_ENDPOINT || "https://api.grid.gg/central-data/graphql", {
    method: "POST",
    headers: gridHeaders(true),
    body: JSON.stringify({ query, variables })
  });
  return parseGridResponse(response);
}

async function gridRest(pathname) {
  const response = await fetch(`${(process.env.GRID_API_BASE || "https://api.grid.gg").replace(/\/$/, "")}${pathname}`, {
    headers: gridHeaders(false)
  });
  return parseGridResponse(response);
}

async function pullGridSeries(seriesId) {
  const list = await gridRest(`/file-download/list/${seriesId}`);
  const files = Array.isArray(list.files) ? list.files : [];
  const readyFiles = files.filter((file) => String(file.status || "").toLowerCase() === "ready" && file.fullURL);
  const selectedFiles = selectGridImportFiles(readyFiles);

  if (selectedFiles.length === 0) {
    throw new Error(`GRID returned no ready importable files for series ${seriesId}.`);
  }

  const results = [];
  const downloadedFiles = [];
  for (const file of selectedFiles) {
    try {
      const filePayload = await gridDownloadPayload(file.fullURL, file.fileName || "");
      downloadedFiles.push({ file, payload: filePayload });
    } catch (error) {
      results.push({
        file,
        result: emptyImportResult([error.message])
      });
    }
  }

  const context = buildImportContext(downloadedFiles.map((item) => item.payload));

  for (const item of downloadedFiles) {
    try {
      results.push({
        file: item.file,
        result: importPayloadToStore(item.payload, item.file.fileName || item.file.id || item.file.fullURL, context)
      });
    } catch (error) {
      results.push({
        file: item.file,
        result: emptyImportResult([error.message])
      });
    }
  }

  recordPulledSeries(seriesId, selectedFiles[0]);

  return {
    seriesId,
    selectedFile: selectedFiles[0],
    importedFiles: results.map((item) => ({
      id: item.file.id,
      fileName: item.file.fileName,
      description: item.file.description,
      ...item.result
    })),
    availableFiles: files,
    importedGames: sumResults(results, "importedGames"),
    updatedGames: sumResults(results, "updatedGames"),
    matchedPicks: sumResults(results, "matchedPicks"),
    updatedPicks: sumResults(results, "updatedPicks"),
    updatedPickOrders: sumResults(results, "updatedPickOrders"),
    updatedPatches: sumResults(results, "updatedPatches"),
    updatedMatchTypes: sumResults(results, "updatedMatchTypes"),
    warnings: results.flatMap((item) => item.result.warnings || []),
    totalGames: readGames().length
  };
}

function buildImportContext(payloads) {
  const roleAssignments = payloads.flatMap((payload) => extractRiotRoleAssignments(payload));
  const pickOrderAssignments = payloads.flatMap((payload) => extractRiotPickOrderAssignments(payload));
  return {
    assignments: mergeRiotAssignments(roleAssignments, pickOrderAssignments),
    patch: payloads.map((payload) => extractRiotPatch(payload)).find(Boolean) || "",
    matchType: payloads.map((payload) => extractRiotMatchType(payload)).find((matchType) => matchType !== "unknown") || "unknown"
  };
}

function payloadListForImport(payload) {
  if (Array.isArray(payload?.files)) return payload.files.map((file) => file.payload).filter(Boolean);
  if (Array.isArray(payload)) return payload;
  return [payload];
}

function emptyImportResult(warnings = []) {
  return {
    importedGames: 0,
    updatedGames: 0,
    matchedPicks: 0,
    updatedPicks: 0,
    updatedPickOrders: 0,
    updatedPatches: 0,
    updatedMatchTypes: 0,
    warnings,
    totalGames: readGames().length
  };
}

async function findGridScrims({ first = 50, pages = 1, after = null, from = GRID_SCRIMS_FROM } = {}) {
  const series = [];
  let cursor = after;
  let pageInfo = null;
  let totalCount = 0;

  for (let page = 0; page < pages; page += 1) {
    const response = await gridGraphql(`
query GridScrims($first: Int!, $after: String, $teamId: ID!, $titleId: ID!, $from: String!) {
  allSeries(
    first: $first
    after: $after
    filter: {
      titleId: $titleId
      teamId: $teamId
      types: SCRIM
      startTimeScheduled: { gte: $from }
      workflowStatuses: [PUBLISHED]
    }
    orderBy: StartTimeScheduled
    orderDirection: DESC
  ) {
    totalCount
    pageInfo {
      hasNextPage
      endCursor
    }
    edges {
      node {
        id
        startTimeScheduled
        type
        workflowStatus
        private
        title { id name nameShortened }
        tournament { id name nameShortened }
        format { id name nameShortened }
        teams { baseInfo { id name } scoreAdvantage }
      }
    }
  }
}
`, {
      first,
      after: cursor,
      teamId: GRID_TEAM_ID,
      titleId: GRID_TITLE_ID,
      from
    });

    const connection = response.data?.allSeries;
    if (!connection) break;

    totalCount = connection.totalCount || totalCount;
    pageInfo = connection.pageInfo || null;
    series.push(...(connection.edges || []).map((edge) => normalizeGridSeriesSummary(edge.node)));
    cursor = pageInfo?.endCursor || null;
    if (!pageInfo?.hasNextPage || !cursor) break;
  }

  const pulled = new Set(readPulledSeries().map((item) => String(item.seriesId)));
  return {
    totalCount,
    teamId: GRID_TEAM_ID,
    titleId: GRID_TITLE_ID,
    from,
    series: series.map((item) => ({ ...item, pulled: pulled.has(String(item.id)) })),
    pageInfo
  };
}

async function pullNewGridScrims({ limit = 3, pages = 3, from = GRID_SCRIMS_FROM } = {}) {
  const pulled = new Set(readPulledSeries().map((item) => String(item.seriesId)));
  const discovered = await findGridScrims({ first: 50, pages, from });
  const targets = discovered.series.filter((item) => !pulled.has(String(item.id)));
  const results = [];
  let pulledSeries = 0;

  for (const series of targets) {
    try {
      const result = await pullGridSeries(series.id);
      results.push({ series, result });
      pulledSeries += 1;
      if (pulledSeries >= limit) break;
    } catch (error) {
      results.push({
        series,
        result: {
          seriesId: series.id,
          importedGames: 0,
          updatedGames: 0,
          matchedPicks: 0,
          updatedPicks: 0,
          updatedPickOrders: 0,
          updatedPatches: 0,
          updatedMatchTypes: 0,
          warnings: [error.message],
          totalGames: readGames().length
        }
      });
    }
  }

  return {
    discovered: discovered.series.length,
    totalCount: discovered.totalCount,
    from,
    skippedAlreadyPulled: discovered.series.filter((item) => pulled.has(String(item.id))).length,
    attemptedSeries: results.length,
    pulledSeries,
    results,
    importedGames: results.reduce((sum, item) => sum + (item.result.importedGames || 0), 0),
    updatedGames: results.reduce((sum, item) => sum + (item.result.updatedGames || 0), 0),
    matchedPicks: results.reduce((sum, item) => sum + (item.result.matchedPicks || 0), 0),
    updatedPicks: results.reduce((sum, item) => sum + (item.result.updatedPicks || 0), 0),
    updatedPickOrders: results.reduce((sum, item) => sum + (item.result.updatedPickOrders || 0), 0),
    updatedPatches: results.reduce((sum, item) => sum + (item.result.updatedPatches || 0), 0),
    updatedMatchTypes: results.reduce((sum, item) => sum + (item.result.updatedMatchTypes || 0), 0),
    warnings: results.flatMap((item) => item.result.warnings || []),
    totalGames: readGames().length
  };
}

function normalizeGridSeriesSummary(series) {
  return {
    id: String(series?.id || ""),
    startTimeScheduled: series?.startTimeScheduled || "",
    type: series?.type || "",
    workflowStatus: series?.workflowStatus || "",
    private: Boolean(series?.private),
    title: series?.title || null,
    tournament: series?.tournament || null,
    format: series?.format || null,
    teams: (series?.teams || []).map((team) => ({
      id: String(team?.baseInfo?.id || ""),
      name: team?.baseInfo?.name || "",
      scoreAdvantage: team?.scoreAdvantage ?? null
    }))
  };
}

async function updatePulledGridSeries() {
  const pulledSeries = readPulledSeries();
  if (pulledSeries.length === 0) {
    throw new Error("No GRID series have been pulled yet. Pull one series ID first, then Update can repull it.");
  }

  const results = [];
  for (const item of pulledSeries) {
    try {
      results.push(await pullGridSeries(item.seriesId));
    } catch (error) {
      results.push({
        seriesId: item.seriesId,
        importedGames: 0,
        warnings: [error.message],
        totalGames: readGames().length
      });
    }
  }

  return {
    updatedSeries: results.length,
    importedGames: results.reduce((sum, item) => sum + item.importedGames, 0),
    updatedGames: results.reduce((sum, item) => sum + (item.updatedGames || 0), 0),
    matchedPicks: results.reduce((sum, item) => sum + (item.matchedPicks || 0), 0),
    updatedPicks: results.reduce((sum, item) => sum + (item.updatedPicks || 0), 0),
    updatedPickOrders: results.reduce((sum, item) => sum + (item.updatedPickOrders || 0), 0),
    updatedPatches: results.reduce((sum, item) => sum + (item.updatedPatches || 0), 0),
    updatedMatchTypes: results.reduce((sum, item) => sum + (item.updatedMatchTypes || 0), 0),
    warnings: results.flatMap((item) => item.warnings || []),
    totalGames: readGames().length,
    results
  };
}

function selectGridImportFiles(files) {
  return files
    .filter((file) => {
      const id = String(file.id || "").toLowerCase();
      const name = String(file.fileName || "").toLowerCase();
      if (id === "state-grid" || name.includes("end_state") && name.includes("grid")) return true;
      if (id.includes("state-summary-riot") || name.includes("summary") && name.includes("riot")) return true;
      if (id.includes("events-riot") || name.includes("events") && name.includes("riot")) return true;
      return false;
    })
    .sort((a, b) => gridImportPriority(a) - gridImportPriority(b) || String(a.fileName || a.id).localeCompare(String(b.fileName || b.id)));
}

function gridImportPriority(file) {
  const id = String(file.id || "").toLowerCase();
  const name = String(file.fileName || "").toLowerCase();
  if (id === "state-grid" || name.includes("end_state") && name.includes("grid")) return 0;
  if (id.includes("state-summary-riot") || name.includes("summary") && name.includes("riot")) return 1;
  if (id.includes("events-riot") || name.includes("events") && name.includes("riot")) return 2;
  return 9;
}

function sumResults(results, key) {
  return results.reduce((sum, item) => sum + (item.result[key] || 0), 0);
}

async function gridDownloadPayload(fullUrl, fileNameHint = "") {
  const response = await fetch(fullUrl, { headers: gridHeaders(false) });
  if (!response.ok) {
    throw new Error(`GRID ${response.status}: ${await response.text()}`);
  }

  const contentDisposition = response.headers.get("content-disposition") || "";
  const fileName = fileNameHint || getDownloadFileName(contentDisposition) || path.basename(new URL(fullUrl).pathname);
  const contentType = response.headers.get("content-type") || "";
  const buffer = Buffer.from(await response.arrayBuffer());

  if (contentType.includes("zip") || fileName.endsWith(".zip")) {
    const entries = extractZipEntries(buffer)
      .filter((entry) => entry.fileName.endsWith(".json") || entry.fileName.endsWith(".jsonl"))
      .map((entry) => ({
        fileName: entry.fileName,
        payload: parseTextPayload(entry.content.toString("utf8"), entry.fileName)
      }));

    if (entries.length === 1) return entries[0].payload;
    return { files: entries };
  }

  return parseTextPayload(buffer.toString("utf8"), fileName);
}

async function parseGridResponse(response) {
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message = typeof data === "object" ? data.message || data.error || data.raw || JSON.stringify(data) : String(data);
    throw new Error(`GRID ${response.status}: ${message}`);
  }

  return data;
}

function gridHeaders(isJson) {
  const apiKey = process.env.GRID_API_KEY;
  if (!apiKey) throw new Error("GRID_API_KEY is missing in .env");
  return {
    ...(isJson ? { "Content-Type": "application/json" } : {}),
    [process.env.GRID_API_KEY_HEADER || "x-api-key"]: apiKey
  };
}

function parseTextPayload(text, fileName) {
  const trimmed = text.trim();
  if (!trimmed) return {};
  const lowerFileName = String(fileName || "").toLowerCase();

  if (isRiotEventsFile(fileName, trimmed)) {
    return parseRiotEventsSnapshot(trimmed);
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    if (lines.length > 1 || lowerFileName.endsWith(".jsonl")) {
      return lines.map((line) => JSON.parse(line));
    }
    return { raw: text };
  }
}

function isRiotEventsFile(fileName, text = "") {
  const name = String(fileName || "").toLowerCase();
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

function extractZipEntries(buffer) {
  const endOfCentralDirectory = findEndOfCentralDirectory(buffer);
  if (endOfCentralDirectory === -1) throw new Error("Downloaded ZIP could not be read.");

  const entryCount = buffer.readUInt16LE(endOfCentralDirectory + 10);
  let offset = buffer.readUInt32LE(endOfCentralDirectory + 16);
  const entries = [];

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;

    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer.slice(offset + 46, offset + 46 + fileNameLength).toString("utf8");

    const localFileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
    const compressed = buffer.slice(dataStart, dataStart + compressedSize);
    const content = compressionMethod === 8 ? inflateRawSync(compressed) : compressed;
    entries.push({ fileName, content });

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function findEndOfCentralDirectory(buffer) {
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function getDownloadFileName(contentDisposition) {
  const match = contentDisposition.match(/filename="?([^";]+)"?/i);
  return match?.[1];
}

function readGames() {
  const games = JSON.parse(readFileSync(GAMES_PATH, "utf8"));
  const cleanedGames = cleanInvalidChampionGames(games);
  if (cleanedGames.length !== games.length) writeGames(cleanedGames);
  return cleanedGames;
}

function writeGames(games) {
  writeFileSync(GAMES_PATH, `${JSON.stringify(games, null, 2)}\n`, "utf8");
}

function readPulledSeries() {
  return JSON.parse(readFileSync(PULLS_PATH, "utf8"));
}

function writePulledSeries(pulledSeries) {
  writeFileSync(PULLS_PATH, `${JSON.stringify(pulledSeries, null, 2)}\n`, "utf8");
}

function recordPulledSeries(seriesId, selectedFile) {
  const pulledSeries = readPulledSeries();
  const nextItem = {
    seriesId: String(seriesId),
    lastPulledAt: new Date().toISOString(),
    selectedFileId: selectedFile?.id || "",
    selectedFileName: selectedFile?.fileName || ""
  };
  const existingIndex = pulledSeries.findIndex((item) => item.seriesId === String(seriesId));
  if (existingIndex >= 0) pulledSeries[existingIndex] = nextItem;
  else pulledSeries.push(nextItem);
  writePulledSeries(pulledSeries);
}

function saveRawImport(payload, sourceName) {
  mkdirSync(RAW_IMPORT_DIR, { recursive: true });
  const safeName = sourceName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "import";
  const filePath = path.join(RAW_IMPORT_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeName}.json`);
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function ensureDataFiles() {
  mkdirSync(APP_DATA_DIR, { recursive: true });
  if (!existsSync(GAMES_PATH)) writeFileSync(GAMES_PATH, "[]\n", "utf8");
  if (!existsSync(PULLS_PATH)) writeFileSync(PULLS_PATH, "[]\n", "utf8");
}

function setSessionCookie(res) {
  const payload = Buffer.from(JSON.stringify({ sub: "coach", exp: Date.now() + 7 * 24 * 60 * 60 * 1000 })).toString("base64url");
  const signature = sign(payload);
  res.setHeader("Set-Cookie", `coach_session=${payload}.${signature}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "coach_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

function isAuthenticated(req) {
  const token = parseCookies(req).coach_session;
  if (!token) return false;

  const [payload, signature] = token.split(".");
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return false;

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return session.sub === "coach" && session.exp > Date.now();
  } catch {
    return false;
  }
}

function sign(value) {
  return createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(header.split(";").map((cookie) => {
    const [key, ...value] = cookie.trim().split("=");
    return [key, value.join("=")];
  }).filter(([key]) => key));
}

async function readJsonBody(req, limit = 2_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Request body is too large");
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}
