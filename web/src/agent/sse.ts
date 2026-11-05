// Small SSE reader over fetch + ReadableStream. Not EventSource: that hides the HTTP status (503 vs 401 vs HTML look
// the same), reconnects on its own schedule, and a recreated instance does not send Last-Event-ID.
// Deliberately not api/client.ts req(): that redirects to /auth/login on 401 and retries 503 as "API waking".
import type { UnavailableReason } from "./types";

export interface SseEvent { event: string; data: string; id?: string }
export interface SseOpen {
  url: string; lastEventId?: string; signal: AbortSignal;
  /** Close as `network` when nothing (not even a status frame) arrives for this long. Default 35 s. */
  idleMs?: number;
  onOpen(): void; onEvent(ev: SseEvent): void;
}
export type SseClose =
  | { kind: "ended" } | { kind: "aborted" } | { kind: "network"; message: string }
  | { kind: "http"; status: number; contentType: string | null; reason: UnavailableReason };

export function classify(status: number, contentType: string | null): UnavailableReason {
  if (status === 503) return "not-configured-503";
  if (status === 401) return "unauthenticated-401";
  if (status === 403) return "forbidden-403";
  if (status === 404) return "not-served";
  const ct = (contentType ?? "").toLowerCase();
  if (status >= 200 && status < 300 && !ct.includes("text/event-stream") && !ct.includes("application/json")) return "not-served";
  return "server-error";
}

export async function openSse(o: SseOpen): Promise<SseClose> {
  let res: Response;
  try {
    res = await fetch(o.url, {
      headers: { Accept: "text/event-stream", ...(o.lastEventId ? { "Last-Event-ID": o.lastEventId } : {}) },
      cache: "no-store", credentials: "same-origin", signal: o.signal,
    });
  } catch (e) {
    return o.signal.aborted ? { kind: "aborted" } : { kind: "network", message: (e as Error).message };
  }
  const ct = res.headers.get("Content-Type");
  if (!res.ok || !(ct ?? "").toLowerCase().includes("text/event-stream") || !res.body) {
    res.body?.cancel().catch(() => {});
    // A 200 that is not an event stream (Vite's index.html fallback, a JSON body) means /agent/events is not served here.
    return { kind: "http", status: res.status, contentType: ct, reason: res.ok ? "not-served" : classify(res.status, ct) };
  }
  o.onOpen();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let idle = false;
  let idleTimer = 0;
  const arm = () => {
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => { idle = true; reader.cancel().catch(() => {}); }, o.idleMs ?? 35_000);
  };
  let buf = "";
  let ev: { event?: string; data: string[]; id?: string } = { data: [] };
  const dispatch = () => {
    if (ev.data.length) o.onEvent({ event: ev.event || "message", data: ev.data.join("\n"), id: ev.id });
    ev = { data: [] };
  };
  arm();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm();
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.search(/\r\n|\r|\n/)) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + (buf[nl] === "\r" && buf[nl + 1] === "\n" ? 2 : 1));
        if (line === "") { dispatch(); continue; }
        if (line.startsWith(":")) continue;
        const c = line.indexOf(":");
        const field = c < 0 ? line : line.slice(0, c);
        const val = c < 0 ? "" : line.slice(c + 1).replace(/^ /, "");
        if (field === "event") ev.event = val;
        else if (field === "data") ev.data.push(val);
        else if (field === "id") ev.id = val;
      }
    }
  } catch (e) {
    if (o.signal.aborted) return { kind: "aborted" };
    return { kind: "network", message: idle ? "no event for 35 s" : (e as Error).message };
  } finally {
    window.clearTimeout(idleTimer);
  }
  if (o.signal.aborted) return { kind: "aborted" };
  return idle ? { kind: "network", message: "no event for 35 s" } : { kind: "ended" };
}
