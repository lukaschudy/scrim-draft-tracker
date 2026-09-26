import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { normalizeGridPayload, buildImportContext, applyRiotAssignments } from "../server.mjs";

const [mode, argument] = process.argv.slice(2);
const directory = "manual data saving";
const gamesPath = "data/app/games.json";
const publishedPath = "public/data/games.json";
const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function snapshot(file) {
  const input = fs.createReadStream(file);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let draft = null, info = null, firstTimestamp = "";
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      firstTimestamp ||= row.rfc460Timestamp || "";
      if (row.rfc461Schema === "champ_select") draft = row;
      if (row.rfc461Schema === "game_info") { info = row; break; }
    }
  } finally { lines.close(); input.destroy(); }
  return { draft, info, firstTimestamp };
}

async function fingerprint(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return { file, bytes: fs.statSync(file).size, sha256: hash.digest("hex") };
}

if (mode === "prepare") {
  if (!/^\d+$/.test(argument || "")) throw new Error("Usage: node scripts/import-manual-batch.mjs prepare <last-series-id>");
  const names = fs.readdirSync(directory);
  const states = names.filter((name) => /^end_state_\d+_grid\.json$/.test(name) && Number(name.match(/\d+/)[0]) > Number(argument)).sort();
  const batch = { createdAt: new Date().toISOString(), baseline: JSON.parse(fs.readFileSync(gamesPath)), matches: [] };
  const seen = new Set(batch.baseline.map((game) => game.id));
  for (const name of states) {
    const seriesId = name.match(/\d+/)[0];
    const state = JSON.parse(fs.readFileSync(path.join(directory, name))).seriesState;
    if (!state?.games?.length) throw new Error(`Missing GRID games in ${name}`);
    const sourceNames = names.filter((candidate) => candidate === name || new RegExp(`^(events_${seriesId}_\\d+_riot\\.jsonl|end_state_summary_riot_${seriesId}_\\d+\\.json)$`).test(candidate));
    const match = { seriesId, sources: [], games: [], warnings: [] };
    for (const file of sourceNames) match.sources.push(await fingerprint(path.join(directory, file)));
    for (const rawGame of state.games) {
      if (seen.has(String(rawGame.id))) continue;
      const number = rawGame.sequenceNumber || 1;
      const eventsName = `events_${seriesId}_${number}_riot.jsonl`;
      const summaryName = `end_state_summary_riot_${seriesId}_${number}.json`;
      const snap = names.includes(eventsName) ? await snapshot(path.join(directory, eventsName)) : {};
      const summary = names.includes(summaryName) ? JSON.parse(fs.readFileSync(path.join(directory, summaryName))) : null;
      // Summary roles take precedence over the start-of-game snapshot.
      const context = buildImportContext([snap.draft, snap.info, summary].filter(Boolean));
      context.matchType = context.matchType === "unknown" ? "scrim" : context.matchType;
      const normalized = normalizeGridPayload({ seriesState: { ...state, games: [rawGame] } }, name, match.warnings, context);
      for (let game of normalized) {
        game.patch = context.patch || game.patch;
        game.date ||= snap.firstTimestamp || "";
        game.recordStatus = snap.info || summary || rawGame.started || rawGame.finished ? "played" : "draft-only";
        if (game.recordStatus === "played") {
          game = applyRiotAssignments([game], context.assignments, { sourceName: eventsName, patch: context.patch, matchType: context.matchType }).games[0];
        }
        if (game.recordStatus === "draft-only" && snap.draft) {
          game.draftSnapshot = {
            state: snap.draft.gameState,
            players: [...(snap.draft.teamOne || []), ...(snap.draft.teamTwo || [])].map((p) => ({ player: p.summonerName || p.displayName || "", championId: p.championID || null, pickOrder: p.pickTurn || null }))
          };
        }
        game.resultStatus = game.teams.filter((t) => t.won).length === 1 ? "known" : "unknown";
        if (game.recordStatus === "draft-only") { game.resultStatus = "unknown"; game.teams.forEach((t) => { t.won = false; }); }
        if (seen.has(game.id)) throw new Error(`Duplicate game ID ${game.id}`);
        seen.add(game.id);
        match.games.push(game);
      }
    }
    batch.matches.push(match);
    console.log(`Prepared ${seriesId}: ${match.games.length} records, ${match.sources.length} source files`);
  }
  const batchPath = `data/grid/manual-batch-${batch.createdAt.replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(batchPath, JSON.stringify(batch, null, 2) + "\n");
  console.log(`Prepared batch: ${batchPath}`);
} else if (mode === "commit") {
  if (!argument) throw new Error("Pass a prepared batch file");
  if (git("status", "--porcelain")) throw new Error("Commit implementation changes before importing the batch");
  const batch = JSON.parse(fs.readFileSync(argument));
  const baseline = JSON.parse(fs.readFileSync(gamesPath));
  if (JSON.stringify(baseline) !== JSON.stringify(batch.baseline)) throw new Error("Local data changed since preparation");
  const backup = argument.replace(/\.json$/, "-backup");
  fs.mkdirSync(backup, { recursive: true });
  fs.copyFileSync(gamesPath, path.join(backup, "games.json"));
  fs.copyFileSync(publishedPath, path.join(backup, "published-games.json"));
  let games = [...baseline];
  for (const match of batch.matches) {
    for (const source of match.sources) {
      const actual = await fingerprint(source.file);
      if (actual.sha256 !== source.sha256) throw new Error(`Source changed: ${source.file}`);
    }
    games.push(...match.games);
    games.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    fs.writeFileSync(gamesPath, JSON.stringify(games, null, 2) + "\n");
    fs.writeFileSync(publishedPath, JSON.stringify({ exportedAt: batch.createdAt, games }, null, 2) + "\n");
    git("add", "--", publishedPath);
    git("add", "-f", "--", ...match.sources.map((s) => s.file));
    const draftOnly = match.games.every((game) => game.recordStatus === "draft-only");
    console.log(git("commit", "-m", `Import GRID series ${match.seriesId}${draftOnly ? " (draft only, result unknown)" : ""} with original downloads`));
  }
  console.log(`Imported ${batch.matches.length} series; ${games.length} total records. Backup: ${backup}`);
} else {
  throw new Error("Usage: node scripts/import-manual-batch.mjs prepare <last-series-id> | commit <batch.json>");
}
