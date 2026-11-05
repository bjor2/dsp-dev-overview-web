// One shared, unfiltered GET /agent/events for the whole SPA (list page, detail header, console, flow). Opened when the
// first subscriber mounts, closed 5 s after the last one leaves. Consumed through useSyncExternalStore.
import { useCallback, useSyncExternalStore } from "react";
import { HTTP_PROBE_MS, backoff } from "./backoff";
import { openSse } from "./sse";
import { isAgentStatus, type AgentStatus, type UnavailableReason } from "./types";

export const AGENT_EVENTS_URL = "/agent/events";

export type AgentLink =
  | { kind: "idle" }
  | { kind: "connecting"; attempt: number }
  | { kind: "open"; since: number }
  | { kind: "reconnecting"; attempt: number; retryAt: number; lastError: string }
  | { kind: "unavailable"; reason: UnavailableReason; httpStatus?: number; retryAt: number; attempt: number };
export interface FeedSnapshot { link: AgentLink; status: AgentStatus | null; receivedAt: number }

const IDLE: FeedSnapshot = { link: { kind: "idle" }, status: null, receivedAt: 0 };
let snap: FeedSnapshot = IDLE;
const listeners = new Set<() => void>();
let subscribers = 0;
let ctrl: AbortController | null = null;
let retryTimer = 0;
let closeTimer = 0;
let resetTimer = 0;
let attempt = 0;

const set = (p: Partial<FeedSnapshot>) => {
  snap = { ...snap, ...p };
  listeners.forEach((l) => l());
};

function connect() {
  window.clearTimeout(retryTimer);
  ctrl?.abort();
  const c = new AbortController();
  ctrl = c;
  attempt += 1;
  set({ link: { kind: "connecting", attempt } });
  let opened = false;
  let badPayload = false;
  void openSse({
    url: AGENT_EVENTS_URL,
    signal: c.signal,
    onOpen: () => {
      opened = true;
      set({ link: { kind: "open", since: Date.now() } });
      window.clearTimeout(resetTimer);
      resetTimer = window.setTimeout(() => { attempt = 0; }, 10_000); // open for > 10 s → attempt counter reset
    },
    onEvent: (ev) => {
      if (ev.event !== "status") return;
      let data: unknown;
      try { data = JSON.parse(ev.data); } catch { data = undefined; }
      if (isAgentStatus(data)) set({ status: data, receivedAt: Date.now() });
      else { badPayload = true; c.abort(); }
    },
  }).then((close) => {
    window.clearTimeout(resetTimer);
    if (ctrl !== c) return; // superseded or stopped
    const now = Date.now();
    if (badPayload || close.kind === "http") {
      const reason: UnavailableReason = badPayload ? "bad-payload" : close.kind === "http" ? close.reason : "server-error";
      set({ link: { kind: "unavailable", reason, httpStatus: close.kind === "http" ? close.status : undefined, retryAt: now + HTTP_PROBE_MS, attempt } });
      retryTimer = window.setTimeout(connect, HTTP_PROBE_MS);
      return;
    }
    if (close.kind === "aborted") return;
    if (opened) attempt = 1; // open → stream closed / error / 35 s silence → reconnecting(1)
    const delay = backoff(attempt);
    set({ link: { kind: "reconnecting", attempt, retryAt: now + delay, lastError: close.kind === "network" ? close.message : "stream ended" } });
    retryTimer = window.setTimeout(connect, delay);
  });
}

function onVisible() {
  if (document.visibilityState !== "visible") return;
  const k = snap.link.kind;
  if (k === "reconnecting" || k === "unavailable") connect();
}

function stop() {
  window.clearTimeout(retryTimer);
  window.clearTimeout(resetTimer);
  const c = ctrl;
  ctrl = null;
  c?.abort();
  attempt = 0;
  document.removeEventListener("visibilitychange", onVisible);
  snap = IDLE;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  subscribers += 1;
  window.clearTimeout(closeTimer);
  if (snap.link.kind === "idle" && !ctrl) {
    document.addEventListener("visibilitychange", onVisible);
    connect();
  }
  return () => {
    listeners.delete(l);
    subscribers -= 1;
    if (subscribers === 0) closeTimer = window.setTimeout(stop, 5000);
  };
}
const noSubscribe = () => () => {};
const getSnapshot = () => snap;
const getIdle = () => IDLE;

/** Live agent feed. `enabled = false` (demo mode) never opens the connection and returns the idle snapshot. */
export function useAgentStatus(enabled = true): FeedSnapshot {
  return useSyncExternalStore(enabled ? subscribe : noSubscribe, enabled ? getSnapshot : getIdle);
}

// ---- shared tickers: one interval per period for every component that needs "now" -----------------------------
const tickers = new Map<number, { now: number; listeners: Set<() => void>; timer: number }>();
function tickerSubscribe(ms: number, l: () => void) {
  let t = tickers.get(ms);
  if (!t) {
    const nt = { now: Date.now(), listeners: new Set<() => void>(), timer: 0 };
    nt.timer = window.setInterval(() => { nt.now = Date.now(); nt.listeners.forEach((f) => f()); }, ms);
    tickers.set(ms, nt);
    t = nt;
  }
  t.listeners.add(l);
  return () => {
    const cur = tickers.get(ms);
    if (!cur) return;
    cur.listeners.delete(l);
    if (cur.listeners.size === 0) { window.clearInterval(cur.timer); tickers.delete(ms); }
  };
}
/** Before the first subscription: a cached clock value, so getSnapshot is stable within one render. */
const unsubscribedNow = new Map<number, number>();
function tickerNow(ms: number) {
  const t = tickers.get(ms);
  if (t) return t.now;
  const cached = unsubscribedNow.get(ms);
  if (cached !== undefined && Date.now() - cached < ms) return cached;
  const now = Date.now();
  unsubscribedNow.set(ms, now);
  return now;
}
/** Browser clock, re-rendered every `ms` (default 5 s) from one shared interval. */
export function useNow(ms = 5000): number {
  const sub = useCallback((l: () => void) => tickerSubscribe(ms, l), [ms]);
  const get = useCallback(() => tickerNow(ms), [ms]);
  return useSyncExternalStore(sub, get);
}
