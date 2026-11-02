import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { setupStatus } from "../setup/status-providers.js";
import { handler, READ_ONLY } from "./util.js";
import { cliHint } from "../lib/cli-hint.js";

export function registerSetupTools(server: McpServer) {
  server.registerTool(
    "setup_status",
    {
      title: "Setup status",
      description:
        "Free. Reports, for each integration (config home, DataForSEO, the default data provider, Ahrefs, Semrush, Google, Search Console, GA4, Tag Manager, PageSpeed Insights key, Chrome, clients), " +
        "whether it is `working`, `configured` (set but not verified), `missing` or in `error`, with a plain-language detail and the exact next step " +
        `(a command for the user to run in a terminal, or a URL). Live checks are cheap (DataForSEO's free account check, a Google token check, ` +
        "cached property lists, one headless Chrome launch) and the whole result is cached for 60 seconds; `refresh: true` re-checks. Never returns secrets. " +
        "Never ask the user to paste credentials into the chat: send them to the `next` command. Commands in `next` already use the result's `cli` field, " +
        `which is how to run the crawlmark command line on this machine (for this install: \`${cliHint()}\`; it may also carry a CRAWLMARK_HOME prefix); use \`cli\` rather than a bare command name when writing any other command. ` +
        "Also reports the default SEO data provider (seoprovider row: which of DataForSEO, Ahrefs, Semrush is the default, where the setting comes from, and which are configured), " +
        "repeated as the top-level `seoDataProvider` object, plus `ahrefs` and `semrush` rows. The provider is changed in a terminal with the command in its next field, never through chat.",
      inputSchema: { refresh: z.boolean().optional().describe("Re-run the checks instead of using the 60-second cache.") },
      annotations: READ_ONLY,
    },
    handler("setup_status", ({ refresh }: { refresh?: boolean | undefined }) => setupStatus({ refresh: refresh ?? false }), { timeoutMs: 120_000 }),
  );
}
