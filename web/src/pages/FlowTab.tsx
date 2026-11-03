import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import type { FlowEdge, FlowGraph, FlowNode } from "../api/types";
import { demoFlow } from "../mocks/demo";
import { Count, Empty, ErrorBanner } from "../components/common";
import SampleMessagePicker from "../components/SampleMessagePicker";
import { countsLabel, nodeCounts, useFlowCounts } from "../flow/useFlowCounts";

/** Node size + tight gutters (top→bottom layers). */
const W = 176, H = 40, GX = 24, GY = 56, PAD = 10, MAX_ROW = 7;
const SEED = "ext:seed-messages";
const ZMIN = 0.2, ZMAX = 3;

/** Single palette for canvas + legend. */
const PALETTE = {
  kind: {
    external: { fill: "#fff4e0", stroke: "#d39b3a", dash: "4 3", label: "Seed / external" },
    app: { fill: "#e0edff", stroke: "#5b8def", dash: undefined, label: "App" },
    queue: { fill: "#e6f6ea", stroke: "#5aa86c", dash: undefined, label: "Queue" },
    topic: { fill: "#f1e9ff", stroke: "#9a7bd8", dash: undefined, label: "Topic" },
    subscription: { fill: "#f7f2ff", stroke: "#b39ddb", dash: undefined, label: "Subscription" },
  } as Record<string, { fill: string; stroke: string; dash?: string; label: string }>,
  fallback: { fill: "#ffffff", stroke: "#94a3b8", dash: undefined, label: "Other" },
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
const kindStyle = (k: string) => PALETTE.kind[k] ?? PALETTE.fallback;
const LEGEND_KEY = "flow.legend.collapsed";

function FlowLegend() {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(LEGEND_KEY) === "1");
  const toggle = () => setCollapsed((c) => { localStorage.setItem(LEGEND_KEY, c ? "0" : "1"); return !c; });
  const box = (fill: string, stroke: string, dash?: string, sw = 1.2) => (
    <svg width="22" height="12"><rect x="1" y="1" width="20" height="10" rx="2" fill={fill} stroke={stroke} strokeWidth={sw} strokeDasharray={dash} /></svg>
  );
  const line = (stroke: string, dash?: string) => (
    <svg width="26" height="10"><line x1="1" y1="5" x2="25" y2="5" stroke={stroke} strokeWidth="1.8" strokeDasharray={dash} /></svg>
  );
  return (
    <div className="flow-legend" onPointerDown={(e) => e.stopPropagation()}>
      <button type="button" className="ghost legend-toggle" onClick={toggle} aria-expanded={!collapsed}>
        {collapsed ? "▸ Legend" : "▾ Legend"}
      </button>
      {!collapsed && (
        <div className="legend-body">
          <div className="legend-col">
            {Object.values(PALETTE.kind).map((k) => (
              <div key={k.label}>{box(k.fill, k.stroke, k.dash)} {k.label}</div>
            ))}
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
            <div className="muted">drag node · drag canvas pans · wheel zooms</div>
          </div>
        </div>
      )}
    </div>
  );
}

type PosMap = Record<string, { x: number; y: number }>;
type View = { x: number; y: number; k: number };

function computeLayers(nodes: FlowNode[], edges: FlowEdge[]): Record<string, number> {
  const layer: Record<string, number> = Object.fromEntries(nodes.map((n) => [n.id, 0]));
  for (let i = 0; i < nodes.length; i++)
    for (const e of edges)
      if (layer[e.from] !== undefined && layer[e.to] !== undefined && layer[e.to] < layer[e.from] + 1 && e.to !== SEED)
        layer[e.to] = layer[e.from] + 1;
  // Seed kit is the sole entry row; everything else starts below it.
  if (layer[SEED] !== undefined) {
    for (const id of Object.keys(layer)) if (id !== SEED) layer[id] = Math.max(1, layer[id] + (layer[id] === 0 ? 1 : 0));
    layer[SEED] = 0;
  }
  return layer;
}

/** Top→bottom layered layout; rows centred, long rows wrapped so the graph stays compact. */
function denseAutoLayout(nodes: FlowNode[], edges: FlowEdge[]): PosMap {
  const layer = computeLayers(nodes, edges);
  const rows: Record<number, FlowNode[]> = {};
  nodes.forEach((n) => (rows[layer[n.id]] ??= []).push(n));
  Object.values(rows).forEach((ns) => ns.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)));
  const lines: FlowNode[][] = [];
  Object.keys(rows).map(Number).sort((a, b) => a - b).forEach((r) => {
    const ns = rows[r];
    for (let i = 0; i < ns.length; i += MAX_ROW) lines.push(ns.slice(i, i + MAX_ROW));
  });
  const widest = Math.max(1, ...lines.map((l) => l.length));
  const fullW = widest * W + (widest - 1) * GX;
  const pos: PosMap = {};
  lines.forEach((line, li) => {
    const lw = line.length * W + (line.length - 1) * GX;
    const x0 = PAD + (fullW - lw) / 2;
    line.forEach((n, i) => (pos[n.id] = { x: x0 + i * (W + GX), y: PAD + li * (H + GY) }));
  });
  return pos;
}

