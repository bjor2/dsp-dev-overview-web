// Live activity for the Flow canvas: count deltas (useFlowCounts polls) + Functions host lines off the shared agent
// feed → short-lived node classes, edge dots and a capped feed. All timing lives here; the rules are in activity.ts.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { subscribeAgentLines } from "../../agent/statusFeed";
import { containerAppId } from "../../agent/useProjectApps";
import type { FlowNodeCounts } from "../../flow/useFlowCounts";
import type { FlowContainer, FlowEdge, FlowNode } from "../../api/types";
import {
  DOT_MS, HOLD_MS, activityEdges, diffCounts, eventText, feedKind, functionIndex, lineEvents, nodeClass, pushFeed,
  type ActivityEvent, type FeedItem,
} from "./activity";

export interface FlowActivity {
  /** nodeId → space-separated activity classes (activity-pulse, activity-dlq, activity-executing, …). */
  nodeClasses: ReadonlyMap<string, string>;
  /** nodeId → latest activity text while any class is held (appended to the node tooltip). */
  nodeTitles: ReadonlyMap<string, string>;
  /** nodeId → the "+3" / "DLQ +1" / "✗ Failed" chip beside the node while its event is held. */
  nodeBadges: ReadonlyMap<string, { kind: string; text: string }>;
  /** edgeKey (from→to) → restart key: a new value remounts the dot so its animation starts over. */
  edgeDots: ReadonlyMap<string, number>;
  /** Newest first, at most FEED_MAX. */
  feed: readonly FeedItem[];
  clearFeed: () => void;
}

interface Opts {
  projectId: string;
  nodes: readonly FlowNode[];
  containers: readonly FlowContainer[];
  edges: readonly FlowEdge[];
  counts: ReadonlyMap<string, FlowNodeCounts>;
  /** Tail Functions lines off the agent feed (false in demo mode). */
  agentLines: boolean;
}

type Mark = { until: number; text: string; at: number; badge?: string };
/** Chip text for events that change a number or fail; executing / succeeded / drain only light the ring. */
const badgeOf = (ev: ActivityEvent): string | undefined =>
  ev.type === "active" && ev.delta > 0 ? `+${ev.delta}`
    : ev.type === "dlq" ? `DLQ +${ev.delta}`
      : ev.type === "executed" && !ev.ok ? `✗ ${ev.outcome}`
        : undefined;
const FLUSH_MS = 100;
const hasFunctionLine = (raw: string) => raw.includes("Functions.");

/** DEV-only seam for Playwright: drive the canvas without Service Bus or an agent. */
declare global {
  interface Window {
    __flowActivityTest?: {
      projectId: string;
      inject: (events: ActivityEvent[]) => void;
      line: (l: { regId?: string; appId: string; line: string }) => void;
    };
  }
}

