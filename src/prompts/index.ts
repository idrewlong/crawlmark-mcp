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

/** Load a template and replace each `{{name}}` with its value. Unknown placeholders are left as-is. */
export function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, name: string) => vars[name] ?? match);
}

function template(name: string, vars: Record<string, string>): string {
  return renderTemplate(readFileSync(new URL(`${name}.md`, TEMPLATES), "utf8"), vars);
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
    "client-health-check",
    {
      title: "Client health check",
      description:
        "Check a client's setup: its sources and missing pieces, then one cheap live check each for Search Console, GA4, Chrome and DataForSEO, and what to fix. Useful when onboarding.",
      argsSchema: { client: clientArg },
    },
    ({ client }) => text(template("client-health-check", { client: client.trim() })),
  );
}