/** Honour stored coords only when EVERY node has one (avoids partial left/right clusters). */
function layoutGraph(g: FlowGraph, edges: FlowEdge[]): PosMap {
  const allStored = g.nodes.length > 0 && g.nodes.every((n) => n.position != null);
  if (g.layout === "stored" && allStored)
    return Object.fromEntries(g.nodes.map((n) => [n.id, { x: n.position!.x, y: n.position!.y }]));
  return denseAutoLayout(g.nodes, edges);
}

type Side = "top" | "bottom" | "left" | "right";
/** Anchor on the side of `a` facing `b` (centre-to-centre direction). */
function anchor(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number; nx: number; ny: number } {
  const dx = b.x + W / 2 - (a.x + W / 2), dy = b.y + H / 2 - (a.y + H / 2);
  const side: Side = Math.abs(dx) / W > Math.abs(dy) / H ? (dx > 0 ? "right" : "left") : dy > 0 ? "bottom" : "top";
  switch (side) {
    case "right": return { x: a.x + W, y: a.y + H / 2, nx: 1, ny: 0 };
    case "left": return { x: a.x, y: a.y + H / 2, nx: -1, ny: 0 };
    case "bottom": return { x: a.x + W / 2, y: a.y + H, nx: 0, ny: 1 };
    default: return { x: a.x + W / 2, y: a.y, nx: 0, ny: -1 };
  }
}

function edgePath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const s = anchor(a, b), t = anchor(b, a);
  const dist = Math.hypot(t.x - s.x, t.y - s.y);
  const c = Math.max(24, Math.min(90, dist * 0.4));
  return `M${s.x},${s.y} C${s.x + s.nx * c},${s.y + s.ny * c} ${t.x + t.nx * c},${t.y + t.ny * c} ${t.x},${t.y}`;
}

