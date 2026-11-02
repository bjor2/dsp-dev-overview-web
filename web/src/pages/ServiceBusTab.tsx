import { useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import { demoDlq, demoEntities } from "../mocks/demo";
import { Count, Empty, ErrorBanner, fmtOslo } from "../components/common";

// Layout per COMPONENTS.md: EntityTable (queues + topic + subscriptions, ADDENDUM §1) | detail pane (Peek / DLQ).
export default function ServiceBusTab() {
  const { projectId = "" } = useParams();
  const { data, error, loading, reload } = useApi(() => api.entities(projectId), demoEntities, [projectId]);
  const [sel, setSel] = useState<string | null>(null);
  const [view, setView] = useState<"peek" | "dlq">("dlq");
  return (
    <div className="split">
      <div>
        <div className="toolbar"><button onClick={reload}>Refresh</button></div>
        {error && <ErrorBanner error={error} onRetry={reload} />}
        {loading && <Empty>Loading entities…</Empty>}
        {data && (
          <table className="grid">
            <thead><tr><th>Entity</th><th>Kind</th><th>Active</th><th>DLQ</th><th>Owner</th></tr></thead>
            <tbody>{data.map((e) => (
              <tr key={e.entityId} className={`clickable ${sel === e.entityId ? "sel" : ""}`} onClick={() => setSel(e.entityId)}>
                <td style={{ paddingLeft: e.parentEntityId ? 24 : undefined }}>{e.label}</td><td>{e.kind}</td>
                <td><Count v={e.activeCount} /></td><td><Count v={e.deadLetterCount} hot={e.dlqHot} /></td><td>{e.owner}</td>
              </tr>))}
            </tbody>
          </table>
        )}
      </div>
      <div>
        {!sel ? <Empty>Select an entity.</Empty> : (
          <>
            <nav className="tabs small"><a className={view === "peek" ? "active" : ""} onClick={() => setView("peek")}>Peek</a><a className={view === "dlq" ? "active" : ""} onClick={() => setView("dlq")}>Dead-letter</a></nav>
            {view === "dlq" ? <DlqPane projectId={projectId} entityId={sel} /> : <PeekPane projectId={projectId} entityId={sel} />}
          </>
        )}
      </div>
    </div>
  );
}

function PeekPane({ projectId, entityId }: { projectId: string; entityId: string }) {
  const { data, error, reload } = useApi(() => api.peek(projectId, entityId), undefined, [projectId, entityId]);
  // TODO(Developer): MessageDetail (props + body JSON viewer, bodyTruncated hint), auto-refresh.
  return <>{error && <ErrorBanner error={error} onRetry={reload} />}
    {data && (data.messages.length ? <ul className="msgs">{data.messages.map((m) => <li key={m.sequenceNumber}>#{m.sequenceNumber} {m.subject} <span className="muted">{fmtOslo(m.enqueuedTime)} · deliveries {m.deliveryCount}</span></li>)}</ul> : <Empty>Queue empty.</Empty>)}</>;
}

function DlqPane({ projectId, entityId }: { projectId: string; entityId: string }) {
  const { data, error, reload } = useApi(() => api.dlq(projectId, entityId), demoDlq, [projectId, entityId]);
  const [picked, setPicked] = useState<number[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>, label: string) => { try { await fn(); setMsg(label + " ok"); reload(); } catch (e) { setMsg(label + " failed: " + (e as Error).message); } };
  return (
    <>
      <div className="toolbar">
        <button disabled={!picked.length} onClick={() => act(() => api.dlqRetry(projectId, entityId, picked), "Retry")}>Retry selected</button>
        <button onClick={() => confirm("Retry all dead-lettered messages?") && act(() => api.dlqRetry(projectId, entityId, "all"), "Retry all")}>Retry all</button>
        <button className="danger" disabled={!picked.length} onClick={() => confirm("Discard selected?") && act(() => api.dlqDiscard(projectId, entityId, picked), "Discard")}>Discard</button>
        {msg && <span>{msg}</span>}
      </div>
      {error && <ErrorBanner error={error} onRetry={reload} />}
      {data && (data.length === 0 ? <Empty>DLQ empty.</Empty> : (
        <table className="grid"><thead><tr><th /><th>Seq</th><th>Subject</th><th>Reason</th><th>Deliveries</th><th>Enqueued</th></tr></thead>
          <tbody>{data.map((m) => (
            <tr key={m.sequenceNumber}>
              <td><input type="checkbox" checked={picked.includes(m.sequenceNumber)} onChange={(e) => setPicked(e.target.checked ? [...picked, m.sequenceNumber] : picked.filter((x) => x !== m.sequenceNumber))} /></td>
              <td>{m.sequenceNumber}</td><td>{m.subject}</td><td title={m.deadLetterErrorDescription}>{m.deadLetterReason}</td><td>{m.deliveryCount}</td><td className="muted">{fmtOslo(m.enqueuedTime)}</td>
            </tr>))}</tbody></table>
      ))}
      {/* TODO(Developer): row expand → MessageDetail with body/props; inject edited copy via SampleMessagePicker. */}
    </>
  );
}
