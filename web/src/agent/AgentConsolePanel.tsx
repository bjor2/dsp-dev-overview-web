// Read-only console fed by the local agent (§2). Nothing here can start or stop an app (ADDENDA-010 §0).
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { fmtOslo } from "../components/common";
import { useDemo } from "../components/DemoContext";
import { useNow } from "./statusFeed";
import { busyText, declaredPorts, stateGlyph, type ConsoleUnavailableReason } from "./derive";
import { useAppConsole, type ConsoleEntry, type ConsolePhase } from "./useAppConsole";

/** Exact banner copy (the Playwright plan asserts on these strings). The dspwatch hint follows it in the banner. */
export function unavailableText(reason: ConsoleUnavailableReason, appId: string, lastSeen?: string, detail?: string): string {
  const p = "Console unavailable — ";
  switch (reason) {
    case "agent-offline": return p + `agent offline (${lastSeen ? "last seen " + fmtOslo(lastSeen) : "never seen"})`;
    case "app-not-reported": return p + `the agent does not report ${appId} (registration outdated? rebuild the agent)`;
    case "status-stale": return p + "no agent status for 30 s";
    case "not-configured-503": return p + "front door answered 503 (Entra / agent ingest not configured)";
    case "unauthenticated-401": return p + "not signed in (401)";
    case "forbidden-403": return p + "not allowed (403)";
    case "not-served": return p + "/agent is not served here (dev: run with AGENT_MOCK or AGENT_TARGET)";
    case "network": return p + "front door unreachable, retrying";
    case "no-snapshot": return p + "no agent status received";
    case "no-agent": return p + "no agent has connected to the front door";
    case "bad-payload": return p + "/agent sent something that is not agent status";
    case "server-error": return p + `front door error${detail ? " (" + detail + ")" : ""}`;
  }
}

/** Console lines only come from apps launched through the dspwatch wrapper; the agent reads nothing else. */
export const DSPWATCH_COMMAND = "dspwatch <command>";

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // No Clipboard API (insecure origin, permission denied): fall back to a hidden textarea + execCommand.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { return document.execCommand("copy"); } catch { return false; } finally { ta.remove(); }
  }
}

/** `dspwatch <command>` as code plus a small copy button that says "Copied" for 1.5 s. */
function DspwatchCommand() {
  const [copied, setCopied] = useState<boolean | null>(null);
  useEffect(() => {
    if (copied === null) return;
    const t = window.setTimeout(() => setCopied(null), 1500);
    return () => window.clearTimeout(t);
  }, [copied]);
  return (
    <span className="dspwatch">
      <code className="dspwatch-cmd">{DSPWATCH_COMMAND}</code>
      <button type="button" className="dspwatch-copy" title="Copy command" onClick={async () => setCopied(await copyText(DSPWATCH_COMMAND))}>
        {copied === null ? "Copy" : copied ? "Copied" : "Copy failed"}
      </button>
    </span>
  );
}

function DspwatchHint() {
  return <span className="dspwatch-hint">Start the app with <DspwatchCommand /> to get live output.</span>;
}

const OSLO_TIME = new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
/** Oslo wall clock with milliseconds: 15:02:11.123 */
const fmtTs = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${OSLO_TIME.format(d)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};
const nb = (n: number) => n.toLocaleString("nb-NO");

const Row = memo(function Row({ e }: { e: ConsoleEntry }) {
  if (e.kind === "system") return <div className="line system ui">{e.text}</div>;
  const l = e.line;
  const agentSystem = l.line.startsWith("[agent] ");
  return (
    <div className={`line${l.redacted ? " redacted" : ""}${l.truncated ? " truncated" : ""}${agentSystem ? " system" : ""}`} data-seq={e.seq}>
      <span className="ts">{fmtTs(l.ts)}</span>
      <span className="src" title={l.source}>{l.source}</span>
      <span className="txt">{l.line}</span>
      {l.redacted && <span className="flag" title="Secrets replaced by ***">redacted</span>}
      {l.truncated && <span className="flag" title="Cut to 4 KiB by the agent">truncated</span>}
    </div>
  );
});

