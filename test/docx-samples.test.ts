/**
 * Writes one DOCX per builtin template (fixture data) to DOCX_SAMPLES_DIR, so CI can open each
 * file with LibreOffice. Skipped unless DOCX_SAMPLES_DIR is set.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReportDoc } from "../src/reports/render/doc.js";
import { toDocx } from "../src/reports/render/docx.js";
import { BUILTIN_TEMPLATES } from "../src/reports/templates/builtin.js";
import { fixtureReport } from "./fixtures/reports/report.js";

const out = process.env.DOCX_SAMPLES_DIR;

describe.skipIf(!out)("DOCX samples for CI", () => {
  for (const id of Object.keys(BUILTIN_TEMPLATES)) {
    it(`writes ${id}.docx`, async () => {
      const doc = buildReportDoc(await fixtureReport(id === "monthly" ? {} : { template: id, include: [] }), {
        version: "0.1.0",
        narrative: { summary: "Clicks grew **12%**.\n\n- One\n- Two", sections: {} },
      });
      const buf = await toDocx(doc);
      expect(buf.subarray(0, 2).toString()).toBe("PK");
      mkdirSync(out!, { recursive: true });
      writeFileSync(join(out!, `${id}.docx`), buf);
    });
  }
});
