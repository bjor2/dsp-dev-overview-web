// Browser-local persistence of Flow positions (the user's own layout, per project + env). No React, no network.
// Key: dsp-flow-pos:v2:{project}:{env}. Value: the v2 wire map {graphId: {x, y}} — containers absolute, inner
// nodes relative to their container, standalone nodes absolute. Only ever written after a drag, never on load.
import type { PosMap, V2Graph, XY } from "./model";

const PREFIX = "dsp-flow-pos:v2";

/** project / env from the graph's own fields when it carries them, else from "project.env" (part after the last dot). */
export function storageKey(projectId: string, graph: V2Graph | null): string {
  const g = graph && graph.projectId === projectId ? (graph as unknown as { project?: unknown; env?: unknown }) : null;
  let project = typeof g?.project === "string" && g.project ? g.project : "";
  let env = typeof g?.env === "string" && g.env ? g.env : "";
  if (!project || !env) {
    const dot = projectId.lastIndexOf(".");
    const splitProject = dot > 0 ? projectId.slice(0, dot) : projectId;
    const splitEnv = dot > 0 ? projectId.slice(dot + 1) : "";
    project ||= splitProject;
    env ||= splitEnv;
  }
  return `${PREFIX}:${project}:${env}`;
}

const isXY = (v: unknown): v is XY =>
  typeof v === "object" && v !== null && Number.isFinite((v as XY).x) && Number.isFinite((v as XY).y);

/** Raw stored map (every valid {x,y} entry, unknown ids included); {} when missing, unreadable or malformed. */
export function readLocalPositions(key: string): PosMap {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: PosMap = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) if (isXY(v)) out[id] = { x: v.x, y: v.y };
    return out;
  } catch {
    return {};
  }
}

/** Stored positions restricted to ids the graph actually has (containers + nodes); unknown ids are ignored. */
export function loadLocalPositions(key: string, graph: V2Graph): PosMap {
  const known = new Set<string>([...graph.containers.map((c) => c.id), ...graph.nodes.map((n) => n.id)]);
  const out: PosMap = {};
  for (const [id, p] of Object.entries(readLocalPositions(key))) if (known.has(id)) out[id] = p;
  return out;
}

/** Merge `patch` (dragged keys) over what is already stored under `key`. Best-effort: quota/privacy errors are swallowed. */
export function mergeLocalPositions(key: string, patch: PosMap): void {
  const ids = Object.keys(patch);
  if (!ids.length) return;
  try {
    const next = { ...readLocalPositions(key) };
    for (const id of ids) next[id] = { x: patch[id].x, y: patch[id].y };
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    /* storage unavailable or full: the layout stays in memory for this session */
  }
}

export function clearLocalPositions(key: string): void {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}
