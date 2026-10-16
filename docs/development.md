# Development

Notes for working on crawlmark itself. Users don't need any of this; see the [README](../README.md).

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Runs the server from `src/` with tsx |
| `npm run build` | Compiles to `dist/` and copies the prompt templates |
| `npm start` | Runs `dist/` with Node's SQLite warning silenced |
| `npm run cli -- <command>` | The `crawlmark-cli` admin CLI from `dist/` |
| `npm run typecheck` | Type-checks source and tests |
| `npm test` | vitest unit tests |
| `npm run test:live` | Opt-in live smoke checks against free vendor endpoints, with your own credentials (see below) |
| `npm run inspect` | Opens the MCP Inspector against the source server |
| `npm run build:mcpb` | Builds `build/crawlmark.mcpb` for Claude Desktop |

CI (`.github/workflows/ci.yml`) runs on every push to `main` and every pull request: `npm ci`, typecheck, build and the tests on Ubuntu (Node 22 and 24), macOS and Windows (Node 22); then `scripts/smoke-pack.mjs` packs the package, installs the tarball into an empty folder and starts the installed server and CLI. A separate job writes one DOCX per builtin template and opens each with LibreOffice. The Security workflow (`.github/workflows/security.yml`) runs `npm audit` on production dependencies, gitleaks over the full history (known fake test keys are listed in `.gitleaksignore`) and CodeQL, on pushes, pull requests and weekly. Dependabot (`.github/dependabot.yml`) opens weekly update pull requests for npm packages and the workflow actions.

`scripts/mcp-list.mjs` starts any install over stdio and prints its tools and prompts, which is a quick smoke test:

```bash
CRAWLMARK_HOME=$(mktemp -d) node scripts/mcp-list.mjs node dist/index.js
```

Tests use fixtures in `test/fixtures/` and never call paid APIs. `scripts/record-fixtures.ts` records raw DataForSEO **sandbox** responses (it refuses the live API); scrub them before committing.

### Testing the setup wizard against fake apps

The register step reads and writes real app configs and runs `claude` and `codex`. To try it without touching yours, point these overrides at temp files and fake scripts. They're read from the shell only (never from the home's `.env`) and aren't needed in normal use:

| Variable | Replaces |
|---|---|
| `CRAWLMARK_CLAUDE_BIN` | The `claude` command |
| `CRAWLMARK_CLAUDE_DESKTOP_CONFIG` | Claude Desktop's `claude_desktop_config.json` |
| `CRAWLMARK_CURSOR_CONFIG` | Cursor's `~/.cursor/mcp.json` (its folder is also what detection looks for) |
| `CRAWLMARK_CODEX_BIN` | The `codex` command (a path that doesn't exist makes the wizard use the `config.toml` text edit) |
| `CRAWLMARK_CODEX_CONFIG` | Codex's `config.toml` (default `$CODEX_HOME/config.toml`, else `~/.codex/config.toml`) |

Also set `CRAWLMARK_HOME` to a temp folder, and `HOME` too if `cursor` is on your `PATH`. `test/setup.ts` sets all five (plus `HOME` and `CODEX_HOME`) for every test run, with both binaries pointing at paths that don't exist, so no test can reach a real config or binary.

```bash
T=$(mktemp -d)
printf '#!/bin/sh\nexit 1\n' > "$T/claude"; chmod +x "$T/claude"
CRAWLMARK_HOME=$T/home CRAWLMARK_CLAUDE_BIN=$T/claude CRAWLMARK_CODEX_BIN=$T/no-codex \
  CRAWLMARK_CLAUDE_DESKTOP_CONFIG=$T/desktop/claude_desktop_config.json \
  CRAWLMARK_CURSOR_CONFIG=$T/cursor/mcp.json CRAWLMARK_CODEX_CONFIG=$T/codex/config.toml \
  npm run cli -- init --dry-run
```

For the fancy flow, also set `FORCE_HYPERLINK=1` to see the OSC 8 links in any terminal, and `CRAWLMARK_NO_UPDATE_CHECK=1` to skip the registry request (tests inject the fetch and never make it). The returning-user menu appears when the temp home has a `.env` and a working integration.

The wizard's display goes through `src/setup/ui.ts`: `plainUi` prints the line-by-line text (pipes, CI, `NO_COLOR`, `--yes`), and `src/setup/ui-clack.ts` is the only module that imports `@clack/prompts`.

## Layout

```
src/
  index.ts        entry: no args starts the stdio server; a CLI subcommand, --help or --version runs the CLI
  server.ts       the stdio MCP server
  cli.ts          crawlmark-cli (help text in cli-help.ts)
  scheduled.ts    scheduled audits and traffic checks
  config.ts       config home, env loading and validation, client defaults
  clients.ts      client resolution, discovery sync and clients.yaml edits
  lib/            pure helpers: SQLite store, cache, budgets, URL checks, clients.yaml editing, Claude config
  providers/      one file per data source (gsc, ga4, dataforseo, ahrefs, semrush, lighthouse, axe, gtm, render, discovery,
                  google auth); seo-data.ts routes paid keyword/ranking/competitor/backlink calls to the client's provider
  analysis/       pure analysis: opportunities, branded split, brand terms, render diff, hygiene, findings, diffs
  reports/        report composers (monthly, audit, site hygiene, gtm), each section isolated
  tools/          MCP tool registrations
  prompts/        MCP prompts; text in templates/*.md, copied to dist/ at build
  setup/          setup wizard, prompts, renderers (plain and clack), app registration, setup_status checks
mcpb/manifest.json  Claude Desktop bundle manifest
scripts/            build-mcpb, mcp-list, prepublish guard, fixture recorder
test/               vitest tests and fixtures
```

## Adding a data source

1. Add `src/providers/<name>.ts`. Wrap calls in `cached()`, and for paid APIs call `assertBudget()` before and `recordSpend()` after.
2. Register any raw tools in `src/tools/raw.ts`.
3. Pull it into a report composer in `src/reports/` inside a `section()` so a failure doesn't break the report.

Paid SEO data (keyword volume, ranked keywords, competitors, backlinks) goes through `src/providers/seo-data.ts`, never a provider file directly: it picks the client's provider (`resolveProvider`, a pure truth table), gates DataForSEO-only capabilities (`requireDataForSeo`), and adds `provider` and `units` to every result. Unit-billed providers (Ahrefs, Semrush) use `unitsCall()` from `units-billing.ts` (cache, `assertUnits()` before, `recordUnits()` per request) and a `createLimiter()` from `src/lib/rate.ts`. Keys never go into an error, log, cache key or ledger row: run vendor text through `redact()`.

Tests point the provider base URLs at a closed local port (`test/setup.ts`) and use a temp `CRAWLMARK_HOME`, so a developer's `.env` is never read and no unstubbed call can reach a real API. For a manual check against a fake server, set `AHREFS_BASE_URL` and `SEMRUSH_BASE_URL` in your shell (they're ignored in `.env`).

