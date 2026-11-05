// Live message activity on the Flow canvas. Pure: count diffs → events, agent console lines → function events,
// function name → handler node ids, node → the edges a message travels along. No React, no timers (useFlowActivity).
import { stripAnsi } from "../../agent/ansi";
import type { FlowNodeCounts } from "../../flow/useFlowCounts";
import type { FlowContainer, FlowEdge, FlowNode } from "../../api/types";

export type ActivityEvent =
  /** activeCount went up between two polls (delta > 0) or down (delta < 0: consumed / moved on). */
  | { type: "active"; nodeId: string; delta: number; count: number }
  /** deadLetterCount went up. */
  | { type: "dlq"; nodeId: string; delta: number; count: number }
  /** `Executing 'Functions.X'` on a handler node. */
  | { type: "executing"; nodeId: string; fn: string }
  /** `Executed 'Functions.X' (Succeeded|Failed…)`. */
  | { type: "executed"; nodeId: string; fn: string; ok: boolean; outcome: string; durationMs?: number };

/**
 * Events between two polls of /sb/entities. Only entities present in BOTH maps with known (non-null) numbers count,
 * so the first poll, a missing entity or an SB error never produces a burst.
 */
export function diffCounts(prev: ReadonlyMap<string, FlowNodeCounts>, next: ReadonlyMap<string, FlowNodeCounts>): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  for (const [id, n] of next) {
    const p = prev.get(id);
    if (!p) continue;
    if (p.active !== null && n.active !== null && n.active !== p.active) out.push({ type: "active", nodeId: id, delta: n.active - p.active, count: n.active });
    if (p.dlq !== null && n.dlq !== null && n.dlq > p.dlq) out.push({ type: "dlq", nodeId: id, delta: n.dlq - p.dlq, count: n.dlq });
  }
  return out;
}

export type FunctionLine =
  | { phase: "executing"; fn: string }
  | { phase: "executed"; fn: string; ok: boolean; outcome: string; durationMs?: number };

const FN_LINE = /Execut(ing|ed) 'Functions\.([A-Za-z0-9_.]+)'(?:\s*\((\w+)(?:[^)]*?Duration=(\d+)ms)?)?/;

/**
 * Azure Functions host lines: `Executing 'Functions.X' (Reason=…)` and `Executed 'Functions.X' (Succeeded, Id=…,
 * Duration=12ms)`. ANSI colour codes are stripped first. Anything other than `Succeeded` (Failed, Cancelled…) is a
 * failure. Null for every other line.
 */
export function parseFunctionLine(raw: string): FunctionLine | null {
  if (!raw.includes("Functions.")) return null;
  const m = FN_LINE.exec(raw.includes("[") ? stripAnsi(raw) : raw);
  if (!m) return null;
  const fn = m[2];
  if (m[1] === "ing") return { phase: "executing", fn };
  const outcome = m[3] ?? "Unknown";
  return { phase: "executed", fn, ok: outcome === "Succeeded", outcome, durationMs: m[4] ? Number(m[4]) : undefined };
}

/** Function name → handler node ids, per agent appId (from the handler's container) and project-wide. */
export interface FunctionIndex { byApp: Map<string, Map<string, string[]>>; any: Map<string, string[]> }

const push = (m: Map<string, string[]>, k: string, v: string) => {
  const xs = m.get(k);
  if (!xs) m.set(k, [v]);
  else if (!xs.includes(v)) xs.push(v);
};
const handlerFunctions = (n: FlowNode): string[] =>
  [n.handler?.function, ...(n.handler?.functions ?? [])].filter((f): f is string => typeof f === "string" && f.length > 0);

/** `appIdOf` maps a container to the agent's appId (containerAppId), injected to keep this module free of agent code. */
export function functionIndex(nodes: readonly FlowNode[], containers: readonly FlowContainer[], appIdOf: (c: FlowContainer) => string): FunctionIndex {
  const appOf = new Map(containers.map((c) => [c.id, appIdOf(c)]));
  const idx: FunctionIndex = { byApp: new Map(), any: new Map() };
  for (const n of nodes) {
    if (n.kind !== "handler") continue;
    const app = n.containerId ? appOf.get(n.containerId) : undefined;
    for (const fn of handlerFunctions(n)) {
      push(idx.any, fn, n.id);
      if (app) {
        let m = idx.byApp.get(app);
        if (!m) idx.byApp.set(app, (m = new Map()));
        push(m, fn, n.id);
      }
    }
  }
  return idx;
}

