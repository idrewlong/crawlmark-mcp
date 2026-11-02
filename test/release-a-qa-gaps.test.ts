/**
 * Release A QA gaps: checks the spec's DoD names but the builders' tests do not pin.
 * D9a: with no checkout and no crawlmark-cli on PATH, the login-required message uses the npx form.
 * D9a (BUG-1): every command hint comes from cliHint(); the empty `gsc-history show` hint does not.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cliHint, cliHintDeps, resetCliHint } from "../src/lib/cli-hint.js";
import { noTokenMessage } from "../src/lib/google-auth.js";
import { gscHistoryCommand } from "../src/gsc-history-cli.js";

const real = { ...cliHintDeps };
afterEach(() => {
  Object.assign(cliHintDeps, real);
  resetCliHint();
});

function npxInstall() {
  cliHintDeps.isCheckout = () => false;
  cliHintDeps.onPath = () => false;
  resetCliHint();
}

describe("D9a command hints", () => {
  it("a login-required message reads `npx -y crawlmark-mcp@latest auth login` without a checkout or crawlmark-cli on PATH", () => {
    npxInstall();
    expect(noTokenMessage("/x/token.json")).toBe("Not signed in to Google (no token at /x/token.json). Run `npx -y crawlmark-mcp@latest auth login` to sign in.");
  });

  // BUG-1 (fixed): the empty-state hint used to print a bare "Run: gsc-history backfill <domain>".
  it("the empty `gsc-history show` hint is a full command built from cliHint()", async () => {
    npxInstall();
    const out: string[] = [];
    await gscHistoryCommand(["show", "example.com"], { all: false, refresh: false }, { out: (l) => void out.push(l), warn: () => undefined, usage: () => 1 }, {
      allClients: async () => [],
      resolveClient: async () => ({ slug: "example.com", domain: "example.com", gscProperty: "sc-domain:example.com" }) as never,
      fill: (async () => ({ stored: [], skipped: [], failed: [] })) as never,
      stored: async () => [],
    });
    expect(cliHint()).toBe("npx -y crawlmark-mcp@latest");
    expect(out.join("\n")).toContain("npx -y crawlmark-mcp@latest gsc-history backfill example.com");
  });
});
