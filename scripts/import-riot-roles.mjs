import { createReadStream, existsSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

loadDotEnv();

const args = process.argv.slice(2);
const filePath = args[0];
const options = parseArgs(args.slice(1));
const appUrl = String(options.url || "http://localhost:4173").replace(/\/$/, "");

if (!filePath) {
  console.error("Usage: node scripts/import-riot-roles.mjs <riot-jsonl-file> [--url http://localhost:4173]");
  process.exit(1);
}

if (!existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

try {
  const snapshot = await readRiotDraftSnapshot(filePath);
  const session = await login();
  const result = await request("/api/import", {
    method: "POST",
    cookie: session.cookie,
    body: {
      sourceName: path.basename(filePath),
      payload: snapshot.rows
    }
  });

  console.log(`Found champ_select with ${snapshot.pickTurnCount} pick turn(s).`);
  console.log(`Found game_info with ${snapshot.gameInfo?.participants?.length || 0} participant(s).`);
  console.log(`Matched ${result.matchedPicks || 0} stored pick(s). Updated roles on ${result.updatedPicks || 0} pick(s). Updated pick orders on ${result.updatedPickOrders || 0} pick(s). Total stored games: ${result.totalGames}.`);
  if (result.warnings?.length) console.log(`Warnings: ${result.warnings.join(" ")}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

async function readRiotDraftSnapshot(sourcePath) {
  const input = createReadStream(sourcePath, { encoding: "utf8" });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  let champSelect = null;
  let gameInfo = null;

  for await (const line of reader) {
    if (!champSelect && (line.includes('"rfc461Schema":"champ_select"') || line.includes('"rfc461Schema": "champ_select"'))) {
      const row = JSON.parse(line);
      const pickTurnCount = [...(row.teamOne || []), ...(row.teamTwo || [])].filter((participant) => participant.pickTurn).length;
      if (pickTurnCount > 0) champSelect = row;
    }

    if (!gameInfo && (line.includes('"rfc461Schema":"game_info"') || line.includes('"rfc461Schema": "game_info"'))) {
      gameInfo = JSON.parse(line);
    }

    if (champSelect && gameInfo) {
      reader.close();
      input.destroy();
      return {
        rows: [champSelect, gameInfo],
        gameInfo,
        pickTurnCount: [...(champSelect.teamOne || []), ...(champSelect.teamTwo || [])].filter((participant) => participant.pickTurn).length
      };
    }
  }

  if (!gameInfo) throw new Error("No Riot game_info row was found in the selected file.");
  return {
    rows: [gameInfo],
    gameInfo,
    pickTurnCount: 0
  };
}

async function login() {
  const password = process.env.COACHING_PASSWORD || "coach";
  const response = await request("/api/login", {
    method: "POST",
    body: { password },
    includeRaw: true
  });
  const cookie = response.headers["set-cookie"]?.map((item) => item.split(";")[0]).join("; ");
  if (!cookie) throw new Error("Login succeeded but no session cookie was returned.");
  return { cookie };
}

function request(route, { method = "GET", body, cookie, includeRaw = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "";
    const req = http.request(`${appUrl}${route}`, {
      method,
      headers: {
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        ...(cookie ? { Cookie: cookie } : {})
      }
    }, (res) => {
      let text = "";
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () => {
        let data = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          data = { raw: text };
        }

        if (res.statusCode >= 400) {
          reject(new Error(data.error || data.raw || `Request failed: ${res.statusCode}`));
          return;
        }

        resolve(includeRaw ? { data, headers: res.headers } : data);
      });
    });

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;

    const key = value.slice(2);
    const nextValue = values[index + 1];
    if (nextValue && !nextValue.startsWith("--")) {
      parsed[key] = nextValue;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function loadDotEnv() {
  const envPath = path.join(process.cwd(), ".env");
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
