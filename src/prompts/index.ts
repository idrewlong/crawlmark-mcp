import { readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * MCP prompts. Prompt text lives in markdown under ./templates so it can be
 * edited without touching code; the build copies it to dist/prompts/templates.
 * Templates are read on each request, so wording edits apply without a restart
 * when running from src (npm run dev) or after a rebuild.
 */

const TEMPLATES = new URL("./templates/", import.meta.url);

/**
 * Number-reading rules shared by monthly-report-writeup and template-report (Phase 12): one string,
 * rendered into both templates as {{numberRules}}, so the two never drift.
 */
export const NUMBER_RULES = [
  "   - No jargon without a one-line explanation the first time it appears (impressions, CTR, average position, striking distance).",
  "   - Round numbers sensibly (whole clicks, one decimal for position and rates).",
  '   - Every percentage change goes next to the absolute numbers it comes from, for example "clicks rose 12% (from 1,000 to 1,120)". Never give a percent change on its own.',
  '   - Say "average position" went from 8.2 to 7.5 (lower is better) rather than calling it a rise or fall.',
  "   - Search Console counts anonymized queries in the totals but not in the query-level tables, so the query tables (and the branded split) won't add up to the totals. Mention this once if you quote both.",
].join("\n");

/**
 * The Google Docs handoff (Phase 12, user decision 2): offered only when the conversation has a Drive
 * tool that can create files, and only acted on after the user says yes. crawlmark never writes to Google.
 */
export const DOCS_OFFER =
  "**Google Docs (only if available).** Only if this conversation has a Google Drive tool that can create files (for example one named \"create_file\"): ask whether to save the report as a Google Doc in their Drive, and say that this puts the report in their Google Drive. " +
  "Only after a yes: call `export_report` with the same `reportId`, `formats: []` (so no file is written again), `inline: \"html\"` and the same `narrative`, then call the Drive tool with `title` = the inline `title`, `textContent` = the inline `content`, `contentMimeType: \"text/html\"`, and no `parentId` unless the user names a folder. " +
  "Don't share the file or change its permissions. If no such tool is available, don't mention Google Docs. If the Drive call fails, give the error and the local file path instead.";

/** "2026-09", "2026-Q3" or "2026-07-01..2026-09-30" as run_report_template arguments. */
export function periodArgs(period: string | undefined): { arg: string; label: string } {
  const p = period?.trim();
  if (!p) return { arg: "", label: "for the template's default period" };
  if (/^\d{4}-\d{2}$/.test(p)) return { arg: `, \`month: "${p}"\``, label: `for ${p}` };
  if (/^\d{4}-Q[1-4]$/i.test(p)) return { arg: `, \`quarter: "${p.toUpperCase()}"\``, label: `for ${p.toUpperCase()}` };
  const m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(p);
  if (m) return { arg: `, \`startDate: "${m[1]}"\`, \`endDate: "${m[2]}"\``, label: `for ${m[1]} to ${m[2]}` };
  throw new Error("period must be YYYY-MM, YYYY-Qn or YYYY-MM-DD..YYYY-MM-DD");
}

/** Load a template and replace each `{{name}}` with its value. Unknown placeholders are left as-is. */
export function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, name: string) => vars[name] ?? match);
}

function template(name: string, vars: Record<string, string>): string {
  return renderTemplate(readFileSync(new URL(`${name}.md`, TEMPLATES), "utf8"), vars);
}

/** The keyword-research prompt's step 2: confirm the seeds passed in, or propose some (Phase 12 B). */
export function keywordResearchVars(client: string, seeds: string | undefined): Record<string, string> {
  const list = (seeds ?? "")
    .split(/[,;\n]/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 20);
  const shown = list.map((s) => `"${s.replace(/["`]/g, "")}"`).join(", ");
  return {
    client,
    scope: list.length ? `keyword ideas from the seeds ${shown}, or a competitor keyword gap` : "keyword ideas from seed keywords, or a competitor keyword gap",
    seedStep: list.length
      ? `Use these seeds for \`keyword_ideas\`: ${shown}. Ask whether I want \`related\` ideas (searches related to the seeds, the default) or \`matching\` ones (keywords containing a seed), and the limit (default 50). If I'd rather see a competitor gap, use \`keyword_gap\` with the saved competitors (or the ones I name) instead.`
      : "Ask whether I want keyword ideas or a competitor gap. For ideas, propose 3-5 non-branded seed keywords from the niche, the tracked keywords and the top pages (never the brand name), and confirm them with me; ask for `related` (the default) or `matching`, and the limit (default 50). For a gap, use the saved competitors (at most 3 by default) or the ones I name; if none are saved, suggest running the find-competitors prompt first.",
  };
}

