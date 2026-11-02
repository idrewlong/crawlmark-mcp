/**
 * Release 0.5.0 Y0b: the labelled partial Search Console range (C2a, user decision C-D6). When the current range is
 * partly older than Google's 16 months and those months aren't saved, Search Console sections show the available
 * whole months, labelled, with no comparison. Fake run deps record every Search Console request; saved history is the
 * temp SQLite table. example.com only, no network.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/lib/store.js";
import type { DateRange } from "../src/lib/dates.js";
import type { SectionResult } from "../src/reports/report-types.js";
import { runTemplate, type RunDeps } from "../src/reports/templates/run.js";
import { client, fakeDeps } from "./fixtures/reports/deps.js";
import * as fx from "./fixtures/reports/data.js";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const today = new Date(NOW);
const H2_2025: DateRange = { startDate: "2025-07-01", endDate: "2025-12-31" };

/** Every Search Console request the run made (queries and totals), as ranges. */
let gscCalls: DateRange[] = [];

/** fakeDeps with the real coverage guard (saved history from the temp table) and recorded Search Console requests. */
function deps(over: Partial<RunDeps> = {}): RunDeps {
  const d = fakeDeps({
    gscQuery: async (c, o) => {
      gscCalls.push({ startDate: o.startDate, endDate: o.endDate });
      return fx.gscQuery(c, o);
    },
    gscTotals: async (c, r) => {
      gscCalls.push({ startDate: r.startDate, endDate: r.endDate });
      return fx.gscTotals(c, r);
    },
    ...over,
  });
  delete d.gscStoredCoverage;
  return d;
}

const home = () => mkdtempSync(join(tmpdir(), "crawlmark-partial-"));
const section = (sections: SectionResult[], id: string) => sections.find((s) => s.id === id)!;

beforeEach(() => {
  db.prepare("DELETE FROM gsc_monthly").run();
  db.prepare("DELETE FROM cache").run();
  gscCalls = [];
});

describe("the yearly template on a 2026-11-01 clock with nothing saved before 2025-07", () => {
  it("Search Console sections are ok on Jul–Dec 2025, not unavailable", async () => {
    const r = await runTemplate(client, { homeDir: home(), today, template: "yearly", store: false }, deps());
    for (const id of ["search", "page-types", "pages", "wins"]) expect(section(r.sections, id).status).toBe("ok");
    expect(gscCalls.length).toBeGreaterThan(0);
    for (const c of gscCalls) expect(c).toEqual(H2_2025);
  });
});
