import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Wrap a handler so results come back as JSON text and errors as tool errors, not crashes. */
export function handler<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      const data = await fn(args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    }
  };
}

export const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;
