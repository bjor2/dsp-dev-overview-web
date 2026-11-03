import { useCallback, useEffect, useState } from "react";
import { ApiError } from "./client";
import { useDemo } from "../components/DemoContext";

/** Real fetch first. Demo data only when the user explicitly enabled "Use demo data" (local design). */
/** pollMs: silent background refresh while the tab is visible (keeps the last data on a failed poll, no loading flash). */
export function useApi<T>(fn: () => Promise<T>, demo: T | undefined, deps: unknown[], pollMs?: number) {
  const { demoMode } = useDemo();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => {
    if (demoMode && demo !== undefined) { setData(demo); setError(null); setLoading(false); return; }
    setLoading(true);
    fn().then((d) => { setData(d); setError(null); })
      .catch((e) => { setData(null); setError(e instanceof ApiError ? e : new ApiError(0, "UNKNOWN", String(e), true)); })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoMode, ...deps]);
  useEffect(load, [load]);
  useEffect(() => {
    if (!pollMs || demoMode) return;
    const t = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      fn().then((d) => { setData(d); setError(null); }).catch(() => { /* keep last data; next poll retries */ });
    }, pollMs);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollMs, demoMode, ...deps]);
  return { data, error, loading, reload: load };
}
