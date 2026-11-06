import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { useOutletContext, useParams } from "react-router-dom";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import { demoFlow } from "../mocks/demo";
import { Count, Empty, ErrorBanner, noticeText, noticeTitle } from "../components/common";
import { useDemo } from "../components/DemoContext";
import { appAgentView, stateGlyph, STATE_GLYPH } from "../agent/derive";
import { useAgentStatus, useNow } from "../agent/statusFeed";
import { containerAppId } from "../agent/useProjectApps";
import { CONTAINER_FONT, CONTAINER_SUB_FONT, NODE_FONT, fitSvgLabel, measureSvgText } from "./flow/labels";
import SampleMessagePicker from "../components/SampleMessagePicker";
import { nodeCounts, useFlowCounts, type FlowNodeCounts } from "../flow/useFlowCounts";
import { edgeKey, type FeedItem } from "./flow/activity";
import { useFlowActivity, usePrefersReducedMotion } from "./flow/useFlowActivity";
import { handlerFunction, normalizeGraph, selfRequeue } from "./flow/model";
import { clearLocalPositions, loadLocalPositions, mergeLocalPositions, storageKey } from "./flow/localPositions";
import type { ArchFlowRef, FlowEdge, FlowNode, HandlerTrigger } from "../api/types";
import ArchitectureView, { type ArchViewState, type LeaveFocus } from "../architecture/ArchitectureView";
import { setArchFixtures, useArchitecture } from "../architecture/useArchitecture";
import { ARCHITECTURE_INVALID } from "../architecture/model";
import type { ProjectOutletContext } from "./ProjectDetailLayout";
import type { FlowContainer, PosMap, Rect, V2Node, XY } from "./flow/model";
import {
  EMPTY_GEOMETRY, H, HDR, W, clampInner, computeLayers, contentBounds, deriveGeometry, edgePath, headerPath, nodeRect, settleLayout,
} from "./flow/layout";

const ZMIN = 0.2, ZMAX = 3;
/** `.activity-badge text` (styles.css). */
const BADGE_FONT = { font: "700 10px system-ui, sans-serif", letterSpacing: 0 };
/** `.explore-pill text` (styles.css). */
const PILL_FONT = { font: "600 11px system-ui, sans-serif", letterSpacing: 0 };
const EXPLORE_TIP = "Explore architecture: responsibilities and data paths for this handler (static, not live)";

/** Single palette for canvas + legend. */
const PALETTE = {
  kind: {
    external: { fill: "#fff4e0", stroke: "#d39b3a", dash: "4 3", label: "Seed / external" },
    app: { fill: "#e0edff", stroke: "#5b8def", dash: undefined, label: "Handler / app" },
    queue: { fill: "#e6f6ea", stroke: "#5aa86c", dash: undefined, label: "Queue" },
    topic: { fill: "#f1e9ff", stroke: "#9a7bd8", dash: undefined, label: "Topic" },
    subscription: { fill: "#f7f2ff", stroke: "#b39ddb", dash: undefined, label: "Subscription" },
    /** ADDENDA-009: standalone storage source; no sb, no counts, not peekable. */
    blobContainer: { fill: "#e0f2f1", stroke: "#0f766e", dash: undefined, label: "Blob container (storage)" },
  } as Record<string, { fill: string; stroke: string; dash?: string; label: string }>,
  fallback: { fill: "#ffffff", stroke: "#94a3b8", dash: undefined, label: "Other" },
  /** ADDENDA-009: sb.state === "missing" → muted + dashed, never hot. */
  missing: { fill: "#f8fafc", stroke: "#94a3b8", dash: "4 3" },
  storage: "#0f766e",
  container: { fill: "#5b8def14", stroke: "#5b8def", dash: "6 3" },
  hot: "#dc2626",
  sel: "#2563eb",
  edge: "#94a3b8",
  inject: "#2f80ed",
  back: "#f59e0b",
  attached: "#16a34a",
  detached: "#94a3b8",
  text: "#0f172a",
  sub: "#475569",
};
/** Handler nodes render like the old app nodes (same box, blue tint). */
const kindStyle = (k: string) => PALETTE.kind[k === "handler" ? "app" : k] ?? PALETTE.fallback;
const LEGEND_KEY = "flow.legend.collapsed";

/** ADDENDA-009 helpers: trigger kinds and the "not provisioned" state. */
const triggersOf = (n: V2Node, kind: HandlerTrigger["kind"]): HandlerTrigger[] =>
  (Array.isArray(n.handler?.triggers) ? n.handler!.triggers! : []).filter((t) => t && t.kind === kind);
const isMissing = (n: V2Node) => n.sb?.state === "missing";
const timerTooltip = (ts: HandlerTrigger[]) =>
  ts.map((t) => `⏰ ${t.function ?? "timer"}: ${t.schedule ?? t.setting ?? "(schedule unknown)"}${t.schedule && t.setting ? " (setting " + t.setting + ")" : ""}`).join("\n");
const blobTooltip = (ts: HandlerTrigger[]) =>
  ts.map((t) => `blob ${t.function ?? "trigger"}: ${t.path ?? t.entityId ?? ""}`).join("\n");

/** Small SVG clock (circle + two hands); used in the timer badge and the legend. */
const ClockIcon = ({ cx, cy, r = 4.5 }: { cx: number; cy: number; r?: number }) => (
  <g className="clock">
    <circle cx={cx} cy={cy} r={r} />
    <path d={`M${cx},${cy - r * 0.6}V${cy}H${cx + r * 0.5}`} />
  </g>
);