/**
 * Handler nodes a console line's function belongs to. The line's app wins (two apps may host a function of the same
 * name); when that app has no handler with that name the project-wide match is used. Other projects never match.
 */
export function matchFunction(idx: FunctionIndex, projectId: string, line: { regId: string; appId: string }, fn: string): string[] {
  if (line.regId !== projectId) return [];
  return idx.byApp.get(line.appId)?.get(fn) ?? idx.any.get(fn) ?? [];
}

/** Console line → events for every matching handler node. */
export function lineEvents(idx: FunctionIndex, projectId: string, line: { regId: string; appId: string; line: string }): ActivityEvent[] {
  const f = parseFunctionLine(line.line);
  if (!f) return [];
  return matchFunction(idx, projectId, line, f.fn).map((nodeId): ActivityEvent =>
    f.phase === "executing"
      ? { type: "executing", nodeId, fn: f.fn }
      : { type: "executed", nodeId, fn: f.fn, ok: f.ok, outcome: f.outcome, durationMs: f.durationMs });
}

/** Edge kinds a message travels along out of an entity (publish edges start at handlers, inject at the seed). */
const CARRIES: ReadonlySet<string> = new Set(["trigger", "forward", "subscription"]);
/** Canvas key of an edge (FlowTab draws one path per from→to). */
export const edgeKey = (e: Pick<FlowEdge, "from" | "to">) => e.from + "→" + e.to;

/**
 * Edges that light up for an event: a message landing on (or leaving) an entity travels its outgoing trigger /
 * forward / subscription edges; a handler starting an invocation lights its incoming trigger edges.
 */
export function activityEdges(ev: ActivityEvent, edges: readonly FlowEdge[]): string[] {
  if (ev.type === "active") return edges.filter((e) => e.from === ev.nodeId && CARRIES.has(e.kind)).map(edgeKey);
  if (ev.type === "executing") return edges.filter((e) => e.to === ev.nodeId && e.kind === "trigger").map(edgeKey);
  return [];
}

/** Node CSS classes per event (the ring overlay reads them). */
export const nodeClass = (ev: ActivityEvent): string =>
  ev.type === "active" ? (ev.delta > 0 ? "activity-pulse" : "activity-drain")
    : ev.type === "dlq" ? "activity-dlq"
      : ev.type === "executing" ? "activity-executing"
        : ev.ok ? "activity-succeeded" : "activity-failed";

/** How long a node keeps the class (ms). Failure holds longest so it is noticed; executing ends early on Executed. */
export const HOLD_MS: Record<string, number> = {
  "activity-pulse": 1400, "activity-drain": 900, "activity-dlq": 2600,
  "activity-executing": 5000, "activity-succeeded": 1100, "activity-failed": 4500,
};
export const DOT_MS = 1200;

/** Short text for the node tooltip and the feed. `label` is the node's display label. */
export function eventText(ev: ActivityEvent, label: string): string {
  switch (ev.type) {
    case "active": return ev.delta > 0 ? `+${ev.delta} message${ev.delta === 1 ? "" : "s"} on ${label} (${ev.count} active)` : `${-ev.delta} consumed from ${label} (${ev.count} active)`;
    case "dlq": return `DLQ +${ev.delta} on ${label} (${ev.count} dead-lettered)`;
    case "executing": return `${ev.fn} executing`;
    case "executed": return `${ev.fn} ${ev.ok ? "succeeded" : ev.outcome.toLowerCase()}${ev.durationMs !== undefined ? ` (${ev.durationMs} ms)` : ""}`;
  }
}

export interface FeedItem { id: number; at: number; nodeId: string; kind: string; text: string; count: number }
export const FEED_MAX = 20;
/** Same node + same kind + same text in a row → one row with ×count (a busy handler would flood the feed). */
export function pushFeed(feed: readonly FeedItem[], item: Omit<FeedItem, "count">): FeedItem[] {
  const top = feed[0];
  if (top && top.nodeId === item.nodeId && top.kind === item.kind && sameText(top.text, item.text)) {
    return [{ ...top, at: item.at, text: item.text, count: top.count + 1 }, ...feed.slice(1)];
  }
  return [{ ...item, count: 1 }, ...feed].slice(0, FEED_MAX);
}
/** Durations / counts vary per row; compare with the numbers taken out. */
const sameText = (a: string, b: string) => a.replace(/\d+/g, "#") === b.replace(/\d+/g, "#");
/** Feed kind (CSS modifier) for an event. */
export const feedKind = (ev: ActivityEvent) => nodeClass(ev).replace("activity-", "");
