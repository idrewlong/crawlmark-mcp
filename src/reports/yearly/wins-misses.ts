/**
 * Release 0.5.0: Wins and misses (C4 wins_misses; Y1).
 * Contract stub (Y0): the phase-1 stream replaces the body only; the signature and module path are fixed.
 */
import type { WinsMissesData } from "../report-types.js";
import type { SectionSpec } from "../templates/schema.js";
import { SectionUnavailableError } from "../templates/run.js";
import type { YearlyCtx } from "./context.js";

export async function winsMissesSection(_s: Extract<SectionSpec, { type: "wins_misses" }>, _ctx: YearlyCtx): Promise<WinsMissesData> {
  throw new SectionUnavailableError("not built yet");
}
