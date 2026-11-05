// ANSI SGR → styled segments for the agent console. Real escape sequences (ESC [ … final byte, OSC, two-byte ESC)
// and the ESC-less `[39;49m` leftovers some log pipelines write are both consumed: no escape code ever reaches the DOM.

export interface AnsiSegment {
  text: string;
  /** Space-separated `ansi-*` classes, "" for unstyled text. */
  cls: string;
}

interface Sgr { bold: boolean; dim: boolean; italic: boolean; underline: boolean; fg: number | null; bg: number | null }
const PLAIN: Sgr = { bold: false, dim: false, italic: false, underline: false, fg: null, bg: null };

/**
 * 1: CSI params, 2: CSI final byte · OSC (… BEL / ST) · other ESC sequences · a stray ESC ·
 * 3: ESC-less SGR params (`[31m`, `[39;49m`, `[m`), not when it reads like text (`[5m]`, `[0ms]`).
 */
const TOKEN = /\x1b\[([0-9;:?<=>]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[ -/]*[0-~]|\x1b|\[((?:\d{1,3}(?:;\d{1,3})*)?)m(?!s?\])/g;
/** C0 controls other than TAB (CR included: a progress-bar redraw is not worth reproducing). */
const CONTROL = /[\x00-\x08\x0a-\x1f\x7f]/g;

/** 256-colour indexes 0–15 map onto the basic classes; anything else (and 24-bit colour) is dropped. */
const fromIndexed = (n: number, base: number) => (n < 8 ? base + n : n < 16 ? base + 60 + n - 8 : null);

function applySgr(s: Sgr, params: number[]): Sgr {
  const n = { ...s };
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) Object.assign(n, PLAIN);
    else if (p === 1) n.bold = true;
    else if (p === 2) n.dim = true;
    else if (p === 3) n.italic = true;
    else if (p === 4) n.underline = true;
    else if (p === 22) { n.bold = false; n.dim = false; }
    else if (p === 23) n.italic = false;
    else if (p === 24) n.underline = false;
    else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) n.fg = p;
    else if (p === 39) n.fg = null;
    else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) n.bg = p;
    else if (p === 49) n.bg = null;
    else if (p === 38 || p === 48) {
      const base = p === 38 ? 30 : 40;
      if (params[i + 1] === 5) { const c = fromIndexed(params[i + 2] ?? 999, base); if (p === 38) n.fg = c; else n.bg = c; i += 2; }
      else if (params[i + 1] === 2) i += 4;
    }
    // Everything else (blink, inverse, fonts, …) is ignored.
  }
  return n;
}

const classes = (s: Sgr) =>
  [s.bold && "ansi-bold", s.dim && "ansi-dim", s.italic && "ansi-italic", s.underline && "ansi-underline",
    s.fg !== null && `ansi-fg-${s.fg}`, s.bg !== null && `ansi-bg-${s.bg}`].filter(Boolean).join(" ");

const parseParams = (raw: string) => (raw === "" ? [0] : raw.split(/[;:]/).map((x) => (x === "" ? 0 : Number(x))));

/** Split a raw log line into styled segments. Adjacent segments with the same style are merged. */
export function parseAnsi(raw: string): AnsiSegment[] {
  const out: AnsiSegment[] = [];
  let style = PLAIN;
  let at = 0;
  const emit = (text: string) => {
    const t = text.replace(CONTROL, "");
    if (!t) return;
    const cls = classes(style);
    const last = out[out.length - 1];
    if (last && last.cls === cls) last.text += t;
    else out.push({ text: t, cls });
  };
  for (const m of raw.matchAll(TOKEN)) {
    const [whole, csiParams, csiFinal, bareParams] = m;
    if (bareParams !== undefined) {
      const ps = parseParams(bareParams);
      if (ps.some((x) => x > 107)) continue; // `[200m` is not SGR: leave it in the text
      emit(raw.slice(at, m.index));
      style = applySgr(style, ps);
    } else {
      emit(raw.slice(at, m.index));
      if (csiFinal === "m" && csiParams !== undefined && !/[?<=>]/.test(csiParams)) style = applySgr(style, parseParams(csiParams));
    }
    at = m.index + whole.length;
  }
  emit(raw.slice(at));
  return out;
}

export const segmentsText = (segs: readonly AnsiSegment[]) => segs.map((s) => s.text).join("");

/** Plain text with every escape sequence removed. */
export const stripAnsi = (raw: string) => segmentsText(parseAnsi(raw));

/** Drop the first `n` characters, keeping the styles of what remains. */
export function dropChars(segs: readonly AnsiSegment[], n: number): AnsiSegment[] {
  const out: AnsiSegment[] = [];
  let left = n;
  for (const s of segs) {
    if (left >= s.text.length) { left -= s.text.length; continue; }
    out.push(left > 0 ? { text: s.text.slice(left), cls: s.cls } : s);
    left = 0;
  }
  return out;
}
