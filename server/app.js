// DSP Dev Overview front door (ADR-006): Entra OIDC (confidential, code+PKCE) + session + /api proxy + SPA.
import express from "express";
import cookieSession from "cookie-session";
import helmet from "helmet";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Issuer, generators } from "openid-client";
import { BOX_OFFLINE_BODY, boxResponseDown, chooseUpstream, createBoxHealth, responseHeaderAllowed, upstreamConfig, upstreamHeaders } from "./upstream.js";


export function createApp(env = process.env, deps = {}) {
const log = deps.log ?? { info: console.log, warn: console.warn, error: console.error };
const fetchImpl = deps.fetch ?? fetch;
const __dirname0 = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname0, "..", "web", "dist");
const PORT = Number(env.PORT || 3000);
const PROD = env.NODE_ENV === "production";
const TENANT = env.AZURE_AD_TENANT_ID || "";
const PUBLIC_BASE_URL = (env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const ALLOWED = (env.ALLOWED_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
// Fail closed: no allowlist → nobody gets in (403 on login and every gated request).
const ALLOWLIST_MISSING = ALLOWED.length === 0;
if (ALLOWLIST_MISSING) log.error("[config] ALLOWED_EMAILS is empty or unset: rejecting every login and request with 403 (fail closed).");
const UPSTREAM = upstreamConfig(env);
const API_UPSTREAM = UPSTREAM.renderUrl; // keepalive/wake target (Render API)
const authConfigured = Boolean(TENANT && env.AZURE_AD_CLIENT_ID && env.AZURE_AD_CLIENT_SECRET);

if (PROD && !env.SESSION_SECRET) throw new Error("SESSION_SECRET required in production");
if (!authConfigured) log.warn("[auth] AZURE_AD_* not set: /auth/login returns 503; all protected routes stay locked.");

// Fire-and-forget: wake the free-tier API while the user lands on the SPA.
function wakeApi() {
  if (!API_UPSTREAM) return;
  fetchImpl(`${API_UPSTREAM.replace(/\/$/, "")}/healthz`, { signal: AbortSignal.timeout(90000) })
    .then((r) => log.info(`[wake] API /healthz ${r.status}`))
    .catch((e) => log.warn("[wake] API wake failed:", e.message));
}

let clientPromise;
function getClient() {
  clientPromise ??= Issuer.discover(`https://login.microsoftonline.com/${TENANT}/v2.0`).then(
    (issuer) => new issuer.Client({
      client_id: env.AZURE_AD_CLIENT_ID,
      client_secret: env.AZURE_AD_CLIENT_SECRET,
      redirect_uris: [`${PUBLIC_BASE_URL}/auth/callback`],
      response_types: ["code"],
    })
  ).catch((e) => { clientPromise = undefined; throw e; });
  return clientPromise;
}

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));

app.get("/healthz", (_req, res) => res.type("text").send("ok"));

// Signed cookie session (HMAC with SESSION_SECRET), not the in-memory store: every Render deploy/restart wiped
// MemoryStore, so open tabs got 401 on their next poll (SMOKE-render-upstream-20261103-1108). The cookie holds only
// {email,name,oid,tid,iat} / the OIDC login nonce; tampering fails the signature. Server-side 8 h expiry via iat.
const SESSION_MAX_MS = 8 * 3600 * 1000;
app.use(cookieSession({
  name: "dsp.sid",
  keys: [env.SESSION_SECRET || "dev-only-insecure-secret"],
  httpOnly: true, secure: PROD, sameSite: "lax", maxAge: SESSION_MAX_MS,
}));
app.use((req, _res, next) => {
  const u = req.session?.user;
  if (u && !(typeof u.iat === "number" && Date.now() - u.iat < SESSION_MAX_MS)) delete req.session.user;
  next();
});

// Tests only (never from env): pretend an OIDC session exists.
if (deps.testUser) app.use((req, _res, next) => { req.session.user ??= { iat: Date.now(), ...deps.testUser }; next(); });

const page = (res, code, msg) => res.status(code).type("html").send(`<!doctype html><title>DSP Dev Overview</title><p>${msg}</p>`);

app.get("/auth/login", async (req, res, next) => {
  if (!authConfigured) return page(res, 503, "Auth not configured (set AZURE_AD_TENANT_ID / CLIENT_ID / CLIENT_SECRET).");
  try {
    const client = await getClient();
    const code_verifier = generators.codeVerifier();
    const state = generators.state();
    const nonce = generators.nonce();
    req.session.oidc = { code_verifier, state, nonce };
    const url = client.authorizationUrl({
      scope: "openid profile email offline_access",
      code_challenge: generators.codeChallenge(code_verifier),
      code_challenge_method: "S256",
      state, nonce, response_mode: "query",
    });
    res.redirect(url); // cookie-session writes the Set-Cookie with this response
  } catch (e) { next(e); }
});

app.get("/auth/callback", async (req, res, next) => {
  if (!authConfigured) return page(res, 503, "Auth not configured.");
  const oidc = req.session.oidc;
  if (!oidc) return page(res, 400, 'Login session expired. <a href="/auth/login">Try again</a>.');
  try {
    const client = await getClient();
    const params = client.callbackParams(req);
    const tokens = await client.callback(`${PUBLIC_BASE_URL}/auth/callback`, params, {
      state: oidc.state, nonce: oidc.nonce, code_verifier: oidc.code_verifier,
    });
    const c = tokens.claims();
    if (c.tid !== TENANT) return page(res, 403, "Wrong tenant.");
    const email = String(c.email || c.preferred_username || "").toLowerCase();
    if (ALLOWLIST_MISSING) { log.error("[config] login rejected: ALLOWED_EMAILS empty"); return page(res, 403, "Not allowed (allowlist not configured)."); }
    if (!ALLOWED.includes(email)) return page(res, 403, "Not allowed.");
    // Replace the whole session (no fixation: new signed cookie, login nonce dropped).
    req.session = { user: { email, name: c.name, oid: c.oid, tid: c.tid, iat: Date.now() } };
    wakeApi();
    res.redirect("/");
  } catch (e) { log.error("[auth] callback failed:", e.message); page(res, 401, 'Login failed. <a href="/auth/login">Try again</a>.'); }
});

