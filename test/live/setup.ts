import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardedFetchFrom } from "./guard.js";

// Credentials come from the user's normal configuration (CRAWLMARK_HOME/.env or the shell). Everything the checks
// could write (cache, ledger, reports) goes to a throwaway folder instead of the user's data.
const dir = mkdtempSync(join(tmpdir(), "crawlmark-live-"));
process.env.DATA_DIR = join(dir, "data");
process.env.REPORTS_DIR = join(dir, "reports");

// Belt and braces: the checks pass the guarded fetch explicitly, and this makes any other global fetch refuse paid paths too.
globalThis.fetch = guardedFetchFrom(globalThis.fetch);
