<!--
Status: draft (ready to splice)
Created: 2026-10-13 14:00
Author: my-skills:planner, branch phase-8-plan
Owner: backend
Reasoning: the user wants an add-mcp style installer, four-app registration, readable status and help, and a Tag Manager name-match fix.
Research: none in docs/research/. Library facts were checked live on 2026-10-13 (npm registry; @clack/prompts 1.8.1 source; Context7 docs for Codex CLI and Cursor).
Supersedes: none

Lives in specs/ (my-skills convention); implementation.md links to it.
-->

## Phase 8: Premium installer

**Status:** planned 2026-10-13 14:00 (planner, branch `phase-8-plan`). Owner: backend, for every file below. Builds on Phase 6s. No MCP tool's input or output shape changes.

Goal: `npx crawlmark-mcp@latest init` should feel like installing any well-made MCP. That means an intro banner, arrow-key choices, masked secrets, a spinner while each credential is checked live, and one clean result line per check. A multi-select registers crawlmark with every AI app it finds (Claude Code, Claude Desktop, Cursor, Codex), and a summary box at the end lists next steps. `setup status` and `--help` become readable at 80 to 100 columns. The phase also includes one Tag Manager discovery fix.

Non-goals: publishing to npm, registry listings (Smithery and the like), Windows-specific testing, new integrations, and any change to `--json` output shapes. Paths stay cross-platform through `node:path` and the existing per-OS helpers.

### 8.1 What the user sees

On a TTY (fancy mode). Values are placeholders; secrets are never shown.

```
$ npx crawlmark-mcp@latest init
┌  crawlmark 0.1.0  SEO audits for Claude, Cursor and Codex
│
◇  Config home: ~/.crawlmark (new)
◇  Node v22.13.1  OK (installed package, nothing to build)
│
◆  DataForSEO  keyword volumes, rankings, competitors, backlinks
│  Set it up now?  ● Yes / ○ No
◇  Which API?  Sandbox (free sample data, recommended to start)
◇  API login  you@example.com
◇  API password  ••••••••••••
◒  Checking with DataForSEO (sandbox.dataforseo.com)…
◇  ✔ DataForSEO works  sandbox, balance $1.00. Saved to ~/.crawlmark/.env (0600)
│
◆  Google  Search Console, GA4, Tag Manager
│  ○ A. OAuth, Google Workspace  ● B. OAuth, personal Gmail  ○ C. Service account
│  ... (same Google steps as today; a spinner while the key or sign-in is checked)
◇  ✔ Google  12 Search Console sites, 9 GA4 properties, 4 Tag Manager containers
◇  PageSpeed key (optional)  Skipped
◒  Discovering clients…
◇  ✔ 11 clients saved to ~/.crawlmark/config/clients.yaml
│
◆  Add crawlmark to which apps?  (space toggles, enter confirms)
│  ◼ Claude Code     found
│  ◼ Claude Desktop  found
│  ◻ Cursor
│  ◼ Codex           found
│
◇  Claude Desktop: add this entry (2 other servers kept unchanged)
│    { "command": "/usr/local/bin/node", "args": ["…/dist/index.js"], "env": { "CRAWLMARK_HOME": "<hidden>" } }
◇  Write it? A backup is kept as .bak  Yes
◇  ✔ Claude Code     registered (user scope)
◇  ✔ Claude Desktop  updated. Restart Claude Desktop
◇  ✔ Codex           registered
│
╭─ crawlmark is ready ─────────────────────────────────────────────╮
│  ✔ Node   ✔ DataForSEO   ✔ Google   ○ PageSpeed (skipped)         │
│  ✔ Clients 11   ✔ Claude Code   ✔ Claude Desktop   ✔ Codex        │
│                                                                  │
│  Next:                                                           │
│    1. Restart Claude Desktop                                     │
│    2. In Claude, run the getting-started prompt                  │
│    3. Change one step: npx crawlmark-mcp setup --step google     │
╰──────────────────────────────────────────────────────────────────╯
└  Done
```

