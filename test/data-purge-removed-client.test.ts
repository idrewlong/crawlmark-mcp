/** `data purge --client` also reaches a client that was already removed from clients.yaml (validated bare domain or slug). */
import { describe, expect, it } from "vitest";
import { bareClientId, dataCommand } from "../src/data-cli.js";
import { purgeProviderData } from "../src/lib/provider-data.js";
import { saveSnapshot } from "../src/lib/snapshots.js";
import { db } from "../src/lib/store.js";

const io = () => {
  const lines: string[] = [];
  const errs: string[] = [];
  return { lines, errs, io: { out: (l: string) => void lines.push(l), warn: (l: string) => void errs.push(l), usage: (p: string) => (errs.push(p), 2) } };
};
const gone = async (id: string): Promise<never> => {
  throw new Error(`No client matches "${id}".`);
};
const deps = { resolveClient: gone, purge: purgeProviderData };
const rows = (client: string) => Number((db.prepare("SELECT COUNT(*) AS c FROM seo_snapshots WHERE client = ?").get(client) as { c: number }).c);
const seed = (client: string) => saveSnapshot({ client, kind: "backlinks", target: client, provider: "ahrefs", market: "global", day: "2026-09-01", source: "live", capturedAt: Date.now(), data: { backlinks: 1 } });

describe("data purge for a removed client", () => {
  it("purges what is stored under a bare domain that is no longer in clients.yaml, and says so", async () => {
    seed("removed.example.com");
    seed("kept.example.com");
    const a = io();
    expect(await dataCommand("purge", [], { provider: "ahrefs", client: " Removed.Example.com " }, a.io, deps)).toBe(0);
    const out = JSON.parse(a.lines.join("\n"));
    expect(out).toMatchObject({ provider: "ahrefs", client: "removed.example.com", snapshots: 1 });
    expect(out.note).toContain("removed client");
    expect(rows("removed.example.com")).toBe(0);
    expect(rows("kept.example.com")).toBe(1);
  });

  it("still fails for something that isn't a bare domain or slug", async () => {
    for (const bad of ["https://removed.example.com/", "a b", "../x", "x/y", ""]) {
      const a = io();
      expect(await dataCommand("purge", [], { provider: "ahrefs", client: bad }, a.io, deps), bad).toBe(1);
      expect(a.errs.join(" ")).toContain("No client matches");
    }
    expect(bareClientId("example.com")).toBe("example.com");
    expect(bareClientId("my_client-2")).toBe("my_client-2");
  });
});