function FlowLegend({ rootRef }: { rootRef: RefObject<HTMLDivElement | null> }) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(LEGEND_KEY) === "1");
  const toggle = () => setCollapsed((c) => { localStorage.setItem(LEGEND_KEY, c ? "0" : "1"); return !c; });
  const box = (fill: string, stroke: string, dash?: string, sw = 1.2) => (
    <svg width="22" height="12"><rect x="1" y="1" width="20" height="10" rx="2" fill={fill} stroke={stroke} strokeWidth={sw} strokeDasharray={dash} /></svg>
  );
  const line = (stroke: string, dash?: string) => (
    <svg width="26" height="10"><line x1="1" y1="5" x2="25" y2="5" stroke={stroke} strokeWidth="1.8" strokeDasharray={dash} /></svg>
  );
  return (
    <div ref={rootRef} className="flow-legend" onPointerDown={(e) => e.stopPropagation()}>
      <button type="button" className="ghost legend-toggle" onClick={toggle} aria-expanded={!collapsed}>
        {collapsed ? "▸ Legend" : "▾ Legend"}
      </button>
      {!collapsed && (
        <div className="legend-body">
          <div className="legend-col">
            {Object.values(PALETTE.kind).map((k) => (
              <div key={k.label}>{box(k.fill, k.stroke, k.dash)} {k.label}</div>
            ))}
            <div>{box(PALETTE.container.fill, PALETTE.container.stroke, PALETTE.container.dash)} Container (app)</div>
            <div><span className="legend-pill">⟲ requeue</span> self-requeue (no edge)</div>
            <div>{box(PALETTE.missing.fill, PALETTE.missing.stroke, PALETTE.missing.dash)} not on namespace (missing)</div>
            <div>{box("#fff", PALETTE.hot, undefined, 2.5)} DLQ hot</div>
            <div>{box("#fff", PALETTE.sel, undefined, 2.5)} Selected</div>
          </div>
          <div className="legend-col">
            <div>{line(PALETTE.edge)} trigger / publish</div>
            <div>{line(PALETTE.storage)} blob trigger (from storage)</div>
            <div>
              <span className="legend-pill timer"><svg width="11" height="11" viewBox="0 0 11 11"><ClockIcon cx={5.5} cy={5.5} /></svg> timer</span>
              <span className="legend-pill blob">▤ blob</span> trigger badges
            </div>
            <div>{line(PALETTE.inject)} inject</div>
            <div>{line(PALETTE.edge, "2 4")} inferred</div>
            <div>{line(PALETTE.edge, "8 5")} cloud</div>
            <div>{line(PALETTE.back)} back-edge (upward)</div>
            <div><code>a 3 · DLQ 7</code> active · dead-letter</div>
            <div><code>a — · DLQ —</code> count unknown (Service Bus did not answer)</div>
            <div><span className="legend-activity pulse" /> message landed · <span className="legend-activity dlq" /> DLQ grew</div>
            <div><span className="legend-activity executing" /> executing · <span className="legend-activity succeeded" /> ok · <span className="legend-activity failed" /> failed</div>
            <div><span style={{ color: PALETTE.attached }}>●</span> attached <span style={{ color: PALETTE.detached }}>○</span> not attached</div>
            <div className="agent-states" title="App state reported by the local agent (container header)">
              {Object.entries(STATE_GLYPH).map(([k, g]) => <span key={k}><span style={{ color: g.color }}>{g.glyph}</span> {k} </span>)}
            </div>
            <div><span className="state-unknown">?</span> state unknown (agent)</div>
            <div className="muted">drag node · drag box header moves its nodes · drag canvas pans · wheel zooms</div>
            <div className="muted">shift+click / shift+drag selects · drag selection moves group · Esc clears</div>
          </div>
        </div>
      )}
    </div>
  );
}

const FEED_KEY = "flow.activity.collapsed";
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Last ~20 activity events (newest first); a row selects its node. Overlays the canvas top-right. */
function ActivityFeed({ feed, onPick, onClear, live }: { feed: readonly FeedItem[]; onPick: (nodeId: string) => void; onClear: () => void; live: string }) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(FEED_KEY) === "1");
  const toggle = () => setCollapsed((c) => { localStorage.setItem(FEED_KEY, c ? "0" : "1"); return !c; });
  return (
    <div className={`flow-activity-feed${collapsed ? " collapsed" : ""}`} onPointerDown={(e) => e.stopPropagation()} aria-live="polite">
      <div className="feed-head">
        <button type="button" className="ghost legend-toggle" onClick={toggle} aria-expanded={!collapsed}>
          {collapsed ? "▸" : "▾"} Activity{feed.length ? ` (${feed.length})` : ""}
        </button>
        {!collapsed && feed.length > 0 && <button type="button" className="ghost feed-clear" onClick={onClear} title="Clear the feed">clear</button>}
      </div>
      {!collapsed && (feed.length === 0 ? (
        <div className="muted feed-empty">Waiting for messages… ({live})</div>
      ) : (
        <ol>
          {feed.map((i) => (
            <li key={i.id} className={`feed-item ${i.kind}`} data-node={i.nodeId}>
              <time>{clock(i.at)}</time>
              <a href="#" title={`Select ${i.nodeId}`} onClick={(e) => { e.preventDefault(); onPick(i.nodeId); }}>{i.text}</a>
              {i.count > 1 && <span className="feed-count">×{i.count}</span>}
            </li>
          ))}
        </ol>
      ))}
    </div>
  );
}

/** SMIL ignores begin="0s" on elements inserted after load (it is relative to the document start): start it now. */
const beginNow = (el: SVGAnimationElement | null) => { try { el?.beginElement(); } catch { /* jsdom / no SMIL */ } };
const NO_NODES: FlowNode[] = [];
const NO_CONTAINERS: FlowContainer[] = [];

type View = { x: number; y: number; k: number };
/**
 * One drag, tracked on window listeners (not on the element under the pointer): the target is computed as
 * `origin + (client − clientStart) / k` from the drag START, never incrementally, so coalesced/fast moves land
 * exactly where the pointer is. `last` is the latest position written to state, in the WIRE frame (containers /
 * standalone absolute, inner nodes relative to their container) — pointer-up reads this, not React state, because
 * the final pointermove is often not rendered yet when pointerup arrives.
 * A drag moves one item, or the whole multi-selection when the grabbed item is part of it: every item gets the
 * same client delta applied to its own drag-start origin.
 */
type DragItem = {
  id: string;
  /** Drag-start position (absolute): the box origin for containers, the absolute node position otherwise. */
  origin: XY;
  /** Container origin (absolute) when dragging an inner node. */
  base?: XY;
};
type Drag = {
  items: DragItem[];
  sx: number; sy: number; k: number;
  /** Latest wire-frame position per dragged id (null until the pointer first moves). */
  last: PosMap | null;
  pointerId: number;
  el: Element;
};
/** Axis-aligned box in graph coordinates without an id (marquee, hit tests). */
type Box = Omit<Rect, "id">;
/** A pointerdown→up that moved less than this (px) is a click, not a drag. */
const CLICK_SLOP = 3;
const isClick = (sx: number, sy: number, ev: PointerEvent) => Math.hypot(ev.clientX - sx, ev.clientY - sy) < CLICK_SLOP;
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const EMPTY_SELECTION: ReadonlySet<string> = new Set();
const isTypingTarget = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
const edgeTooltip = (e: FlowEdge) =>
  `${e.kind}: ${e.from} → ${e.to}${e.label ? " (" + e.label + ")" : ""} [${e.confidence}]` +
  (e.sources?.length ? "\n" + e.sources.map((s) => "  " + s).join("\n") : "");

const requeueTooltip = (n: V2Node) =>
  selfRequeue(n)
    .map((r) => `Self-requeue → ${r.entityId}${r.messages?.length ? ": " + r.messages.join(", ") : ""}`)
    .join("\n");

