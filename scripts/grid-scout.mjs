import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_ENDPOINT = "https://api.grid.gg/central-data/graphql";
const DEFAULT_API_BASE = "https://api.grid.gg";
const DEFAULT_OUT_DIR = "data/grid";

loadDotEnv();

const args = process.argv.slice(2);
const command = args[0] ?? "help";
const options = parseArgs(args.slice(1));

try {
  switch (command) {
    case "health":
      await health();
      break;
    case "introspect":
      await introspect();
      break;
    case "types":
      await listTypes();
      break;
    case "query":
      await runQuery();
      break;
    case "file-list":
      await fileList();
      break;
    case "file-download":
      await fileDownload();
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      throw new Error(`Unknown command "${command}". Run "node scripts/grid-scout.mjs help".`);
  }
} catch (error) {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
}

async function health() {
  const response = await gridRequest("query GridScoutHealth { __typename }");
  printResponseSummary(response);
  writeJson(options.out ?? defaultOutPath("health"), response);
}

async function introspect() {
  const response = await gridRequest(getIntrospectionQuery());
  printResponseSummary(response);
  writeJson(options.out ?? defaultOutPath("schema-introspection"), response);

  const typeCount = response.data?.__schema?.types?.length ?? 0;
  if (typeCount > 0) {
    console.log(`Schema contains ${typeCount} types.`);
  }
}

async function listTypes() {
  const schema = await getSchema();
  const filter = String(options.filter ?? "").toLowerCase();
  const includeFields = Boolean(filter);
  const types = schema.types
    .filter((type) => !type.name.startsWith("__"))
    .map((type) => ({
      ...type,
      fields: type.fields ?? [],
      inputFields: type.inputFields ?? []
    }))
    .filter((type) => {
      if (!filter) return true;

      const fieldNames = [...type.fields, ...type.inputFields].map((field) => field.name.toLowerCase());
      return type.name.toLowerCase().includes(filter) || fieldNames.some((name) => name.includes(filter));
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  if (types.length === 0) {
    console.log(`No schema types matched "${filter}".`);
    return;
  }

  for (const type of types) {
    console.log(`${type.name}${type.kind ? ` (${type.kind})` : ""}`);

    if (includeFields) {
      const matchingFields = [...type.fields, ...type.inputFields].filter((field) =>
        !filter || field.name.toLowerCase().includes(filter) || type.name.toLowerCase().includes(filter)
      );

      for (const field of matchingFields.slice(0, 30)) {
        console.log(`  - ${field.name}: ${formatType(field.type)}`);
      }
    }
  }

  console.log(`\nMatched ${types.length} type(s).`);
}

async function runQuery() {
  const queryFile = options._[0];
  if (!queryFile) {
    throw new Error("Missing query file. Example: node scripts/grid-scout.mjs query queries/team-search.graphql --var name=Skillcamp");
  }

  const queryPath = path.resolve(queryFile);
  if (!existsSync(queryPath)) {
    throw new Error(`Query file not found: ${queryPath}`);
  }

  const query = readFileSync(queryPath, "utf8");
  const variables = readVariables();
  const response = await gridRequest(query, variables);
  printResponseSummary(response);
  writeJson(options.out ?? defaultOutPath(path.basename(queryFile, path.extname(queryFile))), response);
}

async function fileList() {
  const seriesId = options._[0];
  if (!seriesId) {
    throw new Error("Missing series ID. Example: node scripts/grid-scout.mjs file-list 2961007");
  }

  const response = await gridRestRequest(`${getApiBase()}/file-download/list/${seriesId}`);
  console.log(`File list returned ${response.files?.length ?? 0} file(s).`);
  writeJson(options.out ?? defaultOutPath(`file-list-${seriesId}`), response);
}

async function fileDownload() {
  const fullUrl = options._[0];
  if (!fullUrl) {
    throw new Error("Missing file URL. Use a fullURL from file-list, e.g. node scripts/grid-scout.mjs file-download https://api.grid.gg/file-download/end-state/grid/series/2961007");
  }

  const response = await gridFetch(fullUrl);
  const contentType = response.headers.get("content-type") ?? "";
  const contentDisposition = response.headers.get("content-disposition") ?? "";
  const suggestedName = getDownloadFileName(contentDisposition) ?? path.basename(new URL(fullUrl).pathname) ?? "grid-download";
  const outPath = options.out ?? path.join(DEFAULT_OUT_DIR, suggestedName);

  if (contentType.includes("application/json")) {
    const json = await response.json();
    writeJson(outPath.endsWith(".json") ? outPath : `${outPath}.json`, json);
    return;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const resolvedPath = path.resolve(outPath);
  mkdirSync(path.dirname(resolvedPath), { recursive: true });
  writeFileSync(resolvedPath, buffer);
  console.log(`Wrote ${resolvedPath} (${buffer.length} bytes)`);
}

async function getSchema() {
  const schemaPath = options.schema ?? path.join(DEFAULT_OUT_DIR, "schema-introspection.json");

  if (existsSync(schemaPath)) {
    const cached = JSON.parse(readFileSync(schemaPath, "utf8"));
    const schema = cached.data?.__schema;
    if (schema) return schema;
  }

  const response = await gridRequest(getIntrospectionQuery());
  writeJson(schemaPath, response);

  const schema = response.data?.__schema;
  if (!schema) {
    throw new Error("No GraphQL schema returned. Introspection may be disabled for this GRID endpoint.");
  }

  return schema;
}

async function gridRequest(query, variables = {}) {
  const endpoint = process.env.GRID_ENDPOINT || DEFAULT_ENDPOINT;
  const apiKey = process.env.GRID_API_KEY;
  const apiKeyHeader = process.env.GRID_API_KEY_HEADER || "x-api-key";

  if (!apiKey) {
    throw new Error("GRID_API_KEY is missing. Copy .env.example to .env and add your key.");
  }

  const headers = {
    "Content-Type": "application/json",
    [apiKeyHeader]: apiKey,
    ...readExtraHeaders()
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables })
  });

  const text = await response.text();
  let body;

  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`GRID returned non-JSON response (${response.status} ${response.statusText}): ${text.slice(0, 500)}`);
  }

  if (!response.ok) {
    throw new Error(`GRID request failed (${response.status} ${response.statusText}): ${JSON.stringify(body, null, 2)}`);
  }

  return body;
}

