/**
 * create_report_template / update_report_template (Phase 13 C, D18, D19). Without confirmToken a call only
 * proposes: it validates, returns the template's YAML, a diff of the target file, the paid sections with
 * this client's estimates and a single-use token (15 minutes), and writes nothing but the token to the local
 * cache. With the token, the same arguments, an unchanged file and (for paid sections) paidAcknowledged: true,
 * it saves. When the MCP client supports elicitation the user is also asked directly, and only "accept" +
 * save: true writes. Only template files are written: never branding, defaults.template, clients.yaml or
 * secrets.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveClient } from "../clients.js";
import { HOME } from "../config.js";
import type { Client } from "../lib/clients.js";
import { estimateSectionsFor, estimateText } from "../reports/templates/builder.js";
import { argumentsHash, checkProposal, consumeProposal, createProposal, ProposalError } from "../reports/templates/proposals.js";
import { loadDefaultRunDeps, type SectionEstimate } from "../reports/templates/run.js";
import type { TemplateSpec } from "../reports/templates/schema.js";
import { applyTemplateWrite, planTemplateWrite, TemplateFileChangedError, TemplateWriteError, type TemplatePatch, type TemplateWritePlan } from "../reports/templates/write.js";
import { stripControl } from "../lib/terminal-text.js";
import { handler } from "./util.js";

export type TemplateTool = "create_report_template" | "update_report_template";

export interface TemplateWriteArgs {
  client?: string | undefined;
  file?: "global" | "client" | undefined;
  id: string;
  template?: Record<string, unknown> | undefined;
  patch?: TemplatePatch | undefined;
  replace?: boolean | undefined;
  confirmToken?: string | undefined;
  paidAcknowledged?: boolean | undefined;
}

export interface TemplateWriteDeps {
  homeDir: string;
  resolveClient(idOrDomain: string): Promise<Client>;
  /** Per-section estimates for this client (no provider request). */
  estimate(client: Client, template: TemplateSpec): Promise<Map<string, SectionEstimate[]>>;
  /** Ask the human directly (MCP elicitation). Undefined when the client doesn't support it. True only on accept + save. */
  elicit?: ((message: string) => Promise<boolean>) | undefined;
  today?: Date;
}