When a check fails, the wizard prints a ✖ line with the reason and asks again, keeping today's three attempts. For DataForSEO the line is `✖ DataForSEO rejected that login and password. Use the API password from the API access page, not your account password.` Ctrl-C at any prompt prints `Setup cancelled. Anything already saved stays saved; re-run setup any time.` and exits 130.

Plain mode applies when input is piped, or when `CI=true`, `TERM=dumb`, `NO_COLOR` or `--yes` is set. It runs the same steps with today's wording, line by line: no colour, no cursor movement, numbered choices, and one `Checking with DataForSEO…` line in place of each spinner. App selection becomes `Register with: Claude Code, Codex (detected). Use these? [Y/n]`. Secrets keep today's zero-echo raw-mode input.

`setup status` (both modes; colour only on a TTY without `NO_COLOR`):

```
crawlmark status   home ~/.crawlmark (installed package)

✔ Config home    ~/.crawlmark/.env
✔ DataForSEO     sandbox, balance $1.00
✖ Google         Google rejected the key: invalid_grant. The key may have been
                 deleted in Google Cloud.
                 → npx crawlmark-mcp setup --step google
● Tag Manager    Signed in, but no containers are visible. Add the account in
                 Tag Manager > Admin > User Management.
                 → https://tagmanager.google.com/
○ PageSpeed key  Not set (optional)
                 → npx crawlmark-mcp setup --step psi

5 working · 1 needs attention · 1 error · 2 not set up
```

### 8.2 Decisions

1. **Prompt library: `@clack/prompts` 1.8.1, with no colour library.**
   - It is MIT licensed, released 2026-09-13, ESM, needs Node >= 20.12, and is about 94 KB unpacked. Its five small dependencies are also MIT: `@clack/core`, `sisteransi`, `fast-wrap-ansi`, `fast-string-width` and `fast-string-truncated-width`.
   - It has every piece the walkthrough needs: `intro`, `outro`, `select`, `multiselect` (with `initialValues`), `password` (with a mask), `spinner`, `note`, `box`, `log` and `isCancel`. It is what create-* and add-mcp style installers use.
   - **picocolors is not added.** Clack already colours through Node's built-in `util.styleText`, which honours `NO_COLOR`, `FORCE_COLOR` and non-TTY streams. The few colours outside clack (status icons, help headings) use `styleText` too; it is stable in Node 22.13, the project minimum.
   - Rejected: `inquirer` (heavier, with its own render loop), `prompts` (unmaintained) and `ink` (a React runtime for a wizard).
   - `@clack/prompts` and `smol-toml` (decision 4) are the only new runtime dependencies. Listing them here covers the "ask before adding a dependency" rule.
2. **Two renderers behind one interface.**
   - The wizard keeps talking to `Prompter`, plus a new `Ui`: intro, step heading, `spin(label, fn)`, success/fail/warn/info lines, change preview, summary box and outro.
   - `plainUi` with `terminalPrompter` reproduces today's text exactly. `clackUi` with `clackPrompter` gives the fancy mode.
   - A pure `chooseRenderer({ stdinTTY, stdoutTTY, env, yes })` picks fancy only when both streams are TTYs and none of these applies: `CI` set to any non-empty value except `false` or `0`, `TERM=dumb`, a non-empty `NO_COLOR`, or `--yes`.
   - Only `src/setup/ui-clack.ts` imports clack, so the plain path and every test stay free of it.
   - Fancy secrets use clack's `password` with a `•` mask. The user asked for masked input; the mask reveals the length and nothing else. Plain secrets keep zero echo.
