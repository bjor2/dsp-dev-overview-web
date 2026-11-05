// Fit a node / container label into its box in GRAPH units, so the result is the same at every zoom (the text scales
// with the box). Pure: the measure function is injected (canvas in the browser, a char-width table in tests).
export type Measure = (text: string) => number;
export interface FittedLabel { text: string; truncated: boolean }

/** Longest prefix + "…" that fits `maxWidth` (binary search on the prefix length). */
export function fitLabel(label: string, maxWidth: number, measure: Measure): FittedLabel {
  if (measure(label) <= maxWidth) return { text: label, truncated: false };
  let lo = 0, hi = label.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(label.slice(0, mid).trimEnd() + "…") <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return { text: label.slice(0, lo).trimEnd() + "…", truncated: true };
}

/** Same font strings the CSS uses for `.node .t1` and `.container-box .c1` (letter-spacing 0.02em on c1). */
export const NODE_FONT = { font: "600 12px system-ui, sans-serif", letterSpacing: 0 };
export const CONTAINER_FONT = { font: "700 11.5px system-ui, sans-serif", letterSpacing: 0.02 * 11.5 };
/** `.container-box .c2` (the right-aligned attached / agent-state text). */
export const CONTAINER_SUB_FONT = { font: "10px system-ui, sans-serif", letterSpacing: 0 };

let ctx: CanvasRenderingContext2D | null | undefined;
const memo = new Map<string, FittedLabel>();
function canvasMeasure(f: { font: string; letterSpacing: number }): Measure | null {
  if (ctx === undefined) ctx = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
  const c = ctx;
  if (!c) return null;
  return (t) => {
    c.font = f.font;
    return c.measureText(t).width + f.letterSpacing * t.length;
  };
}
/** Rendered width of `text` in graph units (0 when no canvas is available). */
export const measureSvgText = (text: string, f: { font: string; letterSpacing: number }) => canvasMeasure(f)?.(text) ?? 0;
/** fitLabel with a module-level canvas measure, memoised per (label, maxWidth, font). */
export function fitSvgLabel(label: string, maxWidth: number, f: { font: string; letterSpacing: number }): FittedLabel {
  const key = `${f.font}|${maxWidth}|${label}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const measure = canvasMeasure(f);
  if (!measure) return { text: label, truncated: false };
  // 1 unit of slack: canvas measureText and SVG getBBox differ by a fraction of a pixel.
  const r = fitLabel(label, maxWidth - 1, measure);
  if (memo.size > 2000) memo.clear();
  memo.set(key, r);
  return r;
}
