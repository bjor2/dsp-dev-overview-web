// Per-app agent console (§2): attach to /agent/events?regId&appId while the agent reports the app, backfill from
// /agent/console, resume with Last-Event-ID after a drop, keep a capped buffer and the auto-scroll state.
import { useEffect, useReducer, useRef, useState } from "react";
import { HTTP_PROBE_MS, backoff } from "./backoff";
import { appAgentView, type AppAgentView, type ConsoleUnavailableReason } from "./derive";
import { openSse } from "./sse";
import { useAgentStatus, useNow } from "./statusFeed";
import { appKey, isConsoleLine, readerSeq, type AgentConsoleLine, type AgentConsoleRead } from "./types";

export const MAX_LINES = 5000; // the front-door ring size
export const MAX_CHARS = 2_000_000;
const FLUSH_MS = 100;
const BACKFILL_PAGE = 1000;

export type ConsolePhase =
  | { phase: "checking" } // no feed snapshot yet (≤ 3 s), then falls to unavailable
  | { phase: "unavailable"; reason: ConsoleUnavailableReason; detail?: string; lastSeen?: string }
  | { phase: "attaching"; attempt: number } // SSE opening (+ backfill in flight)
  | { phase: "live"; since: number }
  | { phase: "reconnecting"; attempt: number; retryAt: number };

/** A buffered row: an agent line (sorted by reader seq) or a UI system note (sorted right after the seq it follows). */
export type ConsoleEntry =
  | { kind: "line"; key: number; seq: number; line: AgentConsoleLine }
  | { kind: "system"; key: number; id: string; text: string; sticky?: boolean };

export interface ConsoleState {
  phase: ConsolePhase;
  lines: ConsoleEntry[]; // capped ring (MAX_LINES / MAX_CHARS)
  chars: number;
  lastSeq: number; // highest reader seq seen → Last-Event-ID / afterSeq
  droppedByBuffer: number; // client-side ring drops
  droppedBefore?: number; // server-side ring drop marker
  follow: boolean;
  pending: number; // lines received while paused
  sysCount: number;
  /** Set by Clear: lines at or below it never come back (a late backfill page cannot re-fill a cleared console). */
  floorSeq: number;
}

export type ConsoleAction =
  | { type: "attaching"; attempt: number }
  | { type: "live"; since: number }
  | { type: "reconnecting"; attempt: number; retryAt: number }
  | { type: "unavailable"; reason: ConsoleUnavailableReason; detail?: string; lastSeen?: string }
  | { type: "lines"; lines: AgentConsoleLine[]; droppedBefore?: number }
  | { type: "system"; text: string }
  | { type: "clear" }
  | { type: "follow"; on: boolean };

export const initialConsoleState = (): ConsoleState => ({
  phase: { phase: "checking" }, lines: [], chars: 0, lastSeq: 0, droppedByBuffer: 0, follow: true, pending: 0, sysCount: 0, floorSeq: 0,
});

const entryChars = (e: ConsoleEntry) => (e.kind === "line" ? e.line.line.length : e.text.length);

function addSystem(s: ConsoleState, text: string, key = s.lastSeq + 0.5, sticky = false): ConsoleState {
  const e: ConsoleEntry = { kind: "system", key, id: `sys-${s.sysCount + 1}`, text, sticky };
  const lines = s.lines.length && s.lines[s.lines.length - 1].key > key ? sortEntries([...s.lines, e]) : [...s.lines, e];
  return trim({ ...s, lines, chars: s.chars + text.length, sysCount: s.sysCount + 1 });
}
const sortEntries = (xs: ConsoleEntry[]) => xs.sort((a, b) => a.key - b.key);

/**
 * Push + trim from the front so the buffer never exceeds MAX_LINES rows or MAX_CHARS characters. The front-door
 * "older lines dropped" marker is sticky: it sits before the oldest line and must survive the trim it precedes.
 */
function trim(s: ConsoleState): ConsoleState {
  let excess = Math.max(0, s.lines.reduce((n, e) => n + (e.kind === "line" ? 1 : 0), 0) - MAX_LINES); // agent lines, not UI notes
  let chars = s.chars;
  if (!excess && chars <= MAX_CHARS) return s;
  const kept: ConsoleEntry[] = [];
  let gone = 0;
  for (const e of s.lines) {
    if ((excess > 0 || chars > MAX_CHARS) && !(e.kind === "system" && e.sticky)) {
      chars -= entryChars(e);
      if (e.kind === "line") { gone += 1; excess -= 1; }
      continue;
    }
    kept.push(e);
  }
  return { ...s, lines: kept, chars, droppedByBuffer: s.droppedByBuffer + gone };
}

