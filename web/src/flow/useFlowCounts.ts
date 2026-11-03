import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import type { EntityStatus, FlowNode } from "../api/types";

/** Live SB counts for one Flow node; same source as the SB tab (GET /sb/entities). */
export interface FlowNodeCounts { active: number | null; dlq: number | null; dlqHot: boolean }

/**
 * Polls /api/projects/{id}/sb/entities (default every 10 s, immediately on mount) and keys the counts by Flow node id.
 * Node ids are registration entity ids (q:…, t:…, s:topic/sub) on every host kind; the API already resolves
 * sbq-/sbt-{dev}-local-noe-dahl-shared-<short> (ADDENDA-004) and emulator names, so no name mapping is needed here.
 * Errors keep the last good counts and are returned (e.g. SB_NOT_CONFIGURED / SB_AUTH_FAILED).
 */
export function useFlowCounts(projectId: string, intervalMs = 10_000): {
  counts: Map<string, FlowNodeCounts>; error: ApiError | null; updatedAt: Date | null; refresh: () => void;
} {
  const [counts, setCounts] = useState<Map<string, FlowNodeCounts>>(new Map());
  const [error, setError] = useState<ApiError | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(() => {
    api.entities(projectId).then(
      (list) => { if (!alive.current) return; setCounts(toCounts(list)); setError(null); setUpdatedAt(new Date()); },
      (e: unknown) => { if (alive.current) setError(e instanceof ApiError ? e : new ApiError(0, "API_UNREACHABLE", String(e), true)); },
    );
  }, [projectId]);

  useEffect(() => {
    alive.current = true;
    refresh();
    const t = window.setInterval(() => { if (document.visibilityState === "visible") refresh(); }, intervalMs);
    return () => { alive.current = false; window.clearInterval(t); };
  }, [refresh, intervalMs]);

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
