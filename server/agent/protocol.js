// ADDENDA-010 v1.3 §3 ingest contract, mirrored from dev-overview/architecture/ADDENDA-010-local-listen-agent.md.
// The .NET agent (dev-overview/agent) emits the same AppStatus/Heartbeat shapes; test/agent.test.js validates a
// heartbeat produced by that agent against these validators.

/**
 * @typedef {"running"|"starting"|"stopped"|"ambiguous"|"unknown"} AgentState
 * @typedef {"processName"|"commandLine"|"exePath"|"workingDir"|"port"|"wrapper"} MatchedBy
 * @typedef {"PORT_TABLE_UNAVAILABLE"|"WMI_UNAVAILABLE"} HeartbeatWarning
 * @typedef {{ t: "hello", agentId: string, agentVersion: string, host: string,
 *             registrations: { id: string, sha256: string }[], resumeFrom?: Record<string, number> }} AgentHello
 * @typedef {{ t: "welcome", sessionId: string, heartbeatSec: 10, maxBatchLines: 500, maxBatchBytes: 262144,
 *             registrations: { id: string, sha256: string, stale: boolean, unknown?: boolean }[],
 *             ackedSeq: Record<string, number> }} ServerWelcome
 * @typedef {"listening"|"notListening"|"busyByOther"|"unknown"} PortState
 * @typedef {{ regId: string, appId: string, state: AgentState, extraInstances?: number, ambiguousInstances?: number,
 *             rootPid?: number, ambiguousWith?: string[] (appKeys "{registrationId}/{appId}"), listeningPorts?: number[],
 *             reason?: string, pid?: number, ports: { port: number, state: PortState }[], matchedBy?: MatchedBy[],
 *             startedAt?: string, console: "streaming"|"idle"|"error",
 *             portBusyByOther?: { port: number, pid: number, name: string }[] }} AppStatus
 * @typedef {{ t: "hb", agentId: string, sessionId: string, hbSeq: number, ts: string, apps: AppStatus[],
 *             warnings?: HeartbeatWarning[] }} Heartbeat
 * @typedef {{ seq: number, ts: string, regId: string, appId: string, stream: "stdout"|"stderr", source: string,
 *             line: string, truncated: boolean, redacted: boolean }} ConsoleLine
 * @typedef {{ t: "lines", agentId: string, sessionId: string, batchId: string, lines: ConsoleLine[] }} ConsoleBatch
 * @typedef {{ t: "ack", batchId: string, ackedSeq: Record<string, number> }} Ack
 * @typedef {{ t: "slow", retryAfterMs: number }} Slow
 * @typedef {{ t: "error", code: "AUTH"|"FORBIDDEN"|"TOO_LARGE"|"RATE"|"BAD_MSG"|"SESSION"|"NOT_CONFIGURED"|"APP_BUSY", message: string }} Err
 */

export const LIMITS = Object.freeze({
  heartbeatSec: 10,
  maxBatchLines: 500,
  maxBatchBytes: 262144, // measured on the UTF-8 encoded JSON message (WS frame / HTTP body)
  maxLineBytes: 4096,
  maxBatchesPerSec: 20,
  ringLines: 5000, // §5 front door, per appKey
  ringBytes: 2 * 1024 * 1024,
  globalBytes: 32 * 1024 * 1024,
  slowAt: 0.8, // §3 backpressure: the GLOBAL buffer above 80% (per-appKey rings are drop-oldest, never the trigger)
  slowRetryAfterMs: 2000,
  onlineSec: 15,
  staleSec: 30,
  helloTimeoutMs: 30_000, // v1.2.1: WS without a valid hello is closed with 4409
  sessionErrorsBeforeClose: 3, // v1.2.1: consecutive SESSION errors on one WS → close 4409
  sessionIdleSec: 3600, // v1.3: a session with no traffic for this long (or a closed WS) is forgotten; the agent keeps its last state
});

/** WS close code for session trouble (v1.2.1). */
export const WS_CLOSE_SESSION = 4409;

/** sessionId printed by `dsp-agent --json` in detect-only mode; never a real session (v1.2.1). */
export const DETECT_ONLY_SESSION = "detect-only";

export const STATES = ["running", "starting", "stopped", "ambiguous", "unknown"];
const MATCHED_BY = ["processName", "commandLine", "exePath", "workingDir", "port", "wrapper"];
// v1.3: "streaming" = a live dspwatch child; "idle" = no wrapper (or the wrapper's final hb); "error" = wrapper pipe/ingest failure.
export const CONSOLE = ["streaming", "idle", "error"];
/** v1.3 §W.3: lines come only from a dspwatch child's stdout/stderr ("file" is gone with the file tail). */
export const STREAMS = ["stdout", "stderr"];
const WARNINGS = ["PORT_TABLE_UNAVAILABLE", "WMI_UNAVAILABLE"];
const PORT_STATES = ["listening", "notListening", "busyByOther", "unknown"];
export const UNKNOWN_REGISTRATION_LABEL = "registration not deployed to front door";

export const appKey = (regId, appId) => `${regId}/${appId}`;

const isStr = (v) => typeof v === "string" && v.length > 0 && v.length <= 512;
const isInt = (v) => Number.isInteger(v) && v >= 0;
const isPort = (v) => Number.isInteger(v) && v >= 1 && v <= 65535;
const isIso = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));
const optional = (v, check) => v === undefined || check(v);
const arrayOf = (v, check, max = 1000) => Array.isArray(v) && v.length <= max && v.every(check);

