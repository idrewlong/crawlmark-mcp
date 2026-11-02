/**
 * Native charts for the deck, harvested from docx's chart generation (T3b). T0 holds the type and a stub that
 * returns null (the slide then shows the chart's table).
 */
import type { Chart } from "../doc.js";

/** A c:chartSpace whose c:externalData r:id is "rId1", and its data workbook. */
export interface ChartPart {
  xml: string;
  workbook: Buffer;
}

/** null (never a throw) only when the docx chart layout check fails. */
export async function chartPart(_c: Chart, _o: { primary: string; font: string }): Promise<ChartPart | null> {
  return null;
}
