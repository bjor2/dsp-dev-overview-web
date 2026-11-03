import { useEffect, useState } from "react";

/** ADDENDA-006: front door upstream status (box via ngrok, or render). Hidden when the endpoint is absent (Vite dev). */
type Status = { mode: "box" | "render"; fallback: "off" | "read-only"; box: { up: boolean; reason: string } | null };

export function UpstreamBanner({ intervalMs = 30_000 }: { intervalMs?: number }) {
  const [s, setS] = useState<Status | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/upstream-status", { headers: { Accept: "application/json" } })
        .then((r) => (r.ok && r.headers.get("content-type")?.includes("json") ? r.json() : null))
        .then((j) => alive && setS(j))
        .catch(() => alive && setS(null));
    load();
    const t = setInterval(load, intervalMs);
    window.addEventListener("dsp:box-offline", load);
    return () => { alive = false; clearInterval(t); window.removeEventListener("dsp:box-offline", load); };
  }, [intervalMs]);
  if (!s || s.mode !== "box" || s.box?.up !== false) return null;
  return (
    <div role="alert" className="banner box-offline"
      style={{ background: "#7a1f1f", color: "#fff", padding: "6px 12px", fontSize: 13 }}>
      <strong>BOX_OFFLINE</strong>: the box API (ngrok → :5011) is not reachable ({s.box.reason}).{" "}
      {s.fallback === "read-only" ? "Reads fall back to the Render API; writes are blocked." : "All API calls return 503 until it is back."}
    </div>
  );
}
