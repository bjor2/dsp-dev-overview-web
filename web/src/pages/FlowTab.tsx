import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import { demoFlow } from "../mocks/demo";
import { Count, Empty, ErrorBanner } from "../components/common";
import SampleMessagePicker from "../components/SampleMessagePicker";
import { countsLabel, nodeCounts, useFlowCounts } from "../flow/useFlowCounts";
import { handlerFunction, normalizeGraph, selfRequeue } from "./flow/model";
import { clearLocalPositions, loadLocalPositions, mergeLocalPositions, storageKey } from "./flow/localPositions";
import type { FlowEdge } from "../api/types";
import type { FlowContainer, PosMap, Rect, V2Node, XY } from "./flow/model";
import {
  EMPTY_GEOMETRY, H, HDR, W, clampInner, computeLayers, contentBounds, deriveGeometry, edgePath, headerPath, settleLayout,
} from "./flow/layout";

const ZMIN = 0.2, ZMAX = 3;

/** Single palette for canvas + legend. */
const PALETTE = {
  kind: {
    external: { fill: "#fff4e0", stroke: "#d39b3a", dash: "4 3", label: "Seed / external" },
    app: { fill: "#e0edff", stroke: "#5b8def", dash: undefined, label: "Handler / app" },
    queue: { fill: "#e6f6ea", stroke: "#5aa86c", dash: undefined, label: "Queue" },
    topic: { fill: "#f1e9ff", stroke: "#9a7bd8", dash: undefined, label: "Topic" },
    subscription: { fill: "#f7f2ff", stroke: "#b39ddb", dash: undefined, label: "Subscription" },
  } as Record<string, { fill: string; stroke: string; dash?: string; label: string }>,
  fallback: { fill: "#ffffff", stroke: "#94a3b8", dash: undefined, label: "Other" },
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
            <div>{box("#fff", PALETTE.hot, undefined, 2.5)} DLQ hot</div>
            <div>{box("#fff", PALETTE.sel, undefined, 2.5)} Selected</div>
          </div>
          <div className="legend-col">
            <div>{line(PALETTE.edge)} trigger / publish</div>
            <div>{line(PALETTE.inject)} inject</div>
            <div>{line(PALETTE.edge, "2 4")} inferred</div>
            <div>{line(PALETTE.edge, "8 5")} cloud</div>
            <div>{line(PALETTE.back)} back-edge (upward)</div>
            <div><code>a 3 · DLQ 7</code> active · dead-letter</div>
            <div><span style={{ color: PALETTE.attached }}>●</span> attached <span style={{ color: PALETTE.detached }}>○</span> not attached</div>
            <div className="muted">drag node · drag box header moves its nodes · drag canvas pans · wheel zooms</div>
          </div>
        </div>
      )}
    </div>
  );
}

type View = { x: number; y: number; k: number };
/**
 * One drag, tracked on window listeners (not on the element under the pointer): the target is computed as
 * `origin + (client − clientStart) / k` from the drag START, never incrementally, so coalesced/fast moves land
 * exactly where the pointer is. `last` is the latest position written to state, in the WIRE frame (containers /
 * standalone absolute, inner nodes relative to their container) — pointer-up reads this, not React state, because
 * the final pointermove is often not rendered yet when pointerup arrives.
 */
