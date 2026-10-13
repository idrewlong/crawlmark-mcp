import { describe, expect, it } from "vitest";
import { compare } from "../src/reports/monthly.js";

const cur = { clicks: 505, impressions: 11124, ctr: 4.54, position: 9.5 };

describe("monthly compare", () => {
  it("returns changes and the previous absolute values", () => {
    const out = compare(cur, { clicks: 590, impressions: 11270, ctr: 5.23, position: 9.8 });
    expect(out.clicks).toEqual({ value: 505, change: -14.4 });
    expect(out.ctr.change).toBe(-0.69);
    expect(out.position.change).toBe(-0.3);
    expect(out.previous).toEqual({ clicks: 590, impressions: 11270, ctr: 5.23, position: 9.8 });
  });

  it("returns null for every change when the earlier period has no data", () => {
    const out = compare(cur, { clicks: 0, impressions: 0, ctr: 0, position: 0 });
    expect([out.clicks.change, out.impressions.change, out.ctr.change, out.position.change]).toEqual([null, null, null, null]);
    expect(out.previous).toBeNull();
    expect(out.clicks.value).toBe(505);
  });
});
