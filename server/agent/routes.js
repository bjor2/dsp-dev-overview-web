// ADDENDA-010 v1.3 §3–§4: /agent/ingest (WebSocket + HTTPS fallback, bearer only) and the browser reads
// (/agent/status, /agent/console, /agent/events), which sit behind the existing session gate in app.js.
import express from "express";
import { STATUS_CODES } from "node:http";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { createAgentAuth } from "./auth.js";
import { createAgentState } from "./state.js";
import { DETECT_ONLY_SESSION, WS_CLOSE_SESSION, checkHeartbeat, checkHello, checkLines } from "./protocol.js";

const err = (code, message) => ({ t: "error", code, message });

/** regId → sha256 of each checked-in registration file bundled with the front door (§3 registration hash). */
export function loadRegistrationHashes(dir, log) {
  const map = new Map();
  if (!dir || !fs.existsSync(dir)) {
    log?.warn?.(`[agent] no registrations at ${dir}: welcome.registrations[].stale is always false`);
    return map;
  }
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".json") && !n.includes("schema")).sort()) {
    const bytes = fs.readFileSync(path.join(dir, f));
    try {
      const id = JSON.parse(bytes.toString("utf8")).id;
      if (typeof id === "string") map.set(id, createHash("sha256").update(bytes).digest("hex"));
    } catch { log?.warn?.(`[agent] skipping unreadable registration ${f}`); }
  }
  return map;
}

