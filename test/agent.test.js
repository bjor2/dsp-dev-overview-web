// ADDENDA-010 v1.3 §3–§6: agent ingest (WS + HTTPS fallback), browser reads, buffers, bearer auth.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import WebSocket from "ws";
import { createApp } from "../server/app.js";
import { PROCESS_STARTED_AT, createAgentState } from "../server/agent/state.js";
import { LIMITS, checkHeartbeat, checkHello, checkLines, sanitizeLine } from "../server/agent/protocol.js";

const TID = "c3ac4169-9d99-4eb7-b72b-bfa11f13d825";
const WEB = "11111111-1111-1111-1111-111111111111"; // test value for the web app client id
const AGENT = "22222222-2222-2222-2222-222222222222"; // test value for the agent app client id
const OID = "33333333-3333-3333-3333-333333333333";
const OID2 = "66666666-6666-6666-6666-666666666666";
const EMAIL = "bjor.byrkjedal@osilion.no";
const ISS = `https://login.microsoftonline.com/${TID}/v2.0`;
const quiet = { info() {}, warn() {}, error() {} };
// From the .NET agent (dev-overview/agent, SIMULATED snapshots): hello + detect-only heartbeats (see the fixture's _source).
const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/agent-ingest.v1.3.json", import.meta.url)));

// Locally generated test keys: nothing here comes from Entra.
const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const other = await generateKeyPair("RS256", { extractable: true });
const jwks = JSON.stringify({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" }] });

const agentEnv = {
  SESSION_SECRET: "s", ALLOWED_EMAILS: EMAIL, API_UPSTREAM_MODE: "render", RENDER_API_UPSTREAM: "http://127.0.0.1:1",
  AZURE_AD_TENANT_ID: TID, AZURE_AD_CLIENT_ID: WEB, AGENT_CLIENT_ID: AGENT, AGENT_JWKS_JSON: jwks, ALLOWED_OIDS: `${OID},${OID2}`,
};

async function mint(over = {}, key = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: ISS, aud: WEB, tid: TID, scp: "Agent.Ingest", azp: AGENT, oid: OID, preferred_username: EMAIL,
    iat: now, nbf: now - 10, exp: now + 3600, ...over };
  return new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: "k1" }).sign(key);
}

async function serve(env = agentEnv, deps = {}) {
  const app = createApp(env, { log: quiet, ...deps, agent: { log: quiet, ...deps.agent } });
  const server = app.listen(0);
  app.locals.attachAgentIngest(server);
  await new Promise((ok) => server.once("listening", ok));
  const port = server.address().port;
  return {
    base: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}/agent/ingest`, agent: app.locals.agent,
    close: () => new Promise((ok) => { server.closeAllConnections(); app.locals.agent.wss.clients.forEach((c) => c.terminate()); server.close(ok); }),
  };
}

const AGENT_ID = fx.hello.agentId;
const hello = (over = {}) => ({ ...fx.hello, ...over });
const hb = (sessionId, hbSeq, base = fx.main) => ({ ...base, agentId: AGENT_ID, sessionId, hbSeq });
const line = (seq, over = {}) => ({ seq, ts: new Date(Date.now() + seq).toISOString(), regId: "price.dev", appId: "app:functions",
  stream: "stdout", source: "func", line: `line ${seq}`, truncated: false, redacted: false, ...over });
const batch = (sessionId, id, lines, agentId = AGENT_ID) => ({ t: "lines", agentId, sessionId, batchId: id, lines });
/** v1.3 §W.4: what dspwatch sends for its one appKey (claim hb while the child lives, final hb on exit). */
const wrapperApp = (over = {}) => ({ regId: "price.dev", appId: "app:functions", state: "running", pid: 4242, rootPid: 4242, ports: [],
  matchedBy: ["wrapper"], console: "streaming", ...over });
const whb = (sessionId, hbSeq, app = wrapperApp(), agentId = AGENT_ID) => ({ t: "hb", agentId, sessionId, hbSeq, ts: new Date().toISOString(), apps: [app] });

/** POST with the §3 X-Agent-Id / X-Agent-Session headers taken from the body (override via headers). */
async function post(base, path, body, token, headers = {}) {
  const agentHeaders = typeof body === "object" && body
    ? { ...(body.agentId ? { "x-agent-id": body.agentId } : {}), ...(body.sessionId ? { "x-agent-session": body.sessionId } : {}) } : {};
  const r = await fetch(`${base}/agent/ingest/${path}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...agentHeaders, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  const text = await r.text();
  return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : null };
}

