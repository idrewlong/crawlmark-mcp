/**
 * `crawlmark-cli report templates new` (Phase 13 C): build a report template by picking sections. Asks for
 * an id and title, the sections (grouped, each labelled free or paid with this client's estimate), confirms
 * each paid section (default No), which sections are optional, the period, comparisons, layout and (when the
 * file has none) default formats; then shows a one-page preview with sample example.com data and the diff of
 * the file, and loops "change something" until the user saves or cancels. Nothing is written until save (a
 * dry run writes only the preview). All prompts go through the Ui/Prompter pair (clack when fancy, plain
 * text otherwise); every backend step comes in through BuilderDeps.
 */
import type { Prompter, Choice, ChoiceGroup } from "../../setup/prompter.js";
import type { Ui } from "../../setup/ui.js";
import { costLabel, defaultSection, estimateText, GROUP_ORDER, GROUP_LABELS, type CatalogueEntry } from "./builder.js";
import type { SectionEstimate } from "./run.js";
import { BUILTIN_TEMPLATES } from "./builtin.js";
import { ID_RE, MAX_SPAN_DAYS, type Comparison, type Format, type Period, type SectionSpec, type SectionType, type TemplateSpec } from "./schema.js";
import { TemplateFileChangedError, TemplateWriteError, type TemplateWritePlan } from "./write.js";

export interface BuilderTarget {
  path: string;
  /** Template ids already in that file. */
  ids: string[];
  /** The file sets defaults.formats. */
  hasDefaultFormats: boolean;
  valid: boolean;
}

export interface BuilderDeps {
  ui: Ui;
  prompt: Prompter;
  /** How to run crawlmark-cli on this machine (for the closing hint). */
  cliDisplay: string;
  /** --client: the client whose file it may go to and whose costs are shown. */
  client?: { slug: string; domain: string } | undefined;
  file: "global" | "client";
  replace: boolean;
  dryRun: boolean;
  catalogue: CatalogueEntry[];
  /** Estimates per paid section type for the client (no provider request). Only called with a client. */
  estimates(): Promise<Map<SectionType, SectionEstimate[]>>;
  target(): BuilderTarget;
  /** Plan the write (validates; throws TemplateWriteError). Writes nothing. */
  plan(id: string, spec: TemplateSpec, opts: { defaultFormats?: Format[] | undefined }): TemplateWritePlan;
  /** Render the preview with sample data; returns the file. */
  preview(id: string, spec: TemplateSpec): Promise<{ path: string; logoWarning?: string }>;
  /** Open a file in the default app (fancy mode on a terminal only). */
  openPath?: ((path: string) => boolean) | undefined;
  /** Write the planned change (checks the file is unchanged). */
  save(plan: TemplateWritePlan): { path: string; backup: string | null };
}

const MAX_ATTEMPTS = 3;
const FORMAT_CHOICES: Choice<Format>[] = [
  { value: "pdf", label: "PDF" },
  { value: "docx", label: "Word (.docx)" },
  { value: "html", label: "HTML" },
  { value: "md", label: "Markdown" },
];
type PeriodChoice = "last_month" | "last_quarter" | "last_28_days" | "last_n_days";
const PERIOD_CHOICES: readonly Choice<PeriodChoice>[] = [
  { value: "last_month", label: "Last month" },
  { value: "last_quarter", label: "Last quarter" },
  { value: "last_28_days", label: "Last 28 days" },
  { value: "last_n_days", label: "Custom: the last N days" },
];
const COMPARE_CHOICES: Choice<Comparison>[] = [
  { value: "previous_period", label: "The previous period" },
  { value: "previous_year", label: "The same period a year earlier" },
];
type Change = "details" | "sections" | "optional" | "period" | "compare" | "layout" | "formats";

interface Draft {
  id: string;
  title: string;
  types: SectionType[];
  text?: string | undefined;
  optional: Set<SectionType>;
  period: Period;
  compare: Comparison[];
  layout: "standard" | "onepage";
  defaultFormats?: Format[] | undefined;
  /** Sections the optional question has already been asked about (new paid ones start optional). */
  optionalSeen: Set<SectionType>;
}

/** Thrown when the user gave up on a question (three bad answers): nothing is written. */
class GaveUp extends Error {}

