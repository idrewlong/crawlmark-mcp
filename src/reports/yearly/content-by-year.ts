/**
 * Release 0.5.0: Content by publish year (C4 content_by_year; Y2).
 * Contract stub (Y0): the phase-1 stream replaces the body only; the signature and module path are fixed.
 */
import type { ContentByYearData } from "../report-types.js";
import type { SectionSpec } from "../templates/schema.js";
import { SectionUnavailableError } from "../templates/run.js";
import type { YearlyCtx } from "./context.js";

export async function contentByYear(_s: Extract<SectionSpec, { type: "content_by_year" }>, _ctx: YearlyCtx): Promise<ContentByYearData> {
  throw new SectionUnavailableError("not built yet");
}