export function registerPrompts(server: McpServer) {
  server.registerPrompt(
    "find-competitors",
    {
      title: "Find competitors",
      description:
        "Walk through confirming a client's area and niche, getting competitor suggestions with evidence, and saving the ones you choose.",
      argsSchema: { client: z.string().describe("Client domain, e.g. example.com, or a clients.yaml slug.") },
    },
    ({ client }) => ({
      messages: [{ role: "user", content: { type: "text", text: template("find-competitors", { client: client.trim() }) } }],
    }),
  );

  server.registerPrompt(
    "review-brand-terms",
    {
      title: "Review brand terms",
      description:
        "Walk through automatically inferred brand terms for one client (or every client), confirm the uncertain ones with you, and save the ones you accept.",
      argsSchema: { client: z.string().optional().describe("Client domain or clients.yaml slug. Leave empty to review every client.") },
    },
    ({ client }) => {
      const c = client?.trim();
      const scope = c
        ? `the client \`${c}\``
        : "every client (call `list_clients` first and take them one at a time, in the order listed)";
      return { messages: [{ role: "user", content: { type: "text", text: template("review-brand-terms", { scope, client: c ?? "each client" }) } }] };
    },
  );

  const clientArg = z.string().describe("Client domain, e.g. example.com, or a clients.yaml slug.");
  const text = (t: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: t } }] });

  server.registerPrompt(
    "monthly-report-writeup",
    {
      title: "Monthly report write-up",
      description:
        "Pull a client's monthly_report and write a plain-language, client-facing report: summary, what went up and down and why, branded vs non-branded, issues fixed, top 3 opportunities and next month's priorities.",
      argsSchema: { client: clientArg, month: z.string().regex(/^\d{4}-\d{2}$/, "Use YYYY-MM.").optional().describe("YYYY-MM. Defaults to the last complete month.") },
    },
    ({ client, month }) => {
      const m = month?.trim();
      return text(
        template("monthly-report-writeup", {
          client: client.trim(),
          period: m ? `for ${m}` : "for the last complete month",
          monthArg: m ? ` and \`month: "${m}"\`` : " and no `month` (it defaults to the last complete month)",
          exportMonthArg: m ? `, \`month: "${m}"\`` : " (no `month`, so the same last complete month)",
          numberRules: NUMBER_RULES,
          docsOffer: DOCS_OFFER,
        }),
      );
    },
  );

  server.registerPrompt(
    "template-report",
    {
      title: "Template report",
      description:
        "Build a client report from a report template (run_report_template), write commentary per section with the same number-reading rules as the monthly write-up, save it as Markdown, HTML, PDF or Word files (export_report), and offer a Google Doc only when a Drive tool is available and you agree. Free unless you ask for paid sections.",
      argsSchema: {
        client: clientArg,
        template: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "Use a template id such as monthly.").optional().describe("Template id (see list_report_templates). Leave empty to choose from the list."),
        period: z
          .string()
          .regex(/^(\d{4}-\d{2}|\d{4}-Q[1-4]|\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2})$/i, "Use YYYY-MM, YYYY-Qn or YYYY-MM-DD..YYYY-MM-DD.")
          .optional()
          .describe("YYYY-MM, YYYY-Qn or YYYY-MM-DD..YYYY-MM-DD. Defaults to the template's period."),
      },
    },
    ({ client, template: tpl, period }) => {
      const c = client.trim();
      const t = tpl?.trim();
      const p = periodArgs(period);
      return text(
        template("template-report", {
          client: c,
          templateNote: t ? ` (\`${t}\`)` : "",
          period: p.label,
          templateStep: t
            ? `Use the \`${t}\` template.`
            : `Call \`list_report_templates\` with \`client: "${c}"\`, show me the templates (id, title, period, optional sections) and ask which one to use before going on.`,
          templateArg: t ? `, \`template: "${t}"\`` : ", `template` set to the one I chose",
          periodArg: p.arg,
          numberRules: NUMBER_RULES,
          docsOffer: DOCS_OFFER,
        }),
      );
    },
  );

  server.registerPrompt(
    "audit-findings",
    {
      title: "Audit findings",
      description:
        "Use the latest stored audit (if under 7 days old) or run a new one, compare it with the previous audit, and write findings by severity with affected URLs, why they matter, fixes and a prioritized fix list.",
      argsSchema: { client: clientArg },
    },
    ({ client }) => text(template("audit-findings", { client: client.trim() })),
  );

  server.registerPrompt(
    "opportunity-review",
    {
      title: "Opportunity review",
      description:
        "Run the free Search Console opportunity tools (striking distance, quick wins, low CTR, cannibalization, declining pages) and write a prioritized action list with estimated click upside. Paid competitor checks are only offered, not run.",
      argsSchema: { client: clientArg },
    },
    ({ client }) => text(template("opportunity-review", { client: client.trim() })),
  );

  server.registerPrompt(
    "getting-started",
    {
      title: "Getting started",
      description:
        "Check what's set up with setup_status (with the exact command for anything missing), explain what crawlmark can do, then pick the client with the most Search Console data and offer an opportunity review or a monthly report write-up. Never asks for credentials in chat.",
    },
    () => text(template("getting-started", {})),
  );

  server.registerPrompt(
    "client-health-check",
    {
      title: "Client health check",
      description:
        "Check a client's setup: its sources and missing pieces, then one cheap live check each for Search Console, GA4, Chrome and DataForSEO, and what to fix. Useful when onboarding.",
      argsSchema: { client: clientArg },
    },
    ({ client }) => text(template("client-health-check", { client: client.trim() })),
  );

  server.registerPrompt(
    "keyword-research",
    {
      title: "Keyword research",
      description:
        "Find keyword ideas from seed keywords, or the keywords competitors rank for and the client doesn't, through the client's SEO data provider. Always shows the estimate and the remaining cap first and runs the paid call only after you agree; then groups the results by intent and suggests which page should target each.",
      argsSchema: {
        client: clientArg,
        seeds: z.string().max(1000).optional().describe('Optional seed keywords, comma-separated, e.g. "emergency plumber, water heater repair".'),
      },
    },
    ({ client, seeds }) => text(template("keyword-research", keywordResearchVars(client.trim(), seeds))),
  );
}
