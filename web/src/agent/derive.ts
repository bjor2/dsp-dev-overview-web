// Pure derivations from the shared feed snapshot (no React, no clock reads: `now` is passed in).
import type { FeedSnapshot } from "./statusFeed";
import type { AgentAppStatus, AgentInfo, AgentPresence, PortState, UnavailableReason } from "./types";

export const STATUS_STALE_MS = 30_000;

export type OfflineReason = "no-snapshot" | "no-agent" | "agent-offline" | "status-stale" | UnavailableReason;
export type ProjectAgentView =
  | { kind: "offline"; reason: OfflineReason; lastSeen?: string }
  | { kind: "online" | "stale"; up: number; total: number; starting: number; apps: AgentAppStatus[];
      agent: AgentInfo; heartbeatAgeSec: number; registrationStale: boolean; registrationUnknown: boolean };

export type ConsoleUnavailableReason = OfflineReason | "app-not-reported";
export type AppAgentView =
  | { kind: "offline"; reason: ConsoleUnavailableReason; lastSeen?: string }
  | { kind: "reported"; presence: "online" | "stale"; app: AgentAppStatus; agent: AgentInfo; heartbeatAgeSec: number };

/**
 * Presence re-evaluated against the browser clock: offline if the server says so or the heartbeat is > 30 s old,
 * stale if the server says so or it is > 15 s old. A frozen server snapshot can therefore never show green.
 */
export function effectivePresence(agent: AgentInfo, now: number): { presence: AgentPresence; heartbeatAgeSec: number } {
  const hb = agent.lastHeartbeat ? Date.parse(agent.lastHeartbeat) : NaN;
  const heartbeatAgeSec = Number.isFinite(hb) ? Math.max(0, (now - hb) / 1000) : 999;
  const presence: AgentPresence =
    agent.presence === "offline" || heartbeatAgeSec > 30 ? "offline"
      : agent.presence === "stale" || heartbeatAgeSec > 15 ? "stale"
        : "online";
  return { presence, heartbeatAgeSec };
}

const maxIso = (xs: (string | undefined)[]) =>
  xs.filter((x): x is string => !!x).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1);

/** Rules 1–3 of §1, shared by the project and the app view. Returns null when the snapshot is usable. */
function feedProblem(snap: FeedSnapshot, now: number): { reason: OfflineReason } | null {
  if (snap.link.kind === "unavailable") return { reason: snap.link.reason };
  if (!snap.status) return { reason: snap.link.kind === "reconnecting" ? "network" : "no-snapshot" };
  if (now - snap.receivedAt > STATUS_STALE_MS) return { reason: "status-stale" };
  return null;
}

function agentFor(agents: AgentInfo[], apps: AgentAppStatus[]): AgentInfo | undefined {
  if (apps.length) return agents.find((a) => a.agentId === apps[0].agentId);
  return agents.length === 1 ? agents[0] : undefined;
}

export function projectAgentView(snap: FeedSnapshot, regId: string, now: number): ProjectAgentView {
  const p = feedProblem(snap, now);
  if (p) return { kind: "offline", reason: p.reason };
  const apps = snap.status!.apps.filter((a) => a.regId === regId);
  const agent = agentFor(snap.status!.agents, apps);
  if (!agent) return { kind: "offline", reason: "no-agent" };
  const { presence, heartbeatAgeSec } = effectivePresence(agent, now);
  if (presence === "offline") {
    // Only the browser clock says offline and our own feed is down: blame the feed, not the agent.
    const reason: OfflineReason = agent.presence !== "offline" && snap.link.kind !== "open" ? "network" : "agent-offline";
    return { kind: "offline", reason, lastSeen: maxIso(apps.map((a) => a.lastSeen)) ?? agent.lastHeartbeat ?? undefined };
  }
  const reg = agent.registrations?.find((r) => r.id === regId);
  return {
    kind: presence, apps, agent, heartbeatAgeSec,
    total: apps.length,
    up: apps.filter((a) => a.state === "running").length,
    starting: apps.filter((a) => a.state === "starting").length,
    registrationStale: !!reg?.stale,
    registrationUnknown: !!reg?.unknown,
  };
}

export function appAgentView(snap: FeedSnapshot, regId: string, appId: string, now: number): AppAgentView {
  const pv = projectAgentView(snap, regId, now);
  if (pv.kind === "offline") {
    const app = snap.status?.apps.find((a) => a.regId === regId && a.appId === appId);
    return { kind: "offline", reason: pv.reason, lastSeen: app?.lastSeen ?? pv.lastSeen };
  }
  const app = pv.apps.find((a) => a.appId === appId);
  if (!app) return { kind: "offline", reason: "app-not-reported" };
  return { kind: "reported", presence: pv.kind, app, agent: pv.agent, heartbeatAgeSec: pv.heartbeatAgeSec };
}

/** Ports as {port,state}[] whatever the wire shape (v1.1 number[] + listeningPorts, or v1.2 objects). */
export function declaredPorts(app: AgentAppStatus): { port: number; state: PortState }[] {
  const busy = new Set((app.portBusyByOther ?? []).map((b) => b.port));
  const listening = new Set(app.listeningPorts ?? []);
  return (app.ports ?? []).map((p) =>
    typeof p === "number"
      ? { port: p, state: busy.has(p) ? "busyByOther" : listening.has(p) ? "listening" : app.listeningPorts ? "notListening" : "unknown" }
      : p,
  );
}

/** "52160 busy (pid 4000 dotnet)" for every port another process holds. */
export const busyText = (app: AgentAppStatus) =>
  (app.portBusyByOther ?? []).map((b) => `${b.port} busy (pid ${b.pid} ${b.name})`);

export const STATE_GLYPH: Record<string, { glyph: string; color: string }> = {
  running: { glyph: "●", color: "#16a34a" },
  starting: { glyph: "◐", color: "#f2a900" },
  stopped: { glyph: "○", color: "#94a3b8" },
  ambiguous: { glyph: "⚠", color: "#d97706" },
  unknown: { glyph: "?", color: "#94a3b8" },
};
export const stateGlyph = (s: string) => STATE_GLYPH[s] ?? STATE_GLYPH.unknown;
