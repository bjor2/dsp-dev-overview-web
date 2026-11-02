import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api/client";
import { APPS, type ConsoleChunk } from "../api/types";
import { useDemo } from "../components/DemoContext";

// COMPONENTS.md: per-app ConsolePanel with Start / Stop / Restart (ADDENDUM §2: POST /restart only) + SSE stream.
export default function ConsoleTab() {
  const { projectId = "" } = useParams();
  const [app, setApp] = useState<string>(APPS[0].appId);
  return (
    <div>
      <nav className="tabs small">{APPS.map((a) => <a key={a.appId} className={app === a.appId ? "active" : ""} onClick={() => setApp(a.appId)}>{a.label}</a>)}</nav>
      <ConsolePanel key={app} projectId={projectId} appId={app} />
    </div>
  );
}

function ConsolePanel({ projectId, appId }: { projectId: string; appId: string }) {
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
