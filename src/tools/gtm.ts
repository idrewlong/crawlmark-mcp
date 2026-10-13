import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveClient } from "../clients.js";
import { TIMEOUTS } from "../lib/timeout.js";
import { runGtmAudit } from "../reports/gtm.js";
import { handler, READ_ONLY } from "./util.js";

export function registerGtmTools(server: McpServer) {
  server.registerTool(
    "gtm_audit",
    {
      title: "Tag Manager container audit",
      description:
        "Audit a client's live (published) Tag Manager container: paused tags, tags with no firing trigger, legacy Universal Analytics tags, duplicate GA4 configuration / Google tags for one measurement ID, " +
        "unused variables and triggers, custom HTML tags (listed for review), and tags missing consent settings when Consent Mode is used elsewhere. Also counts unpublished workspace changes. " +
        "Findings carry severity medium or low. The container comes from clients.yaml (gtmAccountId, gtmContainerId) or is discovered by matching container domains; " +
        "needs Read access to the container in Tag Manager. Free (Google API only); cached for an hour.",
      inputSchema: {
        client: z
          .string()
          .describe("Client domain, e.g. 'example.com' (URL and www. forms also work), or a clients.yaml slug. Use list_clients to see options."),
        refresh: z.boolean().optional().describe("Bypass the one-hour cache and re-read the container from Tag Manager."),
      },
      annotations: READ_ONLY,
    },
    handler(
      "gtm_audit",
      async ({ client, refresh }: { client: string; refresh?: boolean | undefined }) => runGtmAudit(await resolveClient(client), { refresh: refresh ?? false }),
      { timeoutMs: TIMEOUTS.networkMs * 4 },
    ),
  );
}
