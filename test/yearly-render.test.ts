/**
 * 0.5.0 Y3: the four yearly sections (channel_yoy, page_groups, content_by_year, wins_misses) rendered from the Y0
 * fixture in every format and theme, plus the long-period "by month" fallback tables. Fixture data only (example.com).
 */
import { describe, expect, it } from "vitest";
import { buildReportDoc } from "../src/reports/render/doc.js";
import { yearlyReport } from "./fixtures/reports/yearly-data.js";

const v = { version: "0.5.0" };

describe("yearly sections: block mapping", () => {
  it("channels starts with a share chart", () => {
    const doc = buildReportDoc(yearlyReport(), v);
    const s = doc.sections.find((x) => x.id === "channels");
    expect(s?.blocks[0]?.kind).toBe("chart");
    expect(s?.blocks[0]?.kind === "chart" && s.blocks[0].chart.type).toBe("share");
  });
});
