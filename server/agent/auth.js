// ADDENDA-010 §6 bearer validation for /agent/ingest*. Bearer only: a cookie is never accepted there.
// Fails closed: with any required setting missing every ingest request gets 503 (nothing is accepted).
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from "jose";

const list = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);

/** Reads the agent ingest auth settings. Values are ids and URLs only; there are no secrets on this path. */
export function agentAuthConfig(env) {
  const tenant = env.AGENT_TENANT_ID || env.AZURE_AD_TENANT_ID || "";
  const webClientId = env.AZURE_AD_CLIENT_ID || "";
  const audiences = list(env.AGENT_AUDIENCES).length ? list(env.AGENT_AUDIENCES)
    : webClientId ? [webClientId, `api://${webClientId}`] : [];
  const cfg = {
    tenant,
    issuer: env.AGENT_ISSUER || (tenant ? `https://login.microsoftonline.com/${tenant}/v2.0` : ""),
    audiences,
    agentClientId: env.AGENT_CLIENT_ID || "",
    scope: env.AGENT_SCOPE || "Agent.Ingest",
    jwksJson: env.AGENT_JWKS_JSON || "",
    jwksUrl: env.AGENT_JWKS_URL || (tenant ? `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys` : ""),
    allowedOids: list(env.ALLOWED_OIDS).map((s) => s.toLowerCase()),
    allowedEmails: list(env.ALLOWED_EMAILS).map((s) => s.toLowerCase()),
  };
  cfg.missing = [
    !cfg.tenant && "AGENT_TENANT_ID/AZURE_AD_TENANT_ID",
    !cfg.issuer && "AGENT_ISSUER",
    !cfg.audiences.length && "AGENT_AUDIENCES/AZURE_AD_CLIENT_ID",
    !cfg.agentClientId && "AGENT_CLIENT_ID",
    !cfg.jwksJson && !cfg.jwksUrl && "AGENT_JWKS_URL/AGENT_JWKS_JSON",
    !cfg.allowedOids.length && "ALLOWED_OIDS",
    !cfg.allowedEmails.length && "ALLOWED_EMAILS",
  ].filter(Boolean);
  cfg.configured = cfg.missing.length === 0;
  return cfg;
}

/**
 * @returns {{ cfg, verify: (headers: Record<string, string|undefined>) => Promise<
 *   { ok: true, claims: object } | { ok: false, status: number, code: "AUTH"|"FORBIDDEN"|"NOT_CONFIGURED", message: string }>}}
 */
export function createAgentAuth(env, deps = {}) {
  const cfg = agentAuthConfig(env);
  let keys = null;
  if (cfg.configured) {
    try {
      keys = cfg.jwksJson ? createLocalJWKSet(JSON.parse(cfg.jwksJson)) : createRemoteJWKSet(new URL(cfg.jwksUrl), deps.jwksOptions);
    } catch (e) {
      cfg.configured = false;
      cfg.missing.push(`valid JWKS (${e.message})`);
    }
  }
  const fail = (status, code, message) => ({ ok: false, status, code, message });

  async function verify(headers) {
    // §3: NOT_CONFIGURED (not AUTH), so the agent backs off without a pointless token refresh.
    if (!cfg.configured) return fail(503, "NOT_CONFIGURED", `agent ingest auth not configured (missing: ${cfg.missing.join(", ")})`);
    if (headers.cookie) return fail(401, "AUTH", "cookies are not accepted on /agent/ingest; use a bearer token");
    const m = /^Bearer\s+(\S+)$/i.exec(String(headers.authorization || ""));
    if (!m) return fail(401, "AUTH", "bearer token required");
    let claims;
    try {
      ({ payload: claims } = await jwtVerify(m[1], keys, {
        issuer: cfg.issuer,
        audience: cfg.audiences,
        algorithms: ["RS256"],
        clockTolerance: 120, // §6: exp/nbf with 2 min skew
        requiredClaims: ["exp", "tid", "oid"],
      }));
    } catch (e) {
      return fail(401, "AUTH", `invalid token (${e.code || e.name})`);
    }
    if (claims.tid !== cfg.tenant) return fail(401, "AUTH", "wrong tenant");
    if (!String(claims.scp || "").split(" ").includes(cfg.scope)) return fail(401, "AUTH", `scope ${cfg.scope} required`);
    if ((claims.azp ?? claims.appid) !== cfg.agentClientId) return fail(401, "AUTH", "token not issued to the agent client");
    if (!cfg.allowedOids.includes(String(claims.oid).toLowerCase())) return fail(403, "FORBIDDEN", "oid not allowed");
    const email = String(claims.preferred_username || claims.email || "").toLowerCase();
    if (!cfg.allowedEmails.includes(email)) return fail(403, "FORBIDDEN", "user not allowed");
    return { ok: true, claims };
  }

  return { cfg, verify };
}