/** Merge new agent lines (live events or backfill): dedup by reader seq, keep seq order, trim, count while paused. */
function mergeLines(s: ConsoleState, incoming: AgentConsoleLine[], droppedBefore?: number): ConsoleState {
  let next = s;
  if (droppedBefore !== undefined && droppedBefore !== s.droppedBefore) {
    next = addSystem({ ...next, droppedBefore }, `[front door] older lines dropped before seq ${droppedBefore}`, droppedBefore - 0.5, true);
  }
  if (!incoming.length) return next;
  const fresh: ConsoleEntry[] = [];
  let seen: Set<number> | null = null;
  let needSort = false;
  let lastSeq = next.lastSeq;
  for (const line of incoming) {
    const seq = readerSeq(line);
    if (seq <= lastSeq) {
      // Older than the newest line we hold (backfill or a replay): only keep it if we do not have it yet.
      seen ??= new Set(next.lines.filter((e) => e.kind === "line").map((e) => e.seq));
      if (seen.has(seq) || seq <= next.floorSeq) continue;
      seen.add(seq);
      needSort = true;
    }
    fresh.push({ kind: "line", key: seq, seq, line });
    lastSeq = Math.max(lastSeq, seq);
  }
  if (!fresh.length) return next;
  const lines = needSort ? sortEntries([...next.lines, ...fresh]) : [...next.lines, ...fresh];
  const chars = next.chars + fresh.reduce((n, e) => n + entryChars(e), 0);
  return trim({ ...next, lines, chars, lastSeq, pending: next.follow ? 0 : next.pending + fresh.length });
}

const endedText = (reason: ConsoleUnavailableReason) =>
  reason === "agent-offline" ? "agent offline"
    : reason === "app-not-reported" ? "app no longer reported"
      : reason === "status-stale" ? "no agent status for 30 s"
        : reason;

export function consoleReducer(s: ConsoleState, a: ConsoleAction): ConsoleState {
  switch (a.type) {
    case "attaching":
      return { ...s, phase: { phase: "attaching", attempt: a.attempt } };
    case "live":
      return { ...s, phase: { phase: "live", since: a.since } };
    case "reconnecting": {
      const n = { ...s, phase: { phase: "reconnecting", attempt: a.attempt, retryAt: a.retryAt } as ConsolePhase };
      return s.phase.phase === "live" ? addSystem(n, "[ui] stream lost, reconnecting") : n;
    }
    case "unavailable": {
      const p = s.phase;
      if (p.phase === "unavailable" && p.reason === a.reason && p.lastSeen === a.lastSeen && p.detail === a.detail) return s;
      const n = { ...s, phase: { phase: "unavailable", reason: a.reason, detail: a.detail, lastSeen: a.lastSeen } as ConsolePhase };
      return p.phase === "live" || p.phase === "reconnecting" ? addSystem(n, `[ui] ${endedText(a.reason)}, stream ended`) : n;
    }
    case "lines":
      return mergeLines(s, a.lines, a.droppedBefore);
    case "system":
      return addSystem(s, a.text);
    case "clear": // keeps lastSeq, so Clear never replays history
      return { ...s, lines: [], chars: 0, pending: 0, droppedByBuffer: 0, floorSeq: s.lastSeq };
    case "follow":
      return a.on === s.follow && (a.on ? s.pending === 0 : true) ? s : { ...s, follow: a.on, pending: a.on ? 0 : s.pending };
  }
}

const qs = (regId: string, appId: string) => `regId=${encodeURIComponent(regId)}&appId=${encodeURIComponent(appId)}`;

/**
 * Scrollback + gap fill. The front door returns the OLDEST `limit` lines after `afterSeq`, so page forward until a
 * short page (at most MAX_LINES / 1000 pages: the buffer cannot hold more).
 */
async function backfill(regId: string, appId: string, afterSeq: number, signal: AbortSignal): Promise<{ lines: AgentConsoleLine[]; droppedBefore?: number }> {
  const out: AgentConsoleLine[] = [];
  let droppedBefore: number | undefined;
  let cursor = afterSeq;
  for (let page = 0; page < MAX_LINES / BACKFILL_PAGE; page++) {
    const res = await fetch(`/agent/console?${qs(regId, appId)}&afterSeq=${cursor}&limit=${BACKFILL_PAGE}`, {
      headers: { Accept: "application/json" }, cache: "no-store", credentials: "same-origin", signal,
    });
    if (!res.ok || !(res.headers.get("Content-Type") ?? "").includes("application/json")) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as AgentConsoleRead;
    if (!Array.isArray(body?.lines)) throw new Error("bad payload");
    out.push(...body.lines.filter(isConsoleLine));
    droppedBefore ??= body.droppedBefore;
    if (body.lines.length < BACKFILL_PAGE || !(body.nextSeq > cursor)) break;
    cursor = body.nextSeq;
  }
  return { lines: out, droppedBefore };
}