async function gridRestRequest(url) {
  const response = await gridFetch(url);
  const text = await response.text();

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`GRID returned non-JSON response (${response.status} ${response.statusText}): ${text.slice(0, 500)}`);
  }
}

async function gridFetch(url) {
  const apiKey = process.env.GRID_API_KEY;
  const apiKeyHeader = process.env.GRID_API_KEY_HEADER || "x-api-key";

  if (!apiKey) {
    throw new Error("GRID_API_KEY is missing. Copy .env.example to .env and add your key.");
  }

  const response = await fetch(url, {
    headers: {
      [apiKeyHeader]: apiKey,
      ...readExtraHeaders()
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GRID request failed (${response.status} ${response.statusText}): ${text.slice(0, 500)}`);
  }

  return response;
}

function getApiBase() {
  return (process.env.GRID_API_BASE || DEFAULT_API_BASE).replace(/\/$/, "");
}

function getDownloadFileName(contentDisposition) {
  const match = contentDisposition.match(/filename="?([^";]+)"?/i);
  return match?.[1];
}

function readVariables() {
  const variables = {};

  if (options.vars) {
    const varsPath = path.resolve(options.vars);
    Object.assign(variables, JSON.parse(readFileSync(varsPath, "utf8")));
  }

  for (const entry of options.var ?? []) {
    const equalsIndex = entry.indexOf("=");
    if (equalsIndex === -1) {
      throw new Error(`Invalid --var "${entry}". Use --var key=value.`);
    }

    const key = entry.slice(0, equalsIndex);
    const value = entry.slice(equalsIndex + 1);
    variables[key] = parseVariableValue(value);
  }

  return variables;
}

function parseVariableValue(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function readExtraHeaders() {
  if (!process.env.GRID_EXTRA_HEADERS_JSON) return {};

  try {
    return JSON.parse(process.env.GRID_EXTRA_HEADERS_JSON);
  } catch {
    throw new Error("GRID_EXTRA_HEADERS_JSON must be valid JSON.");
  }
}

function writeJson(filePath, data) {
  const resolvedPath = path.resolve(filePath);
  mkdirSync(path.dirname(resolvedPath), { recursive: true });
  writeFileSync(resolvedPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`Wrote ${resolvedPath}`);
}

function defaultOutPath(name) {
  return path.join(DEFAULT_OUT_DIR, `${name}.json`);
}

function printResponseSummary(response) {
  if (response.errors?.length) {
    console.log("GraphQL returned errors:");
    for (const error of response.errors) {
      console.log(`- ${error.message}`);
    }
  } else {
    console.log("GRID request succeeded.");
  }

  if (response.data) {
    console.log(`Top-level data keys: ${Object.keys(response.data).join(", ") || "(none)"}`);
  }
}

function parseArgs(rawArgs) {
  const parsed = { _: [] };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];

    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }

    const withoutPrefix = arg.slice(2);
    const [keyFromArg, valueFromArg] = withoutPrefix.split(/=(.*)/s, 2);
    const key = keyFromArg.replaceAll("-", "_");
    const value = valueFromArg ?? rawArgs[index + 1];

    if (valueFromArg === undefined && (value === undefined || value.startsWith("--"))) {
      parsed[key] = true;
      continue;
    }

    if (valueFromArg === undefined) index += 1;

    if (parsed[key] === undefined) {
      parsed[key] = key === "var" ? [value] : value;
    } else if (Array.isArray(parsed[key])) {
      parsed[key].push(value);
    } else {
      parsed[key] = [parsed[key], value];
    }
  }

  return parsed;
}

function formatType(type) {
  if (!type) return "unknown";
  if (type.kind === "NON_NULL") return `${formatType(type.ofType)}!`;
  if (type.kind === "LIST") return `[${formatType(type.ofType)}]`;
  return type.name ?? type.kind ?? "unknown";
}

function loadDotEnv() {
  const envPath = path.resolve(".env");
  if (!existsSync(envPath)) return;

  const content = readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
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

function printHelp() {
  console.log(`
GRID scout

Commands:
  health
    Sends a tiny GraphQL request and writes data/grid/health.json.

  introspect [--out path]
    Downloads GraphQL schema introspection and writes data/grid/schema-introspection.json.

  types [--filter text] [--schema path]
    Lists GraphQL schema types. With --filter, also prints matching fields.

  query <file.graphql> [--var key=value] [--vars variables.json] [--out path]
    Runs a custom GraphQL query and writes the raw response JSON.

  file-list <seriesId> [--out path]
    Calls the GRID File Download list endpoint for a series/match ID.

  file-download <fullURL> [--out path]
    Downloads a file URL returned by file-list.

Environment:
  GRID_API_KEY           Required.
  GRID_API_BASE          Defaults to ${DEFAULT_API_BASE}
  GRID_ENDPOINT          Defaults to ${DEFAULT_ENDPOINT}
  GRID_API_KEY_HEADER    Defaults to x-api-key.
  GRID_EXTRA_HEADERS_JSON Optional JSON object for extra headers.
`);
}

function getIntrospectionQuery() {
  return `
query GridScoutIntrospection {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      kind
      name
      description
      fields(includeDeprecated: true) {
        name
        description
        isDeprecated
        deprecationReason
        args {
          name
          description
          defaultValue
          type {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
                ofType {
                  kind
                  name
                }
              }
            }
          }
        }
        type {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
              }
            }
          }
        }
      }
      inputFields {
        name
        description
        defaultValue
        type {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
              }
            }
          }
        }
      }
      enumValues(includeDeprecated: true) {
        name
        description
        isDeprecated
        deprecationReason
      }
      possibleTypes {
        kind
        name
      }
    }
  }
}
`;
}
