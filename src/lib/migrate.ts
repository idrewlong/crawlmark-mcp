import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { copyFileAtomic } from "./atomic-file.js";
import { parseEnvText } from "./env-file.js";

/**
 * `crawlmark-cli setup migrate --to <dir>`: copy (never move) a config home's
 * `.env`, `config/clients.yaml`, `config/competitor-denylist.txt`, `data/` and
 * `secrets/` to another directory.
 * Existing files at the target are skipped unless `force`. Secret files
 * (`.env`, everything under `secrets/`, the OAuth token) are written 0600.
 */

export const MIGRATE_ITEMS = [".env", join("config", "clients.yaml"), join("config", "competitor-denylist.txt"), "data", "secrets"] as const;

export interface MigrateFile {
  /** Path relative to the home, e.g. `secrets/key.json`. */
  rel: string;
  from: string;
  to: string;
  action: "copy" | "overwrite" | "skip-exists";
  secret: boolean;
}

export interface MigratePlan {
  from: string;
  to: string;
  files: MigrateFile[];
  /** Items not present in the source home. */
  missing: string[];
  /** Absolute paths in the source .env that point inside the source home (they keep pointing there after the copy). */
  absolutePathWarnings: string[];
}

/** Secret files get 0600 at the target whatever the source mode. */
export function isSecretPath(rel: string): boolean {
  const parts = rel.split(/[\\/]/);
  return rel === ".env" || parts[0] === "secrets" || parts[parts.length - 1] === "google-token.json";
}

function walk(dir: string, base: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue; // never follow links out of the home
    if (st.isDirectory()) out.push(...walk(full, base));
    else if (st.isFile()) out.push(relative(base, full));
  }
  return out;
}

const ENV_PATH_KEYS = ["CLIENTS_FILE", "DATA_DIR", "GOOGLE_APPLICATION_CREDENTIALS", "COMPETITOR_DENYLIST_FILE"];

export function planMigration(fromDir: string, toDir: string, opts: { force?: boolean } = {}): MigratePlan {
  const from = resolve(fromDir);
  const to = resolve(toDir);
  if (from === to) throw new Error(`The target is the current home (${from}); nothing to copy.`);
  if (to.startsWith(from + sep)) {
    // Copying into <home>/data/x would copy into itself.
    const first = relative(from, to).split(sep)[0];
    if (first === "data" || first === "secrets" || first === "config") throw new Error(`The target can't be inside the ${first}/ folder being copied.`);
  }
  const files: MigrateFile[] = [];
  const missing: string[] = [];
  for (const item of MIGRATE_ITEMS) {
    const src = join(from, item);
    if (!existsSync(src)) {
      missing.push(item);
      continue;
    }
    const rels = statSync(src).isDirectory() ? walk(src, from) : [item];
    for (const rel of rels) {
      const dest = join(to, rel);
      const exists = existsSync(dest);
      files.push({ rel, from: join(from, rel), to: dest, action: exists ? (opts.force ? "overwrite" : "skip-exists") : "copy", secret: isSecretPath(rel) });
    }
  }
  const absolutePathWarnings: string[] = [];
  const envPath = join(from, ".env");
  if (existsSync(envPath)) {
    const vars = parseEnvText(readFileSync(envPath, "utf8"));
    for (const k of ENV_PATH_KEYS) {
      const v = vars[k];
      if (v && isAbsolute(v) && (v === from || v.startsWith(from + sep))) {
        absolutePathWarnings.push(`${k} in .env is an absolute path inside ${from}; after switching homes it still points there. Make it relative (e.g. ./${relative(from, v)}).`);
      }
    }
  }
  return { from, to, files, missing, absolutePathWarnings };
}

/** Copy the planned files. Directories are created 0700. Returns counts. */
export function executeMigration(plan: MigratePlan): { copied: number; skipped: number } {
  mkdirSync(plan.to, { recursive: true, mode: 0o700 });
  let copied = 0;
  let skipped = 0;
  for (const f of plan.files) {
    if (f.action === "skip-exists") {
      skipped++;
      continue;
    }
    mkdirSync(dirname(f.to), { recursive: true, mode: 0o700 });
    // Secrets are 0600 from the moment they exist; other files keep the source mode.
    copyFileAtomic(f.from, f.to, f.secret ? 0o600 : statSync(f.from).mode & 0o777);
    copied++;
  }
  return { copied, skipped };
}
