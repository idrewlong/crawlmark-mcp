import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep tests away from the repo's data/ and config/: a temp DATA_DIR (SQLite cache, audits) and CLIENTS_FILE.
const dir = mkdtempSync(join(tmpdir(), "crawlmark-test-"));
process.env.DATA_DIR ??= dir;
process.env.CLIENTS_FILE ??= join(dir, "clients.yaml");
