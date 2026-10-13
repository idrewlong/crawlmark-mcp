/**
 * Reports pull from several sources. One failing source (missing GA4 access,
 * an empty DataForSEO balance) shouldn't sink the whole report, so each
 * section is settled on its own and errors are reported inline.
 */
import { ProviderUnavailableError } from "../lib/provider-ids.js";

/** `unavailable: true` marks a section no configured provider can serve (Phase 9): unverified, never "passed". */
export type Section<T> = { ok: true; data: T } | { ok: false; error: string; unavailable?: true };

export async function section<T>(fn: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    if (err instanceof ProviderUnavailableError) return { ok: false, error: err.message, unavailable: true };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const dataOf = <T>(s: Section<T>): T | undefined => (s.ok ? s.data : undefined);
