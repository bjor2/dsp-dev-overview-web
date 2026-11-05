// ADDENDA-010 v1.3 §3–§5 front-door state: agents and their (several) sessions, last AppStatus per appKey, console rings.
// In memory only (§5).
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { LIMITS, UNKNOWN_REGISTRATION_LABEL, appKey, sanitizeLine } from "./protocol.js";

/** v1.2.2 §9 #25: when this front-door process started (ISO-8601 UTC). rseq and all agent state restart with it. */
export const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();

/**
 * @param {{ now?: () => number, limits?: Partial<typeof LIMITS>, registrations?: Map<string, string>, startedAt?: string }} opts
 *   registrations: regId → sha256 of the checked-in registration bundled with the front door.
 *   startedAt: overrides frontDoorStartedAt (tests); defaults to the process start.
 */
export function createAgentState(opts = {}) {
  const now = opts.now ?? Date.now;
  const L = { ...LIMITS, ...opts.limits };
  const serverRegs = opts.registrations ?? new Map();
  const frontDoorStartedAt = opts.startedAt ?? PROCESS_STARTED_AT;
  const events = new EventEmitter();
  events.setMaxListeners(100);

  /**
   * v1.3 §W.5: several sessions per agentId (one per dspwatch process, plus an optional dsp-agent).
   * sessionId → { sessionId, agentId, oid, connectedVia, wsOpen, closedAt, lastHeartbeat, lastActivity, lastHbSeq,
   *               inherit: Map<appKey, sessionId>, superseded, warnings, apps: Map<appKey, AppStatus & { lastSeen, agentId }> }
   */
  const sessions = new Map();
  /** agentId → { agentId, host, version, registrations, connectedVia, lastHeartbeat, warnings } (latest hello / hb of any session) */
  const agents = new Map();
  /** appKey → the freshest AppStatus & { lastSeen, agentId } from any session; kept after its session is gone (§4 last state). */
  const lastApps = new Map();
  /** appKey → { agentId, lastSession, lines: (ConsoleLine & { rseq, bytes })[], bytes, rseq, droppedBefore, ackedSeq } */
  const rings = new Map();
  let globalBytes = 0;
  const batchTimes = new Map(); // sessionId → recent batch timestamps (rate limit)

  const ring = (key) => {
    let r = rings.get(key);
    if (!r) rings.set(key, (r = { agentId: null, lastSession: null, lines: [], bytes: 0, rseq: 0, droppedBefore: undefined, ackedSeq: 0 }));
    return r;
  };
  const lineBytes = (l) => Buffer.byteLength(l.line, "utf8") + 128;
  const dropOldest = (r) => {
    const gone = r.lines.shift();
    r.bytes -= gone.bytes;
    globalBytes -= gone.bytes;
    r.droppedBefore = r.lines.length ? r.lines[0].rseq : gone.rseq + 1;
  };

  /** Forgets superseded sessions and sessions idle for longer than sessionIdleSec. The agent entry and lastApps stay. */
  function sweep() {
    const t = now();
    for (const [id, s] of sessions)
      if (s.superseded || t - s.lastActivity > L.sessionIdleSec * 1000) {
        sessions.delete(id);
        batchTimes.delete(id);
      }
  }

    /**
   * §3: every hello issues a new sessionId bound to (oid, agentId). A hello without resumeFrom is a new agent session.
   * v1.3: other sessions of the same agent stay valid. A hello with resumeFrom continues, per appKey it names, the latest
   * session of the same agentId and oid that claims that appKey as streaming (the wrapper reconnected): that predecessor
   * is retired (so the new claim hb isn't APP_BUSY) and seq de-duplication carries over from it. Without such a predecessor
   * the appKey starts afresh for the new session, so a stale ackedSeq of an earlier wrapper run never swallows new lines.
   */
  function hello(msg, via, oid) {
    sweep();
    const fresh = msg.resumeFrom === undefined;
    const sessionId = randomUUID();
    const registrations = msg.registrations.map((r) => {
      const known = serverRegs.get(r.id);
      return known === undefined
        ? { id: r.id, sha256: r.sha256, stale: true, unknown: true }
        : { id: r.id, sha256: r.sha256, stale: known !== r.sha256 };
    });
    /** appKey → predecessor sessionId whose ackedSeq this session continues */
    const inherit = new Map();
    const ackedSeq = {};
    for (const key of fresh ? [] : Object.keys(msg.resumeFrom)) {
      const claimants = [...sessions.values()]
        .filter((s) => s.agentId === msg.agentId && s.oid === oid && s.apps.get(key)?.console === "streaming")
        .sort((x, y) => y.lastActivity - x.lastActivity);
      if (!claimants.length) continue;
      for (const c of claimants) c.superseded = true;
      inherit.set(key, claimants[0].sessionId);
      const r = rings.get(key);
      if (r && r.lastSession === claimants[0].sessionId) ackedSeq[key] = r.ackedSeq;
    }
    sweep();
    const prev = agents.get(msg.agentId);
    agents.set(msg.agentId, {
      agentId: msg.agentId, host: msg.host, version: msg.agentVersion, registrations,
      connectedVia: via, lastHeartbeat: prev?.lastHeartbeat ?? null, warnings: prev?.warnings ?? [],
    });
    sessions.set(sessionId, {
      sessionId, agentId: msg.agentId, oid, connectedVia: via, wsOpen: via === "ws", closedAt: null, lastHeartbeat: null,
      lastActivity: now(), lastHbSeq: 0, inherit, superseded: false, warnings: [], apps: new Map(),
    });
    events.emit("status");
    return {
      t: "welcome", sessionId, heartbeatSec: L.heartbeatSec, maxBatchLines: L.maxBatchLines, maxBatchBytes: L.maxBatchBytes,
      registrations, ackedSeq,
    };
  }

  /** §3 session binding: the message's sessionId must be a live session of its agentId, bound to the token oid. */
  function session(msg, oid) {
    const s = sessions.get(msg.sessionId);
    if (!s || s.superseded || s.agentId !== msg.agentId || s.oid !== oid) return null;
    return s;
  }

  /**
   * v1.3 §3 / §W.5 APP_BUSY: another online session (of any agent) is streaming one of the appKeys this message claims.
   * An hb claims the apps it reports with console "streaming"; a lines batch claims every appKey it carries.
   * An hb that only reports an app as idle (e.g. dsp-agent detection) claims nothing and is accepted.
   * Returns the APP_BUSY message, or null.
   */
  function appBusy(msg) {
    const keys = msg.t === "hb"
      ? msg.apps.filter((a) => a.console === "streaming").map((a) => appKey(a.regId, a.appId))
      : msg.lines.map((l) => appKey(l.regId, l.appId));
    for (const key of new Set(keys))
      for (const s of sessions.values()) {
        if (s.sessionId === msg.sessionId || s.superseded || presence(s) !== "online") continue;
        if (s.apps.get(key)?.console === "streaming")
          return `${key} is already streaming from another dspwatch (agent ${s.agentId}, session ${s.sessionId}); stop it first`;
      }
    return null;
  }

  /** Returns "ok", "dropped" (hbSeq not newer) or "session". Call appBusy first. */
  function heartbeat(msg, via, oid) {
    const s = session(msg, oid);
    if (!s) return "session";
    if (msg.hbSeq <= s.lastHbSeq) return "dropped";
    const t = now();
    s.lastHbSeq = msg.hbSeq;
    s.lastHeartbeat = t;
    s.lastActivity = t;
    s.connectedVia = via;
    s.warnings = msg.warnings ?? [];
    const a = agents.get(s.agentId);
    a.lastHeartbeat = t;
    a.connectedVia = via;
    a.warnings = s.warnings;
    let changed = false;
    for (const st of msg.apps) {
      const key = appKey(st.regId, st.appId);
      const prev = s.apps.get(key) ?? lastApps.get(key);
      const { lastSeen: _ls, agentId: _a, registrationUnknown: _u, label: _l, ...prevStatus } = prev ?? {};
      if (!prev || JSON.stringify(prevStatus) !== JSON.stringify(st)) changed = true;
      const entry = { ...st, lastSeen: new Date(t).toISOString(), agentId: s.agentId };
      // §3: statuses of a registration the front door doesn't have are accepted and labelled.
      if (!serverRegs.has(st.regId)) Object.assign(entry, { registrationUnknown: true, label: UNKNOWN_REGISTRATION_LABEL });
      s.apps.set(key, entry);
      lastApps.set(key, entry);
    }
    if (changed) events.emit("status");
    return "ok";
  }

  /** Rate check (§3: max 20 batches/s). v1.3: per session, so several dspwatch processes under one agentId don't share it. */
  function rateOk(sessionId) {
    const t = now();
    const recent = (batchTimes.get(sessionId) ?? []).filter((x) => t - x < 1000);
    recent.push(t);
    batchTimes.set(sessionId, recent);
    return recent.length <= L.maxBatchesPerSec;
  }

  const overSlowMark = () => globalBytes > L.globalBytes * L.slowAt;

  /** Stores a validated batch; de-duplicates on seq ≤ ackedSeq within the agent session; assigns rseq (§3). */
  function lines(msg) {
    const s = sessions.get(msg.sessionId);
    if (s) s.lastActivity = now();
    const touched = new Set();
    for (const raw of msg.lines) {
      const key = appKey(raw.regId, raw.appId);
      const r = ring(key);
      if (s && r.lastSession !== s.sessionId) {
        // First batch of this session for the appKey: de-duplication continues only from the session it resumed (hello);
        // otherwise the wrapper's seq restarted at 1.
        if (s.inherit.get(key) !== r.lastSession) r.ackedSeq = 0;
        r.lastSession = s.sessionId;
      }
      r.agentId = msg.agentId;
      touched.add(key);
      if (raw.seq <= r.ackedSeq) continue;
      r.ackedSeq = raw.seq;
      const l = sanitizeLine(raw);
      const stored = { ...l, rseq: ++r.rseq, bytes: lineBytes(l) };
      r.lines.push(stored);
      r.bytes += stored.bytes;
      globalBytes += stored.bytes;
      while (r.lines.length > L.ringLines || r.bytes > L.ringBytes) dropOldest(r);
      events.emit("line", key, publicLine(stored));
    }
    evictGlobal();
    const ackedSeq = {};
    for (const key of touched) ackedSeq[key] = rings.get(key).ackedSeq;
    return { t: "ack", batchId: msg.batchId, ackedSeq };
  }

  /** §5 global cap: evict from the appKey holding the oldest line first. */
  function evictGlobal() {
    while (globalBytes > L.globalBytes) {
      let oldest = null;
      for (const r of rings.values())
        if (r.lines.length && (!oldest || r.lines[0].ts < oldest.lines[0].ts)) oldest = r;
      if (!oldest) break;
      dropOldest(oldest);
    }
  }

  const publicLine = ({ bytes: _b, ...l }) => l;

  /** Presence of one session (§4 staleness). */
  function presence(s) {
    if (s.lastHeartbeat === null) return s.wsOpen ? "online" : "offline";
    const age = (now() - s.lastHeartbeat) / 1000;
    if (!s.wsOpen && s.closedAt !== null && s.closedAt >= s.lastHeartbeat) return "offline"; // socket closed, no HTTPS hb since
    if (age <= L.onlineSec) return "online";
    if (age <= L.staleSec) return "stale";
    return "offline";
  }

  const RANK = { online: 2, stale: 1, offline: 0 };

  function status() {
    sweep();
    const live = [...sessions.values()];
    const agentList = [...agents.values()].map((a) => {
      const own = live.filter((s) => s.agentId === a.agentId);
      // v1.3: the agent is online if any of its sessions is.
      const presences = own.map(presence);
      const best = presences.reduce((p, q) => (RANK[q] > RANK[p] ? q : p), "offline");
      const active = own.filter((_, i) => presences[i] !== "offline");
      const warnings = active.length ? [...new Set(active.flatMap((s) => s.warnings))] : a.warnings;
      const via = active.sort((x, y) => (y.lastHeartbeat ?? 0) - (x.lastHeartbeat ?? 0))[0]?.connectedVia ?? a.connectedVia;
      return {
        agentId: a.agentId, host: a.host, version: a.version, connectedVia: via,
        lastHeartbeat: a.lastHeartbeat === null ? null : new Date(a.lastHeartbeat).toISOString(),
        presence: best, registrations: a.registrations, warnings,
      };
    });
    // v1.3: union of apps across sessions; per appKey prefer an online session that is streaming it, else the freshest hb.
    const appList = [...lastApps].map(([key, freshest]) => {
      const streaming = live.find((s) => s.apps.get(key)?.console === "streaming" && presence(s) === "online");
      return streaming ? streaming.apps.get(key) : freshest;
    });
    // frontDoorStartedAt changes only when the front door restarts: readers then reset afterSeq / Last-Event-ID (rseq restarted).
    return { frontDoorStartedAt, agents: agentList, apps: appList };
  }

  /** §4: readers page by rseq (afterSeq / nextSeq are rseq values). */
  function consoleRead(key, afterSeq = 0, limit = 200) {
    const r = rings.get(key);
    if (!r) return { lines: [], nextSeq: afterSeq };
    const out = r.lines.filter((l) => l.rseq > afterSeq).slice(0, limit).map(publicLine);
    const res = { lines: out, nextSeq: out.length ? out[out.length - 1].rseq : Math.max(afterSeq, 0) };
    if (r.droppedBefore !== undefined && afterSeq < r.droppedBefore - 1) res.droppedBefore = r.droppedBefore;
    return res;
  }

  /**
   * The newest n lines of one appKey, oldest first. droppedBefore is set when the reader asked for more than the ring
   * still holds and lines were dropped (the window starts at the ring head).
   */
  function consoleTail(key, n) {
    const r = rings.get(key);
    if (!r || r.lines.length === 0) return { lines: [], nextSeq: 0 };
    const out = r.lines.slice(-n).map(publicLine);
    const res = { lines: out, nextSeq: out[out.length - 1].rseq };
    if (r.droppedBefore !== undefined && n > r.lines.length) res.droppedBefore = r.droppedBefore;
    return res;
  }

  function wsClosed(_agentId, sessionId) {
    const s = sessions.get(sessionId);
    if (s) {
      s.wsOpen = false;
      s.closedAt = now();
      events.emit("status");
    }
  }

  return {
    hello, session, appBusy, heartbeat, lines, rateOk, overSlowMark, status, consoleRead, consoleTail, wsClosed, events,
    limits: L,
    get globalBytes() { return globalBytes; },
  };
}