const titleFromId = (id: string) => id.replace(/-+/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** The draft as a template spec (pure). Paid sections carry paid: true; Tag Manager is always optional. */
export function draftSpec(d: { title: string; types: readonly SectionType[]; text?: string | undefined; optional: ReadonlySet<SectionType>; period: Period; compare: readonly Comparison[]; layout: "standard" | "onepage" }): TemplateSpec {
  const sections: SectionSpec[] = d.types.map((t) => {
    const s = defaultSection(t, t === "text" && d.text ? { text: d.text } : {});
    if (!d.optional.has(t) && t !== "tag_manager") return s;
    // optional right after the type, as in the builtin templates ({ id, type, optional, paid }).
    const { id, type, ...rest } = s as SectionSpec & Record<string, unknown>;
    return { id, type, optional: true, ...rest } as SectionSpec;
  });
  return { title: d.title, period: d.period, compare: [...d.compare], ...(d.layout === "onepage" ? { layout: "onepage" as const } : {}), sections };
}

export async function runTemplateBuilder(deps: BuilderDeps): Promise<number> {
  const { ui, prompt } = deps;
  ui.step("New report template");
  const target = deps.target();
  if (!target.valid) {
    ui.fail(`${target.path} has errors; fix it first (${deps.cliDisplay} report templates validate). Nothing was changed.`);
    return 1;
  }
  ui.info(deps.file === "client" ? `Saving to ${target.path} (${deps.client!.domain} only).` : `Saving to ${target.path} (every client).`);
  let estimates = new Map<SectionType, SectionEstimate[]>();
  if (deps.client) {
    try {
      estimates = await ui.spin(`Pricing the paid sections for ${deps.client.domain} (no requests, nothing spent)...`, () => deps.estimates());
    } catch (err) {
      ui.warn(`Couldn't price the paid sections: ${(err as Error).message.slice(0, 200)}. They are shown as paid without a number.`);
    }
  }
  const byType = new Map(deps.catalogue.map((c) => [c.type, c]));
  const priceOf = (t: SectionType) => estimateText(estimates.get(t));

  try {
    const draft: Draft = {
      id: await askId(deps, target),
      title: "",
      types: [],
      optional: new Set(),
      optionalSeen: new Set(),
      period: { range: "last_month" },
      compare: ["previous_period", "previous_year"],
      layout: "standard",
    };
    draft.title = await askTitle(prompt, draft.id);
    await askSections(deps, draft, byType, estimates, priceOf);
    await askOptional(prompt, draft, byType);
    draft.period = await askPeriod(prompt, ui, draft.period);
    draft.compare = await askCompare(prompt, draft.compare);
    draft.layout = await askLayout(prompt, draft.layout);
    if (!target.hasDefaultFormats) draft.defaultFormats = await askFormats(prompt, draft.defaultFormats);

    for (;;) {
      const spec = draftSpec(draft);
      let plan: TemplateWritePlan | undefined;
      try {
        plan = deps.plan(draft.id, spec, { defaultFormats: draft.defaultFormats });
      } catch (err) {
        if (!(err instanceof TemplateWriteError)) throw err;
        ui.fail(`This template isn't valid yet: ${err.message}`);
      }
      if (plan) {
        try {
          const p = await ui.spin("Making a one-page preview with sample data...", () => deps.preview(draft.id, spec));
          if (p.logoWarning) ui.warn(p.logoWarning);
          ui.info(`Preview (sample example.com data, not a client report): ${p.path}`);
          if (deps.openPath && ui.fancy && !deps.dryRun) {
            const a = await prompt.ask("Press Enter to open the preview (or s to skip)");
            if (a.trim() === "" && !deps.openPath(p.path)) ui.info(`Couldn't open it. The preview is ${p.path}`);
          }
        } catch (err) {
          ui.warn(`The preview couldn't be made: ${(err as Error).message.slice(0, 300)}`);
        }
        const lines = plan.diff.trimEnd().split("\n");
        ui.preview(`Changes to ${plan.path}`, lines.length > 80 ? [...lines.slice(0, 80), `... (${lines.length - 80} more lines)`] : lines);
        for (const w of plan.warnings) ui.warn(`${w.path ? `${w.path}: ` : ""}${w.message}`);
      }
      const next = await prompt.choose(
        plan ? "Save this template?" : "What next?",
        [...(plan ? [{ value: "save" as const, label: "Looks good, save" }] : []), { value: "change" as const, label: "Change something" }, { value: "cancel" as const, label: "Cancel (save nothing)" }],
        plan ? "save" : "change",
      );
      if (next === "cancel") {
        ui.result("skipped", "Nothing saved.");
        return 0;
      }
      if (next === "save" && plan) {
        if (deps.dryRun) {
          ui.result("done", `Dry run: would save template "${draft.id}" to ${plan.path}; nothing saved.`);
          return 0;
        }
        let written: { path: string; backup: string | null };
        try {
          written = deps.save(plan);
        } catch (err) {
          if (err instanceof TemplateFileChangedError) {
            ui.fail(err.message);
            return 1;
          }
          throw err;
        }
        ui.success(`Saved template "${draft.id}" (validated) to ${written.path}${written.backup ? `; the previous version is ${written.backup}` : ""}.`);
        const optional = plan.template.sections.filter((s) => s.optional).map((s) => s.id);
        const paid = plan.paidSections.length > 0;
        ui.result(
          "done",
          `Run it: ${deps.cliDisplay} report --client ${deps.client?.domain ?? "<domain>"} --template ${draft.id}` +
            (optional.length ? ` (optional sections: add --include ${optional.join(",")}${paid ? " and --paid for the paid ones" : ""})` : paid ? " --paid" : ""),
        );
        return 0;
      }
      const what = await prompt.choose<Change>(
        "What would you like to change?",
        [
          { value: "sections", label: "Sections" },
          { value: "optional", label: "Optional sections" },
          { value: "period", label: "Period" },
          { value: "compare", label: "Comparisons" },
          { value: "layout", label: "Layout" },
          { value: "details", label: "Id and title" },
          ...(!target.hasDefaultFormats ? [{ value: "formats" as const, label: "Default formats" }] : []),
        ],
        "sections",
      );
      if (what === "details") {
        draft.id = await askId(deps, target, draft.id);
        draft.title = await askTitle(prompt, draft.id, draft.title);
      } else if (what === "sections") {
        await askSections(deps, draft, byType, estimates, priceOf);
        await askOptional(prompt, draft, byType);
      } else if (what === "optional") await askOptional(prompt, draft, byType);
      else if (what === "period") draft.period = await askPeriod(prompt, ui, draft.period);
      else if (what === "compare") draft.compare = await askCompare(prompt, draft.compare);
      else if (what === "layout") draft.layout = await askLayout(prompt, draft.layout);
      else draft.defaultFormats = await askFormats(prompt, draft.defaultFormats);
    }
  } catch (err) {
    if (err instanceof GaveUp) {
      ui.result("failed", `${err.message} Nothing saved.`);
      return 1;
    }
    throw err;
  }
}

async function askId(deps: BuilderDeps, target: BuilderTarget, current?: string): Promise<string> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const id = (await deps.prompt.ask("Template id (lowercase letters, digits and hyphens, e.g. board)", { default: current })).trim();
    if (!ID_RE.test(id)) {
      deps.ui.fail(`"${id.slice(0, 40)}" isn't a valid id: 1-40 lowercase letters, digits and hyphens, starting with a letter or digit.`);
      continue;
    }
    if (target.ids.includes(id) && !deps.replace) {
      deps.ui.fail(`A template "${id}" is already in ${target.path}. Pick another id, or run with --replace to overwrite it.`);
      continue;
    }
    if (Object.hasOwn(BUILTIN_TEMPLATES, id) && !deps.replace) {
      deps.ui.fail(`"${id}" is a builtin template. Pick another id, or run with --replace to save your own "${id}" (it then hides the builtin one).`);
      continue;
    }
    return id;
  }
  throw new GaveUp("No usable template id.");
}