export interface AppConsole {
  state: ConsoleState;
  view: AppAgentView;
  dispatch: (a: ConsoleAction) => void;
}

export function useAppConsole(regId: string, appId: string, enabled = true): AppConsole {
  const [state, dispatch] = useReducer(consoleReducer, undefined, initialConsoleState);
  const snap = useAgentStatus(enabled);
  const now = useNow(1000);
  const view = appAgentView(snap, regId, appId, Math.max(now, snap.receivedAt));
  const [grace, setGrace] = useState(true);
  useEffect(() => {
    const t = window.setTimeout(() => setGrace(false), 3000);
    return () => window.clearTimeout(t);
  }, []);
  const lastSeqRef = useRef(0);
  lastSeqRef.current = state.lastSeq;

  const want = enabled && view.kind === "reported";
  const offReason = !enabled ? "no-snapshot" : view.kind === "offline" ? view.reason : null;
  const offLastSeen = view.kind === "offline" ? view.lastSeen : undefined;

  // Feed says the app cannot be attached → unavailable (the attach effect's cleanup has already aborted the SSE).
  useEffect(() => {
    if (!offReason) return;
    if (offReason === "no-snapshot" && grace && enabled) return; // still "checking"
    dispatch({ type: "unavailable", reason: offReason, lastSeen: offLastSeen });
  }, [offReason, offLastSeen, grace, enabled]);

  // Attach while the agent reports the app (presence online or stale). `probe` re-runs it after an HTTP failure.
  const [probe, setProbe] = useState(0);
  useEffect(() => {
    if (!want) return;
    let cancelled = false;
    let ctrl: AbortController | null = null;
    let timer = 0;
    let flushTimer = 0;
    let queue: AgentConsoleLine[] = [];
    let queuedDrop: number | undefined;
    const flush = () => {
      window.clearTimeout(flushTimer);
      flushTimer = 0;
      if (!queue.length && queuedDrop === undefined) return;
      dispatch({ type: "lines", lines: queue, droppedBefore: queuedDrop });
      queue = [];
      queuedDrop = undefined;
    };
    const key = appKey(regId, appId);

    const run = async (attempt: number) => {
      dispatch({ type: "attaching", attempt });
      const c = new AbortController();
      ctrl = c;
      const after = lastSeqRef.current;
      let opened = false;
      // Backfill in parallel with the SSE; SSE lines that arrive first are buffered and merged by seq.
      backfill(regId, appId, after, c.signal).then(
        (b) => { if (!cancelled && ctrl === c) { flush(); dispatch({ type: "lines", lines: b.lines, droppedBefore: b.droppedBefore }); } },
        () => { if (!cancelled && ctrl === c && !c.signal.aborted) dispatch({ type: "system", text: "[ui] history unavailable" }); },
      );
      const close = await openSse({
        url: `/agent/events?${qs(regId, appId)}`,
        lastEventId: after > 0 ? `${key}:${after}` : undefined,
        signal: c.signal,
        onOpen: () => { opened = true; dispatch({ type: "live", since: Date.now() }); },
        onEvent: (ev) => {
          if (ev.event !== "lines") return;
          try {
            const d = JSON.parse(ev.data) as { lines?: unknown[]; droppedBefore?: number };
            for (const l of d.lines ?? []) if (isConsoleLine(l) && l.regId === regId && l.appId === appId) queue.push(l);
            if (typeof d.droppedBefore === "number") queuedDrop = d.droppedBefore;
          } catch { /* ignore a malformed frame */ }
          if (!flushTimer) flushTimer = window.setTimeout(flush, FLUSH_MS);
        },
      });
      if (cancelled) return;
      flush();
      if (close.kind === "aborted") return;
      if (close.kind === "http") {
        // No SSE retry loop: probe again in 30 s (the status feed normally flips first and drives recovery).
        dispatch({ type: "unavailable", reason: close.reason, detail: `HTTP ${close.status}` });
        timer = window.setTimeout(() => setProbe((p) => p + 1), HTTP_PROBE_MS);
        return;
      }
      const next = opened ? 1 : attempt + 1;
      const delay = backoff(next);
      dispatch({ type: "reconnecting", attempt: next, retryAt: Date.now() + delay });
      timer = window.setTimeout(() => { if (!cancelled) void run(next); }, delay);
    };
    void run(1);
    return () => {
      cancelled = true;
      ctrl?.abort();
      window.clearTimeout(timer);
      flush();
    };
  }, [want, regId, appId, probe]);

  return { state, view, dispatch };
}
