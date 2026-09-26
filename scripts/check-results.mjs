import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { normalizeGridPayload } from "../server.mjs";

const elements = new Map();
const element = (selector) => {
  if (!elements.has(selector)) elements.set(selector, { innerHTML: "", textContent: "", value: "", querySelectorAll: () => [], classList: { remove() {} } });
  return elements.get(selector);
};
const context = vm.createContext({ document: { querySelector: element }, console });
vm.runInContext(fs.readFileSync("public/app.js", "utf8").replace("bootstrap();", ""), context);
vm.runInContext(`
function fixture(winner, recordStatus = "played", resultSource = "") {
  const our = { id: "ours", name: "Nightbirds", side: "blue", won: winner === "ours", picks: [{ champion: "Ahri", role: "mid", pickOrder: 7 }], bans: [{ champion: "Vi", phase: "first" }] };
  const enemy = { id: "enemy", name: "Other", side: "red", won: winner === "enemy", picks: [{ champion: "Lux", role: "mid", pickOrder: 8 }], bans: [] };
  return { game: { id: winner, date: "2026-09-26", recordStatus, resultSource, teams: [our, enemy] }, our, enemy, enemyPick: enemy.picks[0] };
}
const entries = [fixture("ours"), fixture("enemy"), fixture("unknown"), fixture("ours", "played", "gold-at-12")];
const ctx = { games: entries, totalGames: entries.length, minGames: 1 };
renderMetrics(ctx);
renderChampionPool(ctx);
renderBans(ctx);
renderBlindCounter(ctx);
renderGames({ ...ctx, games: [...entries, fixture("unknown", "draft-only")] });
openChampionDetails("mid", "Ahri", ctx);
`, context);
assert.equal(element("#metric-wr").textContent, "50%");
for (const selector of ["#lane-columns", "#ban-table", "#blind-columns", "#details-content"]) {
  assert.match(element(selector).innerHTML, /50%/);
  assert.doesNotMatch(element(selector).innerHTML, /25%|75%|NaN/);
}
assert.match(element("#games-table").innerHTML, /Unknown/);
assert.match(element("#games-table").innerHTML, /Draft only/);
assert.equal(vm.runInContext('winPercent(0, 0)', context), "—");
assert.equal(vm.runInContext('hasKnownResult(fixture("ours", "draft-only"))', context), false);
const draft = normalizeGridPayload({ seriesState: { id: "1", teams: [], games: [{ id: "draft", started: false, finished: false, teams: [{ id: "a", players: [] }, { id: "b", players: [] }] }] } }, "end_state_1_grid.json", [], { matchType: "scrim" });
assert.equal(draft.length, 1);
assert.equal(draft[0].recordStatus, "draft-only");
assert.equal(draft[0].teams.some((t) => t.won), false);
console.log("Passed: unknown results, inferred results, all WR views, neutral labels, and draft-only preservation.");