async function askTitle(prompt: Prompter, id: string, current?: string): Promise<string> {
  const t = (await prompt.ask("Title, shown on the report cover", { default: current ?? titleFromId(id) })).replace(/\s+/g, " ").trim();
  return (t || titleFromId(id)).slice(0, 120);
}

async function askSections(
  deps: BuilderDeps,
  draft: Draft,
  byType: Map<SectionType, CatalogueEntry>,
  estimates: Map<SectionType, SectionEstimate[]>,
  priceOf: (t: SectionType) => string | null,
): Promise<void> {
  const { prompt, ui } = deps;
  const domain = deps.client?.domain;
  const groups: ChoiceGroup<SectionType>[] = GROUP_ORDER.map((g) => ({
    label: GROUP_LABELS[g],
    choices: deps.catalogue.filter((c) => c.group === g).map((c) => ({ value: c.type, label: `${c.title} ${costLabel(c, estimates.get(c.type), domain)}` })),
  })).filter((g) => g.choices.length);
  const defaults: SectionType[] = draft.types.length ? draft.types : ["search_overview"];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const question = "Sections to include (paid ones cost money every time the report runs with --paid)";
    let picked = prompt.groupMultiselect
      ? await prompt.groupMultiselect(question, groups, defaults)
      : prompt.multiselect
        ? await prompt.multiselect(
            question,
            groups.flatMap((g) => g.choices.map((c) => ({ ...c, label: `${g.label}: ${c.label}` }))),
            defaults,
          )
        : defaults;
    // Each paid section once more, by name and cost; the default is No.
    const kept: SectionType[] = [];
    for (const t of picked) {
      const entry = byType.get(t);
      if (!entry?.paid || draft.types.includes(t)) {
        kept.push(t);
        continue;
      }
      const price = priceOf(t);
      const cost = price ? `It costs ${price} every time the report runs with --paid` : domain ? `It costs money every time the report runs with --paid (no estimate for ${domain} right now)` : "It costs money every time the report runs with --paid (the amount depends on the client's data provider)";
      if (await prompt.confirm(`Include ${entry.title}? ${cost}.`, false)) kept.push(t);
    }
    picked = kept;
    if (!picked.length) {
      ui.fail("Pick at least one section.");
      continue;
    }
    if (picked.includes("text")) {
      const text = (await prompt.ask("Text for the note section (one paragraph)", { default: draft.text })).replace(/\s+/g, " ").trim().slice(0, 2000);
      draft.text = text || "Notes for this report.";
    }
    draft.types = picked;
    for (const t of [...draft.optional]) if (!picked.includes(t)) draft.optional.delete(t);
    return;
  }
  throw new GaveUp("No sections picked.");
}