export default function FlowTab() {
  const { projectId = "" } = useParams();
  const [showCloud, setShowCloud] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  /** Multi-selection (node + container ids): shift+click toggles, shift+drag marquee adds, a drag moves all of it. */
  const [selection, setSelection] = useState<ReadonlySet<string>>(EMPTY_SELECTION);
  /** Live marquee in graph coordinates while shift-dragging on the empty canvas. */
  const [marquee, setMarquee] = useState<Box | null>(null);
  /** Wire frame (ADDENDA-008 §7): container ids absolute, inner node ids RELATIVE to their container, others absolute. */
  const [pos, setPos] = useState<PosMap>({});
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const pan = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null);
  const [resetting, setResetting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const drag = useRef<Drag | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  /** ADDENDA-011 architecture mode. Flow stays mounted (hidden) so view / pos / selection / activity keep their state. */
  const [arch, setArch] = useState<{ layerId: string } | null>(null);
  const archRef = useRef(arch);
  archRef.current = arch;
  const archViewState = useRef<ArchViewState | null>(null);
  const legendRef = useRef<HTMLDivElement | null>(null);
  const scope = showCloud ? "all" : "local";
  const { data, error, loading, reload } = useApi(() => api.flow(projectId, scope), demoFlow, [projectId, scope]);
  const { counts, updatedAt, refresh } = useFlowCounts(projectId);
  /** ADDENDA-010 §4: the local agent's app state, shown next to (never merged with) the API's attached flag. */
  const { demoMode } = useDemo();
  const agentFeed = useAgentStatus(!demoMode);
  const agentNow = Math.max(useNow(5000), agentFeed.receivedAt);
  /** ADDENDA-009: the project notice comes from the summary ProjectDetailLayout already fetched (no extra endpoint). */
  const outlet = useOutletContext<ProjectOutletContext | undefined>();
  const notice = outlet?.project?.notice;
  /** ADDENDA-009 §3: `available === false` → no "Inject sample…" (send/purge would 404 SAMPLES_NOT_AVAILABLE). */
  const samples = useApi(() => api.samples(projectId), undefined, [projectId]);
  const samplesAvailable = samples.data ? samples.data.available !== false : null; // null = unknown (loading / error) → keep the button
  /** Local positions are the source of truth; nodes the user moved are never overwritten by server data. */
  const moved = useRef<Set<string>>(new Set());
  const needFit = useRef(true); // first load, Reset, project change only
  const posRef = useRef<PosMap>({});
  posRef.current = pos;
  useEffect(() => {
    moved.current = new Set();
    needFit.current = true;
    setSelection(EMPTY_SELECTION);
    setSelected(null);
  }, [projectId]);

  /** Clears multi-selection AND the single focus (outline + side panel). Used by Esc, empty-canvas click, Reset. */
  const clearSelection = useCallback(() => {
    setSelection((s) => (s.size ? EMPTY_SELECTION : s));
    setSelected(null);
  }, []);
  const toggleSelected = (id: string) =>
    setSelection((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  // Esc clears multi-selection and focus.
  useEffect(() => {
    // Skipped in architecture mode: there Esc clears the architecture selection only.
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !archRef.current) clearSelection(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clearSelection]);

  const graph = useMemo(() => (data ? normalizeGraph(data) : null), [data]);
  /** ADDENDA-011.1: root layer per handler id (handler.opensLayerId / fixture seam). Never changes `graph`. */
  const architecture = useArchitecture(projectId, graph?.nodes, graph?.warnings, demoMode);
  useEffect(() => { setArch(null); }, [projectId]);
  const openLayer = useCallback((layerId: string) => setArch({ layerId }), []);
  /**
   * Back to Flow: arch = null and nothing else (no fitView, no view change, selection kept). Only an explicit
   * "View in Flow" (focus: origin) or a node's "⇱ Flow" (focus: entity id) selects something, and only when it is
   * in the current graph.
   */
  const { clearCache: clearArchCache } = architecture;
  const leaveArchitecture = useCallback((opts?: LeaveFocus & { rootFlowRef?: ArchFlowRef }) => {
    setArch(null);
    clearArchCache();
    const ref = opts?.rootFlowRef ?? archViewState.current?.rootFlowRef ?? undefined;
    const id = opts?.focus === "origin" ? ref?.handlerId : opts?.focus;
    if (id && graph && (graph.containers.some((c) => c.id === id) || graph.nodes.some((n) => n.id === id))) setSelected(id);
  }, [clearArchCache, graph]);
  const inGraph = useCallback(
    (id: string) => !!graph && (graph.containers.some((c) => c.id === id) || graph.nodes.some((n) => n.id === id)),
    [graph],
  );
  const onArchState = useCallback((st: ArchViewState) => { archViewState.current = st; }, []);
  // DEV only (compiled out of builds): Playwright hooks for the fixture seam.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __archTest?: unknown };
    w.__archTest = {
      enable: () => setArchFixtures(true),
      disable: () => setArchFixtures(false),
      open: (layerId: string) => openLayer(layerId),
      state: () => ({
        mode: archRef.current ? "architecture" : "flow",
        layerId: archRef.current?.layerId ?? null,
        breadcrumbs: archRef.current ? (archViewState.current?.breadcrumbs ?? []) : [],
        rootFlowRef: archRef.current ? (archViewState.current?.rootFlowRef ?? null) : null,
        source: architecture.source,
        roots: Object.fromEntries(architecture.roots),
      }),
    };
    return () => { delete w.__archTest; };
  }, [openLayer, architecture.source, architecture.roots]);
  /** localStorage key for this project + env (dsp-flow-pos:v2:{project}:{env}); the ref is for drag-end / unload writes. */
  const posKey = useMemo(() => storageKey(projectId, graph), [projectId, graph]);
  const posKeyRef = useRef(posKey);
  posKeyRef.current = posKey;
  /** Ids whose position came from localStorage (shown in the toolbar indicator). */
  const [localCount, setLocalCount] = useState(0);
  const pad = graph?.layoutHints.containerPadding ?? 16;
  const visibleEdges = useMemo(
    () => (graph?.edges ?? []).filter((e) => showCloud || e.scope !== "cloud"),
    [graph, showCloud],
  );
  /** Canvas draws one path per from→to; the side panel still lists every edge. */
  const drawnEdges = useMemo(() => {
    const seen = new Set<string>();
    return visibleEdges.filter((e) => {
      const key = e.from + "→" + e.to;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [visibleEdges]);
  const geo = useMemo(() => (graph ? deriveGeometry(graph, pos) : EMPTY_GEOMETRY), [graph, pos]);
  /** Live message activity: count deltas + Functions host lines → node rings, edge dots, the feed. */
  const activity = useFlowActivity({
    projectId, nodes: graph?.nodes ?? NO_NODES, containers: graph?.containers ?? NO_CONTAINERS, edges: visibleEdges, counts, agentLines: !demoMode,
  });
  const reducedMotion = usePrefersReducedMotion();

  const fitView = useCallback((rects: Rect[]) => {
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const b = contentBounds(rects);
    const padPx = 24;
    // The legend overlays the bottom-left corner of the canvas. Reserve its bbox either as a bottom inset or as a
    // left inset (whichever leaves the graph larger) so a fitted graph is never covered by it.
    const gap = 8;
    const lg = legendRef.current?.getBoundingClientRect();
    const overlaps = !!lg && lg.width > 0 && lg.height > 0 && lg.top < r.bottom && lg.right > r.left;
    const insets = overlaps
      ? [{ left: 0, bottom: r.bottom - lg.top + gap }, { left: lg.right - r.left + gap, bottom: 0 }]
      : [{ left: 0, bottom: 0 }];
    const fitFor = ({ left, bottom }: { left: number; bottom: number }) => {
      const aw = Math.max(1, r.width - left - padPx * 2), ah = Math.max(1, r.height - bottom - padPx * 2);
      const k = Math.min(ZMAX, Math.max(ZMIN, Math.min(aw / b.w, ah / b.h, 1.6)));
      return { k, x: left + (r.width - left - b.w * k) / 2 - b.minX * k, y: (r.height - bottom - b.h * k) / 2 - b.minY * k };
    };
    setView(insets.map(fitFor).reduce((best, v) => (v.k > best.k ? v : best)));
  }, []);

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const px = cx ?? r.width / 2, py = cy ?? r.height / 2;
    setView((v) => {
      const k = Math.min(ZMAX, Math.max(ZMIN, v.k * factor));
      const f = k / v.k;
      return { k, x: px - (px - v.x) * f, y: py - (py - v.y) * f };
    });
  }, []);

  // Non-passive wheel listener so preventDefault works (wheel + pinch zoom toward cursor).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const step = e.ctrlKey ? 0.01 : 0.0015;
      zoomAt(Math.exp(-e.deltaY * step), e.clientX - r.left, e.clientY - r.top);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [zoomAt, data]);

  // Rebuild positions only when the graph is (re)fetched. Precedence: this browser's localStorage positions, then
  // the server's (wire) positions for ids missing there, then auto-layout. Local + stored + moved items are pinned
  // verbatim, only auto-laid items are de-overlapped — and NOTHING here is persisted (never write on load), so
  // nudged defaults never end up in localStorage. Fit only when requested (first load / Reset / project change).
  useEffect(() => {
    if (!graph) return;
    const local = loadLocalPositions(posKey, graph); // unknown ids already dropped
    const prev: PosMap = { ...posRef.current };
    const pin = new Set(moved.current);
    for (const [id, p] of Object.entries(local)) {
      if (!moved.current.has(id)) prev[id] = p; // a drag this session wins over the stored copy
      pin.add(id);
    }
    setLocalCount(Object.keys(local).length);
    const { pos: next, geo: g } = settleLayout(graph, visibleEdges, prev, pin);
    posRef.current = next;
    setPos(next);
    // Drop selected ids the fresh graph no longer has (e.g. cloud nodes after "Show cloud edges" is turned off).
    setSelection((s) => {
      const keep = [...s].filter((id) => g.boxes[id] || g.absPos[id]);
      return keep.length === s.size ? s : new Set(keep);
    });
    if (needFit.current) {
      needFit.current = false;
      const rects = g.topRects;
      requestAnimationFrame(() => fitView(rects));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, visibleEdges, posKey]);

  /**
   * Write every key dragged this session (from the in-memory map, wire frame) into localStorage under `key`,
   * merged over what is already stored there. No-op when nothing was dragged, so a plain load never writes.
   * Drags are NOT sent to the server any more: positions live in this browser only.
   */
  const flushLocal = useCallback((key: string) => {
    const ids = [...moved.current];
    if (!ids.length) return;
    const patch: PosMap = {};
    for (const id of ids) if (posRef.current[id]) patch[id] = posRef.current[id];
    mergeLocalPositions(key, patch);
  }, []);

  // Drag-end already writes; these are the safety net for a drag whose write got lost: pagehide / beforeunload /
  // tab hidden, and unmount / project switch (the cleanup closes over the OLD key, before `moved` is reset).
  useEffect(() => {
    const onHide = () => flushLocal(posKey);
    const onVis = () => { if (document.visibilityState === "hidden") flushLocal(posKey); };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("beforeunload", onHide);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("beforeunload", onHide);
      document.removeEventListener("visibilitychange", onVis);
      flushLocal(posKey);
    };
  }, [posKey, flushLocal]);

  /**
   * Track one pointer on window listeners until it is released: `onMove` for every move, `onEnd` once on
   * pointerup / pointercancel (other pointers are ignored).
   */
  const trackPointer = (pointerId: number, onMove: ((ev: PointerEvent) => void) | null, onEnd: (ev: PointerEvent) => void) => {
    const move = (ev: PointerEvent) => { if (ev.pointerId === pointerId) onMove?.(ev); };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      onEnd(ev);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  // Background pointerdown: shift → marquee select; otherwise pan (window listeners until pointerup, absolute delta
  // from the start). A plain click (no movement) on the empty canvas clears multi-selection and focus.
  const onBgPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || drag.current) return;
    if (e.shiftKey) return beginMarquee(e);
    const pn = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    pan.current = pn;
    trackPointer(
      e.pointerId,
      (ev) => setView((v) => ({ ...v, x: pn.vx + ev.clientX - pn.sx, y: pn.vy + ev.clientY - pn.sy })),
      (ev) => {
        pan.current = null;
        if (ev.type === "pointerup" && isClick(pn.sx, pn.sy, ev)) clearSelection();
      },
    );
  };

  /**
   * Shift+drag on the empty canvas: a marquee in graph coordinates (view snapshot from the start). On release every
   * node and container whose bbox intersects it is ADDED to the selection.
   */
  const beginMarquee = (e: React.PointerEvent) => {
    const svg = svgRef.current;
    if (!svg) return;
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    const v = view;
    const toGraph = (cx: number, cy: number): XY => ({ x: (cx - r.left - v.x) / v.k, y: (cy - r.top - v.y) / v.k });
    const a = toGraph(e.clientX, e.clientY);
    const boxTo = (ev: PointerEvent): Box => {
      const b = toGraph(ev.clientX, ev.clientY);
      return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
    };
    trackPointer(
      e.pointerId,
      (ev) => setMarquee(boxTo(ev)),
      (ev) => {
        setMarquee(null);
        if (ev.type !== "pointerup") return;
        const m = boxTo(ev);
        if (!m.w && !m.h) return; // shift+click on empty canvas: no-op
        const hits = [
          ...Object.values(geo.boxes).filter((b) => overlaps(m, b)).map((b) => b.id),
          ...Object.entries(geo.absPos).filter(([id, p]) => overlaps(m, nodeRect(id, p))).map(([id]) => id),
        ];
        if (hits.length) setSelection((s) => new Set([...s, ...hits]));
      },
    );
  };

  /** Latest drag-frame state → wire-frame position for one dragged item (inner nodes clamped inside their box). */
  const dragTarget = (d: Drag, it: DragItem, clientX: number, clientY: number): XY => {
    const ax = it.origin.x + (clientX - d.sx) / d.k, ay = it.origin.y + (clientY - d.sy) / d.k;
    return it.base ? clampInner({ x: ax - it.base.x, y: ay - it.base.y }, pad) : { x: ax, y: ay };
  };
  /** Wire-frame positions of every dragged item for one pointer position (same delta for all). */
  const dragTargets = (d: Drag, clientX: number, clientY: number): PosMap =>
    Object.fromEntries(d.items.map((it) => [it.id, dragTarget(d, it, clientX, clientY)]));

  const endDrag = (d: Drag) => {
    drag.current = null;
    try { d.el.releasePointerCapture?.(d.pointerId); } catch { /* already released */ }
    if (!d.last || !graph) return;
    // The drop position is exactly where the user let go: `origin + (client − clientStart) / k`, computed once from
    // the drag-start snapshot (inner nodes only clamped inside their box). No de-overlap nudge here: it used to snap a
    // box that landed on another unit to the far side of that unit (a 150px drag to the right became a 218px drop).
    // Read the drag's own last positions, not React state: the last pointermove may not be rendered yet.
    const final = d.last;
    const cur: PosMap = { ...posRef.current, ...final };
    posRef.current = cur;
    setPos(cur);
    // Exact graph ids ("container:…" for boxes, node id otherwise) merged into this browser's localStorage map.
    mergeLocalPositions(posKeyRef.current, final);
    setLocalCount(Object.keys(loadLocalPositions(posKeyRef.current, graph)).length);
  };

  /**
   * One item to drag. Box origin == the container's stored position (deriveGeometry puts the box at pos[c.id];
   * header and padding are drawn INSIDE the box), so the drag target is the wire position with no header/padding
   * offset added. Inner nodes also carry their container's origin, to convert back to the relative wire frame.
   */
  const dragItem = (id: string): DragItem | null => {
    const origin = geo.boxes[id] ?? geo.absPos[id];
    if (!origin) return null;
    const cid = geo.containerOf[id];
    const base = cid ? posRef.current[cid] : undefined;
    return { id, origin: { x: origin.x, y: origin.y }, base: base ? { x: base.x, y: base.y } : undefined };
  };

  const beginDrag = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    if (e.button !== 0 || drag.current) return;
    e.preventDefault();
    // Shift+click toggles the item in/out of the multi-selection; a shift+drag on an item moves nothing.
    if (e.shiftKey) {
      const sx = e.clientX, sy = e.clientY;
      trackPointer(e.pointerId, null, (ev) => { if (ev.type === "pointerup" && isClick(sx, sy, ev)) toggleSelected(id); });
      return;
    }
    if (resetting) return;
    // Grabbing a selected item drags the whole selection, except inner nodes whose container is selected too (they
    // follow their box). Grabbing anything else clears the selection and drags just that item.
    const group = selection.has(id);
    if (!group) clearSelection();
    const ids = group
      ? [...selection].filter((s) => { const cid = geo.containerOf[s]; return !(cid && selection.has(cid)); })
      : [id];
    const items = ids.map(dragItem).filter((it): it is DragItem => !!it);
    if (!items.length) return;
    const el = e.currentTarget as Element;
    const d: Drag = { items, sx: e.clientX, sy: e.clientY, k: view.k, last: null, pointerId: e.pointerId, el };
    drag.current = d;
    // Capture on the element that got pointerdown (keeps delivery when the pointer outruns the box or leaves the
    // window); listeners on window so neither React re-renders nor hit-testing can drop a move or the up.
    try { el.setPointerCapture?.(e.pointerId); } catch { /* unsupported */ }
    const onMove = (ev: PointerEvent) => {
      if (drag.current !== d || ev.pointerId !== d.pointerId) return;
      if (!d.last && ev.clientX === d.sx && ev.clientY === d.sy) return;
      const p = dragTargets(d, ev.clientX, ev.clientY);
      d.last = p;
      for (const it of d.items) moved.current.add(it.id);
      setPos((prev) => ({ ...prev, ...p }));
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== d.pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (drag.current !== d) return;
      if (ev.type === "pointerup" && d.last) d.last = dragTargets(d, ev.clientX, ev.clientY);
      endDrag(d);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    setSelected(id);
  };

  /**
   * Reset = back to the server's default layout: this browser's localStorage key is removed, PUT {} clears any
   * legacy server-side store (best-effort, errors ignored), then /flow is re-fetched and its positions REPLACE
   * every local position (nothing dragged this session survives: the moved-set and the in-memory map are cleared
   * before the fresh graph is settled and fitted).
   */
  const resetLayout = async () => {
    setConfirmReset(false);
    setResetting(true);
    try {
      drag.current = null;
      setSelection(EMPTY_SELECTION);
      setSelected(null);
      moved.current = new Set(); // cleared first so the unload safety net cannot re-write the dropped keys
      clearLocalPositions(posKey);
      await api.saveFlowPositions(projectId, {}).catch(() => { /* server store is optional now */ });
      posRef.current = {};
      needFit.current = true;
      reload(); // fresh /flow → settleLayout with no moved ids, no local map, no previous map → defaults → fit
    } finally {
      setResetting(false);
    }
  };
  /** "stored" / "default" counts for the toolbar indicator. */
  const positionStats = useMemo(() => {
    const items = [...(graph?.containers ?? []), ...(graph?.nodes ?? [])].filter((i) => i.position);
    const stored = items.filter((i) => i.positionSource === "stored").length;
    const dflt = items.filter((i) => i.positionSource === "default").length;
    return { total: items.length, stored, default: dflt, local: localCount };
  }, [graph, localCount]);

  const layers = useMemo(() => (graph ? computeLayers(graph.nodes.map((n) => n.id), visibleEdges) : {}), [graph, visibleEdges]);
  /** Node kind by id, for styling an edge by its SOURCE node (blob trigger = normal `trigger` edge from a blobContainer). */
  const kindOf = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n.kind as string])), [graph]);
  const sel = graph?.nodes.find((n) => n.id === selected);
  const selContainer = graph?.containers.find((c) => c.id === selected);
  const containerLabel = (id?: string) => graph?.containers.find((c) => c.id === id)?.label ?? id;

  const nodeSubtitle = (n: V2Node, c: ReturnType<typeof nodeCounts>) => {
    if (n.app)
      return n.app.attached ? <tspan fill={PALETTE.attached}>● attached</tspan> : <tspan fill={PALETTE.detached}>○ not attached</tspan>;
    if (n.kind === "handler") return handlerFunction(n) ?? (n.handler?.triggerEntityIds?.length ? "trigger: " + n.handler.triggerEntityIds.join(", ") : "handler");
    if (n.kind === "blobContainer") return "storage · blob container";
    if (isMissing(n)) return c ? `a — · DLQ — · not on namespace` : "not on namespace";
    return c ? countsText(c) : n.kind;
  };
  /** Same text as countsLabel ("a 3 · DLQ 7"), with the DLQ part in its own tspan so `activity-dlq` can flash it. */
  const countsText = (c: FlowNodeCounts) => <>a {c.active ?? "—"} · <tspan className="dlq-count">DLQ {c.dlq ?? "—"}</tspan></>;

  const renderContainer = (c: FlowContainer) => {
    const b = geo.boxes[c.id];
    if (!b) return null;
    const isSel = selected === c.id;
    const inSel = selection.has(c.id);
    const av = c.app ? appAgentView(agentFeed, projectId, containerAppId(c), agentNow) : null;
    const ag = av?.kind === "reported" ? stateGlyph(av.app.state) : null;
    // Room for the right-aligned "● attached" (+ agent state) text when the box is an app: measured, plus a gap.
    const agentText = ag && av?.kind === "reported" ? `${ag.glyph} ${av.app.state}` : "";
    const statusW = c.app
      ? measureSvgText(c.app.attached ? "● attached" : "○ not attached", CONTAINER_SUB_FONT) + (agentText ? 8 + measureSvgText(agentText, CONTAINER_SUB_FONT) : 0)
      : 0;
    // ADDENDA-011.1: Explore lives on handler items inside containers — never on the container header (B1 identity unchanged).
    const right = c.app ? statusW + 10 : 0;
    const label = fitSvgLabel(c.label, b.w - 20 - right, CONTAINER_FONT);
    // Narrow app box (label + attached + agent state don't fit): the header shows only the agent state icon and the
    // full name, port, attached flag and agent state move to the tooltip.
    const compact = !!c.app && label.truncated;
    const attachedText = c.app?.attached ? "● attached" : "○ not attached";
    const icon = ag ?? STATE_GLYPH.unknown;
    const resources = `${c.kind} container (${c.resourceRefs.join(", ") || "no resources"}) · drag the header to move it with its nodes`;
    return (
      <g
        key={c.id}
        className={`container-box ${c.kind} ${isSel ? "sel" : ""} ${inSel ? "selected" : ""} ${compact ? "compact" : ""}`}
        data-id={c.id}
        data-selected={inSel ? "true" : undefined}
        transform={`translate(${b.x},${b.y})`}
        onPointerDown={(e) => beginDrag(e, c.id)}
        {...(compact ? { "data-label": c.label, "aria-label": c.label } : {})}
      >
        <title>
          {compact
            ? `${c.label}\nport: ${c.app?.port ?? "?"}\nconsole: ${attachedText}\nagent: ${agentText || "? not reported"}\n${resources}`
            : `${c.label} · ${resources}`}
        </title>
        {/* The body is pass-through (CSS pointer-events: none): only the header band grabs the pointer, so a box that
            overlaps another can never steal a drag aimed at the header underneath it (that is how a "Functions header"
            drag ended up moving the Ingress box). */}
        <rect className="box" width={b.w} height={b.h} rx={10} />
        <path className="hdr" d={headerPath(b.w)} />
        {compact ? (
          <text x={b.w - 10} y={HDR - 7} textAnchor="end" className="c2 compact">
            <tspan className="agent-state" fill={icon.color} data-state={av?.kind === "reported" ? av.app.state : "not-reported"}>{icon.glyph}</tspan>
          </text>
        ) : (
          <text x={10} y={HDR - 8} className="c1" {...(label.truncated ? { "aria-label": c.label, "data-full": c.label } : {})}>{label.text}</text>
        )}
        {c.app && !compact && (
          <text x={b.w - 10} y={HDR - 8} textAnchor="end" className="c2">
            {c.app.attached ? <tspan fill={PALETTE.attached}>● attached</tspan> : <tspan fill={PALETTE.detached}>○ not attached</tspan>}
            {ag && av?.kind === "reported" && (
              <tspan className="agent-state" fill={ag.color} data-state={av.app.state} dx={8}>{agentText}</tspan>
            )}
          </text>
        )}
      </g>
    );
  };

  const renderNode = (n: V2Node) => {
    const p = geo.absPos[n.id];
    if (!p) return null;
    const c = n.kind === "queue" || n.kind === "subscription" ? nodeCounts(n, counts) : null;
    const missing = isMissing(n);
    const hot = !missing && (c ? c.dlqHot : !!n.sb?.dlqHot); // a missing entity is never DLQ-hot (ADDENDA-009)
    const isSel = selected === n.id;
    const inSel = selection.has(n.id);
    const rq = selfRequeue(n);
    const timers = n.kind === "handler" ? triggersOf(n, "timer") : [];
    const blobs = n.kind === "handler" ? triggersOf(n, "blob") : [];
    const style = missing ? PALETTE.missing : kindStyle(n.kind);
    const label = fitSvgLabel(n.label, W - 16 - (rq.length > 0 ? 60 : 0), NODE_FONT);
    const act = activity.nodeClasses.get(n.id);
    const actText = activity.nodeTitles.get(n.id);
    const badge = activity.nodeBadges.get(n.id);
    const rx = n.kind === "app" || n.kind === "handler" ? 8 : 3;
    const root = n.kind === "handler" ? architecture.roots.get(n.id) : undefined;
    const fullPillW = Math.ceil(measureSvgText("Explore →", PILL_FONT)) + 14;
    const onPillDown = (e: React.PointerEvent) => {
      if (e.shiftKey || e.button !== 0 || !root) return;
      e.stopPropagation();
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY;
      trackPointer(e.pointerId, null, (ev) => { if (ev.type === "pointerup" && isClick(sx, sy, ev)) openLayer(root.layerId); });
    };
    const onHandlerKey = (e: React.KeyboardEvent) => {
      if (!root || isTypingTarget(e.target)) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openLayer(root.layerId); }
    };
    return (
      <g
        key={n.id}
        transform={`translate(${p.x},${p.y})`}
        className={`node ${n.kind} ${hot ? "hot" : ""} ${isSel ? "sel" : ""} ${inSel ? "selected" : ""} ${missing ? "missing" : ""}${act ? " " + act : ""}${root ? " has-architecture" : ""}`}
        data-id={n.id}
        data-selected={inSel ? "true" : undefined}
        data-activity={actText}
        data-opens-layer={root?.layerId}
        onPointerDown={(e) => beginDrag(e, n.id)}
        style={{ cursor: "grab" }}
        {...(root ? { tabIndex: 0, role: "button", "aria-label": `Explore architecture of ${n.label}`, onKeyDown: onHandlerKey } : {})}
      >
        <title>
          {n.kind === "blobContainer"
            ? `${n.label} · storage blob container (not a Service Bus entity) · drag to move`
            : missing
              ? `${n.label} · not provisioned on this namespace${n.sb?.maxDeliveryCount != null ? " · MaxDeliveryCount " + n.sb.maxDeliveryCount : ""} · drag to move`
              : n.sb?.maxDeliveryCount != null
                ? `${n.label} · MaxDeliveryCount ${n.sb.maxDeliveryCount}${hot ? " · DLQ hot" : ""} · drag to move`
                : `${n.label}${n.containerId ? " · in " + containerLabel(n.containerId) : ""} · drag to move`}
          {actText ? `\n⚡ ${actText}` : ""}
        </title>
        {act && <rect key={act + actText} className="activity-ring" x={-4} y={-4} width={W + 8} height={H + 8} rx={rx + 4} />}
        <rect
          width={W}
          height={H}
          rx={rx}
          style={{
            fill: style.fill,
            // Multi-selected: stroke + glow come from `g.node.selected > rect` in styles.css (inline would win).
            ...(inSel ? {} : { stroke: isSel ? PALETTE.sel : hot ? PALETTE.hot : style.stroke, strokeWidth: isSel || hot ? 2.5 : 1.2 }),
            strokeDasharray: style.dash,
          }}
        />
        <text x={8} y={17} className="t1" {...(label.truncated ? { "aria-label": n.label, "data-full": n.label } : {})}>
          {label.text}
        </text>
        <text x={8} y={33} className="t2">
          {nodeSubtitle(n, c)}
        </text>
        {/* Activity chip straddles the bottom-right border: the top edge belongs to the requeue / trigger badges, and
            anything beside the box would sit under the next node (drawn later). */}
        {badge && (() => {
          const bw = Math.ceil(measureSvgText(badge.text, BADGE_FONT)) + 14;
          return (
            <g className={`activity-badge ${badge.kind}`} transform={`translate(${W - bw - 4},${H - 8})`}>
              <rect width={bw} height={16} rx={8} />
              <text x={bw / 2} y={11.5} textAnchor="middle">{badge.text}</text>
            </g>
          );
        })()}
        {rq.length > 0 && (
          <g className="requeue-badge" transform={`translate(${W - 66},-9)`}>
            <title>{requeueTooltip(n)}</title>
            <rect width={62} height={17} rx={8.5} />
            <text x={31} y={12} textAnchor="middle">⟲ requeue</text>
          </g>
        )}
        {/* ADDENDA-009 trigger badges sit top-left (requeue stays top-right, so they never collide). */}
        {timers.length > 0 && (
          <g className="trigger-badge timer" transform="translate(6,-9)" data-count={timers.length}>
            <title>{timerTooltip(timers)}</title>
            <rect width={timers.length > 1 ? 34 : 22} height={17} rx={8.5} />
            <ClockIcon cx={11} cy={8.5} />
            {timers.length > 1 && <text x={28} y={12.5} textAnchor="middle">{timers.length}</text>}
          </g>
        )}
        {blobs.length > 0 && (
          <g className="trigger-badge blob" transform={`translate(${timers.length ? (timers.length > 1 ? 44 : 32) : 6},-9)`}>
            <title>{blobTooltip(blobs)}</title>
            <rect width={40} height={17} rx={8.5} />
            <text x={20} y={12.5} textAnchor="middle">▤ blob</text>
          </g>
        )}
        {root && (
          <g className="explore-pill" transform={`translate(${(W - fullPillW) / 2},${H + 4})`} onPointerDown={onPillDown} data-layer={root.layerId} data-label="Explore →">
            <title>{`${EXPLORE_TIP}\n${root.title}`}</title>
            <rect width={fullPillW} height={16} rx={8} />
            <text x={fullPillW / 2} y={11.5} textAnchor="middle">Explore →</text>
          </g>
        )}
      </g>
    );
  };

  return (
    <div className="flow-page">
      {!arch && <div className="toolbar">
        <label>
          <input type="checkbox" checked={showCloud} onChange={(e) => setShowCloud(e.target.checked)} /> Show cloud edges
        </label>
        <button onClick={() => { reload(); refresh(); }}>Refresh</button>
        <button type="button" onClick={() => fitView(geo.topRects)} title="Fit entire graph in view">
          Fit
        </button>
        <button type="button" onClick={() => zoomAt(1 / 1.2)} title="Zoom out">−</button>
        <button type="button" onClick={() => zoomAt(1.2)} title="Zoom in">+</button>
        <span className="muted zoom-pct">{Math.round(view.k * 100)}%</span>
        {updatedAt && <span className="muted">counts {updatedAt.toLocaleTimeString()}</span>}
        {graph && (
          <span className="muted layout-stat" title={`layout ${graph.layout} · ${positionStats.total} positions (${positionStats.local} moved in this browser, ${positionStats.stored} stored on the server, ${positionStats.default} checked-in default)`}>
            layout {graph.layout} · {positionStats.total} positions
            {positionStats.local > 0 ? ` (${positionStats.local} local)` : positionStats.stored > 0 ? ` (${positionStats.stored} stored)` : ""}
          </span>
        )}
        {selection.size > 0 && <span className="muted selection-count">{selection.size} selected</span>}
        {confirmReset ? (
          <span className="inline-confirm" role="alertdialog" aria-label="Reset positions?">
            Reset positions?
            <button type="button" className="danger" onClick={resetLayout}>Yes</button>
            <button type="button" onClick={() => setConfirmReset(false)}>Cancel</button>
          </span>
        ) : (
          <button type="button" onClick={() => setConfirmReset(true)} disabled={resetting} title="Asks first; forgets the positions saved in this browser (and any server-side ones) and returns to the default layout">
            {resetting ? "Resetting…" : "Reset layout"}
          </button>
        )}
        <span className="spacer" />

        {samplesAvailable === false ? (
          <span className="muted no-samples" title={samples.data?.reason}>No sample kit for this project</span>
        ) : (
          <button className="primary" onClick={() => setPickerOpen(true)}>
            Inject sample…
          </button>
        )}
        {architecture.source === "fixtures" && (
          <span className="muted arch-fixtures-note" title="Explore links come from the SPA's copy of architecture/layers (DEV fixture seam), not from the API">architecture: fixtures</span>
        )}
      </div>}
      {notice && (
        <div className={`notice flow-notice ${notice.severity === "warn" ? "warn" : "info"}`} role="note" title={noticeTitle(notice)} data-code={notice.code}>
          {noticeText(notice)}
        </div>
      )}
      {error && <ErrorBanner error={error} onRetry={reload} />}
      {graph && ((graph.warnings?.length ?? 0) > 0 || architecture.invalid) && (
        <div className="warn-banner" role="status">
          <strong>Flow warnings</strong>
          <ul>
            {(graph.warnings ?? []).map((w, i) => (
              <li key={i}>
                <code>{w}</code>
              </li>
            ))}
            {architecture.invalid && !graph.warnings?.includes(ARCHITECTURE_INVALID) && (
              <li className="arch-invalid-warning">
                <code>{ARCHITECTURE_INVALID}</code> — architecture catalog rejected; Explore is unavailable, Flow is unaffected
              </li>
            )}
          </ul>
        </div>
      )}
      {loading && <Empty>Loading flow…</Empty>}
      {graph && arch && (
        <ArchitectureView
          projectId={projectId}
          layerId={arch.layerId}
          loadLayer={architecture.loadLayer}
          onOpen={openLayer}
          onLeave={leaveArchitecture}
          canFocus={inGraph}
          fixtures={architecture.source === "fixtures"}
          onState={onArchState}
        />
      )}
      {graph && (
        <div className="flow-wrap" hidden={!!arch}>
          <div className="flow-canvas">
          <svg
            ref={svgRef}
            className="flow"
            onPointerDown={onBgPointerDown}
          >
            <defs>
              <marker id="arr" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,0L10,5L0,10z" fill={PALETTE.edge} />
              </marker>
              <marker id="arrBack" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,0L10,5L0,10z" fill={PALETTE.back} />
              </marker>
              <marker id="arrStorage" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,0L10,5L0,10z" fill={PALETTE.storage} />
              </marker>
              <pattern id="dots" width="20" height="20" patternUnits="userSpaceOnUse">
                <circle cx="1" cy="1" r="1" fill="#d7dde6" />
              </pattern>
            </defs>
            <rect className="flow-bg" width="100%" height="100%" fill="url(#dots)" />
            <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {graph.containers.map(renderContainer)}
            {drawnEdges.map((e) => {
              const a = geo.absPos[e.from],
                b = geo.absPos[e.to];
              if (!a || !b) return null;
              const d = edgePath(a, b);
              const back = layers[e.to] !== undefined && layers[e.to] <= layers[e.from];
              const fromBlob = kindOf.get(e.from) === "blobContainer";
              const lit = activity.edgeDots.has(edgeKey(e));
              const cls = `edge${back ? " back" : ""} ${e.kind} ${fromBlob ? "from-blobContainer" : ""} ${e.confidence === "inferred-from-settings" ? "inferred" : ""} ${e.scope === "cloud" ? "cloud" : ""}${lit ? " activity-edge" : ""}`;
              // Exactly one path per from→to and exactly one marker on it (markerEnd = the target node). No
              // markerStart, no hit-area twin: a second path would get its own arrowhead and read as double-headed.
              return (
                <path key={e.id} d={d} className={cls} markerEnd={back ? "url(#arrBack)" : fromBlob ? "url(#arrStorage)" : "url(#arr)"}>
                  <title>{edgeTooltip(e)}</title>
                </path>
              );
            })}
            {/* Travelling dots (one per lit edge, remounted per event so the motion restarts); none under reduced motion. */}
            {!reducedMotion && drawnEdges.map((e) => {
              const k = activity.edgeDots.get(edgeKey(e));
              const a = geo.absPos[e.from], b = geo.absPos[e.to];
              if (k === undefined || !a || !b) return null;
              return (
                <circle key={e.id + ":" + k} className="activity-dot" r={4.5} data-edge={edgeKey(e)}>
                  <animateMotion ref={beginNow} dur="1.1s" begin="indefinite" fill="freeze" path={edgePath(a, b)} />
                </circle>
              );
            })}
            {graph.nodes.map(renderNode)}
            {marquee && <rect className="marquee" x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h} />}
            </g>
          </svg>
          <FlowLegend rootRef={legendRef} />
          <ActivityFeed
            feed={activity.feed}
            onPick={setSelected}
            onClear={activity.clearFeed}
            live={demoMode ? "demo data: counts only" : "counts every 2.5 s · Functions lines from the local agent"}
          />
          </div>
          <aside className="side-panel">
            {!sel && !selContainer && <Empty>Select or drag a node or container.</Empty>}
            {selContainer && (
              <>
                <h4>{selContainer.label}</h4>
                <div className="muted">
                  {selContainer.id} · {selContainer.kind} container{selContainer.scope ? ` · scope ${selContainer.scope}` : ""}
                </div>
                <p>
                  Resources: {selContainer.resourceRefs.length ? selContainer.resourceRefs.map((r) => <code key={r}>{r} </code>) : <span className="muted">none</span>}
                </p>
                {selContainer.app && (
                  <p>
                    {selContainer.app.appKind}{selContainer.app.port != null ? ` :${selContainer.app.port}` : ""}
                    {selContainer.app.cloudRoleName && (<><br /><code>{selContainer.app.cloudRoleName}</code></>)}
                    <br />
                    {selContainer.app.attached ? "Console attached" : "Not attached"}
                  </p>
                )}
                <h5>Nodes</h5>
                <ul>
                  {graph.nodes.filter((n) => n.containerId === selContainer.id).map((n) => (
                    <li key={n.id}>
                      <a href="#" onClick={(e) => { e.preventDefault(); setSelected(n.id); }}>{n.label}</a>
                      {selfRequeue(n).length > 0 && <span className="legend-pill" title={requeueTooltip(n)}>⟲ requeue</span>}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {sel && (
              <>
                <h4>{sel.label}</h4>
                <div className="muted">
                  {sel.id} · {sel.kind} · scope {sel.scope}
                </div>
                {sel.containerId && (
                  <div className="muted">
                    in <a href="#" onClick={(e) => { e.preventDefault(); setSelected(sel.containerId!); }}>{containerLabel(sel.containerId)}</a>
                  </div>
                )}
                {sel.app && (
                  <p>
                    {sel.app.appKind} :{sel.app.port}
                    <br />
                    <code>{sel.app.cloudRoleName}</code>
                    <br />
                    {sel.app.attached ? "Console attached" : "Not attached"}
                  </p>
                )}
                {architecture.roots.get(sel.id) && (
                  <p className="explore-line">
                    Architecture: {architecture.roots.get(sel.id)!.title} ·{" "}
                    <a href="#" onClick={(e) => { e.preventDefault(); openLayer(architecture.roots.get(sel.id)!.layerId); }} title={EXPLORE_TIP}>Explore →</a>
                  </p>
                )}
                {sel.handler && (
                  <p>
                    {handlerFunction(sel) ? <>Function <code>{handlerFunction(sel)}</code></> : <span className="muted">HTTP surface (no Function)</span>}
                    {sel.handler.triggerEntityIds && sel.handler.triggerEntityIds.length > 0 && (
                      <>
                        <br />
                        Trigger: {sel.handler.triggerEntityIds.map((t) => <code key={t}>{t} </code>)}
                      </>
                    )}
                  </p>
                )}
                {(triggersOf(sel, "timer").length > 0 || triggersOf(sel, "blob").length > 0) && (
                  <>
                    <h5>Triggers</h5>
                    <ul className="trigger-list">
                      {triggersOf(sel, "timer").map((t, i) => (
                        <li key={"t" + i} title={timerTooltip([t])}>
                          <span className="legend-pill timer"><svg width="11" height="11" viewBox="0 0 11 11"><ClockIcon cx={5.5} cy={5.5} /></svg> timer</span>
                          {t.function && <code>{t.function}</code>} <span className="muted">{t.schedule ?? t.setting}{t.schedule && t.setting ? ` · setting ${t.setting}` : ""}</span>
                        </li>
                      ))}
                      {triggersOf(sel, "blob").map((t, i) => (
                        <li key={"b" + i} title={blobTooltip([t])}>
                          <span className="legend-pill blob">▤ blob</span>
                          {t.function && <code>{t.function}</code>} <span className="muted">{t.path ?? t.entityId}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {sel.kind === "blobContainer" && (
                  <p className="muted">Storage blob container. Not a Service Bus entity: no counts, no DLQ, not peekable.</p>
                )}
                {isMissing(sel) && (
                  <p><span className="state-missing">not on namespace</span> <span className="muted">Not provisioned on this namespace (counts unknown, never DLQ-hot).</span></p>
                )}
                {selfRequeue(sel).length > 0 && (
                  <>
                    <h5><span className="legend-pill">⟲ requeue</span> Self-requeue</h5>
                    <ul className="requeue-list">
                      {selfRequeue(sel).map((r, i) => (
                        <li key={r.entityId + i}>
                          <code>{r.entityId}</code>
                          {r.messages && r.messages.length > 0 && (
                            <ul>
                              {r.messages.map((m) => <li key={m}>{m}</li>)}
                            </ul>
                          )}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {sel.sb && (
                  <p>
                    Active <Count v={isMissing(sel) ? null : nodeCounts(sel, counts)?.active ?? sel.sb.activeCount} /> · DLQ{" "}
                    <Count v={isMissing(sel) ? null : nodeCounts(sel, counts)?.dlq ?? sel.sb.deadLetterCount} hot={!isMissing(sel) && (nodeCounts(sel, counts)?.dlqHot ?? sel.sb.dlqHot)} /> ·{" "}
                    {sel.sb.owner}
                    {sel.sb.maxDeliveryCount != null && (
                      <>
                        {" "}
                        · MaxDelivery <code title="Display only — does not drive dlqHot (ADDENDA-003)">{sel.sb.maxDeliveryCount}</code>
                      </>
                    )}
                  </p>
                )}
                <h5>Edges</h5>
                <ul>
                  {visibleEdges
                    .filter((e) => e.from === sel.id || e.to === sel.id)
                    .map((e) => (
                      <li key={e.id} title={edgeTooltip(e)}>
                        {e.kind}: {e.from === sel.id ? "→ " + e.to : "← " + e.from} {e.label && <span className="muted">({e.label})</span>}
                      </li>
                    ))}
                </ul>
              </>
            )}
          </aside>
        </div>
      )}
      <SampleMessagePicker open={pickerOpen} projectId={projectId} onClose={() => setPickerOpen(false)} />
    </div>
  );
}
