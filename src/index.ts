#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeEgressProxy } from "./lib/egress-proxy.js";
import { restrictToClientDomains } from "./lib/url-guard.js";
import { closeAllBrowsers } from "./providers/browser.js";
import { registerPrompts } from "./prompts/index.js";
import { registerBrandTools } from "./tools/brand.js";
import { registerCompetitorTools } from "./tools/competitors.js";
import { registerOpportunityTools } from "./tools/opportunities.js";
import { registerRawTools } from "./tools/raw.js";
import { registerReportTools } from "./tools/reports.js";

// Fail at boot, not on the first URL, when RESTRICT_TO_CLIENT_DOMAINS has a typo.
restrictToClientDomains();

const server = new McpServer(
  { name: "crawlmark", version: "0.1.0" },
  {
    instructions:
      "SEO audit and reporting tools across Google Search Console, GA4, DataForSEO, Lighthouse and axe-core. " +
      "Start with list_clients. Manage a client's competitors and tracked keywords with the add_/remove_/list_ tools; " +
      "suggest_competitors proposes more (show them to the user and add only the ones they confirm). " +
      "suggest_brand_terms infers the names people search a client by; confirm medium and low candidates with the user before add_brand_terms. For routine work use monthly_report and run_audit; use the lower-level tools for follow-up questions. " +
      "Tools marked paid spend DataForSEO credit and are capped per client per month; prefer the free Google tools when they answer the question. " +
      "Results are cached, so re-running a report is cheap.",
  },
);

registerReportTools(server);
registerCompetitorTools(server);
registerBrandTools(server);
registerOpportunityTools(server);
registerRawTools(server);
registerPrompts(server);

// On shutdown (signal, or the MCP client closing stdin) close every headless Chrome
// (puppeteer and Lighthouse's chrome-launcher) and the egress proxy, so none outlive the server.
let shuttingDown = false;
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`crawlmark: shutting down (${reason})`);
  const force = setTimeout(() => process.exit(0), 10_000);
  force.unref();
  try {
    await closeAllBrowsers();
    await closeEgressProxy();
  } finally {
    process.exit(0);
  }
}
for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.once(sig, () => void shutdown(sig));
process.stdin.once("end", () => void shutdown("stdin closed"));
process.stdin.once("close", () => void shutdown("stdin closed"));

await server.connect(new StdioServerTransport());
// stdout is the MCP channel; log to stderr only.
console.error("crawlmark MCP server running on stdio");
