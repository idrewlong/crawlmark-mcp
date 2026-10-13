import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseTokenFile, type StoredToken } from "./google-auth.js";

/** Read the stored OAuth token, or undefined if there is none. Throws if the file is corrupt. */
export function readTokenFile(path: string): StoredToken | undefined {
  if (!existsSync(path)) return undefined;
  return parseTokenFile(readFileSync(path, "utf8"), path);
}

/** Modification time in ms, or undefined if the file doesn't exist. */
export function tokenFileMtime(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Write atomically with mode 0600: write a sibling temp file, then rename over
 * the target so a reader never sees a half-written token.
 */
export function writeTokenFile(path: string, token: StoredToken): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(token, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function deleteTokenFile(path: string): boolean {
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}
