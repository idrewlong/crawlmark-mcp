#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerRawTools } from "./tools/raw.js";
import { registerReportTools } from "./tools/reports.js";

const server = new McpServer(
  { name: "seo-ops", version: "0.1.0" },
  {
    instructions:
      "SEO audit and reporting tools across Google Search Console, GA4, DataForSEO, Lighthouse and axe-core. " +
      "Start with list_clients. For routine work use monthly_report and run_audit; use the lower-level tools for follow-up questions. " +
      "Tools marked paid spend DataForSEO credit and are capped per client per month; prefer the free Google tools when they answer the question. " +
      "Results are cached, so re-running a report is cheap.",
  },
);

registerReportTools(server);
registerRawTools(server);

await server.connect(new StdioServerTransport());
// stdout is the MCP channel; log to stderr only.
console.error("seo-ops MCP server running on stdio");
