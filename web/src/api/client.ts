import type {
  ApiErrorBody, DlqMessage, EntityStatus, FlowGraph, LogEvent, ProjectSummary, QueuePeek,
  SampleMessageCatalog, SampleSendRequest, SampleSendResult,
} from "./types";

export const API_BASE = "/api"; // Vite proxy → http://localhost:5090 (ADR-000)

export class ApiError extends Error {
  code: string; retryable: boolean; status: number;
  constructor(status: number, code: string, message: string, retryable: boolean) {
    super(message); this.status = status; this.code = code; this.retryable = retryable;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Free-tier Render API sleeps; front door returns 502/503 (API_UPSTREAM_COLD) while it wakes.
async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  try {
    return await reqOnce<T>(method, path, body);
  } catch (e) {
    if (e instanceof ApiError && isCold(e)) {
      await sleep(3000);
      try { return await reqOnce<T>(method, path, body); } catch (e2) {
        if (e2 instanceof ApiError && isCold(e2)) throw new ApiError(e2.status, "API_WAKING", "Overview API waking, retry in a few seconds…", true);
        throw e2;
      }
    }
    throw e;
  }
}
const isCold = (e: ApiError) => e.code === "API_UPSTREAM_COLD" || e.status === 502 || e.status === 503 || e.status === 504;
async function reqOnce<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      method, headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError(0, "API_UNREACHABLE", `Overview API unreachable (${(e as Error).message})`, true);
  }
  if (!res.ok) {
    let parsed: ApiErrorBody | null = null;
    try { parsed = await res.json(); } catch { /* not json */ }
    if (parsed?.error) throw new ApiError(res.status, parsed.error.code, parsed.error.message, parsed.error.retryable);
    // Vite proxy returns 500/502/504 when :5090 is down
    throw new ApiError(res.status, res.status >= 500 ? "API_UNREACHABLE" : "HTTP_" + res.status, `HTTP ${res.status} ${res.statusText}`, res.status >= 500);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
const p = (id: string) => `/projects/${encodeURIComponent(id)}`;
const e = (id: string) => encodeURIComponent(id);

export const api = {
  projects: () => req<ProjectSummary[]>("GET", "/projects"),
  refreshRegistration: (id: string) => req<ProjectSummary>("POST", `${p(id)}/registration/refresh`),
  flow: (id: string, scope: "local" | "all") => req<FlowGraph>("GET", `${p(id)}/flow?scope=${scope}`),
  saveFlowPositions: (id: string, pos: Record<string, { x: number; y: number }>) => req<unknown>("PUT", `${p(id)}/flow/positions`, pos),
  samples: (id: string) => req<SampleMessageCatalog>("GET", `${p(id)}/samples`),
  sendSamples: (id: string, body: SampleSendRequest) => req<SampleSendResult>("POST", `${p(id)}/samples/send`, body),
  purge: (id: string) => req<{ purged: number }>("POST", `${p(id)}/sb/purge`),
  entities: (id: string) => req<EntityStatus[]>("GET", `${p(id)}/sb/entities`),
  peek: (id: string, ent: string, max = 20) => req<QueuePeek>("GET", `${p(id)}/sb/${e(ent)}/peek?max=${max}`),
  dlq: (id: string, ent: string, max = 50) => req<DlqMessage[]>("GET", `${p(id)}/sb/${e(ent)}/dlq?max=${max}`),
  dlqRetry: (id: string, ent: string, seq: number[] | "all") => req<{ retried: number }>("POST", `${p(id)}/sb/${e(ent)}/dlq/retry`, { sequenceNumbers: seq }),
  dlqDiscard: (id: string, ent: string, seq: number[]) => req<unknown>("POST", `${p(id)}/sb/${e(ent)}/dlq/discard`, { sequenceNumbers: seq }),
  logs: (id: string, q: { roles?: string[]; since?: string; kql?: string }) => {
    const s = new URLSearchParams();
    if (q.roles?.length) s.set("roles", q.roles.join(","));
    if (q.since) s.set("since", q.since);
    if (q.kql) s.set("kql", q.kql);
    return req<LogEvent[]>("GET", `${p(id)}/logs?${s}`);
  },
  consoleStreamUrl: (id: string, appId: string) => `${API_BASE}${p(id)}/console/${e(appId)}/stream`,
  consoleStart: (id: string, appId: string) => req<{ attached: boolean }>("POST", `${p(id)}/console/${e(appId)}/start`),
  consoleStop: (id: string, appId: string) => req<{ attached: boolean }>("POST", `${p(id)}/console/${e(appId)}/stop`),
  /** ADDENDUM §2: server-side atomic restart. Never client stop→start. */
  consoleRestart: (id: string, appId: string) => req<{ attached: boolean }>("POST", `${p(id)}/console/${e(appId)}/restart`),
};