3. **`init` is an alias of `setup`** (the wizard with no subcommand), with the same flags: `--step`, `--dry-run` and `--yes`. The only difference is wording: the intro says "init". `setup status`, `setup migrate` and every flag keep working unchanged. `init` is added to `CLI_SUBCOMMANDS` in `src/lib/entry.ts` so `npx crawlmark-mcp init` runs the CLI.
4. **Codex: run `codex mcp add` when the binary works; otherwise make a guarded text edit.** Codex's CLI owns its file format, so it is preferred, following the Claude Code path. The commands are `codex mcp add <name> --env K=V -- <command> <args>`, `codex mcp get <name> --json` and `codex mcp remove <name>`.
   - CLI path:
     1. Show the command, with env values as `<hidden>`.
     2. Compare with `codex mcp get --json` first. As in `registerClaudeCode`, the existing entry is the same, different or unreadable.
     3. Ask.
     4. Before running `add` or `remove`, copy `config.toml` to `config.toml.bak` (0600) ourselves.
   - Text-edit path, used when no working binary exists but the Codex config directory does (the IDE extension or desktop app without the CLI on PATH):
     - Parse the whole file with `smol-toml`, pinned to `1.9.0` (BSD-3-Clause, released 2026-09-22; 1.9.1 is under two weeks old). If the TOML is invalid, refuse and write nothing.
     - The crawlmark entry must be absent, or exactly a `[mcp_servers.crawlmark]` header plus an optional `[mcp_servers.crawlmark.env]` sub-table. Any other spelling (an inline table under `[mcp_servers]`, dotted keys, a quoted name, an array of tables) means refuse and print the snippet to paste.
     - Replace that span: from the header through the line before the next `[` header that isn't a `crawlmark` sub-table. If there is no entry, append one at the end, after one blank line. Every other byte, comments included, stays untouched.
     - Re-parse the result and check two things: every other `mcp_servers` entry and every top-level key is deep-equal to before, and `mcp_servers.crawlmark` equals the intended entry. If either check fails, abort without writing.
     - Show only the crawlmark block (env values as `<hidden>`) and the other servers' names, never their config. Write atomically, keep a 0600 `.bak`, and keep the existing file mode.
   - Config path: `$CODEX_HOME/config.toml`, else `~/.codex/config.toml`.
5. **Cursor: the same JSON merge as Claude Desktop.**
   - The global config is `~/.cursor/mcp.json` (Cursor docs, checked 2026-10-13). Each entry is `mcpServers.<name>` with `type: "stdio"`, `command`, `args` and `env`.
   - `mergeDesktopConfig` becomes a generic `mergeMcpServersJson(existing, entry, { app })`, whose error messages name the app. `writeDesktopConfig` becomes `writeConfigWithBackup`.
   - The old names stay as thin wrappers so existing tests keep passing.
6. **Launch command per app.**
   - Claude Code keeps `node`, because it inherits the shell PATH.
   - Claude Desktop, Cursor and Codex get the absolute node path (`process.execPath`), because GUI apps don't load the shell PATH.
   - From an npx cache, all four get `npx -y crawlmark-mcp`, as `serverLaunch` does today. The GUI apps get the absolute `npx` beside node.
   - `CRAWLMARK_HOME` goes in `env` when the home isn't the project root, as today.
7. **Detection.** It only decides which apps are pre-ticked in the multi-select; it never writes.

   | App | Detected when | Config / command |
   |---|---|---|
   | Claude Code | `claude --version` exits 0 | `claude mcp get/add/remove` (existing) |
   | Claude Desktop | the config file or its directory exists (existing rule) | `claudeDesktopConfigPath()` |
   | Cursor | `~/.cursor` exists, or `cursor` is on PATH | `~/.cursor/mcp.json` |
   | Codex | `codex --version` exits 0, or the Codex config directory exists | `codex mcp …`, else `config.toml` |

   - An app already registered with the same command is shown as `already set up` and pre-ticked. Confirming it again changes nothing.
   - Unticked apps are left alone.
   - If nothing is ticked, the wizard prints the snippets for all four apps, as today's fallback does: the Claude Code command, the `mcpServers` JSON and the Codex TOML block.
   - Under `--yes`, the detected apps are registered. A different existing registration is never replaced, because the replace question defaults to no, as today.