/** HTTPS hello; returns the sessionId. */
async function open(base, token, over = {}) {
  const r = await post(base, "hello", hello(over), token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.sessionId;
}

/** Opens a WS; resolves { ws, send, next, closed } or rejects with { status } on a refused upgrade. */
function connect(url, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const queue = [], waiters = [];
    ws.on("message", (d) => { const m = JSON.parse(d.toString()); waiters.length ? waiters.shift()(m) : queue.push(m); });
    const closed = new Promise((ok) => ws.on("close", (code) => ok(code)));
    ws.on("unexpected-response", (_req, res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => reject({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    ws.on("error", (e) => reject(e));
    ws.on("open", () => resolve({
      ws, closed,
      send: (m) => ws.send(JSON.stringify(m)),
      next: () => new Promise((ok, fail) => { if (queue.length) return ok(queue.shift()); waiters.push(ok); setTimeout(() => fail(new Error("no message")), 2000); }),
    }));
  });
}

/** Minimal SSE reader over fetch. */
async function sse(url, headers = {}) {
  const ctrl = new AbortController();
  const res = await fetch(url, { headers, signal: ctrl.signal });
  const reader = res.body.getReader();
  let buf = "";
  const events = [];
  async function next(pred = () => true) {
    const deadline = Date.now() + 2000;
    for (;;) {
      const i = events.findIndex(pred);
      if (i >= 0) return events.splice(i, 1)[0];
      if (Date.now() > deadline) throw new Error("no matching SSE event");
      const { value, done } = await reader.read();
      if (done) throw new Error("SSE closed");
      buf += new TextDecoder().decode(value);
      let k;
      while ((k = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, k); buf = buf.slice(k + 2);
        const ev = { id: null, event: "message", data: "" };
        for (const l of raw.split("\n")) {
          const [f, ...rest] = l.split(": ");
          if (f === "id") ev.id = rest.join(": "); else if (f === "event") ev.event = rest.join(": "); else if (f === "data") ev.data += rest.join(": ");
        }
        ev.json = ev.data ? JSON.parse(ev.data) : null;
        events.push(ev);
      }
    }
  }
  return { res, next, close: () => ctrl.abort() };
}

// ---- §6 auth ---------------------------------------------------------------------------------------------------

test("v1.2 item 14: not configured → 503 NOT_CONFIGURED on HTTPS and on the WS upgrade", async () => {
  for (const env of [
    { SESSION_SECRET: "s", ALLOWED_EMAILS: EMAIL }, // nothing configured
    { ...agentEnv, ALLOWED_OIDS: "" },               // ALLOWED_OIDS is required on the bearer path
    { ...agentEnv, AGENT_CLIENT_ID: "" },
  ]) {
    const s = await serve(env);
    try {
      const r = await post(s.base, "hello", hello(), await mint());
      assert.deepEqual([r.status, r.body.code], [503, "NOT_CONFIGURED"]);
      await assert.rejects(connect(s.ws, { authorization: `Bearer ${await mint()}` }), (e) => e.status === 503 && e.body.code === "NOT_CONFIGURED");
    } finally { await s.close(); }
  }
});

test("valid locally signed token is accepted (aud = client id or api:// URI; azp or appid)", async () => {
  const s = await serve();
  try {
    for (const token of [await mint(), await mint({ aud: `api://${WEB}` }), await mint({ azp: undefined, appid: AGENT }), await mint({ exp: Math.floor(Date.now() / 1000) - 60 })]) {
      const r = await post(s.base, "hello", hello(), token);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.t, "welcome");
    }
  } finally { await s.close(); }
});

test("bad issuer / audience / tenant / scope / azp / expired / not yet valid / signature are 401; oid or email not allowed are 403", async () => {
  const now = Math.floor(Date.now() / 1000);
  const cases = [
    ["issuer", await mint({ iss: "https://login.microsoftonline.com/other/v2.0" }), 401],
    ["audience", await mint({ aud: "api://someone-else" }), 401],
    ["tenant", await mint({ tid: "00000000-0000-0000-0000-000000000000" }), 401],
    ["scope", await mint({ scp: "User.Read" }), 401],
    ["azp", await mint({ azp: "44444444-4444-4444-4444-444444444444" }), 401],
    ["expired beyond 2 min skew", await mint({ exp: now - 300 }), 401],
    ["nbf in the future", await mint({ nbf: now + 300 }), 401],
    ["signature", await mint({}, other.privateKey), 401],
    ["alg none", `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ iss: ISS, aud: WEB })).toString("base64url")}.`, 401],
    ["oid", await mint({ oid: "55555555-5555-5555-5555-555555555555" }), 403],
    ["email", await mint({ preferred_username: "someone@else.test" }), 403],
  ];
  const s = await serve();
  try {
    for (const [name, token, status] of cases) {
      const r = await post(s.base, "hello", hello(), token);
      assert.equal(r.status, status, `${name}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, status === 403 ? "FORBIDDEN" : "AUTH", name);
      await assert.rejects(connect(s.ws, { authorization: `Bearer ${token}` }), (e) => e.status === status, name);
    }
    assert.equal((await post(s.base, "hello", hello(), null)).status, 401); // no token at all
  } finally { await s.close(); }
});

test("a cookie is never accepted on /agent/ingest (alone or next to a valid bearer)", async () => {
  const s = await serve();
  try {
    assert.equal((await post(s.base, "hello", hello(), null, { cookie: "dsp.sid=x; dsp.sid.sig=y" })).status, 401);
    const both = await post(s.base, "hello", hello(), await mint(), { cookie: "dsp.sid=x" });
    assert.equal(both.status, 401);
    assert.match(both.body.message, /cookie/);
    await assert.rejects(connect(s.ws, { authorization: `Bearer ${await mint()}`, cookie: "dsp.sid=x" }), (e) => e.status === 401);
  } finally { await s.close(); }
});

test("browser reads: 401 without session, 403 for non-allowlisted email or empty allowlist, 200 for an allowed session", async () => {
  const paths = ["/agent/status", "/agent/console?regId=price.dev&appId=app:functions", "/agent/events"];
  const anon = await serve();
  try {
    for (const p of paths) {
      const r = await fetch(anon.base + p, { redirect: "manual" });
      assert.equal(r.status, 401, p);
      assert.deepEqual(await r.json(), { error: "UNAUTHENTICATED" });
    }
    // A valid agent bearer token does not open the browser reads either.
    assert.equal((await fetch(anon.base + "/agent/status", { headers: { authorization: `Bearer ${await mint()}` } })).status, 401);
  } finally { await anon.close(); }
  const wrong = await serve(agentEnv, { testUser: { email: "someone@else.test" } });
  try { for (const p of paths) assert.equal((await fetch(wrong.base + p)).status, 403, p); } finally { await wrong.close(); }
  const noList = await serve({ ...agentEnv, ALLOWED_EMAILS: "" }, { testUser: { email: EMAIL } });
  try { for (const p of paths) assert.equal((await fetch(noList.base + p)).status, 403, p); } finally { await noList.close(); }
  const ok = await serve(agentEnv, { testUser: { email: EMAIL } });
  try {
    assert.equal((await fetch(ok.base + "/agent/status")).status, 200);
    assert.equal((await fetch(ok.base + "/agent/console")).status, 400); // regId/appId required
  } finally { await ok.close(); }
});

// ---- §3 WebSocket flow ------------------------------------------------------------------------------------------

test("WS: hello → welcome, hb → status, lines → ack, resend de-duplicated, resume, close → offline", async () => {
  const s = await serve(agentEnv, { testUser: { email: EMAIL } });
  try {
    const auth = { authorization: `Bearer ${await mint()}` };
    const c = await connect(s.ws, auth);
    c.send(hb("x", 1));
    assert.deepEqual(await c.next(), { t: "error", code: "BAD_MSG", message: "hello first" });

    const c1 = await connect(s.ws, auth);
    c1.send(hello());
    const w = await c1.next();
    assert.equal(w.t, "welcome");
    assert.deepEqual([w.heartbeatSec, w.maxBatchLines, w.maxBatchBytes], [10, 500, 262144]);
    // The .NET agent's embedded registrations match the copies bundled with the front door.
    assert.deepEqual(w.registrations.map((r) => [r.id, r.stale]), [["customerproject.dev", false], ["price.dev", false]]);
    assert.deepEqual(w.ackedSeq, {});

    c1.send(hb(w.sessionId, 1));
    c1.send(whb(w.sessionId, 2)); // v1.3: the dspwatch claim for price.dev/app:functions
    c1.send(batch(w.sessionId, "b-1", [line(1), line(2)]));
    assert.deepEqual(await c1.next(), { t: "ack", batchId: "b-1", ackedSeq: { "price.dev/app:functions": 2 } });
    c1.send(batch(w.sessionId, "b-2", [line(2), line(3)])); // seq 2 again: de-duplicated (§3)
    assert.deepEqual((await c1.next()).ackedSeq, { "price.dev/app:functions": 3 });

    const st = await (await fetch(`${s.base}/agent/status`)).json();
    assert.deepEqual(st.agents.map((a) => [a.agentId, a.connectedVia, a.presence]), [[AGENT_ID, "ws", "online"]]);
    assert.equal(st.apps.length, 7);
    const fn = st.apps.find((a) => a.regId === "price.dev" && a.appId === "app:functions");
    assert.deepEqual([fn.state, fn.console, fn.pid, fn.matchedBy], ["running", "streaming", 4242, ["wrapper"]]);
    assert.ok(fn.lastSeen);
    const con = await (await fetch(`${s.base}/agent/console?regId=price.dev&appId=app:functions`)).json();
    assert.deepEqual(con.lines.map((l) => [l.seq, l.rseq]), [[1, 1], [2, 2], [3, 3]]);
    assert.equal(con.nextSeq, 3);

    c1.ws.close();
    await c1.closed;
    await new Promise((ok) => setTimeout(ok, 20));
    assert.equal((await (await fetch(`${s.base}/agent/status`)).json()).agents[0].presence, "offline");

    // Reconnect with resumeFrom naming the appKey this session streamed: the front door returns what it acked.
    const c2 = await connect(s.ws, auth);
    c2.send(hello({ resumeFrom: { "price.dev/app:functions": 3 } }));
    assert.deepEqual((await c2.next()).ackedSeq, { "price.dev/app:functions": 3 });
  } finally { await s.close(); }
});

test("v1.2 item 12: hello without resumeFrom starts a new session; rseq keeps increasing for readers", async () => {
  const s = await serve(agentEnv, { testUser: { email: EMAIL } });
  try {
    const token = await mint();
    const s1 = await open(s.base, token);
    await post(s.base, "lines", batch(s1, "a", [line(1), line(2)]), token);
    const s2 = await open(s.base, token); // agent restart: its seq restarts at 1
    assert.notEqual(s1, s2);
    const ack = await post(s.base, "lines", batch(s2, "b", [line(1, { line: "after restart" })]), token);
    assert.deepEqual(ack.body.ackedSeq, { "price.dev/app:functions": 1 }); // not de-duplicated against the old session
    const after = await (await fetch(`${s.base}/agent/console?regId=price.dev&appId=app:functions&afterSeq=2`)).json();
    assert.deepEqual(after.lines.map((l) => [l.seq, l.rseq, l.line]), [[1, 3, "after restart"]]);
    assert.equal(after.nextSeq, 3);
  } finally { await s.close(); }
});

test("v1.2 item 10: session binding — headers must equal body, session must be current and bound to the token oid", async () => {
  const s = await serve();
  try {
    const token = await mint();
    const sid = await open(s.base, token);
    // Header mismatches → 409 SESSION.
    for (const headers of [{ "x-agent-id": "someone-else" }, { "x-agent-session": "other" }]) {
      const r = await post(s.base, "heartbeat", hb(sid, 1), token, headers);
      assert.deepEqual([r.status, r.body.code], [409, "SESSION"]);
    }
    const noHeader = await fetch(`${s.base}/agent/ingest/heartbeat`, { method: "POST", body: JSON.stringify(hb(sid, 1)), headers: { authorization: `Bearer ${token}` } });
    assert.equal(noHeader.status, 409);
    assert.equal((await post(s.base, "hello", hello(), token, { "x-agent-id": "nope" })).status, 409);
    // Unknown or superseded session → 409 SESSION. v1.3: a session is superseded by a resume hello naming an appKey it streams.
    assert.equal((await post(s.base, "heartbeat", hb("not-a-session", 1), token)).status, 409);
    assert.equal((await post(s.base, "heartbeat", whb(sid, 1), token)).status, 204);
    const sid2 = await open(s.base, token, { resumeFrom: { "price.dev/app:functions": 0 } });
    assert.equal((await post(s.base, "lines", batch(sid, "old", [line(1)]), token)).status, 409);
    // A valid session cannot be used with another user's token (bound to oid).
    assert.equal((await post(s.base, "heartbeat", hb(sid2, 1), await mint({ oid: OID2 }))).status, 409);
    assert.equal((await post(s.base, "heartbeat", hb(sid2, 1), token)).status, 204);

    // WS: SESSION error for a foreign session, socket stays open; the same socket then works with its own session.
    const c = await connect(s.ws, { authorization: `Bearer ${token}` });
    c.send(hello({ resumeFrom: {} }));
    const w = await c.next();
    c.send(batch("wrong", "x", [line(1)]));
    assert.equal((await c.next()).code, "SESSION");
    c.send(batch(w.sessionId, "y", [line(5)]));
    assert.equal((await c.next()).t, "ack");
  } finally { await s.close(); }
});

test("v1.2.1 item 5: sessionId 'detect-only' (dsp-agent --json output) is rejected on hb and lines with SESSION", async () => {
  const s = await serve();
  try {
    const token = await mint();
    await open(s.base, token);
    // The fixture is exactly what `dsp-agent --json` prints: sessionId "detect-only".
    assert.equal(fx.main.sessionId, "detect-only");
    const r = await post(s.base, "heartbeat", fx.main, token);
    assert.deepEqual([r.status, r.body.code], [409, "SESSION"]);
    assert.match(r.body.message, /detect-only/);
    const l = await post(s.base, "lines", batch("detect-only", "d", [line(1)]), token);
    assert.deepEqual([l.status, l.body.code], [409, "SESSION"]);

    const c = await connect(s.ws, { authorization: `Bearer ${token}` });
    c.send(hello({ resumeFrom: {} }));
    await c.next();
    c.send(fx.main);
    const e = await c.next();
    assert.equal(e.code, "SESSION");
    assert.match(e.message, /detect-only/);
  } finally { await s.close(); }
});

test("v1.2.1 item 7: WS closes with 4409 after 3 consecutive SESSION errors (a valid message resets the count)", async () => {
  assert.equal(LIMITS.sessionErrorsBeforeClose, 3);
  const s = await serve();
  try {
    const c = await connect(s.ws, { authorization: `Bearer ${await mint()}` });
    c.send(hello());
    const w = await c.next();
    c.send(hb("wrong", 1)); assert.equal((await c.next()).code, "SESSION");
    c.send(hb("wrong", 2)); assert.equal((await c.next()).code, "SESSION");
    c.send(batch(w.sessionId, "ok", [line(1)])); assert.equal((await c.next()).t, "ack"); // resets the count
    c.send(hb("wrong", 3)); assert.equal((await c.next()).code, "SESSION");
    c.send(hb("wrong", 4)); assert.equal((await c.next()).code, "SESSION");
    assert.equal(c.ws.readyState, WebSocket.OPEN);
    c.send(hb("wrong", 5));
    const last = await c.next();
    assert.equal(last.code, "SESSION");
    assert.match(last.message, /3 in a row/);
    assert.equal(await c.closed, 4409);
  } finally { await s.close(); }
});

test("v1.2.1 item 7: WS without a valid hello is closed with 4409 (30 s by default, injectable)", async () => {
  assert.equal(LIMITS.helloTimeoutMs, 30_000);
  const s = await serve(agentEnv, { agent: { helloTimeoutMs: 50 } });
  try {
    const c = await connect(s.ws, { authorization: `Bearer ${await mint()}` });
    const e = await c.next();
    assert.equal(e.code, "SESSION");
    assert.match(e.message, /no valid hello/);
    assert.equal(await c.closed, 4409);

    // A valid hello within the window keeps the socket open past the timeout.
    const ok = await connect(s.ws, { authorization: `Bearer ${await mint()}` });
    ok.send(hello());
    assert.equal((await ok.next()).t, "welcome");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(ok.ws.readyState, WebSocket.OPEN);
  } finally { await s.close(); }
});

test("v1.2 item 10: hbSeq not newer than the last one is dropped", async () => {
  const s = await serve(agentEnv, { testUser: { email: EMAIL } });
  try {
    const token = await mint();
    const sid = await open(s.base, token);
    assert.equal((await post(s.base, "heartbeat", hb(sid, 5, fx.main), token)).status, 204);
    assert.equal((await post(s.base, "heartbeat", hb(sid, 4, fx.wmiFailed), token)).status, 204); // older: dropped
    const st = await (await fetch(`${s.base}/agent/status`)).json();
    assert.equal(st.apps.find((a) => a.appId === "app:api" && a.regId === "customerproject.dev").state, "running");
    assert.equal((await post(s.base, "heartbeat", { ...hb(sid, 6), hbSeq: 0 }, token)).status, 400); // hbSeq starts at 1
  } finally { await s.close(); }
});

test("v1.2 item 15: unknown registration id → stale + unknown; its statuses are accepted and labelled", async () => {
  const s = await serve(agentEnv, { testUser: { email: EMAIL } });
  try {
    const token = await mint();
    const r = await post(s.base, "hello", hello({ registrations: [...fx.hello.registrations, { id: "orders.dev", sha256: "a".repeat(64) }] }), token);
    assert.deepEqual(r.body.registrations.find((x) => x.id === "orders.dev"), { id: "orders.dev", sha256: "a".repeat(64), stale: true, unknown: true });
    assert.equal(r.body.registrations.find((x) => x.id === "price.dev").unknown, undefined);
    const orders = { regId: "orders.dev", appId: "app:api", state: "running", ports: [], console: "idle" };
    await post(s.base, "heartbeat", { ...hb(r.body.sessionId, 1), apps: [...fx.main.apps, orders] }, token);
    const st = await (await fetch(`${s.base}/agent/status`)).json();
    const o = st.apps.find((a) => a.regId === "orders.dev");
    assert.deepEqual([o.state, o.registrationUnknown, o.label], ["running", true, "registration not deployed to front door"]);
    assert.equal(st.apps.find((a) => a.regId === "price.dev").label, undefined);
  } finally { await s.close(); }
});

test("WS: invalid messages, oversized batch and rate limit close the socket with an Err", async () => {
  const s = await serve(agentEnv, { agent: { limits: { maxBatchesPerSec: 2 } } });
  try {
    const auth = { authorization: `Bearer ${await mint()}` };
    const a = await connect(s.ws, auth);
    a.send(hello());
    const wa = await a.next();
    a.send(batch(wa.sessionId, "x", Array.from({ length: 501 }, (_, i) => line(i + 1))));
    assert.equal((await a.next()).code, "TOO_LARGE");
    assert.equal(await a.closed, 1008);

    const b = await connect(s.ws, auth);
    b.send(hello({ agentId: "pc-rate" })); // rate is counted per agentId
    const wb = await b.next();
    const rb = (id, n) => ({ ...batch(wb.sessionId, id, [line(n)]), agentId: "pc-rate" });
    b.send(rb("r1", 1)); await b.next();
    b.send(rb("r2", 2)); await b.next();
    b.send(rb("r3", 3));
    assert.equal((await b.next()).code, "RATE");
    assert.equal(await b.closed, 1008);

    const c = await connect(s.ws, auth);
    c.send({ t: "hello" });
    assert.equal((await c.next()).code, "BAD_MSG");
  } finally { await s.close(); }
});

test("WS: socket closes with 4401 when the token expires", async () => {
  const s = await serve();
  try {
    // exp 119 s in the past is still inside the 2 min skew, so the upgrade passes and the expiry timer fires at once.
    const c = await connect(s.ws, { authorization: `Bearer ${await mint({ exp: Math.floor(Date.now() / 1000) - 119 })}` });
    assert.equal((await c.next()).code, "AUTH");
    assert.equal(await c.closed, 4401);
  } finally { await s.close(); }
});

// ---- §3 HTTPS fallback ------------------------------------------------------------------------------------------

test("HTTPS fallback: hello → welcome, heartbeat → 204, lines → Ack", async () => {
  const s = await serve(agentEnv, { testUser: { email: EMAIL } });
  try {
    const token = await mint();
    const sid = await open(s.base, token);
    assert.equal((await post(s.base, "heartbeat", hb(sid, 1, fx.portsFailed), token)).status, 204);
    const ack = await post(s.base, "lines", batch(sid, "h-1", [line(1)]), token);
    assert.deepEqual(ack.body, { t: "ack", batchId: "h-1", ackedSeq: { "price.dev/app:functions": 1 } });
    const st = await (await fetch(`${s.base}/agent/status`)).json();
    assert.equal(st.agents[0].connectedVia, "https");
    assert.deepEqual(st.agents[0].warnings, ["PORT_TABLE_UNAVAILABLE"]);
    assert.deepEqual(st.apps.find((a) => a.appId === "app:api" && a.regId === "customerproject.dev").ports, [{ port: 5011, state: "unknown" }]);
    assert.equal((await post(s.base, "heartbeat", { ...hb(sid, 2), ts: "x" }, token)).status, 400);
    assert.equal((await post(s.base, "lines", "{not json", token)).status, 400);
  } finally { await s.close(); }
});

test("v1.2 item 13: 256 KiB is measured on the UTF-8 encoded JSON (HTTPS 413, WS TOO_LARGE)", async () => {
  const s = await serve();
  try {
    const token = await mint();
    const sid = await open(s.base, token);
    // 90,000 '€' = 90,000 UTF-16 chars (under 262,144) but 270,000 UTF-8 bytes (over).
    const big = batch(sid, "big", [line(1, { line: "€".repeat(90_000) })]);
    assert.ok(JSON.stringify(big).length < LIMITS.maxBatchBytes);
    assert.ok(Buffer.byteLength(JSON.stringify(big)) > LIMITS.maxBatchBytes);
    const r = await post(s.base, "lines", big, token);
    assert.deepEqual([r.status, r.body.code], [413, "TOO_LARGE"]);
    const ok = batch(sid, "ok", [line(1, { line: "€".repeat(80_000) })]); // 240,000 bytes: accepted, line cut to 4 KiB
    assert.equal((await post(s.base, "lines", ok, token)).status, 200);

    const c = await connect(s.ws, { authorization: `Bearer ${token}` });
    c.send(hello({ resumeFrom: {} }));
    const w = await c.next();
    c.send({ ...big, sessionId: w.sessionId });
    assert.equal((await c.next()).code, "TOO_LARGE");
    assert.equal(await c.closed, 1009);
  } finally { await s.close(); }
});

test("v1.2 item 11: backpressure only from the global buffer (> 80%) → HTTPS 429 + Retry-After, WS ack then slow", async () => {
  // A full per-appKey ring alone never triggers slow.
  const ringOnly = await serve(agentEnv, { agent: { limits: { ringLines: 2 } } });
  try {
    const token = await mint();
    const sid = await open(ringOnly.base, token);
    for (let i = 1; i <= 5; i++) assert.equal((await post(ringOnly.base, "lines", batch(sid, `r${i}`, [line(i)]), token)).status, 200);
  } finally { await ringOnly.close(); }

  const s = await serve(agentEnv, { agent: { limits: { globalBytes: 2000, ringBytes: 2000 } } });
  try {
    const token = await mint();
    const sid = await open(s.base, token);
    const first = await post(s.base, "lines", batch(sid, "p-1", [line(1, { line: "x".repeat(1500) })]), token);
    assert.equal(first.status, 200);
    const second = await post(s.base, "lines", batch(sid, "p-2", [line(2)]), token);
    assert.equal(second.status, 429);
    assert.equal(second.headers.get("retry-after"), "2");
    assert.deepEqual(second.body, { t: "slow", retryAfterMs: 2000 });

    const c = await connect(s.ws, { authorization: `Bearer ${token}` });
    c.send(hello({ resumeFrom: {} }));
    const w = await c.next();
    c.send(batch(w.sessionId, "w-1", [line(3)]));
    assert.equal((await c.next()).t, "ack");
    assert.deepEqual(await c.next(), { t: "slow", retryAfterMs: 2000 });
  } finally { await s.close(); }
});

test("HTTPS rate limit: more than maxBatchesPerSec → 429 RATE", async () => {
  const s = await serve(agentEnv, { agent: { limits: { maxBatchesPerSec: 2 } } });
  try {
    const token = await mint();
    const sid = await open(s.base, token);
    assert.equal((await post(s.base, "lines", batch(sid, "1", [line(1)]), token)).status, 200);
    assert.equal((await post(s.base, "lines", batch(sid, "2", [line(2)]), token)).status, 200);
    const r = await post(s.base, "lines", batch(sid, "3", [line(3)]), token);
    assert.deepEqual([r.status, r.body.code, r.headers.get("retry-after")], [429, "RATE", "1"]);
  } finally { await s.close(); }
  const s2 = await serve();
  try {
    const token = await mint();
    const sid = await open(s2.base, token);
    const r = await post(s2.base, "lines", batch(sid, "big", Array.from({ length: 501 }, (_, i) => line(i + 1))), token);
    assert.deepEqual([r.status, r.body.code], [413, "TOO_LARGE"]);
  } finally { await s2.close(); }
});

// ---- §4 SSE ----------------------------------------------------------------------------------------------------

test("SSE /agent/events: status on connect and on change, filtered lines with <appKey>:<rseq> ids, Last-Event-ID replay", async () => {
  const s = await serve(agentEnv, { testUser: { email: EMAIL } });
  try {
    const token = await mint();
    const all = await sse(`${s.base}/agent/events`);
    assert.equal(all.res.headers.get("content-type"), "text/event-stream");
    assert.equal((await all.next((e) => e.event === "status")).json.agents.length, 0);

    const filtered = await sse(`${s.base}/agent/events?regId=price.dev&appId=app:functions`);
    await filtered.next((e) => e.event === "status");

    const sid = await open(s.base, token);
    await post(s.base, "heartbeat", hb(sid, 1), token);
    const st = await all.next((e) => e.event === "status" && e.json.apps.length === 7);
    assert.equal(st.json.agents[0].presence, "online");

    await post(s.base, "lines", batch(sid, "s-1", [line(7, { appId: "app:api" }), line(7), line(8)]), token);
    const l1 = await filtered.next((e) => e.event === "lines");
    assert.deepEqual([l1.id, l1.json.lines[0].seq], ["price.dev/app:functions:1", 7]); // id uses rseq, not the agent seq
    const l2 = await filtered.next((e) => e.event === "lines");
    assert.equal(l2.id, "price.dev/app:functions:2");
    assert.ok(await all.next((e) => e.event === "lines" && e.id === "price.dev/app:api:1"));
    all.close(); filtered.close();

    const resumed = await sse(`${s.base}/agent/events?regId=price.dev&appId=app:functions`, { "last-event-id": "price.dev/app:functions:1" });
    await resumed.next((e) => e.event === "status");
    const replay = await resumed.next((e) => e.event === "lines");
    assert.deepEqual([replay.id, replay.json.lines[0].line], ["price.dev/app:functions:2", "line 8"]);
    resumed.close();
  } finally { await s.close(); }
});

test("console ?last=N: newest N lines of that app only, capped at the 5,000-line ring, exclusive with afterSeq/limit", async () => {
  const s = await serve(agentEnv, { testUser: { email: EMAIL } });
  try {
    const token = await mint();
    const sid = await open(s.base, token);
    await post(s.base, "lines", batch(sid, "a", [line(1), line(2), line(3), line(1, { appId: "app:api", line: "other app" })]), token);
    const get = (q) => fetch(`${s.base}/agent/console?regId=price.dev&appId=app:functions&${q}`);

    const two = await (await get("last=2")).json();
    assert.deepEqual(two.lines.map((l) => [l.rseq, l.line]), [[2, "line 2"], [3, "line 3"]]); // oldest first, this app only
    assert.equal(two.nextSeq, 3);                                                               // continue with afterSeq=3
    assert.equal(two.droppedBefore, undefined);
    assert.equal((await (await get("last=999999")).json()).lines.length, 3); // capped, not an error
    const empty = await (await fetch(`${s.base}/agent/console?regId=x.dev&appId=app:none&last=5`)).json();
    assert.deepEqual(empty, { lines: [], nextSeq: 0 });

    for (const q of ["last=2&afterSeq=1", "last=2&limit=10", "last=0", "last=-1", "last=abc", "last=1.5"]) {
      const r = await get(q);
      assert.equal(r.status, 400, q);
      assert.equal((await r.json()).error.code, "BAD_REQUEST", q);
    }
  } finally { await s.close(); }
});

test("console ?last=N reports droppedBefore when it asks for more than the ring still holds", () => {
  const st = createAgentState({ limits: { ringLines: 3 } });
  const { sessionId } = st.hello(hello(), "https", OID);
  const sent = [1, 2, 3, 4, 5].map((n) => line(n)); // build once: line() stamps ts from the clock
  st.lines(batch(sessionId, "a", sent));
  assert.deepEqual(st.consoleTail("price.dev/app:functions", 10), {
    lines: sent.slice(2).map((l, i) => ({ ...l, rseq: i + 3 })), nextSeq: 5, droppedBefore: 3 });
  assert.equal(st.consoleTail("price.dev/app:functions", 2).droppedBefore, undefined);
});

test("SSE ?last=N replays the newest N lines of the filtered app; ignored when Last-Event-ID is present; 400 without an app filter", async () => {
  const s = await serve(agentEnv, { testUser: { email: EMAIL } });
  try {
    const token = await mint();
    const sid = await open(s.base, token);
    await post(s.base, "lines", batch(sid, "a", [line(1), line(2), line(3), line(9, { appId: "app:api" })]), token);

    const tail = await sse(`${s.base}/agent/events?regId=price.dev&appId=app:functions&last=2`);
    await tail.next((e) => e.event === "status");
    assert.deepEqual([(await tail.next((e) => e.event === "lines")).id, (await tail.next((e) => e.event === "lines")).id],
      ["price.dev/app:functions:2", "price.dev/app:functions:3"]);
    await post(s.base, "lines", batch(sid, "b", [line(4)]), token); // live lines follow the replay
    assert.equal((await tail.next((e) => e.event === "lines")).id, "price.dev/app:functions:4");
    tail.close();

    // Reconnect: Last-Event-ID wins, last=2 is ignored (replay from rseq 3, not the newest 2).
    const resumed = await sse(`${s.base}/agent/events?regId=price.dev&appId=app:functions&last=2`, { "last-event-id": "price.dev/app:functions:2" });
    await resumed.next((e) => e.event === "status");
    assert.deepEqual([(await resumed.next((e) => e.event === "lines")).id, (await resumed.next((e) => e.event === "lines")).id],
      ["price.dev/app:functions:3", "price.dev/app:functions:4"]);
    resumed.close();

    assert.equal((await fetch(`${s.base}/agent/events?last=2`)).status, 400);
    assert.equal((await fetch(`${s.base}/agent/events?regId=price.dev&appId=app:functions&last=0`)).status, 400);
  } finally { await s.close(); }
});

test("v1.2.2 #25: /agent/status and SSE status carry frontDoorStartedAt (process start, ISO-8601 UTC); it changes only on restart", async () => {
  assert.match(PROCESS_STARTED_AT, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const processStart = Date.now() - process.uptime() * 1000;
  assert.ok(Math.abs(Date.parse(PROCESS_STARTED_AT) - processStart) < 2000, "set at process start, not at request time");

  const s = await serve(agentEnv, { testUser: { email: EMAIL } });
  try {
    const a = await (await fetch(`${s.base}/agent/status`)).json();
    await new Promise((r) => setTimeout(r, 20));
    const b = await (await fetch(`${s.base}/agent/status`)).json();
    assert.equal(a.frontDoorStartedAt, PROCESS_STARTED_AT);
    assert.equal(b.frontDoorStartedAt, a.frontDoorStartedAt); // stable while the process runs
    const ev = await sse(`${s.base}/agent/events`);
    assert.equal((await ev.next((e) => e.event === "status")).json.frontDoorStartedAt, PROCESS_STARTED_AT);
    ev.close();
  } finally { await s.close(); }

  // A restarted front door (new state, new start time) reports a different value: the reader's cue to reset its cursors.
  const restarted = await serve(agentEnv, { testUser: { email: EMAIL }, agent: { startedAt: "2026-11-04T18:00:00.000Z" } });
  try {
    assert.equal((await (await fetch(`${restarted.base}/agent/status`)).json()).frontDoorStartedAt, "2026-11-04T18:00:00.000Z");
  } finally { await restarted.close(); }
});

test("v1.2.2 #24: invalid or unparseable hello → BAD_MSG, then immediate close 1008", async () => {
  const s = await serve();
  try {
    const auth = { authorization: `Bearer ${await mint()}` };
    const invalid = await connect(s.ws, auth);
    invalid.send({ t: "hello", agentId: "pc" }); // missing agentVersion/host/registrations
    assert.equal((await invalid.next()).code, "BAD_MSG");
    assert.equal(await invalid.closed, 1008);

    const garbage = await connect(s.ws, auth);
    garbage.ws.send("{ not json");
    assert.equal((await garbage.next()).code, "BAD_MSG");
    assert.equal(await garbage.closed, 1008);
  } finally { await s.close(); }
});

// ---- §5 buffers, §6 redaction, §4 presence (state unit tests) --------------------------------------------------

function fresh(limits = {}, now = () => Date.now()) {
  const st = createAgentState({ limits, now });
  const { sessionId } = st.hello(hello(), "https", OID);
  return { st, sid: sessionId };
}

test("ring per appKey keeps the newest 5000 lines and reports droppedBefore (rseq)", () => {
  const { st, sid } = fresh();
  for (let i = 0; i < 11; i++)
    st.lines(batch(sid, `b${i}`, Array.from({ length: 500 }, (_, k) => line(i * 500 + k + 1))));
  const r = st.consoleRead("price.dev/app:functions", 0, 1000);
  assert.equal(r.lines[0].rseq, 501);
  assert.equal(r.droppedBefore, 501);
  assert.equal(st.consoleRead("price.dev/app:functions", 5400, 1000).lines.length, 100);
  assert.equal(st.consoleRead("price.dev/app:functions", 5400, 1000).droppedBefore, undefined);
  assert.equal(LIMITS.ringLines, 5000);
});

test("ring byte cap (2 MiB) and global cap (32 MiB) evict the oldest lines first", () => {
  assert.deepEqual([LIMITS.ringBytes, LIMITS.globalBytes], [2 * 1024 * 1024, 32 * 1024 * 1024]);
  const { st, sid } = fresh({ ringBytes: 10_000, globalBytes: 15_000 });
  const big = "y".repeat(3000);
  st.lines(batch(sid, "a", [1, 2, 3, 4].map((n) => line(n, { line: big }))));
  assert.deepEqual(st.consoleRead("price.dev/app:functions").lines.map((l) => l.rseq), [2, 3, 4]); // ring bytes
  st.lines(batch(sid, "b", [1, 2, 3].map((n) => line(n, { appId: "app:api", line: big, ts: new Date(Date.now() + 10_000 + n).toISOString() }))));
  assert.ok(st.globalBytes <= 15_000);
  assert.deepEqual(st.consoleRead("price.dev/app:functions").lines.map((l) => l.rseq), [4]); // oldest appKey tail went first
  assert.equal(st.consoleRead("price.dev/app:api").lines.length, 3);
});

test("front door redacts, then truncates to 4 KiB", () => {
  const r = sanitizeLine(line(1, { line: "conn Endpoint=sb://ns.servicebus.windows.net/;SharedAccessKeyName=k;SharedAccessKey=abc123 ok Bearer eyJabc.def.ghi" }));
  assert.equal(r.redacted, true);
  assert.doesNotMatch(r.line, /abc123|eyJabc/);
  for (const secret of ["AccountKey=zzz", "Password=hunter2", "x-functions-key: k", "?code=abc", '"clientSecret": "v"', "api_key=v", "InstrumentationKey=00000000-0000-0000-0000-000000000000"])
    assert.equal(sanitizeLine(line(1, { line: `a ${secret} b` })).redacted, true, secret);
  const long = sanitizeLine(line(1, { line: "z".repeat(5000) + " pwd=secret" }));
  assert.equal(Buffer.byteLength(long.line), 4096);
  assert.deepEqual([long.truncated, long.redacted], [true, true]); // redaction ran on the full line first
  assert.deepEqual(sanitizeLine(line(1)), line(1));
});

test("presence: online ≤ 15 s, stale ≤ 30 s, then offline; apps keep last state + lastSeen", () => {
  let t = 1_000_000;
  const st = createAgentState({ now: () => t });
  const { sessionId } = st.hello(hello(), "https", OID);
  assert.equal(st.heartbeat(hb(sessionId, 1), "https", OID), "ok");
  const p = () => st.status().agents[0].presence;
  assert.equal(p(), "online");
  t += 16_000; assert.equal(p(), "stale");
  t += 15_000; assert.equal(p(), "offline");
  const app = st.status().apps.find((a) => a.appId === "app:ingress" && a.regId === "customerproject.dev");
  assert.deepEqual([app.state, app.lastSeen], ["starting", new Date(1_000_000).toISOString()]);
});

// ---- contract with the .NET agent ---------------------------------------------------------------------------------

test("hello and heartbeats produced by dsp-agent (SIMULATED fixtures) validate against the v1.3 types", () => {
  assert.equal(checkHello(fx.hello), null);
  for (const k of ["main", "ambiguous", "portsFailed", "wmiFailed"]) assert.equal(checkHeartbeat(fx[k]), null, k);
  assert.ok(fx.main.apps.every((a) => Array.isArray(a.ports) && a.ports.every((p) => typeof p.port === "number" && typeof p.state === "string")));
  assert.ok(fx.portsFailed.apps.every((a) => a.ports.every((p) => p.state === "unknown") && a.listeningPorts === undefined));
  const amb = fx.ambiguous.apps.find((a) => a.appId === "app:api-batch");
  assert.deepEqual([amb.state, amb.ambiguousInstances, amb.ambiguousWith], ["ambiguous", 1, ["price.dev/app:functions"]]);
  assert.deepEqual(new Set(fx.main.apps.map((a) => a.state)), new Set(["running", "starting", "stopped"]));
  assert.match(checkHeartbeat({ ...fx.main, apps: [{ ...fx.main.apps[0], state: "up" }] }), /state/);
  assert.match(checkHeartbeat({ ...fx.main, apps: [{ ...fx.main.apps[0], ports: [5011] }] }), /AppStatus/);
  assert.match(checkHeartbeat({ ...fx.main, apps: [{ ...fx.main.apps[0], ambiguousWith: ["app:functions"] }] }), /AppStatus/);
  assert.match(checkHeartbeat({ ...fx.main, sessionId: undefined }), /sessionId/);
  assert.match(checkHeartbeat({ ...fx.main, warnings: ["NOPE"] }), /warning/);
});

// ---- v1.3: launch wrapper (dspwatch) --------------------------------------------------------------------------------

test("v1.3 #28/#29/#35: stream stdout|stderr (file rejected), console streaming|idle|error (tailing/unavailable rejected), matchedBy wrapper", () => {
  const lb = (l) => checkLines(batch("s", "b", [l]));
  assert.equal(lb(line(1)), null);
  assert.equal(lb(line(1, { stream: "stderr", source: "dotnet" })), null);
  for (const stream of ["file", "STDOUT", undefined]) assert.equal(lb(line(1, { stream })), "invalid ConsoleLine", String(stream));
  for (const console of ["streaming", "idle", "error"]) assert.equal(checkHeartbeat(whb("s", 1, wrapperApp({ console }))), null, console);
  for (const console of ["tailing", "unavailable", undefined]) assert.match(checkHeartbeat(whb("s", 1, wrapperApp({ console }))), /console/, String(console));
  assert.equal(checkHeartbeat(whb("s", 1, wrapperApp({ matchedBy: ["wrapper", "workingDir"] }))), null);
  assert.match(checkHeartbeat(whb("s", 1, wrapperApp({ matchedBy: ["tail"] }))), /AppStatus/);
});

test("v1.3 #33 APP_BUSY over HTTPS: a second session's claim hb or lines for a streaming appKey → 409, nothing stored", async () => {
  let t = Date.now();
  const s = await serve(agentEnv, { testUser: { email: EMAIL }, agent: { now: () => t } });
  try {
    const token = await mint();
    const a = await open(s.base, token);
    const b = await open(s.base, token); // same agentId: several sessions are allowed (#32)
    assert.equal((await post(s.base, "heartbeat", whb(a, 1), token)).status, 204);
    assert.equal((await post(s.base, "lines", batch(a, "a1", [line(1, { line: "from a" })]), token)).status, 200);

    const claim = await post(s.base, "heartbeat", whb(b, 1), token);
    assert.deepEqual([claim.status, claim.body.t, claim.body.code], [409, "error", "APP_BUSY"]);
    assert.match(claim.body.message, /price\.dev\/app:functions/);
    const lines = await post(s.base, "lines", batch(b, "b1", [line(1, { line: "from b" })]), token);
    assert.deepEqual([lines.status, lines.body.code], [409, "APP_BUSY"]);
    const con = await (await fetch(`${s.base}/agent/console?regId=price.dev&appId=app:functions`)).json();
    assert.deepEqual(con.lines.map((l) => l.line), ["from a"]);

    // A non-claiming hb (detection reports the app idle) is accepted; the union keeps the streaming session's status.
    assert.equal((await post(s.base, "heartbeat", whb(b, 2, wrapperApp({ state: "running", pid: 1, matchedBy: ["commandLine"], console: "idle" })), token)).status, 204);
    let fn = (await (await fetch(`${s.base}/agent/status`)).json()).apps.find((x) => x.appId === "app:functions" && x.regId === "price.dev");
    assert.deepEqual([fn.console, fn.pid], ["streaming", 4242]);

    // A's final hb (stopped/idle) releases the appKey: B may claim it now.
    assert.equal((await post(s.base, "heartbeat", whb(a, 2, wrapperApp({ state: "stopped", pid: undefined, rootPid: undefined, console: "idle" })), token)).status, 204);
    assert.equal((await post(s.base, "heartbeat", whb(b, 3), token)).status, 204);
    assert.equal((await post(s.base, "lines", batch(b, "b2", [line(1, { line: "from b" })]), token)).status, 200);

    // A crashed streamer stops blocking once its session is no longer online (> 15 s without hb).
    const c = await open(s.base, token);
    assert.equal((await post(s.base, "heartbeat", whb(c, 1), token)).status, 409);
    t += 16_000;
    assert.equal((await post(s.base, "heartbeat", whb(c, 1), token)).status, 204);
  } finally { await s.close(); }
});

test("v1.3 #33 APP_BUSY over WS: error APP_BUSY, socket stays open; claim hb + empty lines batch gives an ordered answer", async () => {
  const s = await serve(agentEnv, { testUser: { email: EMAIL } });
  try {
    const auth = { authorization: `Bearer ${await mint()}` };
    const a = await connect(s.ws, auth);
    a.send(hello());
    const wa = await a.next();
    // dspwatch claim: hb, then an empty batch; the ack arrives only after the hb was handled.
    a.send(whb(wa.sessionId, 1));
    a.send(batch(wa.sessionId, "claim", []));
    assert.deepEqual(await a.next(), { t: "ack", batchId: "claim", ackedSeq: {} });

    const b = await connect(s.ws, auth);
    b.send(hello());
    const wb = await b.next();
    b.send(whb(wb.sessionId, 1));
    b.send(batch(wb.sessionId, "claim", []));
    const e = await b.next();
    assert.deepEqual([e.t, e.code], ["error", "APP_BUSY"]);
    assert.equal((await b.next()).t, "ack"); // the socket stays open: the claim batch is still answered
    b.send(batch(wb.sessionId, "b1", [line(1)]));
    assert.equal((await b.next()).code, "APP_BUSY");
    // Another appKey is free for B.
    b.send(whb(wb.sessionId, 2, wrapperApp({ appId: "app:api" })));
    b.send(batch(wb.sessionId, "b2", [line(1, { appId: "app:api" })]));
    assert.deepEqual((await b.next()).ackedSeq, { "price.dev/app:api": 1 });

    // Closing A's socket makes its session offline: B can claim app:functions.
    a.ws.close();
    await a.closed;
    await new Promise((ok) => setTimeout(ok, 20));
    b.send(whb(wb.sessionId, 3));
    b.send(batch(wb.sessionId, "b3", [line(1)]));
    assert.deepEqual((await b.next()).ackedSeq, { "price.dev/app:functions": 1 });
  } finally { await s.close(); }
});

test("v1.3 #32: several sessions per agentId; status unions apps (streaming session preferred), presence online if any session is", () => {
  let t = 1_000_000;
  const st = createAgentState({ now: () => t });
  const detect = st.hello(hello(), "https", OID).sessionId; // optional dsp-agent detection
  const w1 = st.hello(hello(), "ws", OID).sessionId; // dspwatch price.dev/app:functions
  const w2 = st.hello(hello(), "ws", OID).sessionId; // dspwatch price.dev/app:api
  assert.equal(st.heartbeat(whb(w1, 1), "ws", OID), "ok");
  assert.equal(st.heartbeat(whb(w2, 1, wrapperApp({ appId: "app:api", pid: 77 })), "ws", OID), "ok");
  assert.equal(st.heartbeat(hb(detect, 1), "https", OID), "ok"); // later, reports every app with console idle
  const view = () => Object.fromEntries(st.status().apps.map((a) => [`${a.regId}/${a.appId}`, a]));
  let apps = view();
  assert.equal(Object.keys(apps).length, 7);
  assert.deepEqual([apps["price.dev/app:functions"].console, apps["price.dev/app:functions"].pid], ["streaming", 4242]);
  assert.deepEqual([apps["price.dev/app:api"].console, apps["price.dev/app:api"].pid], ["streaming", 77]);
  assert.equal(apps["customerproject.dev/app:api"].console, "idle"); // only detection reports it
  assert.deepEqual(st.status().agents.map((a) => [a.agentId, a.presence]), [[AGENT_ID, "online"]]);

  // w1's socket closes (child gone without a final hb): the freshest status wins again for that appKey.
  st.wsClosed(AGENT_ID, w1);
  apps = view();
  assert.equal(apps["price.dev/app:functions"].console, "idle");
  assert.equal(apps["price.dev/app:api"].console, "streaming");
  t += 16_000; // nothing heard for 16 s: stale
  assert.equal(st.status().agents[0].presence, "stale");
  assert.equal(st.heartbeat(whb(w2, 2, wrapperApp({ appId: "app:api", pid: 77 })), "ws", OID), "ok");
  assert.equal(st.status().agents[0].presence, "online"); // detection is still stale, w2 just sent an hb
});

test("v1.3 resume: de-duplication continues only from the session the wrapper resumes, never from an earlier wrapper run", () => {
  const st = createAgentState();
  const key = "price.dev/app:functions";
  // Run #1 streams seq 1..3 and exits cleanly.
  const r1 = st.hello(hello(), "ws", OID).sessionId;
  st.heartbeat(whb(r1, 1), "ws", OID);
  assert.deepEqual(st.lines(batch(r1, "a", [line(1), line(2), line(3)])).ackedSeq, { [key]: 3 });
  st.heartbeat(whb(r1, 2, wrapperApp({ state: "stopped", console: "idle" })), "ws", OID);
  st.wsClosed(AGENT_ID, r1);
  // Run #2 claims, reconnects before sending anything: no predecessor ackedSeq, its seq 1 is new.
  const r2 = st.hello(hello(), "ws", OID).sessionId;
  st.heartbeat(whb(r2, 1), "ws", OID);
  st.wsClosed(AGENT_ID, r2);
  const w = st.hello(hello({ resumeFrom: { [key]: 0 } }), "ws", OID);
  assert.deepEqual(w.ackedSeq, {});
  assert.equal(st.session({ agentId: AGENT_ID, sessionId: r2 }, OID), null); // superseded
  assert.deepEqual(st.lines(batch(w.sessionId, "b", [line(1, { line: "run 2" })])).ackedSeq, { [key]: 1 });
  // A further reconnect carries the ackedSeq over: a resent seq 1 is de-duplicated.
  st.heartbeat(whb(w.sessionId, 1), "ws", OID);
  const w2 = st.hello(hello({ resumeFrom: { [key]: 1 } }), "ws", OID);
  assert.deepEqual(w2.ackedSeq, { [key]: 1 });
  st.lines(batch(w2.sessionId, "c", [line(1, { line: "run 2" }), line(2, { line: "run 2 next" })]));
  assert.deepEqual(st.consoleRead(key).lines.map((l) => [l.seq, l.rseq, l.line]),
    [[1, 1, "line 1"], [2, 2, "line 2"], [3, 3, "line 3"], [1, 4, "run 2"], [2, 5, "run 2 next"]]);
});
