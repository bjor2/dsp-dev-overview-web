// DEV ONLY. Scenario data for the AGENT_MOCK Vite plugin (dev/agent-mock-plugin.ts). Nothing under src/ imports this
// file, so it never lands in the bundle; it is typed against ../types so the mock cannot drift from the wire shapes.
import type { AgentAppStatus, AgentConsoleLine, AgentInfo, AgentStatus } from "../types.ts";

export const SCENARIOS = ["online", "stale", "offline", "503", "401", "flap", "notreported"] as const;
export type ScenarioName = (typeof SCENARIOS)[number];
export const isScenario = (s: string): s is ScenarioName => (SCENARIOS as readonly string[]).includes(s);

/** Scenarios that answer /agent/* with an HTTP error instead of a status. */
export const HTTP_SCENARIOS: Partial<Record<ScenarioName, { status: number; contentType: string; body: string }>> = {
  "503": { status: 503, contentType: "text/html; charset=utf-8", body: "<!doctype html><title>Auth not configured</title><h1>Auth not configured</h1><p>Entra settings are missing.</p>" },
  "401": { status: 401, contentType: "application/json; charset=utf-8", body: JSON.stringify({ error: "UNAUTHENTICATED" }) },
};
/** Scenarios whose console ring keeps growing (one line every 250 ms on price.dev/app:functions). */
export const STREAMING: readonly ScenarioName[] = ["online", "flap", "notreported"];

export const MOCK_AGENT_ID = "agent-bjor-pc";
export const TAILED = { regId: "price.dev", appId: "app:functions", source: "stdout" } as const;

const iso = (ms: number) => new Date(ms).toISOString();

function agent(now: number, s: ScenarioName): AgentInfo {
  const ageSec = s === "stale" ? 20 : s === "offline" ? 120 : 3;
  return {
    agentId: MOCK_AGENT_ID, host: "bjor-pc (mock)", version: "0.3.0-mock", connectedVia: "ws",
    lastHeartbeat: iso(now - ageSec * 1000),
    presence: s === "stale" ? "stale" : s === "offline" ? "offline" : "online",
    registrations: [
      { id: "customerproject.dev", sha256: "c0ffee".padEnd(64, "0"), stale: false },
      { id: "price.dev", sha256: "beef".padEnd(64, "0"), stale: false },
    ],
    warnings: [],
  };
}

function apps(now: number, s: ScenarioName): AgentAppStatus[] {
  const lastSeen = iso(now - (s === "offline" ? 120 : s === "stale" ? 20 : 3) * 1000);
  const base = { lastSeen, agentId: MOCK_AGENT_ID };
  const started = iso(now - 42 * 60_000);
  const list: AgentAppStatus[] = [
    { ...base, regId: "customerproject.dev", appId: "app:api", state: "running", console: "unavailable", pid: 7001, startedAt: started, ports: [{ port: 5011, state: "listening" }], matchedBy: ["processName", "port"] },
    { ...base, regId: "customerproject.dev", appId: "app:functions", state: "running", console: "unavailable", pid: 7002, startedAt: started, ports: [{ port: 7239, state: "listening" }], matchedBy: ["commandLine"] },
    { ...base, regId: "customerproject.dev", appId: "app:ingress", state: "starting", console: "unavailable", pid: 7003, ports: [{ port: 7240, state: "notListening" }], matchedBy: ["commandLine"] },
    {
      ...base, regId: "price.dev", appId: "app:api", state: "stopped", console: "unavailable",
      ports: [{ port: 52160, state: "busyByOther" }, { port: 52161, state: "busyByOther" }],
      portBusyByOther: [{ port: 52160, pid: 4000, name: "dotnet" }, { port: 52161, pid: 4000, name: "dotnet" }],
    },
    // v1.1 wire shape on purpose (number[] + listeningPorts): the client must accept both.
    { ...base, regId: "price.dev", appId: "app:api-batch", state: "running", console: "unavailable", pid: 7020, startedAt: started, ports: [52171], listeningPorts: [52171], matchedBy: ["processName"] },
    { ...base, regId: "price.dev", appId: "app:functions", state: "running", console: "tailing", pid: 7010, startedAt: started, ports: [{ port: 7073, state: "listening" }], matchedBy: ["commandLine", "port"] },
    { ...base, regId: "price.dev", appId: "app:ingress", state: "unknown", console: "unavailable", reason: "no commandLineContains" },
  ];
  return s === "notreported" ? list.filter((a) => !(a.regId === "customerproject.dev" && a.appId === "app:ingress")) : list;
}

/** /agent/status body for a scenario, or null when the scenario answers with an HTTP error. */
export function scenarioStatus(s: ScenarioName, now: number): AgentStatus | null {
  if (HTTP_SCENARIOS[s]) return null;
  return { agents: [agent(now, s)], apps: apps(now, s) };
}

const FUNCS = ["PriceQueueHandler", "PriceBatchHandler", "CustomerAgreementHeadHandler", "SalePriceListHandler"];
const ESC = "\x1b";
const OSLO = new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const osloClock = (ms: number) => `${OSLO.format(new Date(ms))}.${String(new Date(ms).getMilliseconds()).padStart(3, "0")}`;