export function useFlowActivity({ projectId, nodes, containers, edges, counts, agentLines }: Opts): FlowActivity {
  const marks = useRef(new Map<string, Map<string, Mark>>());
  const dots = useRef(new Map<string, { until: number; seq: number }>());
  const seq = useRef(0);
  const [version, setVersion] = useState(0);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const expiry = useRef(0);

  const labels = useMemo(() => new Map(nodes.map((n) => [n.id, n.label])), [nodes]);
  const ctx = useRef({ labels, edges });
  ctx.current = { labels, edges };

  /** Drop everything past its `until`, then sleep until the next deadline. */
  const expire = useCallback(() => {
    window.clearTimeout(expiry.current);
    const now = Date.now();
    let next = Infinity;
    for (const [id, m] of marks.current) {
      for (const [cls, mk] of m) if (mk.until <= now) m.delete(cls); else next = Math.min(next, mk.until);
      if (!m.size) marks.current.delete(id);
    }
    for (const [k, d] of dots.current) if (d.until <= now) dots.current.delete(k); else next = Math.min(next, d.until);
    setVersion((v) => v + 1);
    if (next < Infinity) expiry.current = window.setTimeout(expire, next - now + 16);
  }, []);

  const apply = useCallback((events: ActivityEvent[]) => {
    if (!events.length) return;
    const now = Date.now();
    const { labels: lb, edges: es } = ctx.current;
    const feedItems: Omit<FeedItem, "count">[] = [];
    for (const ev of events) {
      const cls = nodeClass(ev);
      const text = eventText(ev, lb.get(ev.nodeId) ?? ev.nodeId);
      let m = marks.current.get(ev.nodeId);
      if (!m) marks.current.set(ev.nodeId, (m = new Map()));
      if (ev.type === "executed") m.delete("activity-executing");
      if (ev.type === "executing") m.delete("activity-succeeded"); // a held failure stays visible
      m.set(cls, { until: now + HOLD_MS[cls], text, at: now, badge: badgeOf(ev) });
      for (const k of activityEdges(ev, es)) dots.current.set(k, { until: now + DOT_MS, seq: ++seq.current });
      if (ev.type !== "executing") feedItems.push({ id: ++seq.current, at: now, nodeId: ev.nodeId, kind: feedKind(ev), text });
    }
    if (feedItems.length) setFeed((f) => feedItems.reduce(pushFeed, f));
    expire();
  }, [expire]);

  // Project switch: nothing carries over.
  useEffect(() => {
    marks.current.clear();
    dots.current.clear();
    setFeed([]);
    setVersion((v) => v + 1);
  }, [projectId]);
  useEffect(() => () => window.clearTimeout(expiry.current), []);

  // Count deltas between consecutive polls of the same project (useFlowCounts empties the map on a switch).
  const prevCounts = useRef<{ projectId: string; counts: ReadonlyMap<string, FlowNodeCounts> } | null>(null);
  useEffect(() => {
    const prev = prevCounts.current;
    prevCounts.current = { projectId, counts };
    if (prev && prev.projectId === projectId) apply(diffCounts(prev.counts, counts));
  }, [counts, projectId, apply]);

  // Functions host lines → handler nodes. The index is read through a ref so a graph refetch does not resubscribe.
  const index = useMemo(() => functionIndex(nodes, containers, containerAppId), [nodes, containers]);
  const indexRef = useRef(index);
  indexRef.current = index;
  useEffect(() => {
    if (!agentLines) return;
    let queue: ActivityEvent[] = [];
    let timer = 0;
    const flush = () => { timer = 0; const q = queue; queue = []; apply(q); };
    const unsub = subscribeAgentLines(hasFunctionLine, (lines) => {
      for (const l of lines) queue.push(...lineEvents(indexRef.current, projectId, l));
      if (queue.length && !timer) timer = window.setTimeout(flush, FLUSH_MS);
    });
    return () => { unsub(); window.clearTimeout(timer); };
  }, [agentLines, projectId, apply]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    window.__flowActivityTest = {
      projectId,
      inject: (events) => apply(events),
      line: (l) => apply(lineEvents(indexRef.current, projectId, { regId: l.regId ?? projectId, appId: l.appId, line: l.line })),
    };
    return () => { delete window.__flowActivityTest; };
  }, [projectId, apply]);

  const derived = useMemo(() => {
    const nodeClasses = new Map<string, string>();
    const nodeTitles = new Map<string, string>();
    const nodeBadges = new Map<string, { kind: string; text: string }>();
    for (const [id, m] of marks.current) {
      if (!m.size) continue;
      nodeClasses.set(id, [...m.keys()].join(" "));
      const latest = [...m.values()].reduce((a, b) => (b.at >= a.at ? b : a));
      nodeTitles.set(id, latest.text);
      let chip: [string, Mark] | null = null;
      for (const e of m) if (e[1].badge && (!chip || e[1].at >= chip[1].at)) chip = e;
      if (chip) nodeBadges.set(id, { kind: chip[0].replace("activity-", ""), text: chip[1].badge! });
    }
    const edgeDots = new Map([...dots.current].map(([k, d]) => [k, d.seq]));
    return { nodeClasses, nodeTitles, nodeBadges, edgeDots };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const clearFeed = useCallback(() => setFeed([]), []);
  return { ...derived, feed, clearFeed };
}

const REDUCED = "(prefers-reduced-motion: reduce)";
const subscribeReduced = (l: () => void) => {
  const mq = window.matchMedia(REDUCED);
  mq.addEventListener("change", l);
  return () => mq.removeEventListener("change", l);
};
/** True when the OS asks for less motion: no travelling dots (SMIL ignores CSS media queries), static highlights. */
export const usePrefersReducedMotion = () => useSyncExternalStore(subscribeReduced, () => window.matchMedia(REDUCED).matches);
