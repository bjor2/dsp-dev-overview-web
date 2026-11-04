// Pure layout helpers for the Flow SVG canvas: layered auto-layout (containers as units), container geometry,
// de-overlap nudging and content bounds. No React here.
import type { FlowEdge } from "../../api/types";
import type { PosMap, Rect, V2Graph, V2Node, XY } from "./model";

/** Node size + tight gutters (top→bottom layers). */
export const W = 176, H = 40, GX = 24, GY = 56, PAD = 10, MAX_ROW = 7;
/** Container header band height (label row above the children). */
export const HDR = 24;
export const SEED = "ext:seed-messages";

type Item = { id: string; w: number; h: number };
type Pair = { from: string; to: string };

export const nodeRect = (id: string, p: XY): Rect => ({ id, x: p.x, y: p.y, w: W, h: H });
export const isContainerId = (id: string) => id.startsWith("container:");

export function computeLayers(ids: string[], edges: Pair[]): Record<string, number> {
  const layer: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
  for (let i = 0; i < ids.length; i++)
    for (const e of edges)
      if (layer[e.from] !== undefined && layer[e.to] !== undefined && e.from !== e.to && layer[e.to] < layer[e.from] + 1 && e.to !== SEED)
        layer[e.to] = layer[e.from] + 1;
  // Seed kit is the sole entry row; everything else starts below it.
  if (layer[SEED] !== undefined) {
    for (const id of Object.keys(layer)) if (id !== SEED) layer[id] = Math.max(1, layer[id] + (layer[id] === 0 ? 1 : 0));
    layer[SEED] = 0;
  }
  return layer;
}

/** Top→bottom layered layout of variable-size items; rows centred, long rows wrapped so the graph stays compact. */
function layeredLayout(items: Item[], edges: Pair[], sortKey: (id: string) => string): PosMap {
  const layer = computeLayers(items.map((i) => i.id), edges);
  const rows: Record<number, Item[]> = {};
  items.forEach((it) => (rows[layer[it.id]] ??= []).push(it));
  Object.values(rows).forEach((r) => r.sort((a, b) => sortKey(a.id).localeCompare(sortKey(b.id)) || a.id.localeCompare(b.id)));
  const lines: Item[][] = [];
  Object.keys(rows).map(Number).sort((a, b) => a - b).forEach((r) => {
    const ns = rows[r];
    for (let i = 0; i < ns.length; i += MAX_ROW) lines.push(ns.slice(i, i + MAX_ROW));
  });
  const lineW = (l: Item[]) => l.reduce((s, it) => s + it.w, 0) + (l.length - 1) * GX;
  const fullW = Math.max(1, ...lines.map(lineW));
  const pos: PosMap = {};
  let y = PAD;
  for (const line of lines) {
    const lh = Math.max(...line.map((it) => it.h));
    let x = PAD + (fullW - lineW(line)) / 2;
    for (const it of line) {
      pos[it.id] = { x, y: y + (lh - it.h) / 2 };
      x += it.w + GX;
    }
    y += lh + GY;
  }
  return pos;
}

/** Smallest relative position an inner node may take (left/top padding below the header). */
export const innerMin = (pad: number): XY => ({ x: pad, y: HDR + pad });
export const clampInner = (p: XY, pad: number): XY => {
  const m = innerMin(pad);
  return { x: Math.max(m.x, p.x), y: Math.max(m.y, p.y) };
};
/** Box size = children bbox + padding (+ header). Never smaller than one empty slot, never shrinks below children. */
export function containerSize(rel: XY[], pad: number): { w: number; h: number } {
  return {
    w: Math.max(W + pad * 2, ...rel.map((p) => p.x + W + pad)),
    h: Math.max(HDR + H + pad * 2, ...rel.map((p) => p.y + H + pad)),
  };
}

export function membersByContainer(g: V2Graph): Map<string, V2Node[]> {
  const m = new Map<string, V2Node[]>();
  for (const c of g.containers) m.set(c.id, []);
  for (const n of g.nodes) if (n.containerId) m.get(n.containerId)?.push(n);
  return m;
}
export function containerOfMap(g: V2Graph): Record<string, string> {
  const m: Record<string, string> = {};
  for (const n of g.nodes) if (n.containerId) m[n.id] = n.containerId;
  return m;
}

