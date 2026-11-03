import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import type { FlowEdge, FlowGraph, FlowNode } from "../api/types";
import { demoFlow } from "../mocks/demo";
import { Count, Empty, ErrorBanner } from "../components/common";
import SampleMessagePicker from "../components/SampleMessagePicker";

/** Node size + tight gutters (top→bottom layers). */
const W = 176, H = 40, GX = 24, GY = 56, PAD = 10, MAX_ROW = 7;
const SEED = "ext:seed-messages";
const ZMIN = 0.2, ZMAX = 3;

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
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const drag = useRef<{ id: string; ox: number; oy: number; moved: boolean } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const saveTimer = useRef<number | null>(null);
  const scope = showCloud ? "all" : "local";
  const { data, error, loading, reload } = useApi(() => api.flow(projectId, scope), demoFlow, [projectId, scope]);

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

  // Rebuild positions when graph reloads; always fit so first paint is readable.
  useEffect(() => {
    if (!data) return;
    const next = layoutGraph(data, visibleEdges);
    setPos(next);
    requestAnimationFrame(() => fitView(next));
  }, [data, visibleEdges, fitView]);

  const persist = useCallback(
    (next: PosMap) => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(async () => {
        setSaving(true);
        try {
          await api.saveFlowPositions(projectId, next);
        } catch {
          /* keep local; user can retry via drag or Reset */
        } finally {
          setSaving(false);
        }
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
    setPos((prev) => ({ ...prev, [d.id]: { x: nx, y: ny } }));
  };

  const onPointerUp = () => {
    pan.current = null;
    const d = drag.current;
    drag.current = null;
    if (!d?.moved) return;
    setPos((prev) => {
      persist(prev);
      return prev;
    });
  };

  const resetLayout = async () => {
    setResetting(true);
    try {
      await api.saveFlowPositions(projectId, {}); // {} = clear → auto (FlowPositionStore)
      reload(); // reload → auto layout → fit
    } finally {
      setResetting(false);
    }
  };

  const sel = data?.nodes.find((n) => n.id === selected);

  return (
    <div className="flow-page">
      <div className="toolbar">
        <label>
          <input type="checkbox" checked={showCloud} onChange={(e) => setShowCloud(e.target.checked)} /> Show cloud edges
        </label>
        <button onClick={reload}>Refresh</button>
        <button type="button" onClick={() => fitView(pos)} title="Fit entire graph in view">
          Fit
        </button>
        <button type="button" onClick={() => zoomAt(1 / 1.2)} title="Zoom out">−</button>
        <button type="button" onClick={() => zoomAt(1.2)} title="Zoom in">+</button>
        <span className="muted zoom-pct">{Math.round(view.k * 100)}%</span>
        <button type="button" onClick={resetLayout} disabled={resetting} title="PUT {} clears stored positions → auto layout">
          {resetting ? "Resetting…" : "Reset layout"}
        </button>
        {saving && <span className="muted">Saving positions…</span>}
        <span className="spacer" />
        <span className="legend">
          <i className="l-solid" />
          trigger/publish <i className="l-dot" />
          inferred <i className="l-dash" />
          cloud · drag nodes · drag canvas to pan · wheel to zoom
        </span>
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
                <path d="M0,0L10,5L0,10z" fill="#94a3b8" />
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
              const x1 = a.x + W / 2,
                y1 = a.y + H,
                x2 = b.x + W / 2,
                y2 = b.y;
              const back = y2 <= y1;
              const side = Math.max(a.x, b.x) + W;
              const d = back
                ? `M${a.x + W},${a.y + H / 2} C${side + 40},${a.y + H / 2} ${side + 40},${b.y + H / 2} ${b.x + W},${b.y + H / 2}`
                : `M${x1},${y1} C${x1},${y1 + GY / 2} ${x2},${y2 - GY / 2} ${x2},${y2}`;
              const cls = `edge ${e.kind} ${e.confidence === "inferred-from-settings" ? "inferred" : ""} ${e.scope === "cloud" ? "cloud" : ""}`;
              return (
                <g key={e.id}>
                  <path d={d} className={cls} markerEnd="url(#arr)">
                    <title>{`${e.kind}: ${e.from} → ${e.to}${e.label ? " (" + e.label + ")" : ""} [${e.confidence}]`}</title>
                  </path>
                </g>
              );
            })}
            {data.nodes.map((n) => {
              const p = pos[n.id];
              if (!p) return null;
              return (
                <g
                  key={n.id}
                  transform={`translate(${p.x},${p.y})`}
                  className={`node ${n.kind} ${n.sb?.dlqHot ? "hot" : ""} ${selected === n.id ? "sel" : ""}`}
                  onPointerDown={(e) => onPointerDown(e, n.id)}
                  style={{ cursor: "grab" }}
                >
                  <title>
                    {n.sb?.maxDeliveryCount != null
                      ? `${n.label} · MaxDeliveryCount ${n.sb.maxDeliveryCount}${n.sb.dlqHot ? " · DLQ hot" : ""} · drag to move`
                      : `${n.label} · drag to move`}
                  </title>
                  <rect width={W} height={H} rx={n.kind === "app" ? 8 : 3} />
                  <text x={8} y={17} className="t1">
                    {n.label}
                  </text>
                  <text x={8} y={33} className="t2">
                    {n.app
                      ? n.app.attached
                        ? "● attached"
                        : "○ not attached"
                      : n.sb
                        ? `a ${n.sb.activeCount ?? "—"} · DLQ ${n.sb.deadLetterCount ?? "—"}`
                        : n.kind}
                  </text>
                </g>
              );
            })}
            </g>
          </svg>
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
                    Active <Count v={sel.sb.activeCount} /> · DLQ <Count v={sel.sb.deadLetterCount} hot={sel.sb.dlqHot} /> ·{" "}
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