/** Returns an error message, or null when valid. */
export function checkHello(m) {
  if (m?.t !== "hello") return "t must be hello";
  if (!isStr(m.agentId) || !isStr(m.agentVersion) || !isStr(m.host)) return "agentId, agentVersion, host required";
  if (!arrayOf(m.registrations, (r) => isStr(r?.id) && isStr(r?.sha256), 100)) return "registrations[] {id, sha256} required";
  if (m.resumeFrom !== undefined && !(typeof m.resumeFrom === "object" && m.resumeFrom !== null && Object.values(m.resumeFrom).every(isInt)))
    return "resumeFrom must map appKey to seq";
  return null;
}

export function checkAppStatus(a) {
  if (!isStr(a?.regId) || !isStr(a?.appId)) return "regId, appId required";
  if (!STATES.includes(a.state)) return `state must be one of ${STATES.join("|")}`;
  if (!CONSOLE.includes(a.console)) return `console must be one of ${CONSOLE.join("|")}`;
  const ok =
    optional(a.extraInstances, isInt) && optional(a.ambiguousInstances, isInt) && optional(a.rootPid, isInt) && optional(a.pid, isInt) &&
    optional(a.ambiguousWith, (v) => arrayOf(v, (k) => isStr(k) && k.includes("/"), 50)) &&
    optional(a.listeningPorts, (v) => arrayOf(v, isPort)) &&
    arrayOf(a.ports, (p) => isPort(p?.port) && PORT_STATES.includes(p?.state), 50) &&
    optional(a.reason, (v) => typeof v === "string" && v.length <= 4096) &&
    optional(a.matchedBy, (v) => arrayOf(v, (x) => MATCHED_BY.includes(x), MATCHED_BY.length)) &&
    optional(a.startedAt, isIso) &&
    optional(a.portBusyByOther, (v) => arrayOf(v, (b) => isPort(b?.port) && isInt(b?.pid) && typeof b?.name === "string", 50));
  return ok ? null : `invalid AppStatus fields for ${a.regId}/${a.appId}`;
}

/** §3 session binding fields carried by hb and lines. */
function checkBinding(m) {
  return isStr(m.agentId) && isStr(m.sessionId) ? null : "agentId and sessionId required";
}

export function checkHeartbeat(m) {
  if (m?.t !== "hb") return "t must be hb";
  const b = checkBinding(m);
  if (b) return b;
  if (!(Number.isInteger(m.hbSeq) && m.hbSeq >= 1)) return "hbSeq must be an integer >= 1";
  if (!isIso(m.ts)) return "ts must be ISO 8601";
  if (!arrayOf(m.apps, () => true, 200)) return "apps[] required";
  for (const a of m.apps) { const e = checkAppStatus(a); if (e) return e; }
  if (m.warnings !== undefined && !arrayOf(m.warnings, (w) => WARNINGS.includes(w), 10)) return "unknown warning";
  return null;
}

export function checkLines(m) {
  if (m?.t !== "lines") return "t must be lines";
  const b = checkBinding(m);
  if (b) return b;
  if (!isStr(m.batchId)) return "batchId required";
  if (!Array.isArray(m.lines)) return "lines[] required";
  if (m.lines.length > LIMITS.maxBatchLines) return "TOO_LARGE";
  for (const l of m.lines) {
    if (!(Number.isInteger(l?.seq) && l.seq >= 1 && isIso(l.ts) && isStr(l.regId) && isStr(l.appId) && STREAMS.includes(l.stream)
      && isStr(l.source) && typeof l.line === "string" && typeof l.truncated === "boolean" && typeof l.redacted === "boolean"))
      return "invalid ConsoleLine";
  }
  return null;
}

// §6 redaction set. The front door applies it again as a safety net for a missed agent update.
// Order (§6): redact the full line first, then cut it to 4 KiB.
const REDACTIONS = [
  /Endpoint=sb:\/\/[^;\s]*;SharedAccessKey(Name)?=[^;\s]*(;SharedAccessKey=[^;\s]*)?/gi,
  /AccountKey=[^;\s]+/gi,
  /SharedAccessSignature=[^;\s]+/gi,
  /sig=[^&\s]+/gi,
  /DefaultEndpointsProtocol=[^\s]+/gi,
  /Bearer\s+[A-Za-z0-9\-_.]+/gi,
  /eyJ[\w-]+\.[\w-]+\.[\w-]+/g,
  /Password=[^;]+/gi,
  /pwd=[^;&\s]*/gi,
  /client_secret=[^&;\s]*/gi,
  /x-dsp-box-key:\s*\S+/gi,
  /InstrumentationKey=[0-9a-f-]{36}/gi,
  /[?&]code=[^&\s]+/gi,
  /x-functions-key:\s*\S+/gi,
  /Authorization:\s*Basic\s+\S+/gi,
  /"(password|secret|apiKey|clientSecret|connectionString)"\s*:\s*"[^"]*"/gi,
  /(api[_-]?key|token)=[^&;\s]+/gi,
];

/** Redacts, then truncates to maxLineBytes (UTF-8). Keeps the agent's own flags if already set. */
export function sanitizeLine(l) {
  let text = l.line;
  let redacted = l.redacted;
  for (const re of REDACTIONS) {
    re.lastIndex = 0;
    if (re.test(text)) {
      re.lastIndex = 0;
      text = text.replace(re, "***");
      redacted = true;
    }
  }
  let truncated = l.truncated;
  if (Buffer.byteLength(text, "utf8") > LIMITS.maxLineBytes) {
    text = Buffer.from(text, "utf8").subarray(0, LIMITS.maxLineBytes).toString("utf8").replace(/�$/, "");
    truncated = true;
  }
  return { ...l, line: text, redacted, truncated };
}
