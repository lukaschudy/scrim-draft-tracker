# Scrim Data Tracker

Small GRID data scouting setup. This is not the coaching dashboard yet; it is a way to safely pull and inspect what GRID exposes to your account.

## Setup

1. Copy `.env.example` to `.env`.
2. Put your GRID API key in `GRID_API_KEY`.
3. Set `COACHING_PASSWORD` to the password you want for the local web app.
4. If your GRID documentation shows a different GraphQL endpoint, change `GRID_ENDPOINT`.

The key is read from `.env` and `.env` is ignored by git.

For the League of Legends portal, the working production base is:

```env
GRID_API_BASE=https://api.grid.gg
GRID_ENDPOINT=https://api.grid.gg/central-data/graphql
```

## Coaching App

Start the local website:

```bash
npm.cmd start
```

or:

```bash
node server.mjs
```

Open:

```text
http://localhost:4173
```

The login password comes from `COACHING_PASSWORD` in `.env`. If it is not set, the local default is `coach`.

When running through `server.mjs`, the app stores imported normalized games in `data/app/games.json`. When opened as a static site, for example on GitHub Pages, it stores games in browser IndexedDB and disables GRID API pulling. Use **Export backup** regularly to save a portable normalized JSON backup.

Use the Import tab to:

- pull a GRID series/match ID once File Download access is enabled
- update previously pulled GRID series with the Update button
- list GRID files for a series/match ID when you want to inspect available files
- import a returned GRID file URL
- paste JSON manually
- load demo data
- export a backup JSON
- clear stored local data

For manual GRID downloads, import **Grid post series state** first. It contains final teams, champions, result, map, and draft order. **Grid series events** also contains draft order, but it is a history feed and is best used for debugging or if post-state is unavailable.

For accurate lane matching, import **Riot end state summary** after the GRID post-state file. You can select both files in the manual file picker at the same time; the app imports the GRID post-state first, then applies the Riot summary roles. The summary file is small and includes each participant's champion, player name, and assigned matchmaking position, so the app uses it to correct both your lanes and enemy lanes in the stored game.

For accurate blind/counter pick tracking, also include **Riot livestats events game1**. That file contains the player `pickTurn` values used by GRID's champion-select hover. The browser importer extracts only the small `champ_select` and `game_info` snapshots from the JSONL instead of importing the whole 100MB+ event stream.

The Riot livestats file can also be used as a fallback, but it is much larger. Instead of uploading the whole file in the browser, run the streaming helper while the app is open:

```bash
npm run roles:riot -- "manual data saving/events_2961007_1_riot.jsonl"
```

On PowerShell, if `npm` is blocked by execution policy, use:

```powershell
npm.cmd run roles:riot -- "manual data saving/events_2961007_1_riot.jsonl"
```

It reads only until the first useful `champ_select` and `game_info` rows, sends that small snapshot to the app, and skips the rest of the file.

## Static GitHub Pages Mode

The `public/` folder can run as a static local-first dashboard. In that mode:

- manual imports work without the Node server
- games are stored in browser IndexedDB
- export backups are downloaded as normalized JSON
- GRID API pulling is disabled because GitHub Pages cannot protect `GRID_API_KEY`
- login is not real security without a backend

For automatic GRID pulling or shared team data, keep using the Node server or add a backend later.

If GRID does not provide role fields, set player roles in `.env`:

```env
COACHING_PLAYER_ROLES=Vasco:mid,Savero:jungle,SLT:top,Strode:adc,denyk:support
```

## Commands

Check whether the endpoint and API key work:

```bash
npm run grid:health
```

On Windows PowerShell, if `npm` is blocked by execution policy, use either:

```bash
npm.cmd run grid:health
```

or the direct Node command:

```bash
node scripts/grid-scout.mjs health
```

Download the GraphQL schema introspection:

```bash
npm run grid:introspect
```

List schema types:

```bash
npm run grid:types
```

Filter schema types and fields for likely draft data:

```bash
node scripts/grid-scout.mjs types --filter draft
node scripts/grid-scout.mjs types --filter pick
node scripts/grid-scout.mjs types --filter ban
node scripts/grid-scout.mjs types --filter match
```

Pull the latest central series metadata, if your key has Central Data access:

```bash
node scripts/grid-scout.mjs query queries/latest-series.graphql --var first=10 --out data/grid/latest-series.json
```

List raw downloadable files for a GRID series/match ID, if your key has File Download access:

```bash
node scripts/grid-scout.mjs file-list 2961007 --out data/grid/file-list-2961007.json
```

Download one of the returned `fullURL` values:

```bash
node scripts/grid-scout.mjs file-download https://api.grid.gg/file-download/end-state/grid/series/2961007
```

Run a custom query file:

```bash
node scripts/grid-scout.mjs query queries/team-search.graphql --var name=Skillcamp
```

Save any response to a specific file:

```bash
node scripts/grid-scout.mjs query queries/team-search.graphql --var name=Skillcamp --out data/grid/team-search.json
```

## Goal

Once we see the real schema/response shape, we can decide how to pull:

- match list / scrim history
- final picks by role
- pick and ban order
- first and second ban phase
- winner, side, opponent, patch
- whether blind vs counter is possible
