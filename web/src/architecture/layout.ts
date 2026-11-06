// ADDENDA-011 §3.7: deterministic auto-layout for one architecture layer. Pure; persists nothing. The user's own
// positions (localPositions.ts, dsp-arch-pos:v1:…) are overlaid on `pos` by the view, which then re-derives the frame
// and bounds from the merged map with layerFrame / layerBounds.
import type { ArchEdge, ArchNode } from "../api/types";

export type XY = { x: number; y: number };
export type Box = { x: number; y: number; w: number; h: number };
export const NW = 200, NH = 60;
const GX = 180, GY = 30;
/** Frame padding around the inside nodes, plus the title tab at the top of the frame. */
export const FRAME_PAD = 28, FRAME_TAB = 24;
/** Gap between the frame and the outside lanes above / below it. */
const LANE_GAP = 40;

export interface ArchLayout { pos: Record<string, XY>; frame: Box | null; bounds: Box }

/**
 * Longest-path columns over the edges. A DFS from every node (input order) marks edges into a node still on the
 * stack as back-edges and ignores them, so documented conceptual cycles (topic → command queue → …) do not break it.
 */
export function columns(nodes: readonly ArchNode[], edges: readonly ArchEdge[]): Record<string, number> {
  const out = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) out.get(e.from)?.push(e.to);
  const state = new Map<string, 1 | 2>(); // 1 = on stack, 2 = done
  const order: string[] = []; // reverse post-order = topological order of the DAG without back-edges
  const forward = new Set<string>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const to of out.get(id) ?? []) {
      const s = state.get(to);
      if (s === 1) continue; // back-edge
      forward.add(id + "\u0000" + to);
      if (!s) visit(to);
    }
    state.set(id, 2);
    order.push(id);
  };
  // Sources first (no inbound edge), then anything left, so roots land in column 0.
  const inbound = new Set(edges.map((e) => e.to));
  for (const n of nodes) if (!inbound.has(n.id) && !state.has(n.id)) visit(n.id);
  for (const n of nodes) if (!state.has(n.id)) visit(n.id);
  const col: Record<string, number> = Object.fromEntries(nodes.map((n) => [n.id, 0]));
  for (const id of order.reverse())
    for (const to of out.get(id) ?? []) if (forward.has(id + "\u0000" + to)) col[to] = Math.max(col[to], col[id] + 1);
  return col;
}

/**
 * Columns left→right; inside nodes form the boundary frame. Outside nodes left of the first inside column stay
 * left, right of the last stay right; outside nodes whose column falls inside the frame span move to a lane above
 * the frame (stores, contracts) or below it (externals), keeping their column x.
 */
export function layoutLayer(nodes: readonly ArchNode[], edges: readonly ArchEdge[]): ArchLayout {
  if (!nodes.length) return { pos: {}, frame: null, bounds: { x: 0, y: 0, w: NW, h: NH } };
  const col = columns(nodes, edges);
  const inside = nodes.filter((n) => n.boundary === "inside");
  const inCols = inside.map((n) => col[n.id]);
  const minC = inCols.length ? Math.min(...inCols) : Infinity, maxC = inCols.length ? Math.max(...inCols) : -Infinity;
  const band = new Map<number, ArchNode[]>(), above = new Map<number, ArchNode[]>(), below = new Map<number, ArchNode[]>();
  const push = (m: Map<number, ArchNode[]>, c: number, n: ArchNode) => m.set(c, [...(m.get(c) ?? []), n]);
  for (const n of nodes) {
    const c = col[n.id];
    if (n.boundary === "inside" || c < minC || c > maxC) push(band, c, n);
    else push(n.kind === "external" ? below : above, c, n);
  }
  const rowH = NH + GY;
  const colX = (c: number) => c * (NW + GX);
  const pos: Record<string, XY> = {};
  // Main band: every column centred on the tallest one.
  const bandRows = Math.max(...[...band.values()].map((l) => l.length), 1);
  for (const [c, list] of band) {
    const off = ((bandRows - list.length) * rowH) / 2;
    list.forEach((n, i) => { pos[n.id] = { x: colX(c), y: off + i * rowH }; });
  }
  const frame = layerFrame(inside, pos);
  const top = frame ? frame.y : 0, bottom = frame ? frame.y + frame.h : bandRows * rowH;
  for (const [c, list] of above) list.forEach((n, i) => { pos[n.id] = { x: colX(c), y: top - LANE_GAP - (list.length - i) * rowH + GY }; });
  for (const [c, list] of below) list.forEach((n, i) => { pos[n.id] = { x: colX(c), y: bottom + LANE_GAP + i * rowH }; });
  return { pos, frame, bounds: layerBounds(pos, frame) };
}

/** Boundary frame around the inside nodes at their current positions; null when the layer has none placed. */
export function layerFrame(nodes: readonly ArchNode[], pos: Readonly<Record<string, XY>>): Box | null {
  const ps = nodes.filter((n) => n.boundary === "inside" && pos[n.id]).map((n) => pos[n.id]);
  if (!ps.length) return null;
  const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
  const x0 = Math.min(...xs) - FRAME_PAD, y0 = Math.min(...ys) - FRAME_PAD - FRAME_TAB;
  return { x: x0, y: y0, w: Math.max(...xs) + NW + FRAME_PAD - x0, h: Math.max(...ys) + NH + FRAME_PAD - y0 };
}

/** Box around every node and the frame (what Fit frames). */
export function layerBounds(pos: Readonly<Record<string, XY>>, frame: Box | null): Box {
  const rects: Box[] = [...Object.values(pos).map((p) => ({ x: p.x, y: p.y, w: NW, h: NH })), ...(frame ? [frame] : [])];
  if (!rects.length) return { x: 0, y: 0, w: NW, h: NH };
  const minX = Math.min(...rects.map((r) => r.x)), minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.w)), maxY = Math.max(...rects.map((r) => r.y + r.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

type Side = { x: number; y: number; nx: number; ny: number };
/** Point on the side of the NW×NH box at `a` that faces `b`; `shift` separates a tail from a head on one side. */
function anchor(a: XY, b: XY, shift: number): Side {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (Math.abs(dx) / NW >= Math.abs(dy) / NH)
    return dx >= 0 ? { x: a.x + NW, y: a.y + NH / 2 + shift, nx: 1, ny: 0 } : { x: a.x, y: a.y + NH / 2 - shift, nx: -1, ny: 0 };
  return dy > 0 ? { x: a.x + NW / 2 - shift, y: a.y + NH, nx: 0, ny: 1 } : { x: a.x + NW / 2 + shift, y: a.y, nx: 0, ny: -1 };
}

/** One cubic between two nodes plus its t=0.5 point (where the label goes). */
export function archEdgePath(a: XY, b: XY): { d: string; mid: XY } {
  const s = anchor(a, b, 6), t = anchor(b, a, -6);
  const c = Math.max(30, Math.min(110, Math.hypot(t.x - s.x, t.y - s.y) * 0.4));
  const p1 = { x: s.x + s.nx * c, y: s.y + s.ny * c }, p2 = { x: t.x + t.nx * c, y: t.y + t.ny * c };
  return {
    d: `M${s.x},${s.y} C${p1.x},${p1.y} ${p2.x},${p2.y} ${t.x},${t.y}`,
    mid: { x: (s.x + 3 * p1.x + 3 * p2.x + t.x) / 8, y: (s.y + 3 * p1.y + 3 * p2.y + t.y) / 8 },
  };
}