function streamText(p: ConsolePhase, now: number): string {
  switch (p.phase) {
    case "checking": return "checking…";
    case "attaching": return p.attempt > 1 ? `attaching (attempt ${p.attempt})` : "attaching";
    case "live": return "live";
    case "reconnecting": return `reconnecting in ${Math.max(0, Math.ceil((p.retryAt - now) / 1000))} s`;
    case "unavailable": return "unavailable";
  }
}

export default function AgentConsolePanel({ regId, appId }: { regId: string; appId: string }) {
  const { demoMode } = useDemo();
  const { state, view, dispatch } = useAppConsole(regId, appId, !demoMode);
  const now = useNow(1000);
  const preRef = useRef<HTMLPreElement>(null);
  const programmatic = useRef(false);

  // Auto-scroll after every flush, only while following.
  useLayoutEffect(() => {
    const pre = preRef.current;
    if (!pre || !state.follow) return;
    programmatic.current = true;
    pre.scrollTop = pre.scrollHeight;
    requestAnimationFrame(() => { programmatic.current = false; });
  }, [state.lines, state.follow]);

  const onScroll = () => {
    const pre = preRef.current;
    if (!pre || programmatic.current) return;
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
    if (atBottom !== state.follow) dispatch({ type: "follow", on: atBottom });
  };

  const app = view.kind === "reported" ? view.app : undefined;
  const g = app ? stateGlyph(app.state) : null;
  const ports = app ? declaredPorts(app) : [];
  const busy = app ? busyText(app) : [];
  const lastLine = [...state.lines].reverse().find((e) => e.kind === "line");
  const source = lastLine?.kind === "line" ? lastLine.line.source : null;
  const p = state.phase;
  const lineCount = state.lines.filter((e) => e.kind === "line").length;

  return (
    <div className="agent-console">
      <div className="toolbar console-toolbar">
        {app && g ? (
          <span className="app-state" style={{ color: g.color }} title={app.reason ?? app.state} data-state={app.state}>{g.glyph} {app.state}</span>
        ) : (
          <span className="app-state muted">—</span>
        )}
        {app?.pid !== undefined && <span className="muted">pid {app.pid}</span>}
        {ports.length > 0 && (
          <span className="muted ports" title={busy.join("\n") || undefined}>
            ports {ports.map((x) => `${x.port} ${x.state === "listening" ? "✓" : x.state === "busyByOther" ? "✗ busy" : x.state === "notListening" ? "–" : "?"}`).join(" · ")}
          </span>
        )}
        {busy.length > 0 && <span className="busy">{busy.join(", ")}</span>}
        {source && <span className="muted src-name">{source}</span>}
        <span className="muted stream" data-phase={p.phase}>
          stream: {streamText(p, now)}
          {view.kind === "reported" && view.presence === "stale" ? ` · agent stale ${Math.round(view.heartbeatAgeSec)} s` : ""}
        </span>
        <span className="muted line-count">
          {nb(lineCount)} lines{state.droppedByBuffer > 0 ? ` (${nb(state.droppedByBuffer)} older dropped)` : ""}
        </span>
        <span className="spacer" />
        <button className="ghost" onClick={() => dispatch({ type: "clear" })}>Clear</button>
        <button className={state.follow ? "follow on" : "follow"} aria-pressed={state.follow} onClick={() => dispatch({ type: "follow", on: !state.follow })} title="Keep the newest line in view">
          ⤓ Follow
        </button>
      </div>
      {p.phase === "unavailable" && (
        <div className="banner error console-banner" role="alert" data-reason={p.reason}>
          <span className="reason">{unavailableText(p.reason, appId, p.lastSeen, p.detail)}.</span>
          <DspwatchHint />
        </div>
      )}
      <div className="console-wrap">
        <pre className="console agent" ref={preRef} onScroll={onScroll}>
          {app && app.console !== "tailing" && (
            <div className="line notice">
              no live output for this app (agent console: {app.console}{app.console === "error" && app.reason ? ` — ${app.reason}` : ""}). <DspwatchHint />
            </div>
          )}
          {state.lines.map((e) => <Row key={e.kind === "line" ? e.seq : e.id} e={e} />)}
        </pre>
        {!state.follow && (
          <button className="console-paused" onClick={() => dispatch({ type: "follow", on: true })}>
            Paused · <span className="count">{nb(state.pending)}</span> new ▼ Resume
          </button>
        )}
      </div>
    </div>
  );
}