/**
 * Partial layout (§11): every node/container with a stored position is pinned (containers absolute, inner nodes
 * relative to their container, standalone absolute); the rest is auto-laid. Containers are laid out as single
 * units against standalone nodes; unstored inner nodes are laid out inside their container.
 * Returned `pos` uses the wire frame: container ids absolute, inner node ids relative, others absolute.
 */
export function layoutGraph(g: V2Graph, edges: FlowEdge[]): { pos: PosMap; pinned: Set<string> } {
  const pad = g.layoutHints.containerPadding;
  const tb = g.layoutHints.innerDirection === "TB";
  const pinned = new Set<string>();
  const pos: PosMap = {};
  const members = membersByContainer(g);
  const containerOf = containerOfMap(g);
  const byId = (a: V2Node, b: V2Node) => a.id.localeCompare(b.id);

  // 1. Inside each container (relative frame).
  const sizes: Record<string, { w: number; h: number }> = {};
  for (const c of g.containers) {
    const ms = members.get(c.id) ?? [];
    const stored = ms.filter((n) => n.position);
    const free = ms.filter((n) => !n.position).sort(byId);
    for (const n of stored) {
      pos[n.id] = clampInner(n.position!, pad);
      pinned.add(n.id);
    }
    const m = innerMin(pad);
    // Unstored members go after the stored ones along the inner direction.
    let cx = m.x, cy = m.y;
    if (stored.length) {
      if (tb) cy = Math.max(...stored.map((n) => pos[n.id].y + H)) + GY / 2;
      else cx = Math.max(...stored.map((n) => pos[n.id].x + W)) + GX;
    }
    free.forEach((n, i) => (pos[n.id] = tb ? { x: m.x, y: cy + i * (H + GY / 2) } : { x: cx + i * (W + GX), y: m.y }));
    sizes[c.id] = containerSize(ms.map((n) => pos[n.id]), pad);
  }

  // 2. Top level: containers as units + standalone nodes, edges collapsed onto their container.
  const standalone = g.nodes.filter((n) => !containerOf[n.id]);
  const items: Item[] = [
    ...g.containers.map((c) => ({ id: c.id, ...sizes[c.id] })),
    ...standalone.map((n) => ({ id: n.id, w: W, h: H })),
  ];
  const top = (id: string) => containerOf[id] ?? id;
  const topEdges = edges.map((e) => ({ from: top(e.from), to: top(e.to) })).filter((e) => e.from !== e.to);
  const kindOf = new Map(g.nodes.map((n) => [n.id, n.kind as string]));
  const auto = layeredLayout(items, topEdges, (id) => (isContainerId(id) ? "container" : (kindOf.get(id) ?? "")));
  for (const it of items) pos[it.id] = auto[it.id];
  for (const c of g.containers) if (c.position) { pos[c.id] = { ...c.position }; pinned.add(c.id); }
  for (const n of standalone) if (n.position) { pos[n.id] = { x: n.position.x, y: n.position.y }; pinned.add(n.id); }
  return { pos, pinned };
}

export interface Geometry {
  /** Absolute node positions (inner nodes resolved through their container origin). */
  absPos: PosMap;
  /** Container boxes (absolute). */
  boxes: Record<string, Rect>;
  /** Top-level units: container boxes + standalone nodes. */
  topRects: Rect[];
  containerOf: Record<string, string>;
}
export const EMPTY_GEOMETRY: Geometry = { absPos: {}, boxes: {}, topRects: [], containerOf: {} };

