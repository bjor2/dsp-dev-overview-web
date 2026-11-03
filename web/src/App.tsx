import { Link, Navigate, Route, Routes } from "react-router-dom";
import { useEffect, useState } from "react";
import { API_BASE, lastUpstream } from "./api/client";
import { DemoBanner } from "./components/common";
import { UpstreamBanner } from "./components/UpstreamBanner";
import ProjectListPage from "./pages/ProjectListPage";
import ProjectDetailLayout from "./pages/ProjectDetailLayout";
import FlowTab from "./pages/FlowTab";
import ServiceBusTab from "./pages/ServiceBusTab";
import LogsTab from "./pages/LogsTab";
import ConsoleTab from "./pages/ConsoleTab";

/** v1 = local anonymous (HANDOFF Q2). Slot reserved for Entra user chip later. */
/** Header API label: real upstream from X-Dsp-Upstream; else Render in prod, Vite proxy in dev. */
function ApiHint() {
  const [up, setUp] = useState(lastUpstream);
  useEffect(() => {
    const on = () => setUp(lastUpstream);
    window.addEventListener("dsp:upstream", on);
    on();
    return () => window.removeEventListener("dsp:upstream", on);
  }, []);
  if (up) {
    const name = up.target === "box" ? "Bjor's box" : up.target === "render" ? "Render API" : up.target;
    return <span className="api-hint" title={`X-Dsp-Upstream: ${up.target}`}>API: {name}{up.fallback ? " (fallback)" : ""}</span>;
  }
  if (import.meta.env.PROD) return <span className="api-hint">API: Render API</span>;
  return <span className="api-hint" title="Vite proxy → http://localhost:5090">API: {API_BASE} → :5090 (Vite proxy)</span>;
}

const UserChipSlot = () => <div className="user-chip-slot" hidden aria-hidden />;

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">DSP Dev Overview</Link>
        <span className="badge env">dev</span>
        <ApiHint />
        <span className="spacer" />
        <UserChipSlot />
      </header>
      <DemoBanner />
      <UpstreamBanner />
      <main>
        <Routes>
          <Route path="/" element={<ProjectListPage />} />
          <Route path="/projects/:projectId" element={<ProjectDetailLayout />}>
            <Route index element={<Navigate to="flow" replace />} />
            <Route path="flow" element={<FlowTab />} />
            <Route path="service-bus" element={<ServiceBusTab />} />
            <Route path="logs" element={<LogsTab />} />
            <Route path="console" element={<ConsoleTab />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
