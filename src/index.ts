#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { entryAction, packageVersion } from "./lib/entry.js";

// `crawlmark-mcp setup`, `--help` and friends run the admin CLI; no arguments starts the stdio server.
const action = entryAction(process.argv.slice(2));
if (action === "version") {
  console.log(packageVersion(import.meta.url));
  process.exit(0);
}
if (action === "cli") {
  // cli.ts runs its own main() when imported.
  await import("./cli.js");
} else {
  await import("./server.js");
}
