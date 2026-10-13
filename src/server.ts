import { packageVersion } from "./lib/entry.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { providerUrlNotice, seoDefaultProvider } from "./config.js";
import { closeEgressProxy } from "./lib/egress-proxy.js";
import { restrictToClientDomains } from "./lib/url-guard.js";
import { closeAllBrowsers } from "./providers/browser.js";
import { registerPrompts } from "./prompts/index.js";
import { registerBrandTools } from "./tools/brand.js";
import { registerCompetitorTools } from "./tools/competitors.js";
import { registerCrawlTools } from "./tools/crawl.js";
import { registerGtmTools } from "./tools/gtm.js";
import { registerOpportunityTools } from "./tools/opportunities.js";
import { registerRankTools } from "./tools/ranks.js";
import { registerRawTools } from "./tools/raw.js";
import { registerReportTools } from "./tools/reports.js";
import { registerSetupTools } from "./tools/setup.js";

// Fail at boot, not on the first URL, when RESTRICT_TO_CLIENT_DOMAINS has a typo.
restrictToClientDomains();

// An unknown SEO_DATA_PROVIDER never stops the server (D11): one stderr line here, then setup_status and
// every routed paid call report it, while free and DataForSEO-only tools keep working.
if (!seoDefaultProvider.ok) console.error(`crawlmark: ${seoDefaultProvider.message}`);
if (providerUrlNotice) console.error(providerUrlNotice);

const server = new McpServer(
  { name: "crawlmark", version: packageVersion(import.meta.url) },
  {
    instructions:
      "SEO audit and reporting tools across Google Search Console, GA4, DataForSEO, Lighthouse and axe-core. " +
      "Start with list_clients. If something isn't set up, call setup_status and give the user its next step; never ask them to paste credentials into the chat. Manage a client's competitors and tracked keywords with the add_/remove_/list_ tools; " +
      "suggest_competitors proposes more (show them to the user and add only the ones they confirm). " +
      "suggest_brand_terms infers the names people search a client by; confirm medium and low candidates with the user before add_brand_terms. For routine work use monthly_report and run_audit; use the lower-level tools for follow-up questions. " +
      "Tools marked paid spend DataForSEO credit or Ahrefs/Semrush API units (whichever is the client's data provider) and are capped per client per month; prefer the free Google tools when they answer the question. " +
      "Results are cached, so re-running a report is cheap.",
  },
);

registerReportTools(server);
registerCompetitorTools(server);
registerBrandTools(server);
registerOpportunityTools(server);
registerRankTools(server);
registerGtmTools(server);
registerCrawlTools(server);
registerRawTools(server);
registerSetupTools(server);
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