8. **Test-only overrides, read from the shell env only.** They go through the existing `fromShell` and are ignored when they come from the home's `.env`.
   - Existing: `CRAWLMARK_CLAUDE_BIN` and `CRAWLMARK_CLAUDE_DESKTOP_CONFIG`.
   - New: `CRAWLMARK_CURSOR_CONFIG` (the path to `mcp.json`; its directory is also used for detection), `CRAWLMARK_CODEX_BIN` and `CRAWLMARK_CODEX_CONFIG` (the path to `config.toml`).
   - They are documented in `docs/development.md` only.
9. **Short next-step commands.** A pure `commandPrefix({ checkout, cliOnPath, homeSource, homeDir, defaultHomeDir })` replaces `cliInvocation()` for display.
   - The prefix depends on how crawlmark was installed:
     - a source checkout gives `npm run cli --`;
     - an installed package with `crawlmark-cli` on PATH (a global install) gives `crawlmark-cli`;
     - anything else gives `npx crawlmark-mcp`.
   - `CRAWLMARK_HOME=<dir>` is added in front only when the home came from the env and differs from the default for this install (the project root for a checkout, `~/.crawlmark` otherwise). `~` replaces the user's home in the printed path.
   - `setup_status`'s `cli` and `next` fields keep their names and types and carry these shorter strings.
   - In a checkout, the human output adds one line, `Run commands from <project root>`, because `npm run cli` needs that directory.
10. **Status renderer.** A pure `renderStatus(report, { width, color, unicode, prefix })`.
    - Width is `stdout.columns` clamped to 60..100, or 80 when stdout isn't a TTY.
    - Each row has a 16-column label, with the detail word-wrapped under it.
    - `→ <next>` goes on its own line, only when the state isn't `working`.
    - Icons: `✔` working, `●` configured (needs attention), `✖` error, `○` missing. When `TERM=dumb` or the locale isn't UTF-8, the ASCII forms `[ok] [!] [x] [ ]` are used instead.
    - A one-line footer gives the counts.
    - Long tokens (URLs, paths) are never broken mid-token. A token longer than the column overflows its line instead.
11. **Help.**
    - Top-level `--help` lists commands in groups with one-line descriptions and examples.
    - The current long text moves to per-group help, so no detail is lost: `crawlmark-cli help setup` or `crawlmark-cli setup --help`, and likewise for `auth`, `clients`, `competitors`, `keywords`, `brand`, `audit` and `check-traffic`.
    - The program name (`crawlmark-mcp` or `crawlmark-cli`) comes from `argv[1]`.
    - Group headings are bold via `styleText`, only when stdout is a TTY. Every line is at most 80 columns.
    - Usage errors still go to stderr and keep their exit codes: 2, or 1 for `audit` and `check-traffic`.

    ```
    crawlmark: SEO audits and client reports for Claude, Cursor and Codex

    Usage: crawlmark-mcp <command> [options]   (no command: start the MCP server)

    Get started
      init                  Set up credentials and clients, register your AI apps
      setup --step <name>   Re-run one step: node, dataforseo, google, psi,
                            discovery or register
      setup status          What's configured and what to do next
      setup migrate --to    Copy your settings to another folder
    Google
      auth login|status|logout
    Clients
      clients, competitors, keywords, brand   Manage clients and their lists
    Scheduled
      audit, check-traffic  Run from cron; exit 2 means alerts

    Examples
      npx crawlmark-mcp@latest init
      npx crawlmark-mcp setup status
      npx crawlmark-mcp clients add example.com --name "Example Co"

    Run `crawlmark-mcp help <command>` for a command's options.
    ```