export interface PaidSectionOut {
  id: string;
  type: string;
  estimate: { usd: number; units: number; provider: string | null; text: string | null; note?: string } | null;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function planFor(tool: TemplateTool, args: TemplateWriteArgs, deps: TemplateWriteDeps, slug: string | undefined): TemplateWritePlan {
  if (tool === "update_report_template" && args.replace !== undefined) throw new TemplateWriteError("replace is only for create_report_template.", [{ path: "replace", message: "not used by update_report_template" }]);
  if (tool === "create_report_template" && args.patch !== undefined) throw new TemplateWriteError("create_report_template takes a whole template, not a patch.", [{ path: "patch", message: "only update_report_template takes a patch" }]);
  return planTemplateWrite({
    homeDir: deps.homeDir,
    file: args.file ?? "global",
    clientSlug: slug,
    id: args.id,
    mode: tool === "create_report_template" ? "create" : "update",
    template: args.template,
    patch: args.patch,
    replace: args.replace,
    ...(deps.today ? { today: deps.today } : {}),
  });
}

/**
 * Why a save needs the user's own answer (an elicitation dialog), not just the token (SEC-1). Without
 * elicitation the token is a two-step the model can finish on its own, so a model steered by injected text
 * (a crawled page, say) could otherwise hide a builtin, overwrite a template, add paid sections, or put its
 * own text into every client report. Simple additive templates without a text section need no dialog.
 */
export function dialogReasons(plan: Pick<TemplateWritePlan, "id" | "shadowsBuiltin" | "shadowsGlobal" | "replaces" | "paidSections" | "template">): string[] {
  const reasons: string[] = [];
  if (plan.shadowsBuiltin) reasons.push(`it hides the builtin "${plan.id}" template`);
  if (plan.shadowsGlobal) reasons.push(`it hides the global "${plan.id}" template for this client`);
  if (plan.replaces) reasons.push(`it changes the existing template "${plan.id}"`);
  if (plan.paidSections.length) reasons.push(`it has paid sections (${plan.paidSections.map((s) => s.id).join(", ")})`);
  const texts = plan.template.sections.filter((s) => s.type === "text").map((s) => s.id);
  if (texts.length) reasons.push(`it has free-text sections (${texts.join(", ")}) that appear in every report`);
  return reasons;
}

const NO_DIALOG_HELP =
  "This app can't ask the user to confirm directly (MCP elicitation), so crawlmark won't save it from here. The user can build it with `crawlmark-cli report templates new` in a terminal, or use an app that supports confirmation dialogs (Claude Code, for example).";

/** The elicitation text (SEC-2): what is saved, what it hides or replaces, the sections, and the start of any text section. */
export function confirmMessage(plan: TemplateWritePlan): string {
  const parts = [`Save template "${plan.id}" to ${plan.path}?`];
  if (plan.shadowsBuiltin) parts.push(`It hides the builtin "${plan.id}" template${plan.file === "client" ? " for this client" : ""}.`);
  else if (plan.replaces) parts.push("It replaces the template with this id in that file.");
  if (plan.shadowsGlobal) parts.push(`It hides the global "${plan.id}" template for this client.`);
  const paid = paidLine(plan).trim();
  if (paid) parts.push(paid);
  parts.push(`Sections: ${plan.template.sections.map((s) => `${s.id} (${s.type})`).join(", ")}.`);
  for (const s of plan.template.sections) {
    if (s.type !== "text") continue;
    const clean = stripControl(s.text).replace(/\s+/g, " ").trim();
    parts.push(`Text in "${s.id}": "${clean.length > 200 ? `${clean.slice(0, 200)}...` : clean}"`);
  }
  return parts.join(" ");
}

function paidLine(plan: TemplateWritePlan): string {
  return plan.paidSections.length ? ` It includes ${plural(plan.paidSections.length, "paid section")} (${plan.paidSections.map((s) => s.id).join(", ")}).` : "";
}

/** The tool call itself (exported for tests; the MCP layer only adds elicitation and the result envelope). */
export async function templateWriteCall(tool: TemplateTool, args: TemplateWriteArgs, deps: TemplateWriteDeps): Promise<unknown> {
  const file = args.file ?? "global";
  if (file === "client" && !args.client) throw new Error('file: "client" needs a client.');
  const client = args.client ? await deps.resolveClient(args.client) : undefined;
  const slug = file === "client" ? client!.slug : undefined;
  const argsHash = argumentsHash(tool, { ...args });

  let plan: TemplateWritePlan;
  try {
    plan = planFor(tool, args, deps, slug);
  } catch (err) {
    if (err instanceof TemplateWriteError && args.confirmToken === undefined) return { proposal: true, valid: false, errors: err.errors.length ? err.errors : [{ path: "", message: err.message }], message: `Not valid, nothing saved: ${err.message}` };
    throw err;
  }

  if (args.confirmToken === undefined) {
    let estimates = new Map<string, SectionEstimate[]>();
    if (client && plan.paidSections.length) {
      try {
        estimates = await deps.estimate(client, plan.template);
      } catch {
        // No estimate (for example no provider configured): the paid sections are listed without a number.
      }
    }
    const paidSections: PaidSectionOut[] = plan.paidSections.map((s) => {
      const es = estimates.get(s.id);
      if (!es?.length) return { ...s, estimate: null };
      const first = es[0]!;
      return {
        ...s,
        estimate: {
          usd: Number(es.reduce((a, e) => a + e.usd, 0).toFixed(4)),
          units: es.reduce((a, e) => a + e.units, 0),
          provider: first.provider,
          text: estimateText(es),
          ...(first.note ? { note: first.note } : {}),
        },
      };
    });
    const { token, expiresAt } = createProposal({ tool, path: plan.path, beforeHash: plan.beforeHash, afterHash: plan.afterHash, client: client?.slug ?? null, argsHash, paid: plan.paidSections.length > 0 });
    const costs = paidSections.map((p) => `${p.id}: ${p.estimate?.text ?? (client ? "no estimate available" : "paid; pass client for an estimate")} every time the report runs with --paid / allowPaid`);
    return {
      proposal: true,
      saved: false,
      path: plan.path,
      exists: plan.exists,
      replaces: plan.replaces,
      yaml: plan.yaml,
      diff: plan.diff,
      valid: true,
      warnings: plan.warnings,
      paidSections,
      shadowsBuiltin: plan.shadowsBuiltin,
      shadowsGlobal: plan.shadowsGlobal,
      confirmToken: token,
      expiresAt,
      message:
        `Nothing saved yet. Show the user the YAML and the diff for ${plan.path} and ask whether to save it.` +
        (paidSections.length
          ? ` It has ${plural(paidSections.length, "paid section")}: ${costs.join("; ")}. Ask about each one by name and cost; pass paidAcknowledged: true only after the user explicitly agreed to them in this conversation, otherwise remove them and propose again.`
          : "") +
        (plan.shadowsBuiltin ? ` It hides the builtin "${plan.id}" template${file === "client" ? " for this client" : ""}.` : "") +
        (plan.shadowsGlobal ? ` It hides the global "${plan.id}" template for this client.` : "") +
        (!deps.elicit && dialogReasons(plan).length ? ` Saving it from here will be refused because ${dialogReasons(plan).join("; ")} and this app can't ask the user directly: tell the user to run \`crawlmark-cli report templates new\` in a terminal instead (or use an app with confirmation dialogs).` : "") +
        ` To save, call ${tool} again with exactly the same arguments plus confirmToken (valid 15 minutes, once).`,
    };
  }

  // Confirm: same tool, same arguments, an unexpired unused token.
  const binding = checkProposal(args.confirmToken, { tool, argsHash });
  if (binding.paid && args.paidAcknowledged !== true) {
    throw new ProposalError(`Not saved: the template has ${plural(plan.paidSections.length, "paid section")} (${plan.paidSections.map((s) => s.id).join(", ")}). Pass paidAcknowledged: true only after the user explicitly agreed to them; otherwise remove them and propose again.`);
  }
  if (binding.path !== plan.path) throw new ProposalError("The target file differs from the proposal. Propose again.");
  if (binding.beforeHash !== plan.beforeHash) {
    consumeProposal(args.confirmToken);
    throw new TemplateFileChangedError(`${plan.path} changed since the proposal; nothing was written. Propose again and show the user the new diff.`);
  }
  if (binding.afterHash !== plan.afterHash) {
    consumeProposal(args.confirmToken);
    throw new ProposalError("The result differs from the proposal; nothing was written. Propose again.");
  }
  if (!deps.elicit) {
    const reasons = dialogReasons(plan);
    if (reasons.length) throw new ProposalError(`Not saved: ${reasons.join("; ")}, so the user must confirm it themselves. ${NO_DIALOG_HELP}`);
  } else {
    const ok = await deps.elicit(confirmMessage(plan));
    if (!ok) {
      consumeProposal(args.confirmToken);
      throw new ProposalError("Not saved: the user declined.");
    }
  }
  if (!consumeProposal(args.confirmToken)) throw new ProposalError("Unknown or already used confirmToken. Propose the template again.");
  const written = applyTemplateWrite(plan, deps.homeDir, deps.today);
  return { saved: true, path: written.path, backup: written.backup, template: plan.id, validate: { valid: true, warnings: plan.warnings } };
}

// ------------------------------------------------------------------ MCP registration

const sectionLike = z.record(z.string(), z.unknown());
const templateArg = z
  .record(z.string(), z.unknown())
  .describe(
    "The template as JSON, validated with the template schema: { title, description?, period?: { range: last_month | last_quarter | last_n_days (days) | custom (start, end) }, compare?: [previous_period, previous_year], layout?: standard | onepage, sections: [{ id, type, optional?, paid?, title?, ...type options }] }. " +
      "Section types and what they cost: get_report_template's `catalogue`. Paid section types need paid: true. Prefer optional: true for paid sections.",
  );

const common = {
  client: z.string().optional().describe("Client domain or clients.yaml slug: needed for file: \"client\", and gives per-client cost estimates for paid sections."),
  file: z.enum(["global", "client"]).optional().describe("Where to save: the global templates file (default) or the client's own file."),
  id: z.string().min(1).max(40).describe("Template id: lowercase letters, digits and hyphens (e.g. board)."),
  confirmToken: z.string().max(40).optional().describe("Only after the user said yes to the proposal you showed them: the token from the proposal call, with exactly the same other arguments."),
  paidAcknowledged: z
    .boolean()
    .optional()
    .describe("With confirmToken, when the proposal has paid sections: true only if the user explicitly agreed to those paid sections (by name and cost) in this conversation. Never set it on your own."),
};

const DESCRIPTION_TAIL =
  " Two steps, always: (1) call without confirmToken: nothing is saved; you get the template's YAML, a diff of the file, paid sections with estimates and a confirmToken (15 minutes, single use). Show the user the YAML and diff and ask. " +
  "(2) Only after the user says yes, call again with exactly the same arguments plus confirmToken (and paidAcknowledged: true if it has paid sections the user explicitly agreed to). " +
  "Saving fails if the file changed since the proposal. Clients that support it also ask the user directly before saving. Writes only report template files (never branding, clients.yaml or settings); comments in the file are kept and the previous version is saved as <file>.bak. Free and local.";

export function registerTemplateWriteTools(server: McpServer, opts: { homeDir?: string } = {}) {
  const homeDir = opts.homeDir ?? HOME.dir;
  const elicitFor = (): TemplateWriteDeps["elicit"] => {
    const caps = server.server.getClientCapabilities()?.elicitation as { form?: unknown; url?: unknown } | undefined;
    if (!caps || (caps.form === undefined && caps.url !== undefined)) return undefined;
    return async (message) => {
      const r = await server.server.elicitInput({
        mode: "form",
        message,
        requestedSchema: {
          type: "object",
          properties: { save: { type: "boolean", title: "Save this template", description: "Yes writes the template file; no saves nothing.", default: false } },
          required: ["save"],
        },
      });
      return r.action === "accept" && (r.content as { save?: unknown } | undefined)?.save === true;
    };
  };
  const deps = (): TemplateWriteDeps => ({
    homeDir,
    resolveClient,
    estimate: async (client, template) => estimateSectionsFor(client, template.sections, await loadDefaultRunDeps(), { period: template.period, compare: template.compare }),
    elicit: elicitFor(),
  });
  const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

  server.registerTool(
    "create_report_template",
    {
      title: "Create a report template",
      description:
        "Draft a new report template from the user's request and save it to the global template file or a client's file, only after the user confirms. " +
        "Pick sections from get_report_template's `catalogue` (free and paid types, what each needs). Never add a paid section unless the user asked for it; when they did, say what it costs per run (the proposal's paidSections estimates)." +
        DESCRIPTION_TAIL,
      inputSchema: {
        ...common,
        template: templateArg,
        replace: z.boolean().optional().describe("Overwrite a template with this id in that file, or save your own copy of a builtin (monthly, quarterly, executive, technical, local) that then hides it."),
      },
      annotations,
    },
    handler("create_report_template", async (args) => templateWriteCall("create_report_template", args as TemplateWriteArgs, deps())),
  );

  server.registerTool(
    "update_report_template",
    {
      title: "Update a report template",
      description:
        "Change a template that is already in the global template file or a client's file: either the whole `template`, or a `patch` (addSections, removeSectionIds, set title/description/period/compare/layout; null in set removes a field). " +
        "Builtin templates aren't in a file: copy one with create_report_template and replace: true instead." +
        DESCRIPTION_TAIL,
      inputSchema: {
        ...common,
        template: templateArg.optional(),
        patch: z
          .object({
            addSections: z.array(sectionLike).max(40).optional(),
            removeSectionIds: z.array(z.string().min(1).max(40)).max(40).optional(),
            set: z
              .object({ title: z.unknown().optional(), description: z.unknown().optional(), period: z.unknown().optional(), compare: z.unknown().optional(), layout: z.unknown().optional() })
              .strict()
              .optional(),
          })
          .strict()
          .optional()
          .describe("Instead of template: the changes to make. Give exactly one of template or patch."),
      },
      annotations,
    },
    handler("update_report_template", async (args) => templateWriteCall("update_report_template", args as TemplateWriteArgs, deps())),
  );
}
