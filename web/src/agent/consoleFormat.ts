// Display model for the agent console: ANSI → segments, the app's own timestamp prefix dropped when it echoes the
// agent's `ts`, a level per line, stack frames folded under the line they belong to, and runs split at restarts.
// Pure: AgentConsolePanel renders whatever buildRows returns.
import { dropChars, parseAnsi, segmentsText, type AnsiSegment } from "./ansi";
import type { AgentConsoleLine } from "./types";
import type { ConsoleEntry } from "./useAppConsole";

export type Level = "error" | "warn" | "info";
export type LevelFilter = "all" | "warn" | "error";

export interface FormattedLine {
  segs: AnsiSegment[];
  /** Plain text after ANSI and timestamp stripping. */
  text: string;
  level: Level;
  stack: boolean;
  /** `[agent] …` notes from the agent itself. */
  agent: boolean;
}

const OSLO_TIME = new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
/** Oslo wall clock with milliseconds: 15:02:11.123 */
export const fmtTs = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${OSLO_TIME.format(d)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};

// ---- timestamp echo ------------------------------------------------------------------------------------------------

/**
 * A leading time the app wrote itself: `15:02:11`, `15:02:11.123`, `2026-11-05T14:02:11.123Z`, `2026-11-05 15:02:11,123`,
 * optionally bracketed and optionally carrying a Serilog-style level (`[15:02:11 INF]`, which keeps `[INF]`).
 */
const TS_PREFIX = /^\s*(\[)?(?:\d{4}-\d{2}-\d{2}[T ])?(\d{2}):(\d{2}):(\d{2})(?:[.,]\d{1,7})?(?:Z|[+-]\d{2}:?\d{2})?(?: ([A-Z]{3,5}))?(\])?(?:\s*[|-]\s+|:\s+|\s+|$)/;
const ECHO_TOLERANCE_SEC = 120;
const DAY = 86_400;

const secOfDay = (h: number, m: number, s: number) => h * 3600 + m * 60 + s;
/** Time of day of `d` in Oslo, UTC and the browser zone: an app may log in any of them. */
function candidateSecs(d: Date): number[] {
  const oslo = OSLO_TIME.formatToParts(d);
  const part = (t: string) => Number(oslo.find((p) => p.type === t)?.value ?? NaN);
  return [
    secOfDay(part("hour") % 24, part("minute"), part("second")),
    secOfDay(d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()),
    secOfDay(d.getHours(), d.getMinutes(), d.getSeconds()),
  ];
}

/** Remove the app's own time prefix when it is within two minutes of the agent's `ts` (the `.ts` column shows it). */
export function stripEchoedTimestamp(segs: AnsiSegment[], ts: string): AnsiSegment[] {
  const text = segmentsText(segs);
  const m = TS_PREFIX.exec(text);
  if (!m) return segs;
  const [whole, open, hh, mm, ss, lvl, close] = m;
  if (!open !== !close) return segs;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return segs;
  const t = secOfDay(Number(hh), Number(mm), Number(ss));
  const near = candidateSecs(d).some((c) => { const diff = Math.abs(c - t); return Math.min(diff, DAY - diff) <= ECHO_TOLERANCE_SEC; });
  if (!near) return segs;
  const rest = dropChars(segs, whole.length);
  return lvl ? [{ text: open ? `[${lvl}] ` : `${lvl} `, cls: "" }, ...rest] : rest;
}

// ---- level ---------------------------------------------------------------------------------------------------------

/** An explicit level at the start of the line wins over keywords further in (`warn: … retrying after exception`). */
const LEVEL_PREFIX = /^\s*\[?(fail|crit|critical|error|err|eror|ftl|fatal|warn|warning|wrn|info|inf|information|dbug|dbg|debug|trce|trace|verbose|vrb)\]?(?::|\s|$)/i;
const ERROR_WORDS = /\b(?:fail(?:s|ed|ure|ures)?|errors?|exceptions?|fatal|crit(?:ical)?|unhandled)\b|\w(?:Exception|Error)\b/i;
const NOT_ERROR = /\b(?:0|no|zero|without) (?:errors?|failures?|exceptions?)\b/gi;
const WARN_WORDS = /\b(?:warn|warning|warnings)\b/i;

function prefixLevel(word: string): Level {
  const w = word.toLowerCase();
  if (/^(fail|crit|critical|error|err|eror|ftl|fatal)$/.test(w)) return "error";
  if (/^(warn|warning|wrn)$/.test(w)) return "warn";
  return "info";
}

/** Share of the visible characters drawn in a colour family (red: fg 31/91, bg 41/101; yellow: fg 33/93). */
function colourShare(segs: AnsiSegment[], re: RegExp): number {
  let all = 0;
  let hit = 0;
  for (const s of segs) {
    const n = s.text.replace(/\s/g, "").length;
    all += n;
    if (re.test(s.cls)) hit += n;
  }
  return all ? hit / all : 0;
}
const RED = /\bansi-(?:fg-(?:31|91)|bg-(?:41|101))\b/;
const YELLOW = /\bansi-fg-(?:33|93)\b/;

export function detectLevel(text: string, segs: AnsiSegment[]): Level {
  const p = LEVEL_PREFIX.exec(text);
  if (p) return prefixLevel(p[1]);
  if (ERROR_WORDS.test(text.replace(NOT_ERROR, "")) || colourShare(segs, RED) >= 0.5) return "error";
  if (WARN_WORDS.test(text) || colourShare(segs, YELLOW) >= 0.5) return "warn";
  return "info";
}

