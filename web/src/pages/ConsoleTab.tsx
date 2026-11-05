import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api/client";
import type { ConsoleChunk } from "../api/types";
import { useDemo } from "../components/DemoContext";
import AgentConsolePanel from "../agent/AgentConsolePanel";
import { useProjectApps } from "../agent/useProjectApps";

type Source = "agent" | "api";
const SOURCES: [Source, string][] = [["agent", "Local agent"], ["api", "Overview API"]];

// ADDENDA-010 §4: the console comes from the local agent (read-only). The Overview API console (Start / Stop / Restart,
// ADDENDUM §2) stays available as LegacyConsolePanel behind the Source toggle.
export default function ConsoleTab() {
  const { projectId = "" } = useParams();
  const { apps, loading } = useProjectApps(projectId);
  const [picked, setPicked] = useState<string | null>(null);
  const [source, setSource] = useState<Source>("agent");
  const app = (apps.find((a) => a.appId === picked) ?? apps[0])?.appId;
  return (
    <div>
      <div className="console-head">
        <nav className="tabs small">
          {loading ? <span className="muted">Loading apps…</span> : apps.map((a) => (
            <a key={a.appId} className={app === a.appId ? "active" : ""} data-app={a.appId} onClick={() => setPicked(a.appId)}>{a.label}</a>
          ))}
        </nav>
        <span className="source-toggle" role="group" aria-label="Console source">
          <span className="muted">Source:</span>
          {SOURCES.map(([k, label]) => (
            <button key={k} type="button" className={source === k ? "on" : ""} aria-pressed={source === k} onClick={() => setSource(k)}>{label}</button>
          ))}
        </span>
      </div>
      {!loading && app && (source === "agent"
        ? <AgentConsolePanel key={`${projectId}|${app}`} regId={projectId} appId={app} />
        : <LegacyConsolePanel key={`${projectId}|${app}`} projectId={projectId} appId={app} />)}
    </div>
  );
}

function LegacyConsolePanel({ projectId, appId }: { projectId: string; appId: string }) {
  const { demoMode } = useDemo();
  const [lines, setLines] = useState<{ s: ConsoleChunk["stream"]; t: string }[]>([]);
  const [attached, setAttached] = useState<boolean | null>(null);
  const [conn, setConn] = useState<"connecting" | "open" | "error">("connecting");
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (demoMode) { setConn("error"); return; }
    const es = new EventSource(api.consoleStreamUrl(projectId, appId));
    es.onopen = () => setConn("open");
    es.onerror = () => setConn("error"); // EventSource auto-reconnects
    es.onmessage = (ev) => {
      try {
        const c: ConsoleChunk = JSON.parse(ev.data);
        setAttached(c.attached);
        setLines((prev) => [...prev, ...c.lines.map((t) => ({ s: c.stream, t }))].slice(-5000));
      } catch { /* ignore malformed */ }
    };
    return () => es.close();
  }, [projectId, appId, demoMode]);
  useEffect(() => { ref.current?.scrollTo(0, ref.current.scrollHeight); }, [lines]);

  const run = async (fn: (p: string, a: string) => Promise<{ attached: boolean }>) => {
    try { setAttached((await fn(projectId, appId)).attached); } catch (e) { setLines((l) => [...l, { s: "system", t: "Error: " + (e as Error).message }]); }
  };
  return (
    <div>
      <div className="toolbar">
        <span className={`badge ${attached ? "ok" : "off"}`}>{attached === null ? "unknown" : attached ? "attached" : "not attached"}</span>
        <span className="muted">stream: {conn}</span>
        <span className="spacer" />
        <button onClick={() => run(api.consoleStart)}>Start</button>
        <button onClick={() => run(api.consoleStop)}>Stop</button>
        <button onClick={() => run(api.consoleRestart)}>Restart</button>
        <button className="ghost" onClick={() => setLines([])}>Clear</button>
      </div>
      {conn === "error" && <div className="banner error">Console stream unavailable (overview API down or app not managed). Retrying automatically.</div>}
      <pre className="console" ref={ref}>{lines.map((l, i) => <div key={i} className={l.s}>{l.t}</div>)}</pre>
      {/* TODO(Developer): search/filter, pause autoscroll, seq-gap detection & Last-Event-ID resume. */}
    </div>
  );
}
