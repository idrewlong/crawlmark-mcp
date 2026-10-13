#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { entryAction, packageVersion } from "./lib/entry.js";

// `crawlmark-mcp setup`, `--help` and friends run the admin CLI; no arguments starts the stdio server.
const action = entryAction(process.argv.slice(2));
if (action === "version") {
  const current = packageVersion(import.meta.url);
  console.log(current);
  if (process.stdout.isTTY) {
    // Phase 10: the update notice. Loaded only here; the MCP server never imports it.
    const { printUpdateNotice, updateContextWithoutConfig } = await import("./lib/update-check.js");
    const u = updateContextWithoutConfig(import.meta.url);
    if (u) await printUpdateNotice({ current, cacheFile: u.cacheFile, env: u.env });
  }
  process.exit(0);
}
if (action === "cli") {
  // cli.ts runs its own main() when imported.
  await import("./cli.js");
} else {
  await import("./server.js");
}
