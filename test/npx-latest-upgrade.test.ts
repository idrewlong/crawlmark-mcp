// An npx install registers `npx -y crawlmark-mcp@latest`; crawlmark's own older entry (no version) is an update, not a different server.
import { describe, expect, it } from "vitest";
import { isNpxLatestUpgrade, NPX_SPEC } from "../src/setup/apps.js";

const launch = { command: "/usr/local/bin/npx", args: ["-y", NPX_SPEC], env: { CRAWLMARK_HOME: "/home/u/.crawlmark" } };

describe("isNpxLatestUpgrade", () => {
  it("recognises the old unversioned npx entry with the same env", () => {
    expect(isNpxLatestUpgrade({ command: "/usr/local/bin/npx", args: ["-y", "crawlmark-mcp"], env: { CRAWLMARK_HOME: "/home/u/.crawlmark" } }, launch)).toBe(true);
    expect(isNpxLatestUpgrade({ command: "npx", args: ["-y", "crawlmark-mcp"], env: { CRAWLMARK_HOME: "/home/u/.crawlmark" } }, launch)).toBe(true);
    // `claude mcp get` prints args as one string.
    expect(isNpxLatestUpgrade({ command: "npx", args: "-y crawlmark-mcp", env: { CRAWLMARK_HOME: "/home/u/.crawlmark" } }, launch)).toBe(true);
    expect(isNpxLatestUpgrade({ command: "C:\\Program Files\\nodejs\\npx.cmd", args: ["-y", "crawlmark-mcp"], env: { CRAWLMARK_HOME: "/home/u/.crawlmark" } }, launch)).toBe(true);
  });

  it("anything else is a different server", () => {
    expect(isNpxLatestUpgrade({ command: "npx", args: ["-y", "crawlmark-mcp"], env: { CRAWLMARK_HOME: "/elsewhere" } }, launch)).toBe(false);
    expect(isNpxLatestUpgrade({ command: "npx", args: ["-y", "crawlmark-mcp"] }, launch)).toBe(false);
    expect(isNpxLatestUpgrade({ command: "node", args: ["/x/dist/index.js"], env: launch.env }, launch)).toBe(false);
    expect(isNpxLatestUpgrade({ command: "npx", args: ["-y", "other-mcp"], env: launch.env }, launch)).toBe(false);
    expect(isNpxLatestUpgrade(undefined, launch)).toBe(false);
    expect(isNpxLatestUpgrade({ command: "npx", args: ["-y", "crawlmark-mcp"], env: launch.env }, { ...launch, args: ["-y", "crawlmark-mcp"] })).toBe(false);
  });
});