export function createAgentIngest(env, deps = {}) {
  const log = deps.log ?? console;
  const auth = createAgentAuth(env, deps);
  const state = deps.state ?? createAgentState({
    now: deps.now,
    limits: deps.limits,
    startedAt: deps.startedAt,
    registrations: deps.registrations ?? loadRegistrationHashes(env.AGENT_REGISTRATIONS_DIR || deps.defaultRegistrationsDir, log),
  });
  const L = state.limits;
  if (!auth.cfg.configured) log.warn(`[agent] ingest auth not configured (missing: ${auth.cfg.missing.join(", ")}): /agent/ingest* returns 503`);

  const parse = (text) => { try { return JSON.parse(text); } catch { return undefined; } };

  // ---- HTTPS fallback: POST /agent/ingest/{hello,heartbeat,lines} ----------------------------------------------
  const ingest = express.Router();
  ingest.use(async (req, res, next) => {
    const r = await auth.verify(req.headers);
    if (!r.ok) return res.status(r.status).json(err(r.code, r.message));
    req.agentClaims = r.claims;
    next();
  });
  ingest.use(express.raw({ type: () => true, limit: L.maxBatchBytes }));
  ingest.use((req, res, next) => {
    if (req.method !== "POST") return res.status(405).json(err("BAD_MSG", "POST only (WebSocket: GET with Upgrade)"));
    const body = Buffer.isBuffer(req.body) ? parse(req.body.toString("utf8")) : undefined;
    if (body === undefined) return res.status(400).json(err("BAD_MSG", "JSON body required"));
    req.msg = body;
    next();
  });
  // §3: X-Agent-Id (all calls) and X-Agent-Session (hb, lines) must equal the body, else SESSION / 409.
  const headersMatch = (req, withSession) =>
    req.get("x-agent-id") === req.msg.agentId && (!withSession || req.get("x-agent-session") === req.msg.sessionId);
  const sessionError = (res, message) => res.status(409).json(err("SESSION", message));
  const DETECT_ONLY_MESSAGE = `sessionId '${DETECT_ONLY_SESSION}' comes from a detect-only run, not from welcome; send hello`;

  ingest.post("/hello", (req, res) => {
    const e = checkHello(req.msg);
    if (e) return res.status(400).json(err("BAD_MSG", e));
    if (!headersMatch(req, false)) return sessionError(res, "X-Agent-Id must equal hello.agentId");
    res.json(state.hello(req.msg, "https", req.agentClaims.oid));
  });
  ingest.post("/heartbeat", (req, res) => {
    const e = checkHeartbeat(req.msg);
    if (e) return res.status(400).json(err("BAD_MSG", e));
    if (!headersMatch(req, true)) return sessionError(res, "X-Agent-Id / X-Agent-Session must equal the body");
    if (req.msg.sessionId === DETECT_ONLY_SESSION) return sessionError(res, DETECT_ONLY_MESSAGE);
    if (!state.session(req.msg, req.agentClaims.oid)) return sessionError(res, "unknown or mismatched session; send hello");
    const busy = state.appBusy(req.msg);
    if (busy) return res.status(409).json(err("APP_BUSY", busy));
    state.heartbeat(req.msg, "https", req.agentClaims.oid);
    res.status(204).end(); // also for a dropped (not newer) hbSeq
  });
  ingest.post("/lines", (req, res) => {
    const e0 = req.msg?.t === "lines" && typeof req.msg.agentId === "string" ? null : "lines with agentId required";
    if (e0) return res.status(400).json(err("BAD_MSG", e0));
    if (!headersMatch(req, true)) return sessionError(res, "X-Agent-Id / X-Agent-Session must equal the body");
    if (req.msg.sessionId === DETECT_ONLY_SESSION) return sessionError(res, DETECT_ONLY_MESSAGE);
    const a = state.session(req.msg, req.agentClaims.oid);
    if (!a) return sessionError(res, "unknown or mismatched session; send hello");
    if (!state.rateOk(a.sessionId)) return res.status(429).set("Retry-After", "1").json(err("RATE", `max ${L.maxBatchesPerSec} batches/s`));
    if (state.overSlowMark()) {
      const ms = L.slowRetryAfterMs;
      return res.status(429).set("Retry-After", String(Math.ceil(ms / 1000))).json({ t: "slow", retryAfterMs: ms });
    }
    const e = checkLines(req.msg);
    if (e === "TOO_LARGE") return res.status(413).json(err("TOO_LARGE", `max ${L.maxBatchLines} lines or ${L.maxBatchBytes} bytes`));
    if (e) return res.status(400).json(err("BAD_MSG", e));
    const busy = state.appBusy(req.msg);
    if (busy) return res.status(409).json(err("APP_BUSY", busy)); // v1.3: lines for an appKey another session streams are not accepted
    res.json(state.lines(req.msg));
  });
  ingest.use((req, res) => res.status(404).json(err("BAD_MSG", "unknown ingest endpoint")));
  // eslint-disable-next-line no-unused-vars
  ingest.use((e, _req, res, _next) => e.type === "entity.too.large"
    ? res.status(413).json(err("TOO_LARGE", `max ${L.maxBatchBytes} bytes`))
    : res.status(400).json(err("BAD_MSG", "unreadable body")));

  // ---- WebSocket /agent/ingest ---------------------------------------------------------------------------------
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * L.maxBatchBytes });

  function onConnection(ws, claims) {
    let agentId = null;
    let sessionId = null;
    const send = (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
    const fail = (code, message, closeCode = 1008) => { send(err(code, message)); ws.close(closeCode, code); };
    // v1.2.1: no valid hello within 30 s, or 3 SESSION errors in a row → close 4409.
    const helloTimeoutMs = deps.helloTimeoutMs ?? L.helloTimeoutMs;
    const helloTimer = setTimeout(() => !agentId && fail("SESSION", `no valid hello within ${helloTimeoutMs / 1000} s`, WS_CLOSE_SESSION), helloTimeoutMs);
    let sessionErrors = 0;
    const sessionError = (message) => {
      if (++sessionErrors >= L.sessionErrorsBeforeClose) return fail("SESSION", `${message} (${sessionErrors} in a row, closing)`, WS_CLOSE_SESSION);
      send(err("SESSION", message));
    };
    // §3: re-authenticate by reconnecting; when the token expires the socket closes with 4401.
    const expMs = Number(claims.exp) * 1000 - Date.now();
    const expTimer = setTimeout(() => fail("AUTH", "token expired", 4401), Math.max(0, Math.min(expMs, 2 ** 31 - 1)));

    ws.on("message", (data, isBinary) => {
      if (isBinary) return fail("BAD_MSG", "text frames only");
      if (data.length > L.maxBatchBytes) return fail("TOO_LARGE", `max ${L.maxBatchBytes} bytes (UTF-8 JSON)`, 1009);
      const msg = parse(data.toString("utf8"));
      if (!msg) return fail("BAD_MSG", "invalid JSON");
      if (msg.t === "hello") {
        const e = checkHello(msg);
        if (e) return fail("BAD_MSG", e);
        const welcome = state.hello(msg, "ws", claims.oid);
        agentId = msg.agentId;
        sessionId = welcome.sessionId;
        sessionErrors = 0;
        clearTimeout(helloTimer);
        return send(welcome);
      }
      if (!agentId) return fail("BAD_MSG", "hello first");
      // §3 session binding: hb/lines must name this socket's agent and session. SESSION keeps the socket open (the agent
      // re-sends hello) until the third in a row.
      const sessionOk = () => msg.agentId === agentId && msg.sessionId === sessionId && state.session(msg, claims.oid);
      const badSession = () => msg.sessionId === DETECT_ONLY_SESSION
        ? sessionError(`sessionId '${DETECT_ONLY_SESSION}' comes from a detect-only run, not from welcome; send hello`)
        : sessionError("unknown or mismatched session; send hello");
      if (msg.t === "hb") {
        const e = checkHeartbeat(msg);
        if (e) return fail("BAD_MSG", e);
        if (!sessionOk()) return badSession();
        sessionErrors = 0;
        // v1.3 §W.5: a claim (console "streaming") on an appKey another online session streams → APP_BUSY; the socket
        // stays open and the wrapper exits (before spawning its child when this was the claim hb).
        const busy = state.appBusy(msg);
        if (busy) return send(err("APP_BUSY", busy));
        state.heartbeat(msg, "ws", claims.oid);
        return;
      }
      if (msg.t === "lines") {
        if (!state.rateOk(sessionId)) return fail("RATE", `max ${L.maxBatchesPerSec} batches/s`);
        const e = checkLines(msg);
        if (e === "TOO_LARGE") return fail("TOO_LARGE", `max ${L.maxBatchLines} lines`);
        if (e) return fail("BAD_MSG", e);
        if (!sessionOk()) return badSession();
        sessionErrors = 0;
        const busy = state.appBusy(msg);
        if (busy) return send(err("APP_BUSY", busy));
        send(state.lines(msg));
        if (state.overSlowMark()) send({ t: "slow", retryAfterMs: L.slowRetryAfterMs });
        return;
      }
      fail("BAD_MSG", `unknown message type ${String(msg.t)}`);
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      clearTimeout(expTimer);
      if (agentId) state.wsClosed(agentId, sessionId);
    });
  }

  /** Handles HTTP upgrades on the existing server (index.js). Only /agent/ingest is upgraded. */
  function attach(server) {
    server.on("upgrade", async (req, socket, head) => {
      if (new URL(req.url, "http://localhost").pathname !== "/agent/ingest") return socket.destroy();
      const r = await auth.verify(req.headers);
      if (!r.ok) {
        const body = JSON.stringify(err(r.code, r.message));
        socket.end(`HTTP/1.1 ${r.status} ${STATUS_CODES[r.status]}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, r.claims));
    });
  }

  // ---- Browser reads (session-gated in app.js) ----------------------------------------------------------------
  const reads = express.Router();
  reads.get("/status", (_req, res) => res.json(state.status()));
  const badRequest = (res, message) => res.status(400).json({ error: { code: "BAD_REQUEST", message, retryable: false } });
  /** ?last=N: positive integer, clamped to the per-appKey ring size (5,000). Returns null (absent) or a number, or sends 400. */
  const parseLast = (req, res) => {
    if (req.query.last === undefined) return null;
    const raw = String(req.query.last);
    if (!/^\d+$/.test(raw) || Number(raw) < 1) { badRequest(res, "last must be a positive integer"); return undefined; }
    return Math.min(Number(raw), L.ringLines);
  };

  reads.get("/console", (req, res) => {
    const { regId, appId } = req.query;
    if (typeof regId !== "string" || typeof appId !== "string" || !regId || !appId) return badRequest(res, "regId and appId required");
    const last = parseLast(req, res);
    if (last === undefined) return;
    if (last !== null) {
      // last=N is its own mode: combining it with afterSeq or limit is ambiguous, so it is rejected.
      if (req.query.afterSeq !== undefined || req.query.limit !== undefined) return badRequest(res, "last cannot be combined with afterSeq or limit");
      return res.json(state.consoleTail(`${regId}/${appId}`, last));
    }
    const afterSeq = Math.max(0, Number.parseInt(String(req.query.afterSeq ?? "0"), 10) || 0);
    const limit = Math.min(1000, Math.max(1, Number.parseInt(String(req.query.limit ?? "200"), 10) || 200));
    res.json(state.consoleRead(`${regId}/${appId}`, afterSeq, limit));
  });
  reads.get("/events", (req, res) => {
    const filterKey = typeof req.query.regId === "string" && typeof req.query.appId === "string" ? `${req.query.regId}/${req.query.appId}` : null;
    const last = parseLast(req, res);
    if (last === undefined) return;
    if (last !== null && !filterKey) return badRequest(res, "last requires regId and appId");
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const write = (event, data, id) => res.write(`${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    write("status", state.status());

    // Resume: Last-Event-ID = <appKey>:<rseq>. appKeys contain ':' (app:api), so split on the last one.
    // ?last=N is ignored when Last-Event-ID is present: EventSource reconnects with the same URL, so the resume point wins.
    const lastEventId = req.get("last-event-id");
    const sep = lastEventId ? lastEventId.lastIndexOf(":") : -1;
    if (sep < 0 && last !== null) {
      const tail = state.consoleTail(filterKey, last);
      for (const l of tail.lines) write("lines", { lines: [l], ...(tail.droppedBefore ? { droppedBefore: tail.droppedBefore } : {}) }, `${filterKey}:${l.rseq}`);
    }
    if (sep > 0) {
      const key = lastEventId.slice(0, sep);
      const seq = Number.parseInt(lastEventId.slice(sep + 1), 10);
      if ((!filterKey || filterKey === key) && Number.isInteger(seq)) {
        const replay = state.consoleRead(key, seq, 1000);
        for (const l of replay.lines) write("lines", { lines: [l], ...(replay.droppedBefore ? { droppedBefore: replay.droppedBefore } : {}) }, `${key}:${l.rseq}`);
      }
    }

    const onStatus = () => write("status", state.status());
    const onLine = (key, l) => { if (!filterKey || filterKey === key) write("lines", { lines: [l] }, `${key}:${l.rseq}`); };
    state.events.on("status", onStatus);
    state.events.on("line", onLine);
    const tick = setInterval(onStatus, (deps.statusEverySec ?? 10) * 1000);
    req.on("close", () => {
      clearInterval(tick);
      state.events.off("status", onStatus);
      state.events.off("line", onLine);
    });
  });

  return { ingest, reads, attach, state, auth, wss };
}