type Drag = {
  id: string;
  kind: "node" | "container";
  sx: number; sy: number; k: number;
  origin: XY;
  /** Container origin (absolute) when dragging an inner node. */
  base?: XY;
  last: XY | null;
  pointerId: number;
  el: Element;
};
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
  /** Wire frame (ADDENDA-008 §7): container ids absolute, inner node ids RELATIVE to their container, others absolute. */
  const [pos, setPos] = useState<PosMap>({});
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const pan = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null);
  const [resetting, setResetting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const drag = useRef<Drag | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const legendRef = useRef<HTMLDivElement | null>(null);
  const scope = showCloud ? "all" : "local";
  const { data, error, loading, reload } = useApi(() => api.flow(projectId, scope), demoFlow, [projectId, scope]);
  const { counts, updatedAt, refresh } = useFlowCounts(projectId);
  /** Local positions are the source of truth; nodes the user moved are never overwritten by server data. */
  const moved = useRef<Set<string>>(new Set());
  const needFit = useRef(true); // first load, Reset, project change only
  const posRef = useRef<PosMap>({});
  posRef.current = pos;
  useEffect(() => {
    moved.current = new Set();
    needFit.current = true;
  }, [projectId]);

  const graph = useMemo(() => (data ? normalizeGraph(data) : null), [data]);
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

  // Pan: window listeners from pointerdown on the background until pointerup, absolute delta from the start.
  const onBgPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || drag.current) return;
    const pn = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    pan.current = pn;
    const onMove = (ev: PointerEvent) => setView((v) => ({ ...v, x: pn.vx + ev.clientX - pn.sx, y: pn.vy + ev.clientY - pn.sy }));
    const onUp = () => {
      pan.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  /** Latest drag-frame state → wire-frame position for the dragged id (inner nodes clamped inside their box). */
  const dragTarget = (d: Drag, clientX: number, clientY: number): XY => {
    const ax = d.origin.x + (clientX - d.sx) / d.k, ay = d.origin.y + (clientY - d.sy) / d.k;
    return d.base ? clampInner({ x: ax - d.base.x, y: ay - d.base.y }, pad) : { x: ax, y: ay };
  };

  const endDrag = (d: Drag) => {
    drag.current = null;
    try { d.el.releasePointerCapture?.(d.pointerId); } catch { /* already released */ }
    if (!d.last || !graph) return;
    // The drop position is exactly where the user let go: `origin + (client − clientStart) / k`, computed once from
    // the drag-start snapshot (inner nodes only clamped inside their box). No de-overlap nudge here: it used to snap a
    // box that landed on another unit to the far side of that unit (a 150px drag to the right became a 218px drop).
    // Read the drag's own last position, not React state: the last pointermove may not be rendered yet.
    const final = d.last;
    const cur: PosMap = { ...posRef.current, [d.id]: final };
    posRef.current = cur;
    setPos(cur);
    // Exact graph id ("container:…" for boxes, node id otherwise) merged into this browser's localStorage map.
    mergeLocalPositions(posKeyRef.current, { [d.id]: final });
    setLocalCount(Object.keys(loadLocalPositions(posKeyRef.current, graph)).length);
  };

  const beginDrag = (e: React.PointerEvent, id: string, kind: Drag["kind"]) => {
    e.stopPropagation();
    if (e.button !== 0 || drag.current || resetting) return;
    e.preventDefault();
    // Box origin == the container's stored position (deriveGeometry puts the box at pos[c.id]; header and padding
    // are drawn INSIDE the box), so the drag target is the wire position with no header/padding offset added.
    const origin = kind === "container" ? geo.boxes[id] : geo.absPos[id];
    if (!origin) return;
    const cid = kind === "node" ? geo.containerOf[id] : undefined;
    const base = cid ? posRef.current[cid] : undefined;
    const el = e.currentTarget as Element;
    const d: Drag = {
      id, kind, sx: e.clientX, sy: e.clientY, k: view.k, origin: { x: origin.x, y: origin.y },
      base: base ? { x: base.x, y: base.y } : undefined, last: null, pointerId: e.pointerId, el,
    };
    drag.current = d;
    // Capture on the element that got pointerdown (keeps delivery when the pointer outruns the box or leaves the
    // window); listeners on window so neither React re-renders nor hit-testing can drop a move or the up.
    try { el.setPointerCapture?.(e.pointerId); } catch { /* unsupported */ }
    const onMove = (ev: PointerEvent) => {
      if (drag.current !== d || ev.pointerId !== d.pointerId) return;
      if (!d.last && ev.clientX === d.sx && ev.clientY === d.sy) return;
      d.last = dragTarget(d, ev.clientX, ev.clientY);
      moved.current.add(d.id);
      const p = d.last;
      setPos((prev) => ({ ...prev, [d.id]: p }));
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== d.pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (drag.current !== d) return;
      if (ev.type === "pointerup" && d.last) d.last = dragTarget(d, ev.clientX, ev.clientY);
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
  const sel = graph?.nodes.find((n) => n.id === selected);
  const selContainer = graph?.containers.find((c) => c.id === selected);
  const containerLabel = (id?: string) => graph?.containers.find((c) => c.id === id)?.label ?? id;

  const nodeSubtitle = (n: V2Node, c: ReturnType<typeof nodeCounts>) => {
    if (n.app)
      return n.app.attached ? <tspan fill={PALETTE.attached}>● attached</tspan> : <tspan fill={PALETTE.detached}>○ not attached</tspan>;
    if (n.kind === "handler") return handlerFunction(n) ?? (n.handler?.triggerEntityIds?.length ? "trigger: " + n.handler.triggerEntityIds.join(", ") : "handler");
    return c ? countsLabel(c) : n.kind;
  };

  const renderContainer = (c: FlowContainer) => {
    const b = geo.boxes[c.id];
    if (!b) return null;
    const isSel = selected === c.id;
    return (
      <g
        key={c.id}
        className={`container-box ${c.kind} ${isSel ? "sel" : ""}`}
        transform={`translate(${b.x},${b.y})`}
        onPointerDown={(e) => beginDrag(e, c.id, "container")}
      >
        <title>{`${c.label} · ${c.kind} container (${c.resourceRefs.join(", ") || "no resources"}) · drag the header to move it with its nodes`}</title>
        {/* The body is pass-through (CSS pointer-events: none): only the header band grabs the pointer, so a box that
            overlaps another can never steal a drag aimed at the header underneath it (that is how a "Functions header"
            drag ended up moving the Ingress box). */}
        <rect className="box" width={b.w} height={b.h} rx={10} />
        <path className="hdr" d={headerPath(b.w)} />
        <text x={10} y={HDR - 8} className="c1">{c.label}</text>
        {c.app && (
          <text x={b.w - 10} y={HDR - 8} textAnchor="end" className="c2">
            {c.app.attached ? <tspan fill={PALETTE.attached}>● attached</tspan> : <tspan fill={PALETTE.detached}>○ not attached</tspan>}
          </text>
        )}
      </g>
    );
  };

  const renderNode = (n: V2Node) => {
    const p = geo.absPos[n.id];
    if (!p) return null;
    const c = n.kind === "queue" || n.kind === "subscription" ? nodeCounts(n, counts) : null;
    const hot = c ? c.dlqHot : !!n.sb?.dlqHot;
    const isSel = selected === n.id;
    const rq = selfRequeue(n);
    return (
      <g
        key={n.id}
        transform={`translate(${p.x},${p.y})`}
        className={`node ${n.kind} ${hot ? "hot" : ""} ${isSel ? "sel" : ""}`}
        onPointerDown={(e) => beginDrag(e, n.id, "node")}
        style={{ cursor: "grab" }}
      >
        <title>
          {n.sb?.maxDeliveryCount != null
            ? `${n.label} · MaxDeliveryCount ${n.sb.maxDeliveryCount}${hot ? " · DLQ hot" : ""} · drag to move`
            : `${n.label}${n.containerId ? " · in " + containerLabel(n.containerId) : ""} · drag to move`}
        </title>
        <rect
          width={W}
          height={H}
          rx={n.kind === "app" || n.kind === "handler" ? 8 : 3}
          style={{
            fill: kindStyle(n.kind).fill,
            stroke: isSel ? PALETTE.sel : hot ? PALETTE.hot : kindStyle(n.kind).stroke,
            strokeWidth: isSel || hot ? 2.5 : 1.2,
            strokeDasharray: kindStyle(n.kind).dash,
          }}
        />
        <text x={8} y={17} className="t1">
          {n.label}
        </text>
        <text x={8} y={33} className="t2">
          {nodeSubtitle(n, c)}
        </text>
        {rq.length > 0 && (
          <g className="requeue-badge" transform={`translate(${W - 66},-9)`}>
            <title>{requeueTooltip(n)}</title>
            <rect width={62} height={17} rx={8.5} />
            <text x={31} y={12} textAnchor="middle">⟲ requeue</text>
          </g>
        )}
      </g>
    );
  };

  return (
    <div className="flow-page">
      <div className="toolbar">
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

        <button className="primary" onClick={() => setPickerOpen(true)}>
          Inject sample…
        </button>
      </div>
      {error && <ErrorBanner error={error} onRetry={reload} />}
      {graph?.warnings && graph.warnings.length > 0 && (
        <div className="warn-banner" role="status">
          <strong>Flow warnings</strong>
          <ul>
            {graph.warnings.map((w, i) => (
              <li key={i}>
                <code>{w}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {loading && <Empty>Loading flow…</Empty>}
      {graph && (
        <div className="flow-wrap">
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
              const cls = `edge${back ? " back" : ""} ${e.kind} ${e.confidence === "inferred-from-settings" ? "inferred" : ""} ${e.scope === "cloud" ? "cloud" : ""}`;
              // Exactly one path per from→to and exactly one marker on it (markerEnd = the target node). No
              // markerStart, no hit-area twin: a second path would get its own arrowhead and read as double-headed.
              return (
                <path key={e.id} d={d} className={cls} markerEnd={back ? "url(#arrBack)" : "url(#arr)"}>
                  <title>{edgeTooltip(e)}</title>
                </path>
              );
            })}
            {graph.nodes.map(renderNode)}
            </g>
          </svg>
          <FlowLegend rootRef={legendRef} />
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
                    Active <Count v={nodeCounts(sel, counts)?.active ?? sel.sb.activeCount} /> · DLQ{" "}
                    <Count v={nodeCounts(sel, counts)?.dlq ?? sel.sb.deadLetterCount} hot={nodeCounts(sel, counts)?.dlqHot ?? sel.sb.dlqHot} /> ·{" "}
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
