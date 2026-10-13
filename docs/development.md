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
| `npm run inspect` | Opens the MCP Inspector against the source server |
| `npm run build:mcpb` | Builds `build/crawlmark.mcpb` for Claude Desktop |

`scripts/mcp-list.mjs` starts any install over stdio and prints its tools and prompts, which is a quick smoke test:

```bash
CRAWLMARK_HOME=$(mktemp -d) node scripts/mcp-list.mjs node dist/index.js
```

Tests use fixtures in `test/fixtures/` and never call paid APIs. `scripts/record-fixtures.ts` records raw DataForSEO **sandbox** responses (it refuses the live API); scrub them before committing. To test the setup wizard's Claude registration without touching your real config, set `CRAWLMARK_CLAUDE_DESKTOP_CONFIG` and `CRAWLMARK_CLAUDE_BIN` in the shell.

## Layout

```
src/
  index.ts        entry: no args starts the stdio server; a CLI subcommand, --help or --version runs the CLI
  server.ts       the stdio MCP server
  cli.ts          crawlmark-cli
  scheduled.ts    scheduled audits and traffic checks
  config.ts       config home, env loading and validation, client defaults
  clients.ts      client resolution, discovery sync and clients.yaml edits
  lib/            pure helpers: SQLite store, cache, budgets, URL checks, clients.yaml editing, Claude config
  providers/      one file per data source (gsc, ga4, dataforseo, lighthouse, axe, gtm, render, discovery, google auth)
  analysis/       pure analysis: opportunities, branded split, brand terms, render diff, hygiene, findings, diffs
  reports/        report composers (monthly, audit, site hygiene, gtm), each section isolated
  tools/          MCP tool registrations
  prompts/        MCP prompts; text in templates/*.md, copied to dist/ at build
  setup/          setup wizard, prompts, setup_status checks
mcpb/manifest.json  Claude Desktop bundle manifest
scripts/            build-mcpb, mcp-list, prepublish guard, fixture recorder
test/               vitest tests and fixtures
```

## Adding a data source

1. Add `src/providers/<name>.ts`. Wrap calls in `cached()`, and for paid APIs call `assertBudget()` before and `recordSpend()` after.
2. Register any raw tools in `src/tools/raw.ts`.
3. Pull it into a report composer in `src/reports/` inside a `section()` so a failure doesn't break the report.

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
