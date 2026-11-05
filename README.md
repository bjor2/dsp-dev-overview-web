# dsp-dev-overview-web

Render **Web Service** front door for DSP Dev Overview (ADR-006): Entra ID OIDC login (confidential client, auth code + PKCE, Osilion tenant only), server-side session, `/api/*` proxy to the overview API, and the overview SPA from `web/dist`.

Routes: `/healthz` (public) → `/auth/login|callback|logout` (public) → `requireAuth` (HTML → 302 `/auth/login`, `/api` → 401) → `/upstream-status` + `/api/*` proxy (strips Authorization/Cookie/inbound `X-Dsp-Box-Key`, adds `X-Overview-User`; upstream per ADDENDA-006 below) → static `web/dist` → SPA fallback.

Callback enforces state, nonce, PKCE, `tid === AZURE_AD_TENANT_ID`, `ALLOWED_EMAILS`, then replaces the session. Session = signed cookie (`cookie-session`, HMAC with `SESSION_SECRET`, 8 h server-side expiry via `iat`), so deploys/restarts no longer log users out (the old in-memory store did). Rotating `SESSION_SECRET` logs everyone out. The SPA redirects to `/auth/login` once on a 401 `UNAUTHENTICATED`.

## Env
| Var | Value |
|---|---|
| `AZURE_AD_TENANT_ID` | `c3ac4169-9d99-4eb7-b72b-bfa11f13d825` (**Osilion**. Never Dahl, never common/organizations) |
| `AZURE_AD_CLIENT_ID` | app (client) id of `dsp-dev-overview-web` |
| `AZURE_AD_CLIENT_SECRET` | client secret (Render: sync false) |
| `SESSION_SECRET` | 32+ random bytes (required when `NODE_ENV=production`) |
| `ALLOWED_EMAILS` | `bjor.byrkjedal@osilion.no`. **Empty/unset fails closed**: every login and gated request → 403, config error logged |
| `API_UPSTREAM_MODE` | `box` (default in code) or `render` |
| `BOX_API_UPSTREAM` | `https://<MACHINE_HOST>` (ngrok machine endpoint → box API :5011) |
| `BOX_UPSTREAM_SECRET` | value of ngrok vault `dsp-overview/frontdoor-key`; sent as `X-Dsp-Box-Key` only to the box, only after the session check (Render: sync false) |
| `RENDER_API_UPSTREAM` | `https://dsp-dev-overview-api.onrender.com` (legacy name `API_UPSTREAM` still read) |
| `API_UPSTREAM_FALLBACK` | `off` (default) or `read-only`: GET/HEAD go to Render while the box is down |
| `PUBLIC_BASE_URL` | `https://<service>.onrender.com` / `http://localhost:3000` |
| `NODE_ENV` | `production` on Render (enables Secure cookie) |

Authority: `https://login.microsoftonline.com/c3ac4169-9d99-4eb7-b72b-bfa11f13d825/v2.0`.