const logout = (req, res) => {
  req.session = null;
  if (!TENANT) return res.redirect("/");
  res.redirect(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(PUBLIC_BASE_URL + "/")}`);
};
app.get("/auth/logout", logout);
app.post("/auth/logout", logout);

// Everything below requires a session.
app.use((req, res, next) => {
  if (ALLOWLIST_MISSING) {
    if (req.path.startsWith("/api")) return res.status(403).json({ error: { code: "ALLOWLIST_NOT_CONFIGURED", message: "Front door allowlist not configured", retryable: false } });
    return page(res, 403, "Not allowed (allowlist not configured).");
  }
  // Re-check on every request so an allowlist change also evicts existing sessions.
  if (req.session.user && !ALLOWED.includes(String(req.session.user.email || "").toLowerCase()))
    return req.path.startsWith("/api") ? res.status(403).json({ error: { code: "FORBIDDEN", message: "Not allowed", retryable: false } }) : page(res, 403, "Not allowed.");
  if (req.session.user) return next();
  if (req.path.startsWith("/api")) return res.status(401).json({ error: "UNAUTHENTICATED" });
  res.redirect(302, "/auth/login");
});

app.get("/auth/me", (req, res) => res.json(req.session.user));

// ADDENDA-006: /api → box (ngrok machine host, X-Dsp-Box-Key injected here, after the session gate) or render.
const boxHealth = deps.boxHealth ?? createBoxHealth(UPSTREAM, fetchImpl);
app.get("/upstream-status", async (_req, res) => {
  const h = UPSTREAM.mode === "box" ? await boxHealth.check() : null;
  res.json({ mode: UPSTREAM.mode, fallback: UPSTREAM.fallback, box: h && { up: h.up, reason: h.reason } });
});
{
  const RETRIES = 2, TIMEOUT_MS = 120000;
  const COLD = ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "TimeoutError", "AbortError"];
  const offline = (res, reason) => {
    log.warn(`[proxy] box offline: ${reason}`);
    res.setHeader("X-Dsp-Upstream", "box");
    return res.status(503).json(BOX_OFFLINE_BODY);
  };
  app.use("/api", express.raw({ type: () => true, limit: "5mb" }), async (req, res) => {
    const choice = await chooseUpstream(req.method, UPSTREAM, boxHealth);
    if (choice.notConfigured) return res.status(503).json({ error: "API_UPSTREAM_NOT_CONFIGURED" });
    if (choice.offline) return offline(res, choice.reason);
    const url = choice.url + "/api" + req.url;
    const headers = upstreamHeaders(req.headers, choice.target, UPSTREAM, req.session.user.email);
    const hasBody = !["GET", "HEAD"].includes(req.method) && Buffer.isBuffer(req.body) && req.body.length;
    const retries = choice.target === "render" ? RETRIES : 0; // box: no cold-start retries; down = BOX_OFFLINE
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const r = await fetchImpl(url, { method: req.method, headers, body: hasBody ? req.body : undefined, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (choice.target === "box" && boxResponseDown(r) && r.headers.get("ngrok-error-code")) { boxHealth.markDown(r.headers.get("ngrok-error-code")); return offline(res, r.headers.get("ngrok-error-code")); }
        if (r.status === 502 && attempt < retries) { lastErr = { code: "HTTP_502" }; await new Promise((ok) => setTimeout(ok, 2000)); continue; }
        res.status(r.status);
        r.headers.forEach((v, k) => { if (responseHeaderAllowed(k)) res.setHeader(k, v); });
        res.setHeader("X-Dsp-Upstream", choice.target);
        if (choice.fallback) res.setHeader("X-Dsp-Upstream-Fallback", "1");
        return res.send(Buffer.from(await r.arrayBuffer()));
      } catch (e) {
        lastErr = { code: e.cause?.code || e.code || e.name, message: e.message };
        log.warn(`[proxy] ${req.method} ${req.originalUrl} → ${choice.target} attempt ${attempt + 1} failed: ${lastErr.code}`);
        if (choice.target === "box") { boxHealth.markDown(lastErr.code); return offline(res, lastErr.code); }
        if (attempt < retries) await new Promise((ok) => setTimeout(ok, 2000));
      }
    }
    const cold = lastErr.code === "HTTP_502" || COLD.includes(lastErr.code);
    res.setHeader("X-Dsp-Upstream", choice.target);
    res.status(cold ? 503 : 502).json({ error: cold
      ? { code: "API_UPSTREAM_COLD", message: "Overview API waking up; retry in a few seconds", retryable: true }
      : { code: "API_UPSTREAM_ERROR", message: String(lastErr.message || lastErr.code), retryable: true } });
  });
}

app.use(express.static(DIST, { index: false }));
app.get("*", (_req, res) => res.sendFile(path.join(DIST, "index.html")));

app.locals.describe = () => `auth ${authConfigured ? "on" : "unconfigured"}, allowlist ${ALLOWLIST_MISSING ? "MISSING (403 all)" : "[" + ALLOWED.join(",") + "]"}, upstream ${UPSTREAM.mode}${UPSTREAM.mode === "box" ? ` (fallback ${UPSTREAM.fallback})` : ""}`;
return app;
}
