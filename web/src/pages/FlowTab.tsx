import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import type { FlowEdge, FlowGraph, FlowNode } from "../api/types";
import { demoFlow } from "../mocks/demo";
import { Count, Empty, ErrorBanner } from "../components/common";
import SampleMessagePicker from "../components/SampleMessagePicker";

/** Compact node size — keep margins tight so fit-to-view doesn't look sparse. */
const W = 148, H = 42, GX = 36, GY = 14, PAD = 12;

type PosMap = Record<string, { x: number; y: number }>;

/** Longest-path layering; honours stored node.position when present. */
function autoLayout(g: FlowGraph, edges: FlowEdge[]): PosMap {
  const layer: Record<string, number> = Object.fromEntries(g.nodes.map((n) => [n.id, 0]));
  for (let i = 0; i < g.nodes.length; i++)
    for (const e of edges)
      if (layer[e.from] !== undefined && layer[e.to] !== undefined && layer[e.to] < layer[e.from] + 1)
        layer[e.to] = layer[e.from] + 1;
  const cols: Record<number, FlowNode[]> = {};
  g.nodes.forEach((n) => (cols[layer[n.id]] ??= []).push(n));
  const pos: PosMap = {};
  Object.entries(cols).forEach(([c, ns]) =>
    ns.forEach((n, i) => {
      pos[n.id] = n.position ?? { x: PAD + +c * (W + GX), y: PAD + i * (H + GY) };
    }),
  );
  return pos;
}

function contentBounds(pos: PosMap) {
  const vals = Object.values(pos);
  if (!vals.length) return { minX: 0, minY: 0, maxX: 400, maxY: 200, w: 400, h: 200 };
  const minX = Math.min(...vals.map((p) => p.x)) - PAD;
  const minY = Math.min(...vals.map((p) => p.y)) - PAD;
  const maxX = Math.max(...vals.map((p) => p.x + W)) + PAD;
  const maxY = Math.max(...vals.map((p) => p.y + H)) + PAD;
  return { minX, minY, maxX, maxY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

export default function FlowTab() {
  const { projectId = "" } = useParams();
  const [showCloud, setShowCloud] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [pos, setPos] = useState<PosMap>({});
  const [viewBox, setViewBox] = useState("0 0 400 240");
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
    const b = contentBounds(p);
    // Slight padding inside viewBox so stroke/labels aren't clipped
    const pad = 8;
    setViewBox(`${b.minX - pad} ${b.minY - pad} ${b.w + pad * 2} ${b.h + pad * 2}`);
  }, []);

  // Rebuild positions when graph reloads (stored positions come on nodes).
  useEffect(() => {
    if (!data) return;
    const next = autoLayout(data, visibleEdges);
    setPos(next);
    fitView(next);
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

  const clientToSvg = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
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
    const d = drag.current;
    if (!d) return;
    const cur = clientToSvg(e.clientX, e.clientY);
    const nx = cur.x - d.ox;
    const ny = cur.y - d.oy;
    d.moved = true;
    setPos((prev) => ({ ...prev, [d.id]: { x: nx, y: ny } }));
  };

  const onPointerUp = () => {
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
      reload();
    } finally {
      setResetting(false);
    }
  };

  const sel = data?.nodes.find((n) => n.id === selected);

  return (
    <div>
      <div className="toolbar">
        <label>
          <input type="checkbox" checked={showCloud} onChange={(e) => setShowCloud(e.target.checked)} /> Show cloud edges
        </label>
        <button onClick={reload}>Refresh</button>
        <button type="button" onClick={() => fitView(pos)} title="Fit entire graph in view">
          Fit
        </button>
        <button type="button" onClick={resetLayout} disabled={resetting} title="PUT {} clears stored positions → auto layout">
          {resetting ? "Resetting…" : "Reset layout"}
        </button>
        {saving && <span className="muted">Saving positions…</span>}
        <span className="spacer" />
        <span className="legend">
          <i className="l-solid" />
          trigger/publish <i className="l-dot" />
          inferred <i className="l-dash" />
          cloud · drag nodes to rearrange
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
            viewBox={viewBox}
            preserveAspectRatio="xMidYMid meet"
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
          >
            <defs>
              <marker id="arr" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,0L10,5L0,10z" fill="#667" />
              </marker>
            </defs>
            {visibleEdges.map((e) => {
              const a = pos[e.from],
                b = pos[e.to];
              if (!a || !b) return null;
              const x1 = a.x + W,
                y1 = a.y + H / 2,
                x2 = b.x,
                y2 = b.y + H / 2;
              const back = x2 <= x1;
              const d = back
                ? `M${a.x + W / 2},${a.y + H} C${a.x + W / 2},${a.y + H + 40} ${b.x + W / 2},${b.y + H + 40} ${b.x + W / 2},${b.y + H}`
                : `M${x1},${y1} C${x1 + 28},${y1} ${x2 - 28},${y2} ${x2},${y2}`;
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
                  <text x={8} y={16} className="t1">
                    {n.label}
                  </text>
                  <text x={8} y={32} className="t2">
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
