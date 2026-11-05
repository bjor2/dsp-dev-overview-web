import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import type { EntityStatus, FlowNode } from "../api/types";

/** Live SB counts for one Flow node; same source as the SB tab (GET /sb/entities). */
export interface FlowNodeCounts { active: number | null; dlq: number | null; dlqHot: boolean }

/** Poll periods: fast while the Flow tab is on screen (activity pulses come from count deltas), slow when hidden. */
export interface FlowCountsPoll { visibleMs: number; hiddenMs: number }
export const FLOW_COUNTS_POLL: FlowCountsPoll = { visibleMs: 2500, hiddenMs: 30_000 };

/**
 * Polls /api/projects/{id}/sb/entities (immediately on mount, then every `visibleMs` while the document is visible,
 * every `hiddenMs` while hidden, and at once when it becomes visible again) and keys the counts by Flow node id.
 * The next poll is scheduled after the previous one settles, so a slow Service Bus never stacks requests.
 * Node ids are registration entity ids (q:…, t:…, s:topic/sub) on every host kind; the API already resolves
 * sbq-/sbt-{dev}-local-noe-dahl-shared-<short> (ADDENDA-004) and emulator names, so no name mapping is needed here.
 * Errors keep the last good counts and are returned (e.g. SB_NOT_CONFIGURED / SB_AUTH_FAILED).
 */
export function useFlowCounts(projectId: string, poll: FlowCountsPoll = FLOW_COUNTS_POLL): {
  counts: Map<string, FlowNodeCounts>; error: ApiError | null; updatedAt: Date | null; refresh: () => void;
} {
  const [counts, setCounts] = useState<Map<string, FlowNodeCounts>>(new Map());
  const [error, setError] = useState<ApiError | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  /** Bumped by every effect run: a poll that settles after a project switch / unmount neither writes nor reschedules. */
  const gen = useRef(0);

  const load = useCallback((g: number) =>
    api.entities(projectId).then(
      (list) => { if (gen.current !== g) return; setCounts(toCounts(list)); setError(null); setUpdatedAt(new Date()); },
      (e: unknown) => { if (gen.current === g) setError(e instanceof ApiError ? e : new ApiError(0, "API_UNREACHABLE", String(e), true)); },
    ),
  [projectId]);
  const refresh = useCallback(() => { void load(gen.current); }, [load]);

  const { visibleMs, hiddenMs } = poll;
  useEffect(() => {
    const g = ++gen.current;
    setCounts((c) => (c.size ? new Map() : c)); // a project switch never diffs one project's counts against another's
    let timer = 0;
    let inFlight = false;
    const tick = () => {
      window.clearTimeout(timer);
      if (inFlight) return;
      inFlight = true;
      void load(g).finally(() => {
        inFlight = false;
        if (gen.current === g) timer = window.setTimeout(tick, document.visibilityState === "visible" ? visibleMs : hiddenMs);
      });
    };
    const onVis = () => { if (document.visibilityState === "visible") tick(); };
    tick();
    document.addEventListener("visibilitychange", onVis);
    return () => { gen.current += 1; window.clearTimeout(timer); document.removeEventListener("visibilitychange", onVis); };
  }, [load, visibleMs, hiddenMs]);

  return { counts, error, updatedAt, refresh };
}

export const toCounts = (list: EntityStatus[]): Map<string, FlowNodeCounts> =>
  new Map(list.map((e) => [e.entityId, { active: e.activeCount, dlq: e.deadLetterCount, dlqHot: e.dlqHot }]));

/** Polled counts win; else the counts /flow returned with the graph (node.sb). */
export function nodeCounts(node: FlowNode, counts: Map<string, FlowNodeCounts>): FlowNodeCounts | null {
  const live = counts.get(node.id);
  if (live) return live;
  return node.sb ? { active: node.sb.activeCount, dlq: node.sb.deadLetterCount, dlqHot: node.sb.dlqHot } : null;
}

/** Text for a node badge: "a 3 · DLQ 7" ("—" = unknown). */
export const countsLabel = (c: FlowNodeCounts | null) => c ? `a ${c.active ?? "—"} · DLQ ${c.dlq ?? "—"}` : "";
