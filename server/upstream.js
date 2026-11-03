// ADDENDA-006 upstream selection for the /api proxy: box (ngrok machine host → box API) or render.
// Pure-ish module so it can be unit tested; no secret is ever logged or returned.

export const BOX_KEY_HEADER = "x-dsp-box-key";
const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding", "host", "cookie", "authorization",
  BOX_KEY_HEADER, "x-dsp-upstream", "x-dsp-upstream-fallback"]);
const trimUrl = (s) => (s || "").trim().replace(/\/$/, "");

export function upstreamConfig(env) {
  const mode = (env.API_UPSTREAM_MODE || "box").trim().toLowerCase() === "render" ? "render" : "box"; // default box (ADDENDA-006)
  return {
    mode,
    boxUrl: trimUrl(env.BOX_API_UPSTREAM),
    // RENDER_API_UPSTREAM per ADDENDA-006; API_UPSTREAM kept as the legacy name.
    renderUrl: trimUrl(env.RENDER_API_UPSTREAM || env.API_UPSTREAM),
    boxSecret: (env.BOX_UPSTREAM_SECRET || "").trim(),
    fallback: (env.API_UPSTREAM_FALLBACK || "off").trim().toLowerCase() === "read-only" ? "read-only" : "off",
    healthTtlMs: Number(env.BOX_HEALTH_TTL_MS || 30000),
  };
}

/** Request headers for the upstream: hop-by-hop, cookie/authorization and any inbound box key dropped; key added for box only. */
export function upstreamHeaders(inbound, target, cfg, userEmail) {
  const headers = {};
  for (const [k, v] of Object.entries(inbound)) if (!HOP.has(k.toLowerCase()) && typeof v === "string") headers[k] = v;
  if (userEmail) headers["x-overview-user"] = userEmail;
  if (target === "box" && cfg.boxSecret) headers[BOX_KEY_HEADER] = cfg.boxSecret;
  return headers;
}

export const responseHeaderAllowed = (k) => !HOP.has(k) && k !== "set-cookie";

/** Box is down on connect error, 5xx, or an ngrok error page (ERR_NGROK_3200 endpoint offline etc.). */
export function boxResponseDown(r) {
  return r.status >= 500 || Boolean(r.headers.get("ngrok-error-code"));
}

export function createBoxHealth(cfg, fetchImpl = fetch, now = () => Date.now()) {
  let cached = null; // { up, at, reason }
  let inflight = null;
  async function probe() {
    if (!cfg.boxUrl) return { up: false, reason: "BOX_API_UPSTREAM not set" };
    try {
      const r = await fetchImpl(`${cfg.boxUrl}/healthz`, {
        headers: cfg.boxSecret ? { [BOX_KEY_HEADER]: cfg.boxSecret } : {}, signal: AbortSignal.timeout(5000) });
      if (boxResponseDown(r)) return { up: false, reason: r.headers.get("ngrok-error-code") || `HTTP ${r.status}` };
      if (r.status === 403) return { up: false, reason: "edge rejected box key (403)" };
      return { up: r.ok, reason: r.ok ? "ok" : `HTTP ${r.status}` };
    } catch (e) {
      return { up: false, reason: e.cause?.code || e.code || e.name || "error" };
    }
  }
  return {
    async check() {
      if (cached && now() - cached.at < cfg.healthTtlMs) return cached;
      inflight ??= probe().then((s) => { cached = { ...s, at: now() }; inflight = null; return cached; });
      return inflight;
    },
    markDown(reason) { cached = { up: false, reason, at: now() }; },
    peek: () => cached,
  };
}

const READ = new Set(["GET", "HEAD"]);

/** Decide where a request goes. Returns { target: "box"|"render", url, fallback } or { offline: true }. */
export async function chooseUpstream(method, cfg, health) {
  if (cfg.mode === "render") return cfg.renderUrl ? { target: "render", url: cfg.renderUrl, fallback: false } : { notConfigured: true };
  const h = await health.check();
  if (h.up) return { target: "box", url: cfg.boxUrl, fallback: false };
  if (READ.has(method) && cfg.fallback === "read-only" && cfg.renderUrl) return { target: "render", url: cfg.renderUrl, fallback: true };
  return { offline: true, reason: h.reason };
}

export const BOX_OFFLINE_BODY = {
  error: { code: "BOX_OFFLINE", message: "Box API is offline (ngrok tunnel or :5011 down). Start it on the box, or switch API_UPSTREAM_MODE=render.", retryable: true },
};
