import { useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import { APPS } from "../api/types";
import { demoLogs } from "../mocks/demo";
import { Empty, ErrorBanner, fmtOslo } from "../components/common";

// COMPONENTS.md: LogFilterBar (role chips = ADDENDUM §4 cloudRoleNames, since, KQL) + LogTable.
export default function LogsTab() {
  const { projectId = "" } = useParams();
  const [roles, setRoles] = useState<string[]>(APPS.map((a) => a.cloudRoleName));
  const [since, setSince] = useState("PT1H");
  const [kql, setKql] = useState("");
  const [applied, setApplied] = useState({ roles, since, kql });
  const { data, error, loading, reload } = useApi(() => api.logs(projectId, applied), demoLogs, [projectId, JSON.stringify(applied)]);
  const toggle = (r: string) => setRoles(roles.includes(r) ? roles.filter((x) => x !== r) : [...roles, r]);
  return (
    <div>
      <div className="banner info">Local runs don’t send to App Insights by default → see the Console tab.</div>
      <div className="toolbar">
        {APPS.map((a) => <label key={a.appId} className={`chip ${roles.includes(a.cloudRoleName) ? "on" : ""}`} title={a.cloudRoleName}><input type="checkbox" checked={roles.includes(a.cloudRoleName)} onChange={() => toggle(a.cloudRoleName)} />{a.label}</label>)}
        <select value={since} onChange={(e) => setSince(e.target.value)}><option value="PT15M">15 min</option><option value="PT1H">1 h</option><option value="PT24H">24 h</option></select>
        <input placeholder="KQL filter (optional)" value={kql} onChange={(e) => setKql(e.target.value)} style={{ flex: 1 }} />
        <button onClick={() => setApplied({ roles, since, kql })}>Run</button>
      </div>
      {error && <ErrorBanner error={error} onRetry={reload} />}
      {loading && <Empty>Querying…</Empty>}
      {data && (data.length === 0 ? <Empty>No events.</Empty> : (
        <table className="grid"><thead><tr><th>Time (Oslo)</th><th>Table</th><th>Role</th><th>Sev</th><th>Message</th></tr></thead>
          <tbody>{data.map((l, i) => <tr key={i} className={l.table === "exceptions" ? "err" : ""}><td className="muted">{fmtOslo(l.timestamp)}</td><td>{l.table}</td><td>{APPS.find((a) => a.cloudRoleName === l.cloudRoleName)?.label ?? l.cloudRoleName}</td><td>{l.severity ?? ""}</td><td>{l.message}</td></tr>)}</tbody></table>
      ))}
      {/* TODO(Developer): row expand (details, operationId correlation, traceItUrl link), live tail polling. */}
    </div>
  );
}
