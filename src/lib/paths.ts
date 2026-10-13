import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Project root, derived from the URL of a module that lives directly in
 * `src/` or `dist/` (pass `import.meta.url`). Works under tsx and the build.
 */
export function projectRoot(moduleUrl: string): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), "..");
}

/** Absolute paths pass through unchanged; relative ones resolve against `root`. */
export function resolveFromRoot(root: string, p: string): string {
  return isAbsolute(p) ? p : resolve(root, p);
}
