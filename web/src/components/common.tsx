import type { ReactNode } from "react";
import type { ApiError } from "../api/client";
import type { Health } from "../api/types";
import { useDemo } from "./DemoContext";

export function ErrorBanner({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  const { setDemoMode } = useDemo();
  return (
    <div className="banner error" role="alert">
      <strong>{error.code}</strong> — {error.message}
      {error.retryable && onRetry && <button onClick={onRetry}>Retry</button>}
      {error.code === "API_UNREACHABLE" && (
        <button className="ghost" onClick={() => setDemoMode(true)} title="Local design only — not live data">Use demo data</button>
      )}
    </div>
  );
}
export function DemoBanner() {
  const { demoMode, setDemoMode } = useDemo();
  if (!demoMode) return null;
  return <div className="banner demo">DEMO DATA — not live. <button onClick={() => setDemoMode(false)}>Back to live API</button></div>;
}
export const HealthDot = ({ health }: { health: Health }) => <span className={`dot ${health}`} title={health} />;
export const Count = ({ v, hot }: { v: number | null; hot?: boolean }) =>
  <span className={hot ? "count hot" : "count"}>{v === null ? "—" : v}</span>;
export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;
export const fmtOslo = (iso: string) =>
  new Date(iso).toLocaleString("nb-NO", { timeZone: "Europe/Oslo", dateStyle: "short", timeStyle: "medium" }) + " (Oslo)";
export function Drawer({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <header><h3>{title}</h3><button className="ghost" onClick={onClose}>✕</button></header>
        {children}
      </aside>
    </div>
  );
}