// ---- stack frames --------------------------------------------------------------------------------------------------

/** CLR / JS frames (`   at X.Y() in f.cs:line 3`, `    at fn (file.js:1:2)`), `--- End of … ---`, inner-exception arrows. */
const STACK = /^\s+at\s+\S|^at\s+\S.*\(.*\)|^\s*--- End of .*---\s*$|^\s*--->\s|^\s*\.\.\. \d+ more\s*$/;
export const isStackFrame = (text: string) => STACK.test(text);

// ---- one line ------------------------------------------------------------------------------------------------------

const cache = new WeakMap<AgentConsoleLine, FormattedLine>();

export function formatLine(l: AgentConsoleLine): FormattedLine {
  const hit = cache.get(l);
  if (hit) return hit;
  const segs = stripEchoedTimestamp(parseAnsi(l.line), l.ts);
  const text = segmentsText(segs);
  const f: FormattedLine = { segs, text, level: detectLevel(text, segs), stack: isStackFrame(text), agent: text.startsWith("[agent] ") };
  cache.set(l, f);
  return f;
}

// ---- runs ----------------------------------------------------------------------------------------------------------

export const RUN_GAP_MS = 2 * 60_000;
/** A banner only opens a new run when the current one is older than this (one start prints several banners). */
const BANNER_SETTLE_MS = 30_000;
const AGENT_RESTART = /\b(?:restart(?:ed|ing)?|(?:re)?started|new session|re-?attached|launch(?:ed)?|spawn(?:ed)?)\b/i;
const BANNER = /Azure Functions Core Tools|Now listening on:|Application started\.|Hosting starting|Host started/;

const ms = (iso: string) => new Date(iso).getTime();
const fmtGap = (gapMs: number) => (gapMs >= 3_600_000 ? `${Math.round(gapMs / 3_600_000)} h` : `${Math.round(gapMs / 60_000)} min`);

/** Why `cur` starts a new run after `prev`, or null. `runStart` = first line of the current run. */
export function runBreak(prev: AgentConsoleLine | undefined, cur: AgentConsoleLine, f: FormattedLine, runStart: AgentConsoleLine | undefined): string | null {
  if (!prev) return null;
  // `seq` is the agent's own counter (restarts per agent session); only comparable when `rseq` orders the rows.
  if (typeof cur.rseq === "number" && typeof prev.rseq === "number" && cur.seq < prev.seq) return "agent session restarted";
  const gap = ms(cur.ts) - ms(prev.ts);
  if (gap > RUN_GAP_MS) return `no output for ${fmtGap(gap)}`;
  if (f.agent && AGENT_RESTART.test(f.text)) return "restart reported by the agent";
  if (BANNER.test(f.text) && runStart && ms(cur.ts) - ms(runStart.ts) > BANNER_SETTLE_MS) return "app started again";
  return null;
}

// ---- rows ----------------------------------------------------------------------------------------------------------

type LineEntry = Extract<ConsoleEntry, { kind: "line" }>;
type SystemEntry = Extract<ConsoleEntry, { kind: "system" }>;
export interface Frame { entry: LineEntry; fmt: FormattedLine }

export type DisplayRow =
  | { kind: "system"; key: string; run: number; entry: SystemEntry }
  | { kind: "divider"; key: string; run: number; reason: string; ts: string }
  | { kind: "group"; key: string; run: number; entry: LineEntry; fmt: FormattedLine; level: Level; frames: Frame[] };

export interface ConsoleRows {
  rows: DisplayRow[];
  /** Index of the newest run (0 when no restart was seen). */
  lastRun: number;
  /** Agent lines (frames included) in runs before the newest one. */
  prevRunLines: number;
}

/** A parent with frames under it is an exception even when its text does not say so. */
const groupLevel = (fmt: FormattedLine, frames: Frame[]) => (frames.length && fmt.level === "info" ? "error" : fmt.level);

/** Entries (sorted by reader seq) → rows: frames fold into the preceding line of the same run, dividers mark runs. */
export function buildRows(entries: readonly ConsoleEntry[]): ConsoleRows {
  const rows: DisplayRow[] = [];
  let run = 0;
  let prev: AgentConsoleLine | undefined;
  let runStart: AgentConsoleLine | undefined;
  let parent: Extract<DisplayRow, { kind: "group" }> | null = null;
  const perRun: number[] = [0];
  for (const e of entries) {
    if (e.kind === "system") { rows.push({ kind: "system", key: e.id, run, entry: e }); continue; }
    const fmt = formatLine(e.line);
    const why = runBreak(prev, e.line, fmt, runStart);
    if (why) {
      run += 1;
      perRun[run] = 0;
      rows.push({ kind: "divider", key: `run-${e.seq}`, run, reason: why, ts: e.line.ts });
      runStart = e.line;
      parent = null;
    }
    runStart ??= e.line;
    prev = e.line;
    perRun[run] += 1;
    if (fmt.stack && parent) {
      parent.frames.push({ entry: e, fmt });
      parent.level = groupLevel(parent.fmt, parent.frames);
      continue;
    }
    parent = { kind: "group", key: `l-${e.seq}`, run, entry: e, fmt, level: fmt.level, frames: [] };
    rows.push(parent);
  }
  return { rows, lastRun: run, prevRunLines: perRun.slice(0, run).reduce((a, b) => a + b, 0) };
}

export const passesLevel = (level: Level, filter: LevelFilter) =>
  filter === "all" || level === "error" || (filter === "warn" && level === "warn");
