// Browser-local persistence of architecture node positions (the user's own arrangement of one layer). No React, no
// network, never shared with Flow: key dsp-arch-pos:v1:{project}:{env}:{layerId}, value {nodeId: {x, y}} (absolute in
// the layer; architecture nodes are flat). Only ever written after a drag, never on load. Never dsp-flow-pos:* / apos:*.
import type { XY } from "./layout";

export type ArchPosMap = Record<string, XY>;
const PREFIX = "dsp-arch-pos:v1";

/** "customerproject.dev" → customerproject / dev (part after the last dot), the same split Flow's storageKey uses. */
export function archPosKey(projectId: string, layerId: string): string {
  const dot = projectId.lastIndexOf(".");
  const project = dot > 0 ? projectId.slice(0, dot) : projectId;
  const env = dot > 0 ? projectId.slice(dot + 1) : "";
  return `${PREFIX}:${project}:${env}:${layerId}`;
}

const isXY = (v: unknown): v is XY =>
  typeof v === "object" && v !== null && Number.isFinite((v as XY).x) && Number.isFinite((v as XY).y);

/** Stored entries for `known` ids with finite x / y; {} when missing, unreadable or malformed. */
export function loadArchPositions(key: string, known: ReadonlySet<string>): ArchPosMap {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: ArchPosMap = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) if (known.has(id) && isXY(v)) out[id] = { x: v.x, y: v.y };
    return out;
  } catch {
    return {};
  }
}

/**
 * Merge `patch` (the dragged ids) over what is stored under `key`. Stale ids (no longer in the layer) and invalid
 * entries are dropped in the same write. Best-effort: quota / privacy errors are swallowed.
 */
export function mergeArchPositions(key: string, patch: ArchPosMap, known: ReadonlySet<string>): void {
  const ids = Object.keys(patch).filter((id) => known.has(id) && isXY(patch[id]));
  if (!ids.length) return;
  try {
    const next = loadArchPositions(key, known);
    for (const id of ids) next[id] = { x: patch[id].x, y: patch[id].y };
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    /* storage unavailable or full: the arrangement stays in memory for this visit */
  }
}

export function clearArchPositions(key: string): void {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}
