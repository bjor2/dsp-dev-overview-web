import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import type { FlowEdge, FlowGraph, FlowNode } from "../api/types";
import { demoFlow } from "../mocks/demo";
import { Count, Empty, ErrorBanner } from "../components/common";
import SampleMessagePicker from "../components/SampleMessagePicker";

const W = 190, H = 54, GX = 70, GY = 26;

/** v1 auto-layout: longest-path layering (TODO(Developer): swap for dagre/ELK per HANDOFF Q4, honour node.position + PUT /flow/positions + Reset layout). */
function layout(g: FlowGraph, edges: FlowEdge[]) {
  const layer: Record<string, number> = Object.fromEntries(g.nodes.map((n) => [n.id, 0]));
  for (let i = 0; i < g.nodes.length; i++)
    for (const e of edges) if (layer[e.from] !== undefined && layer[e.to] !== undefined && layer[e.to] < layer[e.from] + 1 && layer[e.from] < g.nodes.length) layer[e.to] = layer[e.from] + 1;
  const cols: Record<number, FlowNode[]> = {};
  g.nodes.forEach((n) => (cols[layer[n.id]] ??= []).push(n));
  const pos: Record<string, { x: number; y: number }> = {};
  Object.entries(cols).forEach(([c, ns]) => ns.forEach((n, i) => (pos[n.id] = n.position ?? { x: 20 + +c * (W + GX), y: 20 + i * (H + GY) })));
  return pos;
}

export default function FlowTab() {
  const { projectId = "" } = useParams();
  const [showCloud, setShowCloud] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const scope = showCloud ? "all" : "local";
  const { data, error, loading, reload } = useApi(() => api.flow(projectId, scope), demoFlow, [projectId, scope]);

  const visibleEdges = useMemo(() => (data?.edges ?? []).filter((e) => showCloud || e.scope !== "cloud"), [data, showCloud]);
  const pos = useMemo(() => (data ? layout(data, visibleEdges) : {}), [data, visibleEdges]);
  const sel = data?.nodes.find((n) => n.id === selected);
  const maxX = Math.max(400, ...Object.values(pos).map((p) => p.x + W + 20));
  const maxY = Math.max(200, ...Object.values(pos).map((p) => p.y + H + 20));

  return (
    <div>
      <div className="toolbar">
        <label><input type="checkbox" checked={showCloud} onChange={(e) => setShowCloud(e.target.checked)} /> Show cloud edges</label>
        <button onClick={reload}>Refresh</button>
        <button disabled title="TODO(Developer): PUT /flow/positions reset">Reset layout</button>
        <span className="spacer" />
        <span className="legend"><i className="l-solid" />trigger/publish <i className="l-dot" />inferred <i className="l-dash" />cloud</span>
        <button className="primary" onClick={() => setPickerOpen(true)}>Inject sample…</button>
      </div>
      {error && <ErrorBanner error={error} onRetry={reload} />}
      {data?.warnings && data.warnings.length > 0 && (
        <div className="warn-banner" role="status">
          <strong>Flow warnings</strong>
          <ul>{data.warnings.map((w, i) => <li key={i}><code>{w}</code></li>)}</ul>
        </div>
      )}
      {loading && <Empty>Loading flow…</Empty>}
      {data && (
        <div className="flow-wrap">
          <svg className="flow" width={maxX} height={maxY}>
            <defs><marker id="arr" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L10,5L0,10z" fill="#667" /></marker></defs>
            {visibleEdges.map((e) => {
              const a = pos[e.from], b = pos[e.to]; if (!a || !b) return null;
              const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
              const back = x2 <= x1;
              const d = back ? `M${a.x + W / 2},${a.y + H} C${a.x + W / 2},${a.y + H + 60} ${b.x + W / 2},${b.y + H + 60} ${b.x + W / 2},${b.y + H}` : `M${x1},${y1} C${x1 + 40},${y1} ${x2 - 40},${y2} ${x2},${y2}`;
              const cls = `edge ${e.kind} ${e.confidence === "inferred-from-settings" ? "inferred" : ""} ${e.scope === "cloud" ? "cloud" : ""}`;
              return <g key={e.id}><path d={d} className={cls} markerEnd="url(#arr)"><title>{`${e.kind}: ${e.from} → ${e.to}${e.label ? " (" + e.label + ")" : ""} [${e.confidence}]`}</title></path></g>;
            })}
            {data.nodes.map((n) => {
              const p = pos[n.id]; if (!p) return null;
              return (
                <g key={n.id} transform={`translate(${p.x},${p.y})`} className={`node ${n.kind} ${n.sb?.dlqHot ? "hot" : ""} ${selected === n.id ? "sel" : ""}`} onClick={() => setSelected(n.id)}>
                  <title>{n.sb?.maxDeliveryCount != null ? `${n.label} · MaxDeliveryCount ${n.sb.maxDeliveryCount}${n.sb.dlqHot ? " · DLQ hot" : ""}` : n.label}</title>
                  <rect width={W} height={H} rx={n.kind === "app" ? 10 : 4} />
                  <text x={10} y={20} className="t1">{n.label}</text>
                  <text x={10} y={40} className="t2">
                    {n.app ? (n.app.attached ? "● attached" : "○ not attached") : n.sb ? `active ${n.sb.activeCount ?? "—"} · DLQ ${n.sb.deadLetterCount ?? "—"}` : n.kind}
                  </text>
                </g>
              );
            })}
          </svg>
          <aside className="side-panel">
            {!sel && <Empty>Select a node.</Empty>}
            {sel && (
              <>
                <h4>{sel.label}</h4>
                <div className="muted">{sel.id} · {sel.kind} · scope {sel.scope}</div>
                {sel.app && <p>{sel.app.appKind} :{sel.app.port}<br /><code>{sel.app.cloudRoleName}</code><br />{sel.app.attached ? "Console attached" : "Not attached"}</p>}
                {sel.sb && (
                  <p>
                    Active <Count v={sel.sb.activeCount} /> · DLQ <Count v={sel.sb.deadLetterCount} hot={sel.sb.dlqHot} /> · {sel.sb.owner}
                    {sel.sb.maxDeliveryCount != null && <> · MaxDelivery <code title="Tooltip only — does not drive dlqHot (ADDENDA-003)">{sel.sb.maxDeliveryCount}</code></>}
                  </p>
                )}
                <h5>Edges</h5>
                <ul>{visibleEdges.filter((e) => e.from === sel.id || e.to === sel.id).map((e) => <li key={e.id}>{e.kind}: {e.from === sel.id ? "→ " + e.to : "← " + e.from} {e.label && <span className="muted">({e.label})</span>}</li>)}</ul>
                {/* TODO(Developer): deep links → Service Bus tab (peek/DLQ) for queues, Console/Logs for apps; Inject preselects target. */}
              </>
            )}
          </aside>
        </div>
      )}
      <SampleMessagePicker open={pickerOpen} projectId={projectId} onClose={() => setPickerOpen(false)} />
    </div>
  );
}
