/**
 * Release 0.5.0: Search clicks by page type (C4 page_groups; Y1).
 * Contract stub (Y0): the phase-1 stream replaces the body only; the signature and module path are fixed.
 */
import type { PageGroupsData } from "../report-types.js";
import type { SectionSpec } from "../templates/schema.js";
import { SectionUnavailableError } from "../templates/run.js";
import type { YearlyCtx } from "./context.js";

export async function pageGroupsSection(_s: Extract<SectionSpec, { type: "page_groups" }>, _ctx: YearlyCtx): Promise<PageGroupsData> {
  throw new SectionUnavailableError("not built yet");
}
