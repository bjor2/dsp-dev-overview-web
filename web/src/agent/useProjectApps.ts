// Console app tabs per project: the flow graph's app containers, unioned with the apps the agent reports for the
// regId, falling back to the locked APPS list when both are empty.
import { useMemo } from "react";
import { api } from "../api/client";
import { APPS, type FlowContainer } from "../api/types";
import { useApi } from "../api/useApi";
import { useDemo } from "../components/DemoContext";
import { useAgentStatus } from "./statusFeed";

export interface ProjectApp { appId: string; label: string }

const SLUG: Record<string, string> = { "func-app": "functions", "ingress-app": "ingress" };
/**
 * Registration app id of a flow container: `containers[].appId` when the API sends it, else the slug rule
 * (`container:price.api-batch` → `app:api-batch`, `func-app` → `functions`, `ingress-app` → `ingress`).
 */
export function containerAppId(c: FlowContainer & { appId?: string }): string {
  if (typeof c.appId === "string" && c.appId) return c.appId;
  const last = c.id.replace(/^container:/, "").split(".").at(-1) ?? c.id;
  return "app:" + (SLUG[last] ?? last);
}
/** "Api.Batch :52171" → "Api.Batch"; "Ingress (port ?)" → "Ingress". */
export const containerAppLabel = (label: string) => label.replace(/\s+(:\d+|\(port \?\))$/, "");

/** Prefer the locked APPS label; else strip the `app:` prefix so a late agent-only id never flashes as `app:…`. */
function agentAppLabel(appId: string): string {
  return APPS.find((a) => a.appId === appId)?.label ?? appId.replace(/^app:/, "");
}

export function useProjectApps(projectId: string): { apps: ProjectApp[]; loading: boolean } {
  const { demoMode } = useDemo();
  const flow = useApi(() => api.flow(projectId, "local"), undefined, [projectId]);
  const feed = useAgentStatus(!demoMode);
  const reported = useMemo(
    () => (feed.status?.apps ?? []).filter((a) => a.regId === projectId).map((a) => a.appId).join("|"),
    [feed.status, projectId],
  );
  const apps = useMemo(() => {
    const out: ProjectApp[] = [];
    for (const c of flow.data?.containers ?? []) {
      if (!c.app) continue;
      const appId = containerAppId(c);
      if (!out.some((a) => a.appId === appId)) out.push({ appId, label: containerAppLabel(c.label) });
    }
    for (const appId of reported ? reported.split("|") : []) {
      if (!out.some((a) => a.appId === appId)) out.push({ appId, label: agentAppLabel(appId) });
    }
    return out.length ? out : APPS.map((a) => ({ appId: a.appId, label: a.label }));
  }, [flow.data, reported]);
  // Wait for the flow attempt before exposing tabs. Short-circuiting on `reported` used to flash raw
  // `app:…` labels (agent status often arrives before /flow), which broke console tab assertions.
  return { apps, loading: flow.loading && !flow.data };
}
