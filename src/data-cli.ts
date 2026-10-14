/**
 * `crawlmark-cli data purge --provider <ahrefs|semrush|dataforseo> [--client <domain|slug>]` (Phase 13 B, the Ahrefs
 * storage decision): delete a provider's stored data on demand (trend snapshots, its Site Audit items in
 * technical-issue snapshots, and its tracked cache entries). Local only; nothing is requested. JSON on stdout.
 */
import type { Client } from "./config.js";
import type { DataProvider, PurgeResult } from "./lib/provider-data.js";

export interface DataCliDeps {
  resolveClient(id: string): Promise<Pick<Client, "slug" | "domain">>;
  purge(provider: DataProvider, client: string | null): PurgeResult;
}

/** A bare domain or slug (letters, digits, dots, hyphens, underscores; no scheme, path or spaces), lowercased; else null. Purge only. */
export function bareClientId(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  return v.length > 0 && v.length <= 253 && /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(v) ? v : null;
}

const PROVIDERS: readonly DataProvider[] = ["ahrefs", "semrush", "dataforseo"];

export async function dataCommand(command: string | undefined, args: string[], flags: { provider?: string | undefined; client?: string | undefined }, io: { out(l: string): void; warn(l: string): void; usage(problem: string): number }, deps: DataCliDeps): Promise<number> {
  if (command !== "purge") return io.usage(command ? `Unknown data command: ${command}. Use: data purge --provider <ahrefs|semrush|dataforseo> [--client <domain>]` : "data needs a command: purge");
  if (args.length) return io.usage(`data purge takes only flags, got: ${args.join(" ")}`);
  const provider = flags.provider?.trim().toLowerCase();
  if (!provider || !(PROVIDERS as readonly string[]).includes(provider)) return io.usage("data purge needs --provider ahrefs, semrush or dataforseo.");
  let slug: string | null = null;
  let note: string | undefined;
  if (flags.client !== undefined) {
    try {
      slug = (await deps.resolveClient(flags.client)).slug;
    } catch (err) {
      // A removed client is no longer in clients.yaml, but what was stored for it is still keyed by its domain or slug.
      const bare = bareClientId(flags.client);
      if (!bare) {
        io.warn(`Error: ${(err as Error).message}`);
        return 1;
      }
      slug = bare;
      note = `"${flags.client}" isn't a current client, so this purged whatever was stored under "${bare}" (a removed client's data).`;
    }
  }
  const r = deps.purge(provider as DataProvider, slug);
  io.out(JSON.stringify({ command: "data purge", ...r, ...(note ? { note } : {}) }, null, 2));
  return 0;
}
