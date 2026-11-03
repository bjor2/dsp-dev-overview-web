import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/app.js";
import { chooseUpstream, createBoxHealth, upstreamConfig, upstreamHeaders } from "../server/upstream.js";

const BOX = "https://box.example.test", RENDER = "https://render.example.test", KEY = "box-key-value";
const baseEnv = { ALLOWED_EMAILS: "bjor.byrkjedal@osilion.no", SESSION_SECRET: "s", BOX_API_UPSTREAM: BOX, RENDER_API_UPSTREAM: RENDER, BOX_UPSTREAM_SECRET: KEY };
const user = { email: "bjor.byrkjedal@osilion.no" };
const quiet = { info() {}, warn() {}, error() {} };

/** Fake upstream: records calls; box behaviour switchable. */
function fakeFetch({ boxUp = true, ngrokErr = null } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), headers: { ...(init.headers || {}) }, method: init.method || "GET" });
    if (String(url).startsWith(BOX)) {
      if (!boxUp) throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      if (ngrokErr) return new Response("offline", { status: 404, headers: { "ngrok-error-code": ngrokErr } });
    }
    return new Response(JSON.stringify([{ id: "customerproject.dev" }]), { status: 200, headers: { "content-type": "application/json" } });
  };
  f.calls = calls;
  return f;
}

async function serve(env, deps) {
  const app = createApp(env, { log: quiet, ...deps });
  const srv = app.listen(0);
  await new Promise((ok) => srv.once("listening", ok));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { base, close: () => new Promise((ok) => srv.close(ok)) };
}

test("mode defaults to box; render when set", () => {
  assert.equal(upstreamConfig({}).mode, "box");
  assert.equal(upstreamConfig({ API_UPSTREAM_MODE: "render" }).mode, "render");
  assert.equal(upstreamConfig({ API_UPSTREAM: RENDER }).renderUrl, RENDER); // legacy name
  assert.equal(upstreamConfig({}).fallback, "off");
});

test("box key only for box target; inbound key and cookies stripped", () => {
  const cfg = upstreamConfig(baseEnv);
  const inbound = { "x-dsp-box-key": "evil", cookie: "c", authorization: "a", accept: "application/json" };
  const toBox = upstreamHeaders(inbound, "box", cfg, "u@x");
  assert.equal(toBox["x-dsp-box-key"], KEY);
  assert.equal(toBox.cookie, undefined);
  assert.equal(toBox.authorization, undefined);
  const toRender = upstreamHeaders(inbound, "render", cfg, "u@x");
  assert.equal(toRender["x-dsp-box-key"], undefined);
});

test("health: cached 30 s, down on connect error / ngrok error / 5xx", async () => {
  let t = 0, n = 0;
  const cfg = upstreamConfig(baseEnv);
  const h = createBoxHealth(cfg, async () => { n++; return new Response("ok"); }, () => t);
  assert.equal((await h.check()).up, true);
  await h.check(); assert.equal(n, 1);
  t = 31000; await h.check(); assert.equal(n, 2);
  assert.equal((await createBoxHealth(cfg, fakeFetch({ boxUp: false })).check()).up, false);
  assert.equal((await createBoxHealth(cfg, fakeFetch({ ngrokErr: "ERR_NGROK_3200" })).check()).up, false);
  assert.equal((await createBoxHealth(cfg, async () => new Response("x", { status: 502 })).check()).up, false);
});

test("choose: mutating never falls back; GET falls back only with read-only", async () => {
  const down = { check: async () => ({ up: false, reason: "x" }) };
  assert.ok((await chooseUpstream("POST", upstreamConfig({ ...baseEnv, API_UPSTREAM_FALLBACK: "read-only" }), down)).offline);
  assert.ok((await chooseUpstream("GET", upstreamConfig(baseEnv), down)).offline);
  const fb = await chooseUpstream("GET", upstreamConfig({ ...baseEnv, API_UPSTREAM_FALLBACK: "read-only" }), down);
  assert.deepEqual([fb.target, fb.fallback], ["render", true]);
});

test("proxy box mode: injects key, X-Dsp-Upstream: box", async () => {
  const f = fakeFetch();
  const s = await serve(baseEnv, { fetch: f, testUser: user });
  try {
    const r = await fetch(`${s.base}/api/projects`, { headers: { "x-dsp-box-key": "evil" } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-dsp-upstream"), "box");
    const call = f.calls.find((c) => c.url === `${BOX}/api/projects`);
    assert.equal(call.headers["x-dsp-box-key"], KEY);
    assert.equal(r.headers.get("x-dsp-box-key"), null);
  } finally { await s.close(); }
});

test("proxy render mode: no key sent, X-Dsp-Upstream: render, box never probed", async () => {
  const f = fakeFetch();
  const s = await serve({ ...baseEnv, API_UPSTREAM_MODE: "render" }, { fetch: f, testUser: user });
  try {
    const r = await fetch(`${s.base}/api/projects`);
    assert.equal(r.headers.get("x-dsp-upstream"), "render");
    assert.ok(f.calls.every((c) => !c.url.startsWith(BOX) && c.headers["x-dsp-box-key"] === undefined));
  } finally { await s.close(); }
});

test("box down: 503 BOX_OFFLINE; GET read-only fallback marks header", async () => {
  const s = await serve(baseEnv, { fetch: fakeFetch({ boxUp: false }), testUser: user });
  try {
    const r = await fetch(`${s.base}/api/projects/x/samples/send`, { method: "POST", body: "{}" });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error.code, "BOX_OFFLINE");
    const st = await (await fetch(`${s.base}/upstream-status`)).json();
    assert.deepEqual([st.mode, st.box.up], ["box", false]);
  } finally { await s.close(); }
  const s2 = await serve({ ...baseEnv, API_UPSTREAM_FALLBACK: "read-only" }, { fetch: fakeFetch({ ngrokErr: "ERR_NGROK_3200" }), testUser: user });
  try {
    const r = await fetch(`${s2.base}/api/projects`);
    assert.deepEqual([r.status, r.headers.get("x-dsp-upstream"), r.headers.get("x-dsp-upstream-fallback")], [200, "render", "1"]);
    const p = await fetch(`${s2.base}/api/projects/x/purge`, { method: "POST" });
    assert.equal(p.status, 503);
  } finally { await s2.close(); }
});

for (const allowed of [undefined, "", " , "]) {
  test(`ALLOWED_EMAILS=${JSON.stringify(allowed)} fails closed with 403 and logs config error`, async () => {
    const errors = [];
    const env = { ...baseEnv, ALLOWED_EMAILS: allowed };
    const s = await serve(env, { fetch: fakeFetch(), testUser: user, log: { ...quiet, error: (m) => errors.push(m) } });
    try {
      assert.equal((await fetch(`${s.base}/api/projects`)).status, 403);
      assert.equal((await fetch(`${s.base}/`, { redirect: "manual" })).status, 403);
      assert.equal((await fetch(`${s.base}/upstream-status`)).status, 403);
      assert.equal((await fetch(`${s.base}/healthz`)).status, 200); // Render health check stays open
      assert.ok(errors.some((m) => m.includes("ALLOWED_EMAILS")));
      assert.ok(errors.every((m) => !m.includes(KEY) && !m.includes("SESSION_SECRET=")));
    } finally { await s.close(); }
  });
}

test("session for a non-allowlisted email is 403", async () => {
  const s = await serve(baseEnv, { fetch: fakeFetch(), testUser: { email: "someone@else.test" } });
  try { assert.equal((await fetch(`${s.base}/api/projects`)).status, 403); } finally { await s.close(); }
});
