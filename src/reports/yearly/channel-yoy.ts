/**
 * Release 0.5.0: Traffic by channel, year over year (C4 channel_yoy; Y1).
 * Contract stub (Y0): the phase-1 stream replaces the body only; the signature and module path are fixed.
 */
import type { ChannelYoyData } from "../report-types.js";
import type { SectionSpec } from "../templates/schema.js";
import { SectionUnavailableError } from "../templates/run.js";
import type { YearlyCtx } from "./context.js";

export async function channelYoy(_s: Extract<SectionSpec, { type: "channel_yoy" }>, _ctx: YearlyCtx): Promise<ChannelYoyData> {
  throw new SectionUnavailableError("not built yet");
}