## Local
```bash
npm ci && npm run build
API_UPSTREAM_MODE=render RENDER_API_UPSTREAM=http://127.0.0.1:5090 PUBLIC_BASE_URL=http://localhost:3000 \
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
The `/api` proxy waits up to 120 s per attempt with 2 retries on 502/ECONNRESET/ETIMEDOUT/ECONNREFUSED, returns `503 { error: { code: "API_UPSTREAM_COLD", retryable: true } }`
on ECONNRESET/ETIMEDOUT/ECONNREFUSED instead of an opaque 502, and the login callback fires a background `GET ${API_UPSTREAM}/healthz` to wake the API.

## Upstream selection (ADDENDA-006)
- `render`: every `/api` call → `RENDER_API_UPSTREAM` (cold-start retries as before). No box key is ever sent.
- `box`: `GET <BOX>/healthz` with `X-Dsp-Box-Key`, cached 30 s. Down = connect error, 5xx, `ngrok-error-code` header
  (e.g. `ERR_NGROK_3200`), or 403 from the edge. Box down → **503 `{"error":{"code":"BOX_OFFLINE",…,"retryable":true}}`**
  (envelope as the other API errors). Mutating calls never fall back; GET/HEAD fall back to Render only with
  `API_UPSTREAM_FALLBACK=read-only` (`X-Dsp-Upstream-Fallback: 1`).
- Every proxied response carries `X-Dsp-Upstream: box|render`. `GET /upstream-status` (session-gated) →
  `{mode, fallback, box:{up,reason}}`; the SPA shows a BOX_OFFLINE banner from it.

## Local agent ingest (ADDENDA-010 v1.3 §3–§6, §W; Slice 3)
Code is in `server/agent/`:
- `protocol.js`: the §3 types mirrored as JSDoc, plus validators, limits and the §6 redaction set.
- `auth.js`: bearer validation.
- `state.js`: in-memory agents, their sessions, apps and console rings.
- `routes.js`: HTTP routes, the WebSocket handler and SSE.

All state is lost on restart (§5).

**v1.3 wire (launch wrapper `dspwatch`):** `ConsoleLine.stream` is `"stdout" | "stderr"` (`"file"` is rejected) and `source` is the child's argv0 basename. `AppStatus.console` is `"streaming" | "idle" | "error"` (`tailing`/`unavailable` are rejected). `matchedBy` may contain `"wrapper"`. `Err.code` adds `APP_BUSY`.

| Endpoint | Auth | |
|---|---|---|
| `GET /agent/ingest` (WebSocket upgrade) | bearer only | `hello` → `welcome`, `hb`, `lines` → `ack` / `slow`; `SESSION` error keeps the socket until the 3rd in a row (**4409**); other errors close it (1008; 1009 too large; **4401** token expired; **4409** no hello in 30 s) |
| `POST /agent/ingest/hello` | bearer only | → `ServerWelcome` (`X-Agent-Id` = body `agentId`) |
| `POST /agent/ingest/heartbeat` | bearer only | → 204 (also when `hbSeq` is not newer: dropped); 409 `SESSION`; 409 `APP_BUSY` |
| `POST /agent/ingest/lines` | bearer only | → `Ack`; 429 + `Retry-After` (`RATE` or `slow`); 413 `TOO_LARGE`; 409 `SESSION`; 409 `APP_BUSY` |
| `GET /agent/status` | session + `ALLOWED_EMAILS` | `{ frontDoorStartedAt (ISO-8601 UTC, process start), agents[] (presence online/stale/offline, registrations[] {stale, unknown?}, warnings), apps[] (AppStatus + lastSeen; `registrationUnknown` + `label` for unknown registrations) }` |
| `GET /agent/console?regId=&appId=&afterSeq=&limit=200` or `?regId=&appId=&last=N` | session | `{ lines (ConsoleLine + rseq), nextSeq, droppedBefore? }`, all in `rseq`; `last` is exclusive with `afterSeq`/`limit` (400) and capped at 5,000 |
| `GET /agent/events?regId=&appId=[&last=N]` | session | SSE: `status` (on change + every 10 s), `lines` (id `<appKey>:<rseq>`); `Last-Event-ID` replay; `last=N` replays the newest N on connect and is ignored when `Last-Event-ID` is present |

**`seq` vs `rseq`:** the full read contract is in `../dev-overview/architecture/NOTE-ADDENDA-010-agent-contract.md`.

| | `seq` | `rseq` |
|---|---|---|
| Set by | the agent, per appKey | the front door, per appKey |
| Restarts at 1 | on every agent restart (hello without `resumeFrom`) | only when the front door restarts |
| Used for | de-duplication within one agent session | **all reads**: `afterSeq`, `nextSeq`, `droppedBefore`, SSE ids, `Last-Event-ID` |

- **Resume** (hello with `resumeFrom`): resent lines with `seq ≤ ackedSeq` are dropped, and `rseq` continues.
- **Agent restart:** `seq` restarts and de-duplication starts afresh, but `rseq` keeps increasing, so readers polling `afterSeq` see no gap or reset.
- **Front-door restart:** `rseq` starts at 1 again. `frontDoorStartedAt` (on `/agent/status` and every SSE `status` event) is set at process start and changes only on a restart.
  - **When it changes, readers reset their cursors**: drop `afterSeq` and `Last-Event-ID`, reopen the EventSource, and re-read with `last=N`.
  - After a page reload, also start with `last=N`.
- **`last=N`:** a positive integer, capped at the per-appKey ring (5,000); 0, negative or text → 400. On `/agent/events` it needs `regId` and `appId`.

**Sessions (§3):**
- Each `hello` issues a `sessionId` bound to the token's `oid` and the `agentId`.
- **v1.3: several sessions per `agentId`** (one per `dspwatch` process, plus an optional `dsp-agent`). A new hello does not end the others. A session is forgotten after `LIMITS.sessionIdleSec` (1 h) without traffic.
- **Resume:** a hello with `resumeFrom` continues, per appKey it names, the latest session of the same `agentId` + `oid` that streams that appKey. That session is retired (later use → `SESSION`), its de-duplication state carries over, and `welcome.ackedSeq` returns its acked seq. Without such a predecessor, the appKey starts afresh and `welcome.ackedSeq` omits it.
- **`APP_BUSY` (§W.5):** an `hb` that reports an app with `console: "streaming"`, or a `lines` batch for an appKey, while another **online** session (of any agent) streams that appKey → `error APP_BUSY` (HTTPS 409; WS keeps the socket open). Nothing from that message is stored. An hb that reports the app as `idle` (detection) is accepted. A wrapper's final hb (`stopped`/`idle`), its socket closing, or 15 s without its hb frees the appKey.
- **Claim check:** a successful WS `hb` has no reply, so `dspwatch` sends its claim hb followed by an empty `lines` batch. The `ack` comes after the hb was handled, so an `APP_BUSY` before the ack means the claim failed.
- **`/agent/status` union:** one entry per `agentId` (presence = best of its sessions, warnings = union of its non-offline sessions). Apps are unioned: per appKey, an online session streaming it wins, otherwise the freshest hb.
- `hb` and `lines` must carry `agentId` + `sessionId`. Over HTTPS they also need the `X-Agent-Id` / `X-Agent-Session` headers, which must equal the body.
- A mismatch or an unknown session gives `SESSION` (HTTPS 409); the agent then sends a new hello.
- `sessionId: "detect-only"` (what `dsp-agent --json` prints) is never a session and always gets `SESSION`.
- **WebSocket (v1.2.1):** a `SESSION` error keeps the socket open, but the third one in a row closes it with **4409**; a valid hb/lines resets the count. A socket without a valid hello within 30 s (`LIMITS.helloTimeoutMs`, injectable as `deps.agent.helloTimeoutMs`) is also closed with 4409.
- A `hb` whose `hbSeq` is not newer than the last one is dropped.
- A hello **without** `resumeFrom` starts a new agent session: de-duplication restarts for every appKey it writes, while the front door's per-appKey `rseq` keeps increasing for readers.

**Ingest auth (§6), checked in order:**
1. The ingest is **not configured** if any of these is missing: tenant, issuer, audiences, `AGENT_CLIENT_ID`, a JWKS source, `ALLOWED_OIDS`, `ALLOWED_EMAILS`. Then every ingest request gets **503 `NOT_CONFIGURED`**, so the agent backs off without refreshing its token.
2. Any `Cookie` header → 401. A bearer token is required.
3. The token must be RS256 and verify against the JWKS (remote and cached, refetched on an unknown `kid`, or static `AGENT_JWKS_JSON`). It must also have the configured `iss`, `aud` (`<web-client-id>` or `api://<web-client-id>`), `exp`/`nbf` within 120 s skew, and `tid`. Failing any of these → 401.
4. `scp` must contain `Agent.Ingest`, and `azp`/`appid` must equal `AGENT_CLIENT_ID` → else 401.
5. `oid` must be in `ALLOWED_OIDS` and `preferred_username`/`email` in `ALLOWED_EMAILS` → else 403.