/** Resolve the mixed-frame position map into absolute node positions and container boxes. */
export function deriveGeometry(g: V2Graph, pos: PosMap): Geometry {
  const pad = g.layoutHints.containerPadding;
  const containerOf = containerOfMap(g);
  const members = membersByContainer(g);
  const boxes: Record<string, Rect> = {};
  for (const c of g.containers) {
    const o = pos[c.id];
    if (!o) continue;
    const rel = (members.get(c.id) ?? []).map((n) => pos[n.id]).filter((p): p is XY => !!p);
    boxes[c.id] = { id: c.id, x: o.x, y: o.y, ...containerSize(rel, pad) };
  }
  const absPos: PosMap = {};
  const topRects: Rect[] = Object.values(boxes);
  for (const n of g.nodes) {
    const p = pos[n.id];
    if (!p) continue;
    const cid = containerOf[n.id];
    const origin = cid ? pos[cid] : undefined;
    if (cid && !origin) continue; // container not placed yet
    absPos[n.id] = origin ? { x: origin.x + p.x, y: origin.y + p.y } : p;
    if (!cid) topRects.push(nodeRect(n.id, p));
  }
  return { absPos, boxes, topRects, containerOf };
}

/** Nearest non-overlapping spot for `target` (gap px) among `others`; `min` clamps the result (inner nodes). */
export function nudgeOffOverlaps(target: Rect, others: Rect[], gap = 12, min?: XY): XY {
  const ok = (x: number, y: number) => !min || (x >= min.x && y >= min.y);
  const hits = (x: number, y: number) =>
    others.some((o) => x < o.x + o.w + gap && x + target.w + gap > o.x && y < o.y + o.h + gap && y + target.h + gap > o.y);
  const p = { x: target.x, y: target.y };
  if (!hits(p.x, p.y)) return p;
  // Candidates: snap to each side of every blocker; pick the closest free one.
  const cands: XY[] = [];
  for (const o of others) {
    cands.push(
      { x: o.x - target.w - gap, y: p.y },
      { x: o.x + o.w + gap, y: p.y },
      { x: p.x, y: o.y - target.h - gap },
      { x: p.x, y: o.y + o.h + gap },
    );
  }
  const free = cands
    .filter((c) => ok(c.x, c.y) && !hits(c.x, c.y))
    .sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
  if (free[0]) return free[0];
  for (let r = 1; r < 60; r++)
    for (let a = 0; a < 16; a++) {
      const x = p.x + Math.cos((a / 16) * Math.PI * 2) * r * 10, y = p.y + Math.sin((a / 16) * Math.PI * 2) * r * 10;
      if (ok(x, y) && !hits(x, y)) return { x, y };
    }
  return p;
}

export function contentBounds(rects: Rect[]) {
  if (!rects.length) return { minX: 0, minY: 0, maxX: 320, maxY: 180, w: 320, h: 180 };
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.w));
  const maxY = Math.max(...rects.map((r) => r.y + r.h));
  return { minX, minY, maxX, maxY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

type Side = "top" | "bottom" | "left" | "right";
/** Anchor on the side of node `a` facing node `b` (centre-to-centre direction). Nodes only, never boxes. */
export function anchor(a: XY, b: XY): { x: number; y: number; nx: number; ny: number } {
  const dx = b.x + W / 2 - (a.x + W / 2), dy = b.y + H / 2 - (a.y + H / 2);
  const side: Side = Math.abs(dx) / W > Math.abs(dy) / H ? (dx > 0 ? "right" : "left") : dy > 0 ? "bottom" : "top";
  switch (side) {
    case "right": return { x: a.x + W, y: a.y + H / 2, nx: 1, ny: 0 };
    case "left": return { x: a.x, y: a.y + H / 2, nx: -1, ny: 0 };
    case "bottom": return { x: a.x + W / 2, y: a.y + H, nx: 0, ny: 1 };
    default: return { x: a.x + W / 2, y: a.y, nx: 0, ny: -1 };
  }
}

export function edgePath(a: XY, b: XY): string {
  const s = anchor(a, b), t = anchor(b, a);
  const dist = Math.hypot(t.x - s.x, t.y - s.y);
  const c = Math.max(24, Math.min(90, dist * 0.4));
  return `M${s.x},${s.y} C${s.x + s.nx * c},${s.y + s.ny * c} ${t.x + t.nx * c},${t.y + t.ny * c} ${t.x},${t.y}`;
}

/** Container header band: top corners rounded, bottom edge straight. */
export const headerPath = (w: number, r = 10) => `M${r},0 H${w - r} A${r},${r} 0 0 1 ${w},${r} V${HDR} H0 V${r} A${r},${r} 0 0 1 ${r},0 Z`;
