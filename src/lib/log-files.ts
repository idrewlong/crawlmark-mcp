/**
 * Log file access for log_analysis (Phase 12 C2). The MCP tool reads only regular
 * files inside the allowed directories (LOG_DIRS plus <home>/logs): every path is
 * realpath'd and must stay inside one of them, so `../`, absolute paths elsewhere
 * and symlinks pointing out are refused. Reading is streamed (gzip too) with byte,
 * line and line-length caps; nothing is written anywhere.
 */
import { constants } from "node:fs";
import { open, readdir, realpath, stat, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createGunzip } from "node:zlib";
import type { Readable } from "node:stream";
import { stripControl } from "./terminal-text.js";

export class LogAccessError extends Error {
  override name = "LogAccessError";
}

/** LOG_DIRS (comma-separated absolute directories) plus <home>/logs. Relative entries are ignored and reported. */
export function logDirsFrom(raw: string | undefined, homeDir: string): { dirs: string[]; ignored: string[] } {
  return allowedDirsFrom(raw, homeDir, "logs");
}

/** Comma-separated absolute directories (LOG_DIRS, IMPORT_DIRS) plus <home>/<sub>. Relative entries are ignored and reported. */
export function allowedDirsFrom(raw: string | undefined, homeDir: string, sub: string): { dirs: string[]; ignored: string[] } {
  const entries = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const ignored = entries.filter((d) => !isAbsolute(d));
  return { dirs: [...new Set([...entries.filter((d) => isAbsolute(d)), join(homeDir, sub)])], ignored };
}

/** What a refusal calls the files and the folders: log files by default; Search Console exports for import_index_report. */
export interface AccessLabel {
  file: string;
  dirs: string;
}
export const LOG_LABEL: AccessLabel = { file: "log file", dirs: "log directories" };

/** The allowed directories that exist, resolved (realpath). */
export async function existingDirs(dirs: string[]): Promise<{ dir: string; real: string }[]> {
  const out: { dir: string; real: string }[] = [];
  for (const dir of dirs) {
    try {
      const real = await realpath(dir);
      if ((await stat(real)).isDirectory()) out.push({ dir, real });
    } catch {
      /* missing: not allowed */
    }
  }
  return out;
}

const inside = (real: string, root: string) => real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
/** Most `*` and `?` in one file-name pattern; patterns come from the model, so they are bounded. */
export const MAX_GLOB_WILDCARDS = 8;

/**
 * Does a file name match a glob (`*` any run, `?` one character)? A linear wildcard matcher (greedy with
 * one backtrack point, O(name × pattern) at worst; no regex), so a hostile pattern can't hang the thread.
 */
export function globMatch(pattern: string, name: string): boolean {
  const p = pattern.replace(/\*+/g, "*");
  let i = 0;
  let j = 0;
  let star = -1;
  let mark = 0;
  while (i < name.length) {
    if (j < p.length && p[j] !== "*" && (p[j] === "?" || p[j] === name[i])) {
      i++;
      j++;
    } else if (j < p.length && p[j] === "*") {
      star = j++;
      mark = i;
    } else if (star !== -1) {
      j = star + 1;
      i = ++mark;
    } else return false;
  }
  while (j < p.length && p[j] === "*") j++;
  return j === p.length;
}

export interface ResolvedLogFile {
  /** Shown in results: relative to its allowed directory (MCP) or as typed (CLI). */
  name: string;
  path: string;
  /** The file's identity when it was resolved; the opened handle must be the same file (SEC-6). */
  identity?: { dev: number; ino: number };
  /** MCP files: opened with O_NOFOLLOW and refused when hard-linked (nlink > 1). */
  strict?: boolean;
}

/**
 * Expand names or globs (`*`, `?` in the last segment) relative to the allowed directories.
 * An explicit name that is outside, a symlink out, or not a regular file throws; a glob match like that is skipped and noted.
 */
