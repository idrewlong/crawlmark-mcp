#!/usr/bin/env node
// Packaging smoke test: pack the package, install the tarball into an empty folder the way
// `npx crawlmark-mcp` would, start the installed server over stdio, list its tools and prompts,
// call one free tool, and run the installed CLI's --help. Uses a temporary CRAWLMARK_HOME and
// HOME, so no real config is read. Run after `npm run build`.
//
//   node scripts/smoke-pack.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const MIN_TOOLS = 71;
const MIN_PROMPTS = 5;
const repo = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "crawlmark-smoke-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", shell: process.platform === "win32" && cmd.endsWith(".cmd"), ...opts });

try {
  const packed = JSON.parse(run(npm, ["pack", "--json", "--pack-destination", work], { cwd: repo }));
  const tarball = join(work, packed[0].filename);
  console.log(`packed ${packed[0].filename} (${packed[0].entryCount} files)`);

  const app = join(work, "app");
  const home = join(work, "home");
  run(process.execPath, ["-e", `require("node:fs").mkdirSync(${JSON.stringify(app)});require("node:fs").mkdirSync(${JSON.stringify(home)})`]);
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "smoke", private: true }));
  run(npm, ["install", "--no-audit", "--no-fund", tarball], { cwd: app, stdio: ["ignore", "ignore", "inherit"] });

  const pkgDir = join(app, "node_modules", "crawlmark-mcp");
  const bin = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).bin;
  // The temp home keeps real config out of reach, but Puppeteer looks for its Chrome under the home folder. Point it at
  // the real cache (as test/setup.ts does): with no cached Chrome it falls back to system Chrome, which on Windows
  // won't start with a fake USERPROFILE.
  const env = {
    ...process.env,
    CRAWLMARK_HOME: join(home, ".crawlmark"),
    HOME: home,
    USERPROFILE: home,
    PUPPETEER_CACHE_DIR: process.env.PUPPETEER_CACHE_DIR ?? join(homedir(), ".cache", "puppeteer"),
    NO_UPDATE_NOTIFIER: "1",
    CRAWLMARK_NO_UPDATE_CHECK: "1",
  };

  const listed = JSON.parse(
    run(process.execPath, [join(repo, "scripts", "mcp-list.mjs"), process.execPath, join(pkgDir, bin["crawlmark-mcp"])], {
      env: { ...env, MCP_LIST_CALL: "setup_status", MCP_LIST_TIMEOUT_MS: "120000" },
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  const problems = [];
  if (listed.tools.length < MIN_TOOLS) problems.push(`only ${listed.tools.length} tools (expected at least ${MIN_TOOLS})`);
  if (listed.prompts.length < MIN_PROMPTS) problems.push(`only ${listed.prompts.length} prompts (expected at least ${MIN_PROMPTS})`);
  if (!listed.call || !listed.call.trim()) problems.push("setup_status returned no text");
  console.log(`server ${listed.server?.name} ${listed.server?.version}: ${listed.tools.length} tools, ${listed.prompts.length} prompts; setup_status answered`);

  const help = run(process.execPath, [join(pkgDir, bin["crawlmark-cli"]), "--help"], { env });
  if (!/crawlmark-cli/.test(help)) problems.push("crawlmark-cli --help printed no usage");
  else console.log("crawlmark-cli --help ok");

  if (problems.length) {
    console.error(`smoke-pack failed:\n- ${problems.join("\n- ")}`);
    process.exitCode = 1;
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
