import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep tests away from the repo's data/ and config/: a temp DATA_DIR (SQLite cache, audits) and CLIENTS_FILE.
const dir = mkdtempSync(join(tmpdir(), "crawlmark-test-"));
process.env.DATA_DIR ??= dir;
process.env.CLIENTS_FILE ??= join(dir, "clients.yaml");

// Keep tests away from the user's real app configs and binaries. These are set unconditionally (not ??=),
// so a developer's shell can't point a test run at a real file: HOME (so os.homedir(), ~/.crawlmark,
// ~/.claude.json, ~/.cursor and ~/.codex all resolve inside the temp dir), CODEX_HOME, every app-config
// override, and both binary overrides at a path that doesn't exist (so no test runs the real claude or codex).
const fakeHome = join(dir, "home");
mkdirSync(fakeHome, { recursive: true });
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.CODEX_HOME = join(fakeHome, ".codex");
process.env.CRAWLMARK_CLAUDE_DESKTOP_CONFIG = join(fakeHome, "claude-desktop", "claude_desktop_config.json");
process.env.CRAWLMARK_CURSOR_CONFIG = join(fakeHome, ".cursor", "mcp.json");
process.env.CRAWLMARK_CODEX_CONFIG = join(fakeHome, ".codex", "config.toml");
process.env.CRAWLMARK_CLAUDE_BIN = join(dir, "no-such-bin", "claude");
process.env.CRAWLMARK_CODEX_BIN = join(dir, "no-such-bin", "codex");
