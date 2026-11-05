// Local-agent indicator (§1): shown next to the API's "Apps up", never merged with it (ADDENDA-010 §4).
import { useEffect, useState } from "react";
import { fmtOslo } from "../components/common";
import { useDemo } from "../components/DemoContext";
import { busyText, projectAgentView, type OfflineReason, type ProjectAgentView } from "./derive";
import { useAgentStatus, useNow, type FeedSnapshot } from "./statusFeed";

export const OFFLINE_REASON_TEXT: Record<OfflineReason, string> = {
  "no-snapshot": "no agent status received yet",
  "no-agent": "no agent has connected to the front door",
  "agent-offline": "agent offline (no heartbeat for 30 s or socket closed)",
  "status-stale": "no agent status for 30 s",
  network: "front door unreachable, retrying",
  "not-configured-503": "front door answered 503 (Entra / agent ingest not configured)",
  "unauthenticated-401": "not signed in (401)",
  "forbidden-403": "not allowed (403)",
  "not-served": "/agent is not served here (dev: run with AGENT_MOCK or AGENT_TARGET)",
  "bad-payload": "/agent/events sent something that is not agent status",
  "server-error": "front door error",
};

function tooltip(v: ProjectAgentView, snap: FeedSnapshot, now: number, appsTotal?: number): string {
  if (v.kind === "offline") {
    const lines = [`Local agent: ${OFFLINE_REASON_TEXT[v.reason]}`];
    if (v.lastSeen) lines.push(`last seen ${fmtOslo(v.lastSeen)}`);
    if (snap.link.kind === "unavailable" && snap.link.httpStatus) lines.push(`HTTP ${snap.link.httpStatus}`);
    if (snap.link.kind === "unavailable" || snap.link.kind === "reconnecting") lines.push(`next try in ${Math.max(0, Math.round((snap.link.retryAt - now) / 1000))} s`);
    return lines.join("\n");
  }
  const a = v.agent;
  const lines = [
    `host: ${a.host}`,
    `connected via: ${a.connectedVia}`,
    `heartbeat: ${Math.round(v.heartbeatAgeSec)} s ago${a.version ? ` · agent ${a.version}` : ""}`,
    ...v.apps.map((x) => `${x.appId}: ${x.state}${x.reason ? ` (${x.reason})` : ""}${busyText(x).length ? " · " + busyText(x).join(", ") : ""}`),
    ...(a.warnings ?? []).map((w) => `warning: ${w}`),
  ];
  if (v.registrationStale) lines.push("registration outdated, rebuild the agent");
  if (v.registrationUnknown) lines.push("registration not deployed to front door");
  if (appsTotal !== undefined && appsTotal !== v.total) lines.push(`registration lists ${appsTotal}, agent reports ${v.total}`);
  return lines.join("\n");
}

export default function AgentPill({ regId, appsTotal }: { regId: string; appsTotal?: number }) {
  const { demoMode } = useDemo();
  const snap = useAgentStatus(!demoMode);
  const tick = useNow(5000);
  const now = Math.max(tick, snap.receivedAt);
  const [settling, setSettling] = useState(true); // "…" for the first 3 s without a snapshot
  useEffect(() => {
    const t = window.setTimeout(() => setSettling(false), 3000);
    return () => window.clearTimeout(t);
  }, []);
  if (demoMode)
    return <span className="agent-pill offline" data-state="offline" data-reason="demo" title="Demo data: no live agent"><i className="dot" /> agent offline · demo</span>;
  const v = projectAgentView(snap, regId, now);
  const title = tooltip(v, snap, now, appsTotal);
  if (v.kind === "offline") {
    if (v.reason === "no-snapshot" && settling)
      return <span className="agent-pill pending" data-state="pending" data-reason={v.reason} title={title}><i className="dot" /> …</span>;
    return <span className="agent-pill offline" data-state="offline" data-reason={v.reason} title={title}><i className="dot" /> agent offline</span>;
  }
  if (v.total === 0)
    return <span className="agent-pill none" data-state={v.kind} data-reason="no-apps" title={title}><i className="dot" /> no apps reported</span>;
  const text = `${v.up}/${v.total} apps up${v.starting ? ` · ${v.starting} starting` : ""}${v.kind === "stale" ? ` · stale ${Math.round(v.heartbeatAgeSec)} s` : ""}`;
  return (
    <span className={`agent-pill ${v.kind}`} data-state={v.kind} data-reason={v.kind} title={title}>
      <i className={`dot${v.kind === "online" ? " live" : ""}`} /> {text}
    </span>
  );
}