export async function resolveAllowedLogFiles(patterns: string[], allowed: { dir: string; real: string }[], maxFiles = 50, label: AccessLabel = LOG_LABEL): Promise<{ files: ResolvedLogFile[]; notes: string[] }> {
  const L = label;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const files: ResolvedLogFile[] = [];
  const seen = new Set<string>();
  const notes: string[] = [];
  const shown = (p: string) => stripControl(p).slice(0, 300);
  for (const pattern of patterns) {
    if (pattern.includes("\0")) throw new LogAccessError(`A ${L.file} name contains a NUL character.`);
    const isGlob = /[*?]/.test(basename(pattern));
    if (/[*?]/.test(dirname(pattern))) throw new LogAccessError(`Wildcards are allowed only in the file name, not in directories: ${shown(pattern)}`);
    if ((basename(pattern).match(/[*?]/g) ?? []).length > MAX_GLOB_WILDCARDS) throw new LogAccessError(`A ${L.file} pattern can have at most ${MAX_GLOB_WILDCARDS} wildcards: ${shown(pattern)}`);
    if (!isAbsolute(pattern) && pattern.split(/[\\/]/).includes("..")) throw new LogAccessError(`${cap(L.file)} names can't contain "..": ${shown(pattern)}`);
    // An absolute path is checked lexically before the filesystem is touched, so a refusal never says whether a file exists elsewhere.
    if (isAbsolute(pattern) && !allowed.some((a) => inside(resolve(pattern), a.dir) || inside(resolve(pattern), a.real))) {
      throw new LogAccessError(`Refusing ${shown(pattern)}: it is outside the allowed ${L.dirs}.`);
    }
    // Absolute: only when inside an allowed directory (checked below). Relative: under each allowed directory.
    const bases = isAbsolute(pattern) ? [{ dir: dirname(pattern), root: null as { dir: string; real: string } | null }] : allowed.map((a) => ({ dir: join(a.dir, dirname(pattern)), root: a }));
    let matched = 0;
    // One message for "not there", "outside", "symlink out" and "not a regular file", so a refusal is no existence oracle.
    const unreadable = `No readable ${L.file} ${shown(pattern)} inside the allowed ${L.dirs} (it must be a regular file there; symlinks pointing elsewhere are refused).`;
    for (const b of bases) {
      // The base directory is resolved and checked before anything in it is listed or looked up (SEC-5).
      let realBase: string;
      try {
        realBase = await realpath(b.dir);
      } catch {
        continue;
      }
      if (!allowed.some((a) => inside(realBase, a.real))) continue;
      let names: string[];
      if (isGlob) {
        const glob = basename(pattern);
        try {
          names = (await readdir(realBase)).filter((n) => globMatch(glob, n)).sort();
        } catch {
          continue;
        }
      } else names = [basename(pattern)];
      for (const name of names) {
        const candidate = join(realBase, name);
        let real: string | null = null;
        let root: { dir: string; real: string } | undefined;
        let isFile = false;
        let identity: { dev: number; ino: number } | undefined;
        try {
          real = await realpath(candidate);
          root = allowed.find((a) => inside(real!, a.real));
          const st = await stat(real);
          // A hard link could point at a file outside the allowed directories, so only single-link files are read.
          isFile = root !== undefined && st.isFile() && st.nlink === 1;
          identity = { dev: st.dev, ino: st.ino };
        } catch {
          /* missing or dangling: unreadable */
        }
        if (!real || !root || !isFile) {
          if (isGlob) notes.push(`Skipped ${shown(name)}: not a regular file inside the allowed ${L.dirs}.`);
          continue;
        }
        matched++;
        if (seen.has(real)) continue;
        seen.add(real);
        if (files.length >= maxFiles) {
          notes.push(`Only the first ${maxFiles} ${L.file}s were read.`);
          continue;
        }
        files.push({ name: shown(relative(root.real, candidate) || name), path: real, identity, strict: true });
      }
    }
    if (!matched) {
      if (!isGlob) throw new LogAccessError(unreadable);
      notes.push(`No ${L.file} matched ${shown(pattern)}.`);
    }
  }
  return { files, notes: [...new Set(notes)] };
}

/** CLI paths (the user typed them): each must be an existing regular file. */
export async function resolveCliLogFiles(paths: string[], label: AccessLabel = LOG_LABEL): Promise<ResolvedLogFile[]> {
  const out: ResolvedLogFile[] = [];
  for (const p of paths) {
    let st;
    try {
      st = await stat(p);
    } catch {
      throw new LogAccessError(`No such ${label.file}: ${stripControl(p)}`);
    }
    if (!st.isFile()) throw new LogAccessError(`Not a regular file: ${stripControl(p)}`);
    out.push({ name: stripControl(p).slice(0, 300), path: p, identity: { dev: st.dev, ino: st.ino } });
  }
  return out;
}

