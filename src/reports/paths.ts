/**
 * Where report files and per-client template files live (D7, D8). Pure path
 * helpers; the filesystem checks are in export.ts.
 */
import { join } from "node:path";
import type { Format } from "./templates/schema.js";
import { periodSlug } from "./templates/period.js";
import type { DateRange } from "../lib/dates.js";

/**
 * A client slug as one safe path segment: lowercase, `[a-z0-9.-]` only (others become `-`),
 * no leading `.` or `-`, no `..`, 1 to 100 characters. Throws when nothing usable is left.
 */
export function safeSegment(input: string): string {
  let s = input.normalize("NFKC").toLowerCase().replace(/[^a-z0-9.-]/g, "-");
  while (s.includes("..")) s = s.replace(/\.\.+/g, ".");
  s = s.replace(/^[.-]+/, "").slice(0, 100).replace(/[.-]+$/, "");
  if (!s) throw new Error(`"${input}" can't be used as a folder name.`);
  return s;
}

/** `<home>/config/report-templates.yaml`. */
export const globalTemplatesFile = (homeDir: string) => join(homeDir, "config", "report-templates.yaml");

/** `<home>/config/report-templates/<client>.yaml`. */
export const clientTemplatesFile = (homeDir: string, clientSlug: string) => join(homeDir, "config", "report-templates", `${safeSegment(clientSlug)}.yaml`);

export const FORMAT_EXT: Record<Format, string> = { md: "md", html: "html", pdf: "pdf", docx: "docx" };

/** Relative report path parts: `<client>/<YYYY-MM>/<template>-<period>.<ext>` (D7). */
export function reportRelPath(clientSlug: string, folderMonth: string, templateId: string, period: DateRange, format: Format): { clientDir: string; monthDir: string; file: string } {
  if (!/^\d{4}-\d{2}$/.test(folderMonth)) throw new Error(`Bad folder month "${folderMonth}".`);
  return { clientDir: safeSegment(clientSlug), monthDir: folderMonth, file: `${safeSegment(templateId)}-${periodSlug(period)}.${FORMAT_EXT[format]}` };
}