/** Unhandled exception as the .NET console logger writes it: `fail:` header, indented message, then 12 frame lines. */
const STACK = [
  "      System.InvalidOperationException: Sequence contains no elements",
  "         at System.Linq.ThrowHelper.ThrowNoElementsException()",
  "         at System.Linq.Enumerable.First[TSource](IEnumerable`1 source)",
  "         at Dsp.Price.Ingress.PriceRouter.Resolve(String customerId) in C:\\src\\dsp-price\\Ingress\\PriceRouter.cs:line 87",
  "         at Dsp.Price.Ingress.PriceRouter.HandleAsync(HttpContext ctx) in C:\\src\\dsp-price\\Ingress\\PriceRouter.cs:line 41",
  "      --- End of stack trace from previous location ---",
  "         at Microsoft.AspNetCore.Routing.EndpointMiddleware.<Invoke>g__AwaitRequestTask|7_0(Endpoint endpoint, Task requestTask, ILogger logger)",
  "         at Microsoft.AspNetCore.Authorization.AuthorizationMiddleware.Invoke(HttpContext context)",
  "         at Microsoft.AspNetCore.Authentication.AuthenticationMiddleware.Invoke(HttpContext context)",
  "         at Microsoft.AspNetCore.Server.Kestrel.Core.Internal.Http.HttpProtocol.ProcessRequests[TContext](IHttpApplication`1 application)",
  "      --- End of stack trace from previous location ---",
  "         at Yarp.ReverseProxy.Forwarder.HttpForwarder.SendAsync(HttpContext context, String destinationPrefix)",
  "         at Microsoft.AspNetCore.Server.Kestrel.Core.Internal.Http.HttpProtocol.ProcessRequests[TContext](IHttpApplication`1 application)",
];

/**
 * The polish block: lines 5..35 of every 50 carry what the console has to clean up (ANSI with and without ESC, an
 * exception with a folded stack, the app's own timestamp echoing `ts`, ANSI-only red / yellow). Null = ordinary line.
 */
function polishLine(n: number, now: number): string | null {
  const k = n % 50;
  if (k === 5) return `${ESC}[90m[ingress]${ESC}[39;49m ${ESC}[32mGET${ESC}[39m /api/price/customer/1042 ${ESC}[1m200${ESC}[22m ${ESC}[90m12 ms${ESC}[0m`;
  if (k === 7) return "[39;49m[90m[ingress][39m [33mwarn[39m: upstream price-api slow (1 840 ms), retrying[0m";
  if (k === 9) return "[41m[30mfail[39m[22m[49m: Microsoft.AspNetCore.Server.Kestrel[13]";
  if (k === 10) return `      Connection id "0HN8K${n}", Request id "0HN8K${n}:00000002": An unhandled exception was thrown by the application.`;
  if (k >= 11 && k < 11 + STACK.length) return STACK[k - 11];
  if (k === 25) return `${osloClock(now)} [90minfo[39m: price batch tick (${n} queued)`;
  if (k === 27) return `[${new Date(now).toISOString().slice(11, 19)} INF] Leasing partition ${n % 8} for queue 'price'`;
  if (k === 29) return `${ESC}[33mlock renewal for 'price' took 4.1 s${ESC}[39m`;
  if (k === 31) return `${ESC}[31mprice-api answered 502 Bad Gateway${ESC}[39m`;
  if (k === 33) return `Executed 'Functions.${FUNCS[n % FUNCS.length]}' (Failed, Id=${(n * 2654435761 >>> 0).toString(16)}, Duration=${(n * 37) % 900 + 12}ms)`;
  return null;
}

/**
 * Line number `n` (1-based reader seq) of the app's dspwatch output. Every 40th carries a redacted secret, every 100th
 * is 4 KiB and truncated, every 500th is the agent's own drop notice. `agentSeq` restarts every 1000 lines (as if
 * the agent restarted, announced by an `[agent]` line) so a client that keys on `seq` instead of `rseq` breaks
 * visibly. Lines 5..35 of every 50 come from polishLine.
 */
export function mockLine(n: number, now: number): AgentConsoleLine {
  const fn = FUNCS[n % FUNCS.length];
  let line: string;
  let redacted = false;
  let truncated = false;
  const polish = polishLine(n, now);
  if (n % 500 === 0) line = "[agent] dropped 12 lines";
  else if (n > 1 && n % 1000 === 1) line = `[agent] dspwatch restarted app:functions (pid ${7010 + Math.floor(n / 1000)})`;
  else if (polish !== null) line = polish;
  else if (n % 100 === 0) { line = `Executing 'Functions.${fn}' payload dump: ` + "x".repeat(4096 - 40); truncated = true; }
  else if (n % 40 === 0) { line = `Endpoint=sb://sb-870-dev-euw-dahl.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=***`; redacted = true; }
  else if (n % 2 === 0) line = `Executed 'Functions.${fn}' (Succeeded, Id=${(n * 2654435761 >>> 0).toString(16)}, Duration=${(n * 37) % 900 + 12}ms)`;
  else line = `Executing 'Functions.${fn}' (Reason='New ServiceBus message detected on 'price'.', Id=${(n * 2654435761 >>> 0).toString(16)})`;
  return {
    seq: ((n - 1) % 1000) + 1, rseq: n, ts: new Date(now).toISOString(),
    regId: TAILED.regId, appId: TAILED.appId, stream: "file", source: TAILED.source, line, truncated, redacted,
  };
}