export interface ReadCaps {
  /** Decompressed bytes across all files (default 2 GB). */
  maxBytes: number;
  /** Lines across all files (default 20 million). */
  maxLines: number;
  /** Longer lines are skipped (default 16 KB). */
  maxLineChars: number;
}
export const DEFAULT_READ_CAPS: ReadCaps = { maxBytes: 2 * 1024 ** 3, maxLines: 20_000_000, maxLineChars: 16 * 1024 };

export interface ReadState {
  bytes: number;
  lines: number;
  capped: "bytes" | "lines" | null;
}

/** Stream a log file (gzip by name or magic bytes) line by line, within the caps shared through `state`. Returns lines read and over-long lines dropped. */
/**
 * Open a resolved log file once and check the handle (SEC-6): O_NONBLOCK so a FIFO swapped in can't block,
 * O_NOFOLLOW for MCP files so a symlink swapped in is refused, then fstat: a regular file, the same dev/ino as
 * when it was resolved, and (MCP) a single link. Everything after reads from this handle.
 */
export async function openLogFile(file: ResolvedLogFile): Promise<FileHandle> {
  const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (file.strict ? (constants.O_NOFOLLOW ?? 0) : 0);
  let fh: FileHandle;
  try {
    fh = await open(file.path, flags);
  } catch {
    throw new LogAccessError(`${file.name} couldn't be opened as a regular file (it changed after it was checked, or isn't one).`);
  }
  try {
    const st = await fh.stat();
    const problem = !st.isFile()
      ? "it isn't a regular file"
      : file.identity && (st.dev !== file.identity.dev || st.ino !== file.identity.ino)
        ? "it was replaced after it was checked"
        : file.strict && st.nlink !== 1
          ? "it has more than one hard link"
          : null;
    if (problem) throw new LogAccessError(`Refusing ${file.name}: ${problem}.`);
    return fh;
  } catch (err) {
    await fh.close();
    throw err;
  }
}

/** Stream a log file (gzip by name or magic bytes) line by line, within the caps shared through `state`. Returns lines read and over-long lines dropped. */
export async function readLogLines(input: string | ResolvedLogFile, onLine: (line: string) => void, state: ReadState, caps: ReadCaps = DEFAULT_READ_CAPS): Promise<{ lines: number; tooLong: number }> {
  const target: ResolvedLogFile = typeof input === "string" ? { name: input, path: input } : input;
  const fh = await openLogFile(target);
  const head = Buffer.alloc(2);
  const { bytesRead } = await fh.read(head, 0, 2, 0);
  const gz = /\.gz$/i.test(target.path) || (bytesRead === 2 && head[0] === 0x1f && head[1] === 0x8b);
  const file = fh.createReadStream({ start: 0, highWaterMark: 64 * 1024, autoClose: false });
  const stream: Readable = gz ? file.pipe(createGunzip()) : file;
  file.on("error", (err) => stream.destroy(err));
  const decoder = new StringDecoder("utf8");
  let carry = "";
  let dropping = false;
  let lines = 0;
  let tooLong = 0;
  const emit = (raw: string): boolean => {
    if (state.lines >= caps.maxLines) {
      state.capped = "lines";
      return false;
    }
    state.lines++;
    lines++;
    onLine(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
    return true;
  };
  try {
    outer: for await (const chunk of stream as AsyncIterable<Buffer>) {
      state.bytes += chunk.length;
      if (state.bytes > caps.maxBytes) {
        state.capped = "bytes";
        break;
      }
      const text = carry + decoder.write(chunk);
      let start = 0;
      for (;;) {
        const i = text.indexOf("\n", start);
        if (i === -1) break;
        const line = text.slice(start, i);
        start = i + 1;
        if (dropping) {
          dropping = false;
          tooLong++;
          continue;
        }
        if (line.length > caps.maxLineChars) {
          tooLong++;
          continue;
        }
        if (!emit(line)) break outer;
      }
      carry = text.slice(start);
      if (carry.length > caps.maxLineChars) {
        carry = "";
        dropping = true;
      }
    }
    if (!state.capped) {
      const rest = carry + decoder.end();
      if (dropping) tooLong++;
      else if (rest.length) emit(rest);
    }
  } finally {
    stream.destroy();
    file.destroy();
    await fh.close();
  }
  return { lines, tooLong };
}
