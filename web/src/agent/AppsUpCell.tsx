// Apps up column: when a local agent is reporting this project, show the same up/total as the Local agent badge
// (API healthDetail.appsUp is console-attach / port probe on the API host and stays 0 on Render).
import { useDemo } from "../components/DemoContext";
import { projectAgentView } from "./derive";
import { useAgentStatus, useNow } from "./statusFeed";

export default function AppsUpCell({ regId, appsUp, appsTotal }: { regId: string; appsUp: number; appsTotal: number }) {
  const { demoMode } = useDemo();
  const snap = useAgentStatus(!demoMode);
  const tick = useNow(5000);
  const now = Math.max(tick, snap.receivedAt);
  if (!demoMode) {
    const v = projectAgentView(snap, regId, now);
    if (v.kind !== "offline" && v.total > 0)
      return <>{v.up}/{v.total}</>;
  }
  return <>{appsUp}/{appsTotal}</>;
}