## Live smoke checks

`npm run test:live` is opt-in and never part of `npm test` or CI. It uses your own credentials from the normal config (`CRAWLMARK_HOME/.env` or the shell) and calls only free endpoints: the Search Console sites list, GA4 account summaries, DataForSEO `/appendix/user_data`, Ahrefs limits-and-usage, the Semrush balance, Bing `GetUserSites`, and one CrUX history query for a public origin. Each check runs the response through the production code, skips with a reason when its credential isn't set, and the run ends with a summary table.

`test/live/guard.ts` wraps `fetch` and throws on any request that isn't on its allowlist, so a paid endpoint can't be reached by mistake. Cache, spend ledger and reports go to a temp folder, not your data. To add an endpoint, it needs vendor documentation saying the call is free.

## Releasing

Nothing here runs automatically.

**npm package.** `prepublishOnly` refuses unless you confirm with `CRAWLMARK_PUBLISH_OK=1`, then deletes and rebuilds `dist/`, type-checks and runs the tests:

```bash
npm login                                              # once
git switch main && git pull                            # release from a clean, merged main
npm version patch                                      # then set the same version in mcpb/manifest.json
CRAWLMARK_PUBLISH_OK=1 npm publish --access public
```

Only `dist/` (no source maps), `README.md`, `.env.example`, `config/clients.example.yaml`, `package.json` and a `LICENSE` file if present are published. The guard is a lifecycle script, so `--ignore-scripts` or publishing a pre-built tarball skips it; do neither. `npm pack` doesn't run the guard and ships whatever `dist/` is on disk, so run `npm run build` first. Check the contents with `npm pack` and `tar tzf crawlmark-mcp-*.tgz`.

**Claude Desktop bundle.** `npm run build:mcpb` stages `dist/`, `package.json` and the production `node_modules` (no Chrome download; unused googleapis clients pruned), adds `mcpb/manifest.json` and zips it to `build/crawlmark.mcpb` (about 41 MB). The official packer works on the same staging directory: `npx @anthropic-ai/mcpb pack build/mcpb-stage build/crawlmark.mcpb`. The manifest follows the [MCPB manifest spec](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md) and is checked by `test/mcpb-manifest.test.ts`. Attach `crawlmark.mcpb` to a GitHub release.
