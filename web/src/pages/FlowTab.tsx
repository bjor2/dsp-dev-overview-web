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
import type { FlowEdge } from "../api/types";
import type { FlowContainer, PosMap, Rect, V2Node, XY } from "./flow/model";
import {
  EMPTY_GEOMETRY, H, HDR, W, clampInner, computeLayers, contentBounds, deriveGeometry, edgePath, headerPath,
  innerMin, layoutGraph, nodeRect, nudgeOffOverlaps,
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
type Drag = { id: string; kind: "node" | "container"; ox: number; oy: number; moved: boolean };

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
  const drag = useRef<Drag | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const legendRef = useRef<HTMLDivElement | null>(null);
  const saveTimer = useRef<number | null>(null);
  const pending = useRef<PosMap>({});
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
  const pad = graph?.layoutHints.containerPadding ?? 16;
  const visibleEdges = useMemo(
    () => (graph?.edges ?? []).filter((e) => showCloud || e.scope !== "cloud"),
    [graph, showCloud],
  );
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

  // Rebuild positions only when the graph is (re)fetched; keep moved items; fit only when requested.
  useEffect(() => {
    if (!graph) return;
    const { pos: auto, pinned } = layoutGraph(graph, visibleEdges);
    const prev = posRef.current;
    const next: PosMap = { ...auto };
    moved.current.forEach((id) => {
      if (prev[id] && next[id]) next[id] = prev[id];
    });
    // De-overlap only items without a stored/moved position (no auto-save on load).
    const keep = (id: string) => pinned.has(id) || moved.current.has(id);
    const p = graph.layoutHints.containerPadding;
    // Inner nodes vs their siblings (relative frame, clamped to the box).
    for (const c of graph.containers) {
      const ms = graph.nodes.filter((n) => n.containerId === c.id);
      for (const n of ms) {
        if (!next[n.id] || keep(n.id)) continue;
        const others = ms.filter((o) => o.id !== n.id && next[o.id]).map((o) => nodeRect(o.id, next[o.id]));
        next[n.id] = nudgeOffOverlaps(nodeRect(n.id, next[n.id]), others, 12, innerMin(p));
      }
    }
    // Top level: containers as units vs standalone nodes.
    let g = deriveGeometry(graph, next);
    for (const r0 of [...g.topRects]) {
      if (keep(r0.id)) continue;
      const r = g.topRects.find((x) => x.id === r0.id);
      if (!r) continue;
      const np = nudgeOffOverlaps(r, g.topRects.filter((o) => o.id !== r.id));
      if (np.x !== r.x || np.y !== r.y) {
        next[r.id] = np;
        g = deriveGeometry(graph, next);
      }
    }
    setPos(next);
    if (needFit.current) {
      needFit.current = false;
      const rects = g.topRects;
      requestAnimationFrame(() => fitView(rects));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, visibleEdges]);

  // Fire-and-forget: only the dragged key is sent (container absolute / inner relative / other absolute).
  const persist = useCallback(
    (id: string, xy: XY) => {
      pending.current[id] = xy;
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        const batch = pending.current;
        pending.current = {};
        api.saveFlowPositions(projectId, batch).catch(() => {
          /* keep local; the next drag of that item re-sends its key */
        });
      }, 350);
    },
    [projectId],
  );

  /** Screen → graph coords through the current pan/zoom. */
  const clientToSvg = (clientX: number, clientY: number) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: (clientX - r.left - view.x) / view.k, y: (clientY - r.top - view.y) / view.k };
  };

  const onBgPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    pan.current = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
  };

  const beginDrag = (e: React.PointerEvent, id: string, kind: Drag["kind"]) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.button !== 0) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const origin = kind === "container" ? geo.boxes[id] : geo.absPos[id];
    if (!origin) return;
    const cur = clientToSvg(e.clientX, e.clientY);
    drag.current = { id, kind, ox: cur.x - origin.x, oy: cur.y - origin.y, moved: false };
    setSelected(id);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const pn = pan.current;
    if (pn) {
      setView((v) => ({ ...v, x: pn.vx + e.clientX - pn.sx, y: pn.vy + e.clientY - pn.sy }));
      return;
    }
    const d = drag.current;
    if (!d) return;
    const cur = clientToSvg(e.clientX, e.clientY);
    const ax = cur.x - d.ox, ay = cur.y - d.oy; // absolute target origin
    d.moved = true;
    moved.current.add(d.id);
    const cid = d.kind === "node" ? geo.containerOf[d.id] : undefined;
    setPos((prev) => {
      const origin = cid ? prev[cid] : undefined;
      if (origin) return { ...prev, [d.id]: clampInner({ x: ax - origin.x, y: ay - origin.y }, pad) };
      return { ...prev, [d.id]: { x: ax, y: ay } };
    });
  };

  const onPointerUp = () => {
    pan.current = null;
    const d = drag.current;
    drag.current = null;
    if (!d?.moved || !graph) return;
    const cur = posRef.current;
    if (!cur[d.id]) return;
    const g = deriveGeometry(graph, cur);
    let np: XY | null = null;
    const cid = d.kind === "node" ? g.containerOf[d.id] : undefined;
    if (d.kind === "container") {
      const r = g.boxes[d.id];
      if (r) np = nudgeOffOverlaps(r, g.topRects.filter((o) => o.id !== d.id));
    } else if (cid) {
      const siblings = graph.nodes.filter((n) => n.containerId === cid && n.id !== d.id && cur[n.id]).map((n) => nodeRect(n.id, cur[n.id]));
      np = nudgeOffOverlaps(nodeRect(d.id, cur[d.id]), siblings, 12, innerMin(pad));
    } else {
      const r = g.topRects.find((x) => x.id === d.id);
      if (r) np = nudgeOffOverlaps(r, g.topRects.filter((o) => o.id !== d.id));
    }
    const next = np && (np.x !== cur[d.id].x || np.y !== cur[d.id].y) ? { ...cur, [d.id]: np } : cur;
    if (next !== cur) {
      posRef.current = next;
      setPos(next);
    }
    persist(d.id, next[d.id]);
  };

  const resetLayout = async () => {
    setResetting(true);
    try {
      await api.saveFlowPositions(projectId, {}); // {} = clear → auto (FlowPositionStore)
      moved.current = new Set();
      needFit.current = true;
      reload(); // reload → auto layout → fit
    } finally {
      setResetting(false);
    }
  };

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
        <title>{`${c.label} · ${c.kind} container (${c.resourceRefs.join(", ") || "no resources"}) · drag to move with its nodes`}</title>
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
        <button type="button" onClick={resetLayout} disabled={resetting} title="PUT {} clears stored positions → auto layout">
          {resetting ? "Resetting…" : "Reset layout"}
        </button>
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
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
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
            {visibleEdges.map((e) => {
              const a = geo.absPos[e.from],
                b = geo.absPos[e.to];
              if (!a || !b) return null;
              const d = edgePath(a, b);
              const back = layers[e.to] !== undefined && layers[e.to] <= layers[e.from];
              const cls = `edge${back ? " back" : ""} ${e.kind} ${e.confidence === "inferred-from-settings" ? "inferred" : ""} ${e.scope === "cloud" ? "cloud" : ""}`;
              return (
                <g key={e.id}>
                  <path d={d} className={cls} markerEnd={back ? "url(#arrBack)" : "url(#arr)"}>
                    <title>{edgeTooltip(e)}</title>
                  </path>
                </g>
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
