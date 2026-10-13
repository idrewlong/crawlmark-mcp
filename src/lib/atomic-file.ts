import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

/**
 * Write `data` to `path` atomically with exactly `mode`: a fresh temp file next
 * to the target is created exclusively (`wx`, so a planted file or symlink at the
 * temp path is never followed) with `mode` from the start, then renamed into
 * place. The content is never readable with a wider mode, not even briefly.
 */
export function writeFileAtomic(path: string, data: string | Buffer, mode: number): void {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, data, { mode, flag: "wx" });
    chmodSync(tmp, mode); // the umask may have narrowed it; make it exact
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Copy `src` to `dest` atomically with exactly `mode` (see writeFileAtomic). */
export function copyFileAtomic(src: string, dest: string, mode: number): void {
  writeFileAtomic(dest, readFileSync(src), mode);
}
