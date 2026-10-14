import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveClient } from "../clients.js";
import { env, HOME } from "../config.js";
import { allowedDirsFrom, existingDirs, LogAccessError, resolveAllowedLogFiles, type AccessLabel } from "../lib/log-files.js";
import { stripControl } from "../lib/terminal-text.js";
import { importPagesExport } from "../reports/pages-import.js";
import { handler } from "./util.js";

/**
 * import_index_report (2026-10-14): store Search Console's Pages report export for index_coverage and the
 * indexing_issues section. Reads one file inside IMPORT_DIRS or <home>/imports (the same containment, symlink and
 * hard-link rules as log_analysis); parses locally; never sends anything anywhere.
 */

const IMPORT_LABEL: AccessLabel = { file: "export file", dirs: "import directories" };

/** The setup hint when no import directory is allowed. */
export const IMPORT_DIRS_HINT =
  "import_index_report reads only folders you allow. Put the export in the imports folder of your crawlmark home, or set IMPORT_DIRS to one or more absolute directories, comma-separated " +
  "(for example IMPORT_DIRS=/Users/me/Downloads), in your crawlmark .env or MCP config. Or run crawlmark-cli index-coverage import --client <domain> <file> in a terminal.";

export function registerIndexImportTools(server: McpServer) {
  server.registerTool(
    "import_index_report",
    {
      title: "Import Search Console's Pages report",
      description:
        "Import an export of Search Console's Pages (Page indexing) report so index_coverage and the indexing_issues report section show Google's complete counts per reason. " +
        "Export it in Search Console → Indexing → Pages → Export (CSV gives a zip of CSV files; Excel .xlsx and a single CSV also work). The main page's export has the counts per reason; a reason's own page " +
        "exports up to 1,000 example URLs (import it too, with `reason` if the file doesn't say which). Reads only files inside IMPORT_DIRS or the crawlmark home's imports folder (a name relative to it, or an absolute path inside it; " +
        "symlinks and hard links out are refused; at most 25 MB). Checks the export is for the client's Search Console property. Parsed on this machine; free; importing the same export again replaces it. A summary export that doesn't name its site needs confirmProperty, which you set only after the user confirms it's this client's.",
      inputSchema: {
        client: z.string().describe("Client domain (e.g. 'example.com'; URL and www. forms also work) or a clients.yaml slug. See list_clients."),
        path: z.string().min(1).max(500).describe("The export file, relative to an allowed import folder (e.g. 'example.com-Coverage-2026-10-14.zip') or an absolute path inside one."),
        reason: z.string().min(1).max(200).optional().describe("For a reason's drilldown export whose file doesn't name the reason, e.g. 'Crawled - currently not indexed'."),
        confirmProperty: z.boolean().optional().describe("Only when the user confirms the file is this client's: a summary export whose name and metadata don't say which site it's for is refused without it."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler("import_index_report", async ({ client, path, reason, confirmProperty }) => {
      const c = await resolveClient(client);
      if (/[*?]/.test(path)) throw new LogAccessError("Give one export file, without wildcards.");
      const { dirs, ignored } = allowedDirsFrom(env.IMPORT_DIRS, HOME.dir, "imports");
      const allowed = await existingDirs(dirs);
      if (!allowed.length) throw new LogAccessError(IMPORT_DIRS_HINT);
      const resolved = await resolveAllowedLogFiles([path], allowed, 1, IMPORT_LABEL);
      const file = resolved.files[0];
      if (!file) throw new LogAccessError(`No readable export file ${stripControl(path).slice(0, 300)} inside the allowed import directories.`);
      const r = await importPagesExport(c, file, { reason, confirmProperty, now: Date.now() });
      return { ...r, notes: [...ignored.map((d) => `IMPORT_DIRS entry "${d}" isn't an absolute path, so it was ignored.`), ...r.notes] };
    }),
  );
}
