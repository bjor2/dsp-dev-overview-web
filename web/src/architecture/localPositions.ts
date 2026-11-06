// Browser-local persistence of architecture node positions (the user's own arrangement of one layer). No React, no
// network, never shared with Flow: key dsp-arch-pos:v1:{project}:{env}:{layerId}, value {nodeId: {x, y}} (absolute in
// the layer; architecture nodes are flat). Only ever written after a drag, never on load. Never dsp-flow-pos:* / apos:*.
//
// Safe coordinate limits (release-blocking, Tester FAIL @ 4188c13): a stored / dragged position is accepted only when
// both x and y lie inside the auto-layout axis-aligned bounding box expanded by ARCH_POS_MARGIN on every side.
// Values outside that range are DROPPED on read and CLAMPED on drag/write so one huge coordinate cannot inflate the
// Fit bounds to tens of thousands of units (blank canvas at 15% zoom). Other nodes' valid positions are kept.
import type { Box, XY } from "./layout";

export type ArchPosMap = Record<string, XY>;
const PREFIX = "dsp-arch-pos:v1";

/**
 * Graph units beyond the auto-layout AABB allowed for a custom position. Chosen as a generous drag room that still
 * rejects absurd values like x=99999. Documented here and in DESIGN-flow-drilldown.md §3.7.
 */
export const ARCH_POS_MARGIN = 5000;

export type ArchPosRange = { minX: number; maxX: number; minY: number; maxY: number };

/** Allowed [min,max] from the auto-layout bounds (+ margin). Degenerate / empty bounds → a ±MARGIN box around the origin. */
export function archPosRange(autoBounds: Box): ArchPosRange {
  const w = Number.isFinite(autoBounds.w) && autoBounds.w > 0 ? autoBounds.w : 0;
  const h = Number.isFinite(autoBounds.h) && autoBounds.h > 0 ? autoBounds.h : 0;
  const x = Number.isFinite(autoBounds.x) ? autoBounds.x : 0;
  const y = Number.isFinite(autoBounds.y) ? autoBounds.y : 0;
  return {
    minX: x - ARCH_POS_MARGIN,
    maxX: x + w + ARCH_POS_MARGIN,
    minY: y - ARCH_POS_MARGIN,
    maxY: y + h + ARCH_POS_MARGIN,
  };
}

export function isArchPosInRange(p: XY, range: ArchPosRange): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y)
    && p.x >= range.minX && p.x <= range.maxX
    && p.y >= range.minY && p.y <= range.maxY;
}

/** Clamp a drag target into the safe range (keeps finite numbers; never produces NaN). */
export function clampArchPos(p: XY, range: ArchPosRange): XY {
  const x = Number.isFinite(p.x) ? Math.min(range.maxX, Math.max(range.minX, p.x)) : range.minX;
  const y = Number.isFinite(p.y) ? Math.min(range.maxY, Math.max(range.minY, p.y)) : range.minY;
  return { x, y };
}

/** "customerproject.dev" → customerproject / dev (part after the last dot), the same split Flow's storageKey uses. */
export function archPosKey(projectId: string, layerId: string): string {
  const dot = projectId.lastIndexOf(".");
  const project = dot > 0 ? projectId.slice(0, dot) : projectId;
  const env = dot > 0 ? projectId.slice(dot + 1) : "";
  return `${PREFIX}:${project}:${env}:${layerId}`;
}

const isFiniteXY = (v: unknown): v is XY =>
  typeof v === "object" && v !== null && !Array.isArray(v)
  && Number.isFinite((v as XY).x) && Number.isFinite((v as XY).y);

/** Stored entries for `known` ids with finite x/y inside `range`; {} when missing, unreadable or malformed. Out-of-range and non-object values are dropped (other valid ids kept). */
export function loadArchPositions(key: string, known: ReadonlySet<string>, range: ArchPosRange): ArchPosMap {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: ArchPosMap = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!known.has(id) || !isFiniteXY(v)) continue;
      if (isArchPosInRange(v, range)) out[id] = { x: v.x, y: v.y };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Merge `patch` (the dragged ids, already clamped by the caller) over what is stored under `key`. Stale ids, invalid
 * types and out-of-range coordinates are dropped in the same write. Best-effort: quota / privacy errors are swallowed
 * (the arrangement stays in memory for this visit).
 */
export function mergeArchPositions(key: string, patch: ArchPosMap, known: ReadonlySet<string>, range: ArchPosRange): void {
  const ids = Object.keys(patch).filter((id) => known.has(id) && isFiniteXY(patch[id]));
  if (!ids.length) return;
  try {
    const next = loadArchPositions(key, known, range);
    for (const id of ids) {
      const clamped = clampArchPos(patch[id], range);
      if (isArchPosInRange(clamped, range)) next[id] = clamped;
    }
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    /* storage unavailable or full: the arrangement stays in memory for this visit */
  }
}

export function clearArchPositions(key: string): void {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}
