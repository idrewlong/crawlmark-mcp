import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Keep tests away from the repo's data/ and config/: a temp DATA_DIR (SQLite cache, audits) and CLIENTS_FILE.
const dir = mkdtempSync(join(tmpdir(), "crawlmark-test-"));
process.env.DATA_DIR ??= dir;
process.env.CLIENTS_FILE ??= join(dir, "clients.yaml");

// Keep tests away from the user's real app configs and binaries. These are set unconditionally (not ??=),
// so a developer's shell can't point a test run at a real file: HOME (so os.homedir(), ~/.crawlmark,
// ~/.claude.json, ~/.cursor and ~/.codex all resolve inside the temp dir), CODEX_HOME, every app-config
// override, and both binary overrides at a path that doesn't exist (so no test runs the real claude or codex).
// puppeteer finds its downloaded browsers under the home directory, so point it at the developer's real cache
// first (read-only use); otherwise the fake HOME hides them and tests fall back to a system Chrome.
process.env.PUPPETEER_CACHE_DIR ??= join(homedir(), ".cache", "puppeteer");
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

// Phase 9: tests never read the developer's real .env. A temp CRAWLMARK_HOME (with no .env) means
// process.loadEnvFile has nothing to load, so a real SEO_DATA_PROVIDER or Ahrefs/Semrush key can't
// change a test's routing or reach the network. Every provider key is cleared, and every provider base URL
// points at a closed local port (discard, 9), so an unstubbed call fails at once instead of reaching a real host.
process.env.CRAWLMARK_HOME = join(dir, "crawlmark-home");
for (const k of ["AHREFS_API_KEY", "SEMRUSH_API_KEY", "SEMRUSH_V4_API_KEY", "SEO_DATA_PROVIDER"]) delete process.env[k];
process.env.AHREFS_BASE_URL = "http://127.0.0.1:9/v3";
process.env.SEMRUSH_BASE_URL = "http://127.0.0.1:9";
process.env.SEMRUSH_BALANCE_URL = "http://127.0.0.1:9/users/countapiunits.html";
// Before this home isolation, test runs loaded the developer's .env and so usually had DataForSEO credentials.
// Fake ones keep that "DataForSEO configured" baseline for the routed provider layer (a test that needs it
// unconfigured deletes them before importing config), and the base URL points at the closed port too.
process.env.DATAFORSEO_LOGIN = "test@example.com";
process.env.DATAFORSEO_PASSWORD = "test-password";
process.env.DATAFORSEO_BASE_URL = "http://127.0.0.1:9/v3";
delete process.env.DATAFORSEO_LIVE;
// Phase 12: report files go to a temp folder; CrUX, PSI, Bing, AI-visibility and log settings from a
// developer's shell never reach a test, and the new base URLs point at the closed local port.
process.env.REPORTS_DIR = join(dir, "reports");
for (const k of ["CRUX_API_KEY", "PSI_API_KEY", "BING_WEBMASTER_API_KEY", "AI_VISIBILITY_ENABLED", "AI_VISIBILITY_MONTHLY_BUDGET_USD", "LOG_DIRS"]) delete process.env[k];
process.env.CRUX_BASE_URL = "http://127.0.0.1:9";
process.env.BING_BASE_URL = "http://127.0.0.1:9";
process.env.CRAWLER_IPRANGES_BASE_URL = "http://127.0.0.1:9";
// Phase 13: snapshot reuse and URL Inspection budget settings from a developer's shell never reach a test.
for (const k of ["SNAPSHOT_REUSE_DAYS", "GSC_INSPECTION_DAILY_BUDGET", "GSC_INSPECTION_PER_MINUTE"]) delete process.env[k];
