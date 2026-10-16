#!/usr/bin/env node
// Build the Claude Desktop bundle: build/crawlmark.mcpb.
//
//   npm run build:mcpb          (builds dist/ first)
//   node scripts/build-mcpb.mjs (uses the existing dist/)
//
// The bundle is a zip of: manifest.json, package.json, dist/ and production node_modules.
// Puppeteer's Chrome download is skipped on purpose (it is hundreds of MB); at run time crawlmark uses
// CHROME_PATH or the Chrome installed on the machine. Needs the system `zip`. The official packer
// (`npx @anthropic-ai/mcpb pack build/mcpb-stage build/crawlmark.mcpb`) works on the same stage directory.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(root, "build");
const stage = join(buildDir, "mcpb-stage");
const output = join(buildDir, "crawlmark.mcpb");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.error?.code === "ENOENT") throw new Error(`\`${cmd}\` not found on PATH`);
  if (r.status !== 0) throw new Error(`\`${cmd} ${args.join(" ")}\` failed (exit ${r.status})`);
}

function dirSize(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : e.isFile() ? statSync(p).size : 0;
  }
  return total;
}
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/**
 * Delete every generated API client except `keep` from googleapis and rewrite its apis/index.js
 * (a generated list of `require`s, a version map and one property per API) to match.
 * Line-based on purpose: each API appears on exactly one line per section. Throws if the layout changed.
 */
function pruneGoogleapis(dir, keep) {
  const apisDir = join(dir, "build", "src", "apis");
  const indexFile = join(apisDir, "index.js");
  if (!existsSync(indexFile)) throw new Error(`googleapis layout changed: ${indexFile} not found`);
  for (const name of readdirSync(apisDir)) {
    if (name !== "index.js" && !keep.includes(name) && statSync(join(apisDir, name)).isDirectory()) rmSync(join(apisDir, name), { recursive: true, force: true });
  }
  // Type declarations and build info are not needed at run time.
  for (const name of keep) {
    for (const f of readdirSync(join(apisDir, name))) if (f.endsWith(".d.ts") || f.endsWith(".tsbuildinfo")) rmSync(join(apisDir, name, f));
  }
  const kept = new Set(keep.map((k) => `${k}_1`));
  const lines = readFileSync(indexFile, "utf8").split("\n");
  const out = lines.filter((line) => {
    const m = line.match(/^(?:const (\w+_1) = require\(|\s+\w+: (\w+_1)\.VERSIONS,|\s+\w+ = (\w+_1)\.\w+;)/);
    const ref = m && (m[1] ?? m[2] ?? m[3]);
    return !ref || kept.has(ref);
  });
  const text = out.join("\n");
  for (const k of keep) {
    if (!text.includes(`${k}_1.VERSIONS`) || !text.includes(`${k} = ${k}_1.${k};`)) throw new Error(`googleapis layout changed: ${k} not found in apis/index.js`);
  }
  writeFileSync(indexFile, text);

  // build/src/index.js re-exports every API version; rewrite it with only the kept ones.
  const topFile = join(dir, "build", "src", "index.js");
  const top = readFileSync(topFile, "utf8").split("\n");
  const head = [
    '"use strict";',
    'Object.defineProperty(exports, "__esModule", { value: true });',
    'const googleapis_1 = require("./googleapis");',
    'Object.defineProperty(exports, "GoogleApis", { enumerable: true, get: function () { return googleapis_1.GoogleApis; } });',
    "const google = new googleapis_1.GoogleApis();",
    "exports.google = google;",
    'exports.Common = require("googleapis-common");',
    'exports.Auth = require("google-auth-library");',
  ];
  const reexports = [];
  for (let i = 0; i < top.length - 1; i++) {
    const m = top[i].match(/^var \w+ = require\("\.\/apis\/([^/]+)\//);
    if (m && keep.includes(m[1])) reexports.push(top[i], top[i + 1]);
  }
  if (reexports.length < keep.length * 2) throw new Error("googleapis layout changed: index.js re-exports not found");
  writeFileSync(topFile, [...head, ...reexports, ""].join("\n"));
  for (const f of ["index.d.ts", "googleapis.d.ts"]) rmSync(join(dir, "build", "src", f), { force: true });
}

/** The docx ESM files crawlmark imports: the main entry and `docx/charts` (editable charts in reports). */
const DOCX_KEEP = ["index.mjs", "charts.mjs"];

/** Keep only the docx ESM files crawlmark imports (DOCX_KEEP); throw if the layout changed. */
function pruneDocx(dir) {
  const dist = join(dir, "dist");
  for (const f of DOCX_KEEP) if (!existsSync(join(dist, f))) throw new Error(`docx layout changed: ${join(dist, f)} not found`);
  for (const name of readdirSync(dist)) if (!DOCX_KEEP.includes(name)) rmSync(join(dist, name), { recursive: true, force: true });
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "mcpb", "manifest.json"), "utf8"));
if (manifest.version !== pkg.version) {
  throw new Error(`mcpb/manifest.json version (${manifest.version}) must match package.json (${pkg.version}); update the manifest.`);
}
for (const f of ["dist/index.js", "dist/cli.js", "dist/prompts/templates"]) {
  if (!existsSync(join(root, f))) throw new Error(`${f} is missing. Run \`npm run build\` first.`);
}

rmSync(stage, { recursive: true, force: true });
rmSync(output, { force: true });
mkdirSync(stage, { recursive: true });

// Code, minus source maps.
cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true, filter: (src) => !src.endsWith(".map") });
cpSync(join(root, "package.json"), join(stage, "package.json"));
cpSync(join(root, "package-lock.json"), join(stage, "package-lock.json"));
cpSync(join(root, "mcpb", "manifest.json"), join(stage, "manifest.json"));
for (const f of ["README.md", "LICENSE"]) if (existsSync(join(root, f))) cpSync(join(root, f), join(stage, f));

