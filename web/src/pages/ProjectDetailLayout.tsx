import { NavLink, Outlet, useParams } from "react-router-dom";
import { useState } from "react";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import { demoProjects } from "../mocks/demo";
import { ErrorBanner, HealthDot, fmtOslo } from "../components/common";

const TABS = [["flow", "Flow"], ["service-bus", "Service Bus"], ["logs", "Logs"], ["console", "Console"]] as const;

export default function ProjectDetailLayout() {
  const { projectId = "" } = useParams();
  const { data, error, reload } = useApi(api.projects, demoProjects, []);
  const [refreshing, setRefreshing] = useState(false);
  const p = data?.find((x) => x.id === projectId);
  const refresh = async () => { setRefreshing(true); try { await api.refreshRegistration(projectId); reload(); } catch { reload(); } finally { setRefreshing(false); } };
  return (
    <section>
      <div className="page-head">
        <h2>{p ? <><HealthDot health={p.health} /> {p.project}</> : projectId}</h2>
        {p && <span className="muted">registration {fmtOslo(p.registrationGeneratedAt)}</span>}
        {p?.traceItUrl && (
          <a className="ext-link" href={p.traceItUrl} target="_blank" rel="noopener noreferrer" title={p.traceItUrl}>
            TraceIt ↗
          </a>
        )}
        <button onClick={refresh} disabled={refreshing}>{refreshing ? "Refreshing…" : "Refresh registration"}</button>
      </div>
      {error && <ErrorBanner error={error} onRetry={reload} />}
      <nav className="tabs">{TABS.map(([to, label]) => <NavLink key={to} to={to}>{label}</NavLink>)}</nav>
      <Outlet />
    </section>
  );
}