async function askOptional(prompt: Prompter, draft: Draft, byType: Map<SectionType, CatalogueEntry>): Promise<void> {
  const choices = draft.types.filter((t) => t !== "tag_manager").map((t) => ({ value: t, label: byType.get(t)?.title ?? t }));
  if (!choices.length) return;
  // Paid sections start optional (run only with --include); a section picked before keeps its setting.
  const defaults = draft.types.filter((t) => draft.optional.has(t) || (byType.get(t)?.paid && !draft.optionalSeen.has(t)));
  const label = (ts: readonly SectionType[]) => (ts.length ? ts.map((t) => byType.get(t)?.title ?? t).join(", ") : "none");
  const picked = prompt.multiselect
    ? await prompt.multiselect("Optional sections: left out unless asked for (--include, or include in Claude)", choices, defaults, {
        summary: `Optional sections (left out unless asked for with --include): ${label(defaults)}. Keep this?`,
      })
    : defaults;
  draft.optional = new Set(picked);
  draft.optionalSeen = new Set(draft.types);
}

async function askPeriod(prompt: Prompter, ui: Ui, current: Period): Promise<Period> {
  const cur: PeriodChoice = current.range === "last_n_days" ? (current.days === 28 ? "last_28_days" : "last_n_days") : current.range === "last_quarter" ? "last_quarter" : "last_month";
  const p = await prompt.choose("Report period", PERIOD_CHOICES, cur);
  if (p === "last_month" || p === "last_quarter") return { range: p };
  if (p === "last_28_days") return { range: "last_n_days", days: 28 };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const a = (await prompt.ask(`Number of days (7-${MAX_SPAN_DAYS})`, { default: current.range === "last_n_days" ? String(current.days) : "90" })).trim();
    const n = Number(a);
    if (Number.isInteger(n) && n >= 7 && n <= MAX_SPAN_DAYS) return { range: "last_n_days", days: n };
    ui.fail(`"${a.slice(0, 20)}" isn't a whole number from 7 to ${MAX_SPAN_DAYS}.`);
  }
  throw new GaveUp("No usable number of days.");
}

async function askCompare(prompt: Prompter, current: Comparison[]): Promise<Comparison[]> {
  const label = (cs: readonly Comparison[]) => (cs.length ? cs.map((c) => COMPARE_CHOICES.find((x) => x.value === c)!.label.toLowerCase()).join(" and ") : "nothing");
  if (!prompt.multiselect) return current;
  return prompt.multiselect("Compare with", COMPARE_CHOICES, current, { summary: `Compare with ${label(current)}. Keep this?` });
}

async function askLayout(prompt: Prompter, current: "standard" | "onepage"): Promise<"standard" | "onepage"> {
  return prompt.choose(
    "Layout",
    [
      { value: "standard", label: "Standard (the full report)" },
      { value: "onepage", label: "One page (an executive summary)" },
    ] as const,
    current,
  );
}

async function askFormats(prompt: Prompter, current: Format[] | undefined): Promise<Format[] | undefined> {
  if (!(await prompt.confirm("This file has no default report format, so reports default to PDF. Set the file's default format(s) now?", current !== undefined))) return undefined;
  const defaults = current ?? (["pdf"] as Format[]);
  const picked = prompt.multiselect ? await prompt.multiselect("Default report format(s) for this file", FORMAT_CHOICES, defaults) : defaults;
  return picked.length ? picked : ["pdf"];
}