The browser reads use the existing cookie gate and never accept a bearer token.

**Limits (§3/§5):**
- Batches: 500 lines or 256 KiB (measured on the UTF-8 encoded JSON message), 20 batches/s per session.
- Lines: 4 KiB. The front door applies the §6 redaction set again, then truncates.
- Ring per appKey: 5,000 lines / 2 MiB. The global cap is 32 MiB, and the oldest lines are evicted first.
- Backpressure starts when the **global** buffer is over 80%. Full per-appKey rings never trigger it.

**Registration staleness:** `registrations/` holds the checked-in registrations (refresh with `npm run sync-registrations` from `../dev-overview`).
- `stale: true` when the agent's sha256 differs.
- A registration id the front door doesn't have gets `stale: true, unknown: true`. Its statuses are still accepted, with `label: "registration not deployed to front door"`.

| Env | Value |
|---|---|
| `AGENT_CLIENT_ID` | app (client) id of `dsp-dev-overview-agent` (`416e14f6-406f-45f3-9284-2d7e4b41bd22`) |
| `ALLOWED_OIDS` | Bjor's object id in the Osilion tenant (required on the bearer path) |
| `AGENT_AUDIENCES` | optional; default `<AZURE_AD_CLIENT_ID>,api://<AZURE_AD_CLIENT_ID>` |
| `AGENT_TENANT_ID` / `AGENT_ISSUER` / `AGENT_JWKS_URL` | optional; default from `AZURE_AD_TENANT_ID` (`…/v2.0`, `…/discovery/v2.0/keys`) |
| `AGENT_JWKS_JSON` | optional static JWKS (tests/offline); takes precedence over the URL |
| `AGENT_SCOPE` | default `Agent.Ingest` |
| `AGENT_REGISTRATIONS_DIR` | default `registrations/` |

## Tests
`npm test` (node:test):
- `server.test.js`: upstream choice, key injection/stripping, health cache, BOX_OFFLINE, read-only fallback, allowlist fail-closed, signed sessions.
- `agent.test.js`:
  - agent auth: fail-closed, each bad claim, cookie rejection, locally signed test tokens;
  - browser read gating;
  - the WS and HTTPS ingest flows;
  - rate, backpressure, SSE, buffers, redaction and presence;
  - session binding, `hbSeq`, `rseq`, unknown registrations, UTF-8 batch size;
  - a contract check of the hello and heartbeats produced by the .NET agent (`test/fixtures/agent-ingest.v1.3.json`);
  - v1.3: stream/console enums, `APP_BUSY` over HTTPS and WS (incl. the claim check), multi-session union, resume lineage.
