// ADDENDA-010 §4 wire shapes for the front door's agent reads (/agent/status, /agent/console, /agent/events).
// Follows what dsp-dev-overview-web/server/agent serves today, not only the addendum text.
export type AgentPresence = "online" | "stale" | "offline"; // server: ≤15 s, 15–30 s, >30 s or socket closed
export type AppState = "running" | "starting" | "stopped" | "ambiguous" | "unknown";
export type ConsoleAvail = "tailing" | "unavailable" | "error"; // "tailing" (wire name) = dspwatch is streaming the app
export type AgentWarning = "PORT_TABLE_UNAVAILABLE" | "WMI_UNAVAILABLE";
export type PortState = "listening" | "notListening" | "busyByOther" | "unknown";

export interface AgentInfo {
  agentId: string; host: string; version: string; connectedVia: "ws" | "https";
  lastHeartbeat: string | null; // ISO; null until the first hb
  presence: AgentPresence;
  registrations: { id: string; sha256: string; stale: boolean; unknown?: boolean }[];
  warnings: AgentWarning[];
}
/** state.js: AppStatus & { lastSeen, agentId }. `ports` is number[]|null in v1.1 payloads, {port,state}[] in v1.2. Accept both. */
export interface AgentAppStatus {
  regId: string; appId: string; state: AppState; console: ConsoleAvail;
  lastSeen: string; agentId: string;
  pid?: number; rootPid?: number; startedAt?: string; reason?: string;
  ports?: (number | { port: number; state: PortState })[] | null;
  listeningPorts?: number[]; matchedBy?: ("processName" | "commandLine" | "exePath" | "workingDir" | "port")[];
  extraInstances?: number; ambiguousInstances?: number; ambiguousWith?: string[];
  portBusyByOther?: { port: number; pid: number; name: string }[];
}
export interface AgentStatus { agents: AgentInfo[]; apps: AgentAppStatus[] }
export interface AgentConsoleLine {
  /** The agent's own sequence. It restarts with every agent session, so it is NOT the reader sequence. */
  seq: number;
  /** Reader sequence assigned by the front door (state.js), monotonic per appKey. Used for afterSeq / Last-Event-ID. */
  rseq?: number;
  ts: string; regId: string; appId: string; stream: "file"; source: string;
  line: string; truncated: boolean; redacted: boolean;
}
export interface AgentConsoleRead { lines: AgentConsoleLine[]; nextSeq: number; droppedBefore?: number }
export type AgentSseEvent =
  | { event: "status"; data: AgentStatus; id?: undefined }
  | { event: "lines"; data: { lines: AgentConsoleLine[]; droppedBefore?: number }; id: string };

export const appKey = (regId: string, appId: string) => `${regId}/${appId}`; // same as protocol.js
/** Reader sequence of a public line: `rseq` when the front door sends it (it does today), else `seq`. */
export const readerSeq = (l: AgentConsoleLine) => (typeof l.rseq === "number" ? l.rseq : l.seq);

export type UnavailableReason =
  | "network" | "not-configured-503" | "unauthenticated-401" | "forbidden-403"
  | "not-served" /* HTML/404: endpoint not proxied or front door too old */ | "bad-payload" | "server-error";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
/** Shape check for an `AgentStatus` payload (anything else is `bad-payload`). */
export const isAgentStatus = (v: unknown): v is AgentStatus =>
  isObj(v) && Array.isArray(v.agents) && Array.isArray(v.apps) &&
  v.agents.every((a) => isObj(a) && typeof a.agentId === "string") &&
  v.apps.every((a) => isObj(a) && typeof a.regId === "string" && typeof a.appId === "string");
export const isConsoleLine = (v: unknown): v is AgentConsoleLine =>
  isObj(v) && typeof v.line === "string" && (typeof v.rseq === "number" || typeof v.seq === "number");