// Production dependencies only; no Chrome download; no install scripts.
run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
  cwd: stage,
  env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: "true", PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: "true" },
});
// googleapis ships ~340 generated API clients (245 MB). Keep the ones crawlmark calls.
pruneGoogleapis(join(stage, "node_modules", "googleapis"), ["analyticsadmin", "analyticsdata", "searchconsole", "tagmanager"]);
// Fail the build if the pruned googleapis no longer loads or lacks a client we use.
run(process.execPath, [
  "-e",
  "const { google } = require('googleapis'); for (const [api, v] of [['searchconsole','v1'],['analyticsdata','v1beta'],['analyticsadmin','v1beta'],['tagmanager','v2']]) { if (typeof google[api] !== 'function') throw new Error(api + ' missing'); google[api]({ version: v }); }",
], { cwd: stage });
// docx ships the same code as ESM, CJS, UMD and IIFE builds plus four optional sub-packages and their
// type declarations (about 9 MB). crawlmark imports only the ESM entry and docx/charts (DOCX_KEEP).
pruneDocx(join(stage, "node_modules", "docx"));
// Fail the build if the pruned docx no longer loads or can't write a document.
run(process.execPath, [
  "--input-type=module",
  "-e",
  "const d = await import('docx'); await import('docx/charts'); const b = await d.Packer.toBuffer(new d.Document({ sections: [{ children: [new d.Paragraph('ok')] }] })); if (b.subarray(0, 2).toString() !== 'PK') throw new Error('docx output is not a zip');",
], { cwd: stage });
// The lockfile is only needed for npm ci.
rmSync(join(stage, "package-lock.json"), { force: true });

// Fail the build unless the staged server actually starts and lists its tools: pruning must never remove a file
// some import needs. Runs against a throwaway home, so no real config is read.
{
  const home = mkdtempSync(join(tmpdir(), "crawlmark-mcpb-check-"));
  try {
    const out = execFileSync(process.execPath, [join(root, "scripts", "mcp-list.mjs"), process.execPath, "--disable-warning=ExperimentalWarning", join(stage, "dist", "index.js")], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CRAWLMARK_HOME: join(home, ".crawlmark"), CRAWLMARK_NO_UPDATE_CHECK: "1" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const listed = JSON.parse(out);
    if (!listed.tools?.length) throw new Error("the staged server listed no tools");
    console.log(`Staged server starts: ${listed.tools.length} tools, ${listed.prompts.length} prompts.`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

run("zip", ["-qr", "-X", output, "."], { cwd: stage });

console.log(`\nStage: ${mb(dirSize(stage))} uncompressed`);
console.log(`Bundle: ${output} (${mb(statSync(output).size)})`);
