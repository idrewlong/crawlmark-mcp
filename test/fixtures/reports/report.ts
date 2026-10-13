/** A fixed fixture TemplateReport (stable id and time) for renderer tests. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TemplateReport } from "../../../src/reports/report-types.js";
import { runTemplate, type RunDeps, type RunOptions } from "../../../src/reports/templates/run.js";
import { client, fakeDeps } from "./deps.js";

export async function fixtureReport(extra: Partial<RunOptions> = {}, deps: RunDeps = fakeDeps(), c = client): Promise<TemplateReport> {
  const homeDir = mkdtempSync(join(tmpdir(), "crawlmark-fixture-"));
  const r = await runTemplate(c, { homeDir, today: new Date("2026-10-13T12:00:00Z"), month: "2026-09", include: ["cwv", "gtm"], store: false, ...extra }, deps);
  return { ...r, reportId: "rpt_01JFIXTURE0000000000000000", generatedAt: "2026-10-13T09:00:00.000Z" };
}

/** A 2x1 PNG. */
export const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DAwMDAwAAAD/0B/0JgTmQAAAAASUVORK5CYII=", "base64");
