# dsp-dev-overview-web

Render **Web Service** front door for DSP Dev Overview (ADR-006): Entra ID OIDC login (confidential client, auth code + PKCE, Osilion tenant only), server-side session, `/api/*` proxy to the overview API, and the overview SPA from `web/dist`.

Routes: `/healthz` (public) → `/auth/login|callback|logout` (public) → `requireAuth` (HTML → 302 `/auth/login`, `/api` → 401) → `/api/*` proxy (strips Authorization/Cookie, adds `X-Overview-User`; 503 if `API_UPSTREAM` blank) → static `web/dist` → SPA fallback.

Callback enforces state, nonce, PKCE, `tid === AZURE_AD_TENANT_ID`, `ALLOWED_EMAILS`, and `session.regenerate()`.

## Env
| Var | Value |
|---|---|
| `AZURE_AD_TENANT_ID` | `c3ac4169-9d99-4eb7-b72b-bfa11f13d825` (**Osilion**. Never Dahl, never common/organizations) |
| `AZURE_AD_CLIENT_ID` | app (client) id of `dsp-dev-overview-web` |
| `AZURE_AD_CLIENT_SECRET` | client secret (Render: sync false) |
| `SESSION_SECRET` | 32+ random bytes (required when `NODE_ENV=production`) |
| `ALLOWED_EMAILS` | `bjor.byrkjedal@osilion.no` |
| `API_UPSTREAM` | overview API base, e.g. `http://127.0.0.1:5090`; blank → `/api` 503 |
| `PUBLIC_BASE_URL` | `https://<service>.onrender.com` / `http://localhost:3000` |
| `NODE_ENV` | `production` on Render (enables Secure cookie) |

Authority: `https://login.microsoftonline.com/c3ac4169-9d99-4eb7-b72b-bfa11f13d825/v2.0`.

## Local
```bash
npm ci && npm run build
API_UPSTREAM=http://127.0.0.1:5090 PUBLIC_BASE_URL=http://localhost:3000 \
AZURE_AD_TENANT_ID=c3ac4169-9d99-4eb7-b72b-bfa11f13d825 AZURE_AD_CLIENT_ID=... AZURE_AD_CLIENT_SECRET=... \
SESSION_SECRET=dev ALLOWED_EMAILS=bjor.byrkjedal@osilion.no npm start
```
Without `AZURE_AD_*` the server still starts: `/healthz` 200, everything else stays locked, `/auth/login` returns 503 (no mock bypass).

UI source in `web/` is a copy of `dev-overview/ui/app`; refresh with `npm run sync-ui` (sibling checkout at `../dev-overview`). The SPA calls relative `/api`.

## Entra setup (Osilion tenant)
1. Entra admin center → App registrations → New: `dsp-dev-overview-web`, **Single tenant**.
2. Authentication → platform **Web**; redirect URIs `https://<service>.onrender.com/auth/callback` and `http://localhost:3000/auth/callback`; front-channel logout `https://<service>.onrender.com/auth/logout`; implicit/hybrid tokens **off**.
3. Certificates & secrets → new client secret (6–12 mo; record the expiry) → `AZURE_AD_CLIENT_SECRET`.
4. API permissions: Graph delegated `openid profile email offline_access` (User.Read optional).
5. Token configuration → optional ID-token claims `email`, `preferred_username`.
6. Enterprise applications → app → Properties: **Assignment required = Yes**; Users and groups: assign only `bjor.byrkjedal@osilion.no`.

## Render
Web Service (not Static Site), Node, Frankfurt, build `npm ci && npm run build`, start `node server/index.js`, health `/healthz`, auto-deploy `main` (see `render.yaml`). After create: set `PUBLIC_BASE_URL` and add the real URL to the Entra redirect URIs.

## Free-tier cold start

Both Render services (front door + `dsp-dev-overview-api`) are on the free plan and sleep when idle; the API takes ~30–60 s to wake.
The `/api` proxy waits up to 120 s (`proxyTimeout`/`timeout`), returns `503 { error: { code: "API_UPSTREAM_COLD", retryable: true } }`
on ECONNRESET/ETIMEDOUT/ECONNREFUSED instead of an opaque 502, and the login callback fires a background `GET ${API_UPSTREAM}/healthz` to wake the API.