12. **Tag Manager name fallback** in `joinGtmContainers` (`src/lib/gtm.ts`).
    - After the domain-list pass, a web container with an empty domain list becomes a name candidate when `normalizeHost(name)` gives a host containing a dot.
    - A host already matched by any container's domain list keeps that match. Name candidates for it become neither a match nor an alternate, and stay in `unmatched`.
    - When several name candidates share a host, the lowest `GTM-` ID wins and the others become alternates, as for domains.
    - `GtmMatch` gains `matchedBy: "domain" | "name"`.
    - `gtmNotes` adds a note for each name match whose host isn't pinned: `Tag Manager: matched GTM-XXXX "www.example.com/" to example.com by its name (the container lists no domains). If that's wrong, pin another with gtmContainerId in clients.yaml.`
    - The "list no domain" note now shows each container as `GTM-XXXX "name" (account 123, container 456)`, so the numeric `containerId` can be pinned.
    - Pins in `clients.yaml` still win, because `planSync` already never overwrites them.

### 8.3 Files (all backend)

| File | Change |
|---|---|
| `package.json`, `package-lock.json` | add `@clack/prompts@^1.8.1` and `smol-toml@1.9.0` |
| `src/setup/ui.ts` (new) | `Ui` interface, `plainUi`, `chooseRenderer`, and `recordingUi` for tests |
| `src/setup/ui-clack.ts` (new) | `clackUi` and `clackPrompter` (the only importer of clack); `isCancel` → `PromptAbortedError` |
| `src/setup/prompter.ts` | `multiselect` on `Prompter`. Terminal: a comma list, or Enter for the defaults. Auto: the defaults |
| `src/setup/apps.ts` (new) | app ids, `detectApps(ctx)`, one register function per app (Claude Code and Desktop moved out of `wizard.ts`, Cursor and Codex new), and the snippets fallback |
| `src/setup/wizard.ts` | `WizardContext` gains `ui` and the Cursor/Codex paths and binaries. Steps report through `ui`, with spinners around live checks. `stepRegister` uses `apps.ts`. Adds the summary box |
| `src/setup/cli-setup.ts` | `init`, renderer choice, the new overrides in `realWizardContext`, and status rendering via `status-render.ts` |
| `src/setup/status-render.ts` (new) | `renderStatus` and `wrapText` (pure) |
| `src/setup/status-providers.ts` | `commandPrefix` (pure) replaces `cliInvocation`/`cliBase` for display |
| `src/lib/claude-config.ts` | generic `mergeMcpServersJson`, `writeConfigWithBackup`, `cursorConfigPath` and the Cursor entry; the old names stay as wrappers |
| `src/lib/codex-config.ts` (new) | `codexConfigPath`, `codexAddArgs`, `parseCodexMcpGet`, `planCodexTomlEdit` (pure) and `describeCodexChange` |
| `src/cli.ts`, `src/cli-help.ts` (new) | grouped help and per-group help text; `init` routed to `setupCommand` |
| `src/lib/entry.ts` | `init` in `CLI_SUBCOMMANDS` |
| `src/lib/gtm.ts`, `src/lib/clients.ts` | name fallback, `matchedBy` and notes |
| `test/setup.ts` | point `HOME`, `CODEX_HOME` and every `CRAWLMARK_*` app override at the temp dir, and both binary overrides at a path that doesn't exist, so no test can reach a real config or binary |
| `test/*.test.ts` | see 8.5 |
| `README.md`, `docs/development.md` | `init` as the first install command, the four apps and the new status look; the overrides go in the development doc only |

### 8.4 Tasks

One agent (backend) does all of these. Each is its own commit; tasks marked independent can land in any order.

1. **Tag Manager fix** (independent). Item 12, with tests in `test/gtm.test.ts`. Can ship first.
2. **Test isolation** (before tasks 4 to 7). The `test/setup.ts` changes from 8.3.
3. **Short commands and status renderer** (independent of tasks 4 to 7). Items 9 and 10.
4. **Config writers** (after 2). The `mergeMcpServersJson`/`writeConfigWithBackup` refactor, the Cursor path and entry, and `codex-config.ts` with its pure TOML planner. Adds `smol-toml`.
5. **UI layer** (after 2). Adds `@clack/prompts`, plus `ui.ts`, `ui-clack.ts`, `Prompter.multiselect` and `chooseRenderer`.
6. **Register step** (after 4 and 5). `apps.ts`, detection, the multi-select, the per-app flows and the snippets fallback.
7. **Wizard polish and `init`** (after 5).
   - Spinners around the DataForSEO, PSI, key-file, status and discovery checks.
   - Success and fail lines, and the summary box with next steps.
   - The `init` alias in `cli-setup.ts`, `cli.ts` and `entry.ts`.
8. **Help** (independent). Item 11.
9. **Docs and manual check** (last). Update the README and `docs/development.md`. Then run the manual checks in **Done when**, using a temp `CRAWLMARK_HOME`, temp app configs through the overrides, and fake `claude`/`codex` scripts.

### 8.5 Test plan

Every test uses injected I/O, temp dirs and fake binaries. No test reads or writes a real config or runs a real `claude` or `codex`.

- **Renderer choice and UI.**
  - `chooseRenderer`: fancy only with two TTYs and none of `CI`, `TERM=dumb`, `NO_COLOR` or `--yes`; `CI=false` doesn't count.
  - `plainUi`: today's wizard tests pass unchanged, because plain output is byte-for-byte the current text.
  - `clackPrompter`: the cancel symbol becomes `PromptAbortedError`, `multiselect` passes `initialValues`, and secrets go through `password`. Clack's functions are injected, so no TTY is needed.
- **Prompter.** `Prompter.multiselect`, terminal and auto: Enter takes the defaults, comma lists and names parse, unknown names ask again, and `autoPrompter` returns the defaults.
- **Detection.** `detectApps` follows each rule in decision 7, using the overrides and a fake `exec`.
- **Register.**
  - For each app, four cases: new; identical; different (replace defaults to no, and `--yes` never replaces); unreadable.
  - Unticked apps are left alone.
  - Nothing ticked prints all four snippets.
  - A dry run writes nothing and runs nothing but `--version` and `get`.
- **Cursor JSON.**
  - Other servers and keys are kept.
  - Invalid JSON, a non-object file and a non-object `mcpServers` are refused.
  - The `.bak` has mode 0600.
  - Output shows other servers by name only, with env values as `<hidden>`.
- **Codex TOML planner.**
  - Fixtures include comments, other servers holding secrets, CRLF line endings and a missing trailing newline.
  - Cases: append; replace, with and without an `.env` sub-table; a sub-table followed by another server.
  - Refusal for invalid TOML and for each unsupported spelling.
  - The post-parse equality guard.
  - Comment bytes are preserved exactly.
  - No other server's values appear in any printed line: a sentinel secret never shows up in `ui` output.
- **Codex CLI path.** `codexAddArgs` puts the name first, then the `--env` pairs, then `--`. `parseCodexMcpGet` handles a sample. The `.bak` is taken before `add` or `remove`.
- **`commandPrefix`.** Checkout, global install and npx. `CRAWLMARK_HOME` shows only when it isn't the default, with `~` substituted.
- **`renderStatus`.**
  - At width 80 no line exceeds 80 columns (measured without ANSI codes), for a report with a long path, a long URL and a 300-character detail.
  - No colour when `color: false`.
  - ASCII icons when unicode is off.
  - `→` appears only on rows that aren't working.
  - The footer counts are right.
- **Help.**
  - Every top-level help line is at most 80 columns.
  - Each group's help contains every flag the old `USAGE` text listed for it, checked against a fixture of the old flag names.
  - `init --help` and `help init` work.
- **Entry.** `entryAction`/`CLI_SUBCOMMANDS`: `init` dispatches to the CLI.
- **Tag Manager.**
  - A container with an empty domain list matches by name: `www.example.com` and `www.example.com/` both match `example.com`.
  - A domain-list match beats a name match for the same host.
  - Two name matches for one host give one alternate.
  - Names without a dot, or with spaces, stay unmatched.
  - The unmatched note includes `container <id>`.
  - Pinned hosts get no matched-by-name note.
  - `planSync` never overwrites a pin with a name match.

**Done when**

- [ ] `npm run typecheck` and `npm test` pass.
- [ ] `test/setup.ts` sets `HOME`, `CODEX_HOME` and all five overrides, and `npm test` leaves the mtimes of `~/.claude.json`, the Claude Desktop config, `~/.cursor/mcp.json` and `~/.codex/config.toml` unchanged (compare `stat` before and after).
- [ ] `npm ls --omit=dev @clack/prompts smol-toml` shows `@clack/prompts@1.8.x` and `smol-toml@1.9.0`, and `picocolors` is not a direct dependency.
- [ ] `npm run cli -- init --dry-run` works in a real terminal with a temp `CRAWLMARK_HOME`, temp app configs through the overrides, and fake `claude`/`codex` scripts. It shows the intro, arrow-key selects, a masked password, a spinner per live check, the four-app multi-select with detected apps ticked, and the summary box, and it writes nothing.
- [ ] The same run without `--dry-run` writes the Claude Desktop and Cursor JSON, and the Codex TOML through both paths: the fake `codex` CLI, and the text edit with `CRAWLMARK_CODEX_BIN` pointing nowhere. Each file gets a 0600 `.bak`. A comment and a second server in the TOML fixture survive byte-for-byte. A second run reports every app as already set up.
- [ ] `npm run cli -- init < /dev/null`, `CI=true npm run cli -- init` and `NO_COLOR=1 npm run cli -- init` give the plain text flow with no escape codes (`| cat -v` shows no `^[`).
- [ ] `npm run cli -- setup --yes`, `setup --step register`, `setup --dry-run`, `setup migrate --to <tmp> --dry-run` and `setup status --json --only dataforseo` behave as before. The JSON keys are unchanged: `jq 'keys'` matches the Phase 6s output.
- [ ] `npm run cli -- setup status` at `COLUMNS=80` has no line over 80 characters, and with the default home its next steps read `npm run cli -- setup --step <x>` with no `CRAWLMARK_HOME=`.
- [ ] `npm run cli -- --help` is grouped, under 80 columns, with examples. `help setup` lists `--step`, `--dry-run`, `--yes`, `--json`, `--only`, `--refresh`, `--to` and `--force`.
- [ ] A fixture-driven `list_clients` test matches a container named `www.example.com/` with no domain list to `example.com` and says so in its notes, and the no-domain note shows the numeric container ID.
- [ ] The README's install section starts with `npx crawlmark-mcp@latest init` and lists the four apps; `docs/development.md` lists the five overrides.
- [ ] No real client names or domains appear in code, tests or docs.

**Open questions.** Each has a recommendation, and the build follows it unless the user says otherwise.

- **Masked secrets reveal their length in fancy mode.** Recommended: accept it, since the user asked for masking; plain mode stays zero-echo.
- **The `setup_status` MCP tool will show `npm run cli -- …` from a checkout**, and that command only works from the project directory. Recommended: accept it, because the CLI output says where to run it; installed users see `npx crawlmark-mcp …`.
- **Codex may change the shape of `codex mcp get --json`.** Recommended: treat anything unparseable as "can't read, leave alone" (as for Claude Code) and print the replace commands.
- **Cursor's project-level `.cursor/mcp.json` is not touched.** Recommended: register globally only, matching the user scope used for Claude Code.
