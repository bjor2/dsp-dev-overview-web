// DESIGN-flow-drilldown §3.5: layer provenance + caveats (always), selection, children. Every uncertainty is shown
// verbatim; nothing is summarised, truncated or softened. No dangerouslySetInnerHTML: React escapes all text.
import { useEffect, useRef } from "react";
import type { ArchEdge, ArchitectureLayerResponse, ArchNode, ArchSource } from "../api/types";
import { renderRef } from "./links";
import { edgeLabel, incidentEdges, nodeById, shortRevision } from "./model";

export type ArchSelection = { kind: "node"; id: string } | { kind: "edge"; id: string } | null;

const CONFIDENCE_TITLE: Record<ArchSource["confidence"], string> = {
  confirmed: "confirmed: source-supported, not runtime-observed",
  inferred: "inferred",
  uncertain: "uncertain",
};

function Sources({ sources }: { sources: ArchSource[] }) {
  if (!sources.length) return <p className="muted">No sources recorded.</p>;
  return (
    <ul className="arch-sources">
      {sources.map((s, i) => {
        const ref = renderRef(s.kind, s.ref);
        const title = s.confidence === "confirmed" ? CONFIDENCE_TITLE.confirmed + (s.note ? "\n" + s.note : "") : `${s.confidence}: ${s.note ?? "(no note)"}`;
        return (
          <li key={i} className="arch-source" data-kind={s.kind} data-confidence={s.confidence}>
            <span className={`confidence-pill confidence-${s.confidence}`} title={title}>{s.confidence}</span>
            <span className="arch-source-kind">{s.kind}</span>
            {s.revision && <span className="arch-revision" title={s.revision}>{shortRevision(s.revision)}</span>}
            <div className="arch-ref">
              {ref.href ? <a href={ref.href} target="_blank" rel="noopener noreferrer">{ref.text}</a> : <code>{ref.text}</code>}
            </div>
            {s.note && <div className="arch-note">{s.note}</div>}
          </li>
        );
      })}
    </ul>
  );
}

function Uncertainties({ items, empty }: { items: string[]; empty: string }) {
  if (!items.length) return <p className="muted arch-no-caveats">{empty}</p>;
  return (
    <ul className="arch-uncertainties">
      {items.map((u, i) => <li key={i}><span className="arch-warn" aria-hidden="true">⚠</span> {u}</li>)}
    </ul>
  );
}

const fmtDate = (iso: string) => { const d = new Date(iso); return isNaN(d.getTime()) ? iso : d.toLocaleDateString(); };

export default function CaveatPanel({ resp, selection, onSelect, onOpen, onFlowEntity, canFocus }: {
  resp: ArchitectureLayerResponse;
  selection: ArchSelection;
  onSelect: (s: ArchSelection) => void;
  onOpen: (layerId: string) => void;
  onFlowEntity: (id: string) => void;
  canFocus: (id: string) => boolean;
}) {
  const l = resp.layer;
  const selRef = useRef<HTMLElement | null>(null);
  useEffect(() => { if (selection) selRef.current?.scrollIntoView?.({ block: "nearest" }); }, [selection]);
  const byId = nodeById(l);
  const node: ArchNode | undefined = selection?.kind === "node" ? byId.get(selection.id) : undefined;
  const edge: ArchEdge | undefined = selection?.kind === "edge" ? l.edges.find((e) => e.id === selection.id) : undefined;
  const nodeLink = (id: string) => (
    <a href="#" onClick={(e) => { e.preventDefault(); onSelect({ kind: "node", id }); }}>{byId.get(id)?.label ?? id}</a>
  );
  return (
    <aside className="side-panel architecture-panel" aria-label="Architecture sources and caveats">
      <section className="arch-section arch-layer-section">
        <h4>{l.title}</h4>
        <div className="muted">{l.id} · scope {l.scope} · reviewed {fmtDate(l.reviewedAt)}</div>
        <p className="arch-summary">{l.summary}</p>
        <p className="muted arch-static-note">Static, source-derived explanation: not execution flow, not live traffic.</p>
        {resp.warnings?.length > 0 && (
          <ul className="arch-warnings">{resp.warnings.map((w, i) => <li key={i}><code>{w}</code></li>)}</ul>
        )}
        <h5>Uncertainties ({l.uncertainties.length})</h5>
        <Uncertainties items={l.uncertainties} empty="No layer-wide caveats recorded" />
        <h5>Sources ({l.sources.length})</h5>
        <Sources sources={l.sources} />
      </section>

      {(node || edge) && (
        <section ref={selRef} className="arch-section arch-selection-section" data-selected={node?.id ?? edge?.id}>
          {node && (
            <>
              <h4>{node.label}</h4>
              <div className="muted">{node.id} · {node.kind} · {node.boundary === "inside" ? "inside this boundary" : "outside this boundary"}</div>
              <p>{node.responsibility}</p>
              {node.owner && <p className="muted">Owner (explanatory only): {node.owner}</p>}
              {node.flowEntityId && (
                <p>
                  Flow reference <code>{node.flowEntityId}</code>{" "}
                  {canFocus(node.flowEntityId) ? (
                    <button type="button" className="arch-flow-chip" onClick={() => onFlowEntity(node.flowEntityId!)} title="Back to Flow and select this entity (no live status is shown here)">⇱ Flow</button>
                  ) : (
                    <button type="button" className="arch-flow-chip" disabled title="not in current scope">⇱ Flow (not in current scope)</button>
                  )}
                </p>
              )}
              {node.opensLayerId && (
                <p><button type="button" className="arch-open-child" onClick={() => onOpen(node.opensLayerId!)}>▸ Explore deeper layer</button></p>
              )}
              <h5>Uncertainties ({node.uncertainties.length})</h5>
              <Uncertainties items={node.uncertainties} empty="No caveats recorded for this node" />
              <h5>Sources ({node.sources.length})</h5>
              <Sources sources={node.sources} />
              <h5>Relationships</h5>
              <ul>
                {incidentEdges(l, node.id).map((e) => (
                  <li key={e.id}>
                    <a href="#" onClick={(ev) => { ev.preventDefault(); onSelect({ kind: "edge", id: e.id }); }}>
                      {e.from === node.id ? "→ " + (byId.get(e.to)?.label ?? e.to) : "← " + (byId.get(e.from)?.label ?? e.from)}
                    </a>{" "}
                    <span className="muted">({edgeLabel(e)})</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {edge && (
            <>
              <h4>{edgeLabel(edge)}</h4>
              <div className="muted">{edge.id} · conceptual {edge.relationship}</div>
              <p>{nodeLink(edge.from)} → {nodeLink(edge.to)}</p>
              <p>{edge.description}</p>
              <p className="muted">Direction = message/data supplied or dependency; not sequencing, timing or guaranteed delivery.</p>
              <h5>Uncertainties ({edge.uncertainties.length})</h5>
              <Uncertainties items={edge.uncertainties} empty="No caveats recorded for this relationship" />
              <h5>Sources ({edge.sources.length})</h5>
              <Sources sources={edge.sources} />
            </>
          )}
        </section>
      )}

      <section className="arch-section arch-children-section">
        <h5>Deeper layers</h5>
        {resp.children?.length ? (
          <ul>
            {resp.children.map((c) => (
              <li key={c.layerId}>
                <a href="#" onClick={(e) => { e.preventDefault(); onOpen(c.layerId); }}>{c.title}</a>
                <span className="muted"> opened by {byId.get(c.openedByNodeId)?.label ?? c.openedByNodeId}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No deeper layers</p>
        )}
      </section>
    </aside>
  );
}