function contentBounds(pos: PosMap) {
  const vals = Object.values(pos);
  if (!vals.length) return { minX: 0, minY: 0, maxX: 320, maxY: 180, w: 320, h: 180 };
  const minX = Math.min(...vals.map((p) => p.x));
  const minY = Math.min(...vals.map((p) => p.y));
  const maxX = Math.max(...vals.map((p) => p.x + W));
  const maxY = Math.max(...vals.map((p) => p.y + H));
  return { minX, minY, maxX, maxY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

export default function FlowTab() {
  const { projectId = "" } = useParams();
  const [showCloud, setShowCloud] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [pos, setPos] = useState<PosMap>({});
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const pan = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null);
  const [resetting, setResetting] = useState(false);
  const drag = useRef<{ id: string; ox: number; oy: number; moved: boolean } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const saveTimer = useRef<number | null>(null);
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

  const visibleEdges = useMemo(
    () => (data?.edges ?? []).filter((e) => showCloud || e.scope !== "cloud"),
    [data, showCloud],
  );

  const fitView = useCallback((p: PosMap) => {
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const b = contentBounds(p);
    const pad = 24;
    const k = Math.min(ZMAX, Math.max(ZMIN, Math.min((r.width - pad * 2) / b.w, (r.height - pad * 2) / b.h, 1.6)));
    setView({ k, x: (r.width - b.w * k) / 2 - b.minX * k, y: (r.height - b.h * k) / 2 - b.minY * k });
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

  // Rebuild positions only when the graph is (re)fetched; keep moved nodes; fit only when requested.
  useEffect(() => {
    if (!data) return;
    const auto = layoutGraph(data, visibleEdges);
    const prev = posRef.current;
    const next: PosMap = { ...auto };
    moved.current.forEach((id) => {
      if (prev[id] && next[id]) next[id] = prev[id];
    });
    setPos(next);
    if (needFit.current) {
      needFit.current = false;
      requestAnimationFrame(() => fitView(next));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, visibleEdges]);

  // Fire-and-forget: no state change, no reload, no fit.
  const persist = useCallback(
    (next: PosMap) => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        api.saveFlowPositions(projectId, next).catch(() => {
          /* keep local; next drag re-sends the full map */
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

  const onPointerDown = (e: React.PointerEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = pos[id];
    if (!p) return;
    const cur = clientToSvg(e.clientX, e.clientY);
    drag.current = { id, ox: cur.x - p.x, oy: cur.y - p.y, moved: false };
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
    const nx = cur.x - d.ox;
    const ny = cur.y - d.oy;
    d.moved = true;
    moved.current.add(d.id);
    setPos((prev) => ({ ...prev, [d.id]: { x: nx, y: ny } }));
  };

  const onPointerUp = () => {
    pan.current = null;
    const d = drag.current;
    drag.current = null;
    if (!d?.moved) return;
    persist(posRef.current);
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

  const layers = useMemo(() => (data ? computeLayers(data.nodes, visibleEdges) : {}), [data, visibleEdges]);
  const sel = data?.nodes.find((n) => n.id === selected);

  return (
    <div className="flow-page">
      <div className="toolbar">
        <label>
          <input type="checkbox" checked={showCloud} onChange={(e) => setShowCloud(e.target.checked)} /> Show cloud edges
        </label>
        <button onClick={() => { reload(); refresh(); }}>Refresh</button>
        <button type="button" onClick={() => fitView(pos)} title="Fit entire graph in view">
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
      {data?.warnings && data.warnings.length > 0 && (
        <div className="warn-banner" role="status">
          <strong>Flow warnings</strong>
          <ul>
            {data.warnings.map((w, i) => (
              <li key={i}>
                <code>{w}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {loading && <Empty>Loading flow…</Empty>}
      {data && (
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
            {visibleEdges.map((e) => {
              const a = pos[e.from],
                b = pos[e.to];
              if (!a || !b) return null;
              const d = edgePath(a, b);
              const back = layers[e.to] !== undefined && layers[e.to] <= layers[e.from];
              const cls = `edge${back ? " back" : ""} ${e.kind} ${e.confidence === "inferred-from-settings" ? "inferred" : ""} ${e.scope === "cloud" ? "cloud" : ""}`;
              return (
                <g key={e.id}>
                  <path d={d} className={cls} markerEnd={back ? "url(#arrBack)" : "url(#arr)"}>
                    <title>{`${e.kind}: ${e.from} → ${e.to}${e.label ? " (" + e.label + ")" : ""} [${e.confidence}]`}</title>
                  </path>
                </g>
              );
            })}
            {data.nodes.map((n) => {
              const p = pos[n.id];
              if (!p) return null;
              const c = n.kind === "queue" || n.kind === "subscription" ? nodeCounts(n, counts) : null;
              const hot = c ? c.dlqHot : !!n.sb?.dlqHot;
              return (
                <g
                  key={n.id}
                  transform={`translate(${p.x},${p.y})`}
                  className={`node ${n.kind} ${hot ? "hot" : ""} ${selected === n.id ? "sel" : ""}`}
                  onPointerDown={(e) => onPointerDown(e, n.id)}
                  style={{ cursor: "grab" }}
                >
                  <title>
                    {n.sb?.maxDeliveryCount != null
                      ? `${n.label} · MaxDeliveryCount ${n.sb.maxDeliveryCount}${hot ? " · DLQ hot" : ""} · drag to move`
                      : `${n.label} · drag to move`}
                  </title>
                  <rect
                    width={W}
                    height={H}
                    rx={n.kind === "app" ? 8 : 3}
                    style={{
                      fill: kindStyle(n.kind).fill,
                      stroke: selected === n.id ? PALETTE.sel : hot ? PALETTE.hot : kindStyle(n.kind).stroke,
                      strokeWidth: selected === n.id || hot ? 2.5 : 1.2,
                      strokeDasharray: kindStyle(n.kind).dash,
                    }}
                  />
                  <text x={8} y={17} className="t1">
                    {n.label}
                  </text>
                  <text x={8} y={33} className="t2">
                    {n.app
                      ? n.app.attached
                        ? <tspan fill={PALETTE.attached}>● attached</tspan>
                        : <tspan fill={PALETTE.detached}>○ not attached</tspan>
                      : c
                        ? countsLabel(c)
                        : n.kind}
                  </text>
                </g>
              );
            })}
            </g>
          </svg>
          <FlowLegend />
          </div>
          <aside className="side-panel">
            {!sel && <Empty>Select or drag a node.</Empty>}
            {sel && (
              <>
                <h4>{sel.label}</h4>
                <div className="muted">
                  {sel.id} · {sel.kind} · scope {sel.scope}
                </div>
                {sel.app && (
                  <p>
                    {sel.app.appKind} :{sel.app.port}
                    <br />
                    <code>{sel.app.cloudRoleName}</code>
                    <br />
                    {sel.app.attached ? "Console attached" : "Not attached"}
                  </p>
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
                      <li key={e.id}>
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
