// The free balance check (countapiunits) answers a key it can't parse with HTTP 400 and a JSON body
// (seen live 2026-10-15): {"errors":[{"field":"key","message":"invalid api key: <key>"}]}.
import { describe, expect, it, vi } from "vitest";
import { checkSemrushKey, SEMRUSH_NOT_A_V3_KEY } from "../src/providers/semrush.js";
import { parseSemrushJsonErrors } from "../src/providers/semrush-shape.js";

const respond = (status: number, body: string) => vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;

describe("Semrush balance check errors", () => {
  it("reads the JSON error body", () => {
    expect(parseSemrushJsonErrors('{"errors":[{"field":"key","message":"invalid api key: abc"}]}')).toEqual([{ field: "key", message: "invalid api key: abc" }]);
    expect(parseSemrushJsonErrors("ERROR 50 :: NOTHING FOUND")).toBeNull();
    expect(parseSemrushJsonErrors("1234")).toBeNull();
  });

  it("an invalid key is a clear rejection, not 'couldn't reach Semrush'", async () => {
    const r = await checkSemrushKey("not-a-v3-key", respond(400, '{"errors":[{"field":"key","message":"invalid api key: not-a-v3-key"}]}'));
    expect(r).toMatchObject({ works: false, reachable: true, error: SEMRUSH_NOT_A_V3_KEY });
    expect(r.error).not.toContain("not-a-v3-key");
  });

  it("another 400 says what Semrush said, with the key redacted", async () => {
    const r = await checkSemrushKey("secret-key-xyz", respond(400, '{"errors":[{"field":"other","message":"bad request for secret-key-xyz"}]}'));
    expect(r.works).toBeNull();
    expect(r.reachable).toBe(true);
    expect(r.error).toMatch(/HTTP 400: bad request for/);
    expect(r.error).not.toContain("secret-key-xyz");
  });

  it("a plain number is the balance", async () => {
    const r = await checkSemrushKey("0123456789abcdef0123456789abcdef", respond(200, "25000"));
    expect(r).toMatchObject({ works: true, unitsLeft: 25000 });
  });
});
