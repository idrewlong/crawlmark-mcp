import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { normalizeHost } from "../lib/clients.js";
import { TimeoutError, withTimeout } from "../lib/timeout.js";
import { recordToolCall } from "../lib/usage.js";

export interface ToolContext {
  /** Aborts on the tool's timeout or when the MCP client cancels. Pass it to providers so browsers get closed. */
  signal: AbortSignal;
}

export interface HandlerOptions {
  /** Whole-call limit. On expiry the signal aborts (closing browsers) and the call returns a timeout error. */
  timeoutMs?: number;
}

/** The client a call was about, reduced to a normalised host (slugs normalise too). Nothing else from the arguments is kept. */
function clientOf(args: unknown): string | null {
  const c = (args as { client?: unknown } | undefined)?.client;
  return typeof c === "string" ? (normalizeHost(c) ?? null) : null;
}

function errorClass(err: unknown): string {
  if (err instanceof Error) return err.name && err.name !== "Error" ? err.name : err.constructor?.name || "Error";
  return typeof err;
}

/**
 * Wrap a tool handler: results come back as JSON text and errors as tool errors, not
 * crashes; an optional timeout aborts the work; and every call writes a usage row
 * (tool, client, duration, ok, error class) to tool_calls.
 */
export function handler<A>(name: string, fn: (args: A, ctx: ToolContext) => Promise<unknown>, opts: HandlerOptions = {}) {
  return async (args: A, extra?: { signal?: AbortSignal }): Promise<CallToolResult> => {
    const started = performance.now();
    const ctrl = new AbortController();
    const signal = extra?.signal ? AbortSignal.any([extra.signal, ctrl.signal]) : ctrl.signal;
    let ok = false;
    let failure: unknown;
    try {
      const work = fn(args, { signal });
      const data = opts.timeoutMs
        ? await withTimeout(work, opts.timeoutMs, name, () =>
            // Providers listen on the signal and close their browsers (withChrome).
            ctrl.abort(new TimeoutError(`${name} timed out after ${opts.timeoutMs! / 1000}s`)),
          )
        : await work;
      ok = true;
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      failure = err;
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    } finally {
      try {
        recordToolCall({
          tool: name,
          client: clientOf(args),
          durationMs: performance.now() - started,
          ok,
          errorClass: ok ? null : errorClass(failure),
          ts: Date.now(),
        });
      } catch (err) {
        console.error(`crawlmark: could not write the usage log: ${(err as Error).message}`);
      }
    }
  };
}

export const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;
