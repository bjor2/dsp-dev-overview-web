import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import { demoProjects } from "../mocks/demo";
import AgentPill from "../agent/AgentPill";
import { Count, Empty, ErrorBanner, HealthDot, fmtOslo, noticeText, noticeTitle } from "../components/common";

export default function ProjectListPage() {
  const nav = useNavigate();
  const { data, error, loading, reload } = useApi(api.projects, demoProjects, [], 15_000); // DLQ/health refresh every 15 s
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  useEffect(() => { if (data && !error) setUpdatedAt(new Date()); }, [data, error]);
  return (
    <section>
      <div className="page-head"><h2>Projects</h2><button onClick={reload}>Refresh</button>
        {updatedAt && <span className="muted">updated {updatedAt.toLocaleTimeString()}</span>}</div>
      {error && <ErrorBanner error={error} onRetry={reload} />}
      {loading && <Empty>Loading…</Empty>}
      {data && data.length === 0 && <Empty>No registrations. Add one under architecture/registrations/.</Empty>}
      {data && data.length > 0 && (
        <table className="grid">
          <thead><tr><th>Health</th><th>Project</th><th>Env</th><th>Apps up</th><th>Local agent</th><th>SB</th><th>AI</th><th>Queues</th><th>DLQ</th><th>TraceIt</th><th>Registration</th></tr></thead>
          <tbody>
            {data.map((p) => (
              <tr key={p.id} className="clickable" onClick={() => nav(`/projects/${encodeURIComponent(p.id)}/flow`)}>
                <td><HealthDot health={p.health} /></td>
                <td>
                  <strong>{p.project}</strong><div className="muted">{p.id}</div>
                  {p.notice && (
                    <div className={`notice ${p.notice.severity === "warn" ? "warn" : "info"}`} role="note" title={noticeTitle(p.notice)} data-code={p.notice.code}>
                      {noticeText(p.notice)}
                    </div>
                  )}
                </td>
                <td><span className="badge env">{p.env}</span></td>
                <td className="apps-up">{p.healthDetail.appsUp}/{p.healthDetail.appsTotal}</td>
                <td className="local-agent"><AgentPill regId={p.id} appsTotal={p.healthDetail.appsTotal} /></td>
                <td>{p.healthDetail.sbReachable ? "✓" : "✗"}</td>
                <td>{p.healthDetail.aiQueryOk ? "✓" : "✗"}</td>
                <td>{p.queueCount}</td>
                <td><span title={p.dlqTotal === null ? "Unknown: Service Bus did not answer" : undefined}><Count v={p.dlqTotal} hot={(p.dlqTotal ?? 0) > 0} /></span></td>
                <td onClick={(e) => e.stopPropagation()}>
                  {p.traceItUrl ? (
                    <a className="ext-link" href={p.traceItUrl} target="_blank" rel="noopener noreferrer" title={p.traceItUrl}>TraceIt ↗</a>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="muted">{fmtOslo(p.registrationGeneratedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
