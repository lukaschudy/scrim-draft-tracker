import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const SOURCE_PATH = path.join(ROOT_DIR, "data", "app", "games.json");
const OUT_DIR = path.join(ROOT_DIR, "public", "data");
const OUT_PATH = path.join(OUT_DIR, "games.json");

if (!existsSync(SOURCE_PATH)) {
  throw new Error(`No local app data found at ${SOURCE_PATH}. Pull/import data locally first.`);
}

const games = JSON.parse(readFileSync(SOURCE_PATH, "utf8"));
if (!Array.isArray(games)) {
  throw new Error(`${SOURCE_PATH} must contain a games array.`);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_PATH, `${JSON.stringify({
  exportedAt: new Date().toISOString(),
  games
}, null, 2)}\n`, "utf8");

console.log(`Exported ${games.length} game(s) to ${OUT_PATH}`);
