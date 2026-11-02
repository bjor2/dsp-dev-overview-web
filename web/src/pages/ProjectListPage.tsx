import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import { demoProjects } from "../mocks/demo";
import { Count, Empty, ErrorBanner, HealthDot, fmtOslo } from "../components/common";

export default function ProjectListPage() {
  const nav = useNavigate();
  const { data, error, loading, reload } = useApi(api.projects, demoProjects, []);
  return (
    <section>
      <div className="page-head"><h2>Projects</h2><button onClick={reload}>Refresh</button></div>
      {error && <ErrorBanner error={error} onRetry={reload} />}
      {loading && <Empty>Loading…</Empty>}
      {data && data.length === 0 && <Empty>No registrations. Add one under architecture/registrations/.</Empty>}
      {data && data.length > 0 && (
        <table className="grid">
          <thead><tr><th>Health</th><th>Project</th><th>Env</th><th>Apps up</th><th>SB</th><th>AI</th><th>Queues</th><th>DLQ</th><th>Registration</th></tr></thead>
          <tbody>
            {data.map((p) => (
              <tr key={p.id} className="clickable" onClick={() => nav(`/projects/${encodeURIComponent(p.id)}/flow`)}>
                <td><HealthDot health={p.health} /></td>
                <td><strong>{p.project}</strong><div className="muted">{p.id}</div></td>
                <td><span className="badge env">{p.env}</span></td>
                <td>{p.healthDetail.appsUp}/{p.healthDetail.appsTotal}</td>
                <td>{p.healthDetail.sbReachable ? "✓" : "✗"}</td>
                <td>{p.healthDetail.aiQueryOk ? "✓" : "✗"}</td>
                <td>{p.queueCount}</td>
                <td><Count v={p.dlqTotal} hot={p.dlqTotal > 0} /></td>
                <td className="muted">{fmtOslo(p.registrationGeneratedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
