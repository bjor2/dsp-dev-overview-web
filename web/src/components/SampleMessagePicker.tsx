import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import { useApi } from "../api/useApi";
import type { SamplePreset, SampleSendRequest } from "../api/types";
import { demoSamples } from "../mocks/demo";
import { Drawer, Empty, ErrorBanner } from "./common";
import { useDemo } from "./DemoContext";

export default function SampleMessagePicker({ open, projectId, onClose }: { open: boolean; projectId: string; onClose: () => void }) {
  const { demoMode } = useDemo();
  const { data, error, reload } = useApi(() => (open ? api.samples(projectId) : Promise.resolve(null as never)), demoSamples, [projectId, open]);
  const [preset, setPreset] = useState<SamplePreset | null>(null);
  const [event, setEvent] = useState<string>("");
  const [projectIndex, setProjectIndex] = useState<1 | 2 | 3>(1);
  const [dataVersion, setDataVersion] = useState(1);
  const [bodyText, setBodyText] = useState("");
  const [bodyEdited, setBodyEdited] = useState(false);
  const [propsOverride, setPropsOverride] = useState<Record<string, string | number | boolean> | undefined>(undefined);
  const [status, setStatus] = useState<string | null>(null);
  const [sendErr, setSendErr] = useState<ApiError | null>(null);

  const kitMsg = data?.messages.find((m) => m.presetId === preset?.id);
  const resetToKit = () => { setBodyText(kitMsg ? JSON.stringify(kitMsg.body, null, 2) : ""); setBodyEdited(false); setPropsOverride(undefined); };
  useEffect(resetToKit, [preset?.id, data]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    if (!preset) return;
    if (preset.destructive && !confirm(`${preset.label}? Local emulator only.`)) return;
    setStatus(null); setSendErr(null);
    try {
      if (preset.mode === "purge") { const r = await api.purge(projectId); setStatus(`Purged ${r.purged}`); return; }
      const req: SampleSendRequest = { mode: preset.mode };
      if (preset.mode === "one") { req.event = event || preset.params?.event?.[0]; req.projectIndex = projectIndex; req.dataVersion = dataVersion; }
      if (preset.mode === "ingress") req.dataVersion = dataVersion;
      if (bodyEdited) req.bodyOverride = JSON.parse(bodyText); // body only (ADDENDUM §3)
      if (propsOverride) req.applicationPropertiesOverride = propsOverride; // v1: no editor; reserved
      if (demoMode) { setStatus(`DEMO: would send ${preset.messageCount} → ${preset.targetEntityId ?? "both"}`); return; }
      const r = await api.sendSamples(projectId, req);
      setStatus(`Sent ${r.sent} → ${r.entity}`);
    } catch (e) { setSendErr(e instanceof ApiError ? e : new ApiError(0, "BAD_JSON", String(e), false)); }
  };

  return (
    <Drawer open={open} title="Inject sample messages" onClose={onClose}>
      {error && <ErrorBanner error={error} onRetry={reload} />}
      {!data && !error && <Empty>Loading catalog…</Empty>}
      {data && (
        <div className="picker">
          <div className="muted">Source: <code>{data.source}</code></div>
          <ul className="presets">
            {data.presets.map((p) => (
              <li key={p.id} className={`${preset?.id === p.id ? "sel" : ""} ${p.destructive ? "danger" : ""}`} onClick={() => setPreset(p)}>
                <strong>{p.label}</strong> <span className="muted">{p.mode} · {p.messageCount} msg → {p.targetEntityId ?? "both queues"}</span>
              </li>
            ))}
          </ul>
          {preset?.mode === "one" && (
            <div className="row">
              <select value={event} onChange={(e) => setEvent(e.target.value)}>{preset.params?.event?.map((ev) => <option key={ev}>{ev}</option>)}</select>
              <select value={projectIndex} onChange={(e) => setProjectIndex(+e.target.value as 1 | 2 | 3)}>{(preset.params?.projectIndex ?? [1, 2, 3]).map((i) => <option key={i} value={i}>Project {i}</option>)}</select>
              <label>DataVersion <input type="number" value={dataVersion} onChange={(e) => setDataVersion(+e.target.value)} style={{ width: 60 }} /></label>
            </div>
          )}
          {preset && !preset.destructive && (
            <>
              <label className="muted">Body (edit → bodyOverride; application properties unchanged)</label>
              <textarea rows={10} value={bodyText} onChange={(e) => { setBodyText(e.target.value); setBodyEdited(true); }} placeholder="No single-message preview for batch presets" />
              {kitMsg && <pre className="props">{JSON.stringify(kitMsg.applicationProperties, null, 2)}</pre>}
              <button className="ghost" onClick={resetToKit}>Reset to kit</button>
            </>
          )}
          <div className="row">
            <button className={preset?.destructive ? "danger" : "primary"} disabled={!preset} onClick={send}>{preset?.destructive ? "Purge" : "Send"}</button>
            {status && <span>{status}</span>}
          </div>
          {sendErr && <ErrorBanner error={sendErr} />}
        </div>
      )}
    </Drawer>
  );
}
