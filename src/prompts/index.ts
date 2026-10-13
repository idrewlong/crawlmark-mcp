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
}
