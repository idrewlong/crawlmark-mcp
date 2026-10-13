/** Drop keys whose value is an empty string, so `FOO=` in .env counts as unset. */
export function stripEmptyValues(source: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && v.trim() !== "") out[k] = v;
  }
  return out;
}
