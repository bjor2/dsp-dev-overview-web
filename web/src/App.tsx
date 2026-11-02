import { Link, Navigate, Route, Routes } from "react-router-dom";
import { API_BASE } from "./api/client";
import { DemoBanner } from "./components/common";
import ProjectListPage from "./pages/ProjectListPage";
import ProjectDetailLayout from "./pages/ProjectDetailLayout";
import FlowTab from "./pages/FlowTab";
import ServiceBusTab from "./pages/ServiceBusTab";
import LogsTab from "./pages/LogsTab";
import ConsoleTab from "./pages/ConsoleTab";

/** v1 = local anonymous (HANDOFF Q2). Slot reserved for Entra user chip later. */
const UserChipSlot = () => <div className="user-chip-slot" hidden aria-hidden />;

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">DSP Dev Overview</Link>
        <span className="badge env">dev</span>
        <span className="api-hint" title="Vite proxy → http://localhost:5090">API: {API_BASE} → :5090</span>
        <span className="spacer" />
        <UserChipSlot />
      </header>
      <DemoBanner />
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
