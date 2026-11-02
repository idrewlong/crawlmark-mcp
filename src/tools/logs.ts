import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveClient } from "../clients.js";
import { env, HOME } from "../config.js";
import { BOT_NAMES } from "../analysis/bots.js";
import { existingDirs, LogAccessError, logDirsFrom, resolveAllowedLogFiles } from "../lib/log-files.js";
import { googleCrawlerRanges } from "../providers/crawler-ipranges.js";
import { analyzeLogs } from "../reports/log-analysis.js";
import { handler, READ_ONLY } from "./util.js";
import { cliHint } from "../lib/cli-hint.js";

/**
 * Server-log analysis (Phase 12 C2). Reads only files inside LOG_DIRS or <home>/logs on
 * this machine; returns aggregates (no IPs, user agents or raw lines); writes nothing.
 */

const clientArg = z
  .string()
  .describe("Client domain (e.g. 'example.com'; URL and www. forms also work) or a clients.yaml slug. See list_clients.");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const LOG_TIMEOUT_MS = 10 * 60_000;

/** The setup hint when no log directory is allowed. */
export const LOG_DIRS_HINT =
  "log_analysis reads only directories you allow. Set LOG_DIRS to one or more absolute directories, comma-separated (for example LOG_DIRS=/var/log/nginx), " +
  `in your crawlmark .env or MCP config, or copy the logs into the logs folder of your crawlmark home. Or run ${cliHint()} logs --client <domain> <file>... in a terminal.`;

export function registerLogTools(server: McpServer) {
  server.registerTool(
    "log_analysis",
    {
      title: "Server log analysis (local)",
      description:
        "Summarise crawler traffic from access logs on this machine (Apache/Nginx combined or common format, .gz too): hits per bot (Googlebot, Bingbot, GPTBot, OAI-SearchBot, ChatGPT-User, " +
        "ClaudeBot, Claude-SearchBot, Claude-User, PerplexityBot, Perplexity-User, CCBot, Applebot, Amazonbot, Bytespider, Meta-ExternalAgent and others) with family (search, ai-training, ai-search, ai-user), " +
        "status classes, top paths, top 404s and 5xx, hits per day, the share of parameter URLs and when each was last seen. Googlebot-family hits are verified against Google's published crawler IP ranges " +
        "(downloaded at most weekly; nothing about you is sent); other bots can't be verified this way. Reads only files inside LOG_DIRS or the crawlmark home's logs folder (names or globs relative to them; " +
        "symlinks out are refused). Logs never leave the machine; IP addresses, user agents and referrers are never returned or stored. Free.",
      inputSchema: {
        client: clientArg,
        files: z.array(z.string().min(1).max(500)).min(1).max(50).describe("File names or globs relative to an allowed log directory, e.g. ['access.log*'] or ['nginx/example.com.access.log']."),
        since: day.optional().describe("YYYY-MM-DD, first day to count (UTC)."),
        until: day.optional().describe("YYYY-MM-DD, last day to count (UTC)."),
        bots: z.array(z.string().min(1).max(50)).min(1).max(30).optional().describe(`Only these bots. Known: ${BOT_NAMES.join(", ")}.`),
        verify: z.boolean().optional().describe("Verify Googlebot-family IPs against Google's published ranges. Default true; false makes no network request."),
      },
      annotations: READ_ONLY,
    },
    handler(
      "log_analysis",
      async ({ client, files, since, until, bots, verify }, { signal }) => {
        const c = await resolveClient(client);
        const { dirs, ignored } = logDirsFrom(env.LOG_DIRS, HOME.dir);
        const allowed = await existingDirs(dirs);
        if (!allowed.length) throw new LogAccessError(LOG_DIRS_HINT);
        const notes = ignored.map((d) => `LOG_DIRS entry "${d}" isn't an absolute path, so it was ignored.`);
        const resolved = await resolveAllowedLogFiles(files, allowed);
        if (!resolved.files.length) throw new LogAccessError(`No log file matched ${files.join(", ")} in the allowed log directories.`);
        return analyzeLogs(c.slug, resolved.files, { since, until, bots, verify, signal }, { googleRanges: (s) => googleCrawlerRanges({ signal: s }) }, [...notes, ...resolved.notes]);
      },
      { timeoutMs: LOG_TIMEOUT_MS },
    ),
  );
}
