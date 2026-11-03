// DSP Dev Overview front door (ADR-006): Entra OIDC (confidential, code+PKCE) + session + /api proxy + SPA.
import express from "express";
import session from "express-session";
import helmet from "helmet";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Issuer, generators } from "openid-client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, "..", "web", "dist");
const env = process.env;
const PORT = Number(env.PORT || 3000);
const PROD = env.NODE_ENV === "production";
const TENANT = env.AZURE_AD_TENANT_ID || "";
const PUBLIC_BASE_URL = (env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const ALLOWED = (env.ALLOWED_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const API_UPSTREAM = (env.API_UPSTREAM || "").trim();
const authConfigured = Boolean(TENANT && env.AZURE_AD_CLIENT_ID && env.AZURE_AD_CLIENT_SECRET);

if (PROD && !env.SESSION_SECRET) { console.error("SESSION_SECRET required in production"); process.exit(1); }
if (!authConfigured) console.warn("[auth] AZURE_AD_* not set: /auth/login returns 503; all protected routes stay locked.");

// Fire-and-forget: wake the free-tier API while the user lands on the SPA.
function wakeApi() {
  if (!API_UPSTREAM) return;
  fetch(`${API_UPSTREAM.replace(/\/$/, "")}/healthz`, { signal: AbortSignal.timeout(90000) })
    .then((r) => console.log(`[wake] API /healthz ${r.status}`))
    .catch((e) => console.warn("[wake] API wake failed:", e.message));
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

app.use(session({
  name: "dsp.sid",
  secret: env.SESSION_SECRET || "dev-only-insecure-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: PROD, sameSite: "lax", maxAge: 8 * 3600 * 1000 },
}));

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
    req.session.save((err) => (err ? next(err) : res.redirect(url)));
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
    if (ALLOWED.length && !ALLOWED.includes(email)) return page(res, 403, "Not allowed.");
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.user = { email, name: c.name, oid: c.oid, tid: c.tid };
      wakeApi();
      req.session.save((e2) => (e2 ? next(e2) : res.redirect("/")));
    });
  } catch (e) { console.error("[auth] callback failed:", e.message); page(res, 401, 'Login failed. <a href="/auth/login">Try again</a>.'); }
});

const logout = (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("dsp.sid");
    if (!TENANT) return res.redirect("/");
    res.redirect(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(PUBLIC_BASE_URL + "/")}`);
  });
};
app.get("/auth/logout", logout);
app.post("/auth/logout", logout);

// Everything below requires a session.
app.use((req, res, next) => {
  if (req.session.user) return next();
  if (req.path.startsWith("/api")) return res.status(401).json({ error: "UNAUTHENTICATED" });
  res.redirect(302, "/auth/login");
});

app.get("/auth/me", (req, res) => res.json(req.session.user));

if (API_UPSTREAM) {
  // Custom fetch proxy (replaces http-proxy-middleware) so we can retry while the free-tier API cold-starts.
  // Mount at /api strips the prefix; we re-add it: /api/projects -> ${API_UPSTREAM}/api/projects.
  const UP = API_UPSTREAM.replace(/\/$/, "");
  const RETRIES = 2, TIMEOUT_MS = 120000;
  const COLD = ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "TimeoutError", "AbortError"];
  const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding", "host", "cookie", "authorization"]);
  app.use("/api", express.raw({ type: () => true, limit: "5mb" }), async (req, res) => {
    const url = UP + "/api" + req.url;
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && typeof v === "string") headers[k] = v;
    headers["x-overview-user"] = req.session.user.email;
    const hasBody = !["GET", "HEAD"].includes(req.method) && Buffer.isBuffer(req.body) && req.body.length;
    let lastErr;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      try {
        const r = await fetch(url, { method: req.method, headers, body: hasBody ? req.body : undefined, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (r.status === 502 && attempt < RETRIES) { lastErr = { code: "HTTP_502" }; await new Promise((ok) => setTimeout(ok, 2000)); continue; }
        res.status(r.status);
        r.headers.forEach((v, k) => { if (!HOP.has(k) && k !== "set-cookie") res.setHeader(k, v); });
        return res.send(Buffer.from(await r.arrayBuffer()));
      } catch (e) {
        lastErr = { code: e.cause?.code || e.code || e.name, message: e.message };
        console.warn(`[proxy] ${req.method} ${req.originalUrl} attempt ${attempt + 1} failed: ${lastErr.code}`);
        if (attempt < RETRIES) await new Promise((ok) => setTimeout(ok, 2000));
      }
    }
    const cold = lastErr.code === "HTTP_502" || COLD.includes(lastErr.code);
    res.status(cold ? 503 : 502).json({ error: cold
      ? { code: "API_UPSTREAM_COLD", message: "Overview API waking up; retry in a few seconds", retryable: true }
      : { code: "API_UPSTREAM_ERROR", message: String(lastErr.message || lastErr.code), retryable: true } });
  });
} else {
  app.use("/api", (_req, res) => res.status(503).json({ error: "API_UPSTREAM_NOT_CONFIGURED" }));
}

app.use(express.static(DIST, { index: false }));
app.get("*", (_req, res) => res.sendFile(path.join(DIST, "index.html")));

app.listen(PORT, () => console.log(`dsp-dev-overview-web on :${PORT} (auth ${authConfigured ? "on" : "unconfigured"}, upstream ${API_UPSTREAM || "none"})`));
