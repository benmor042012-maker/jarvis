import { useEffect } from "react";

import { AlertScreen } from "./components/AlertScreen";
import { ApprovalDialog } from "./components/ApprovalDialog";
import { CallScreen } from "./components/CallScreen";
import { Dashboard } from "./components/Dashboard";
import { PairingScreen } from "./components/PairingScreen";
import { AlertsPanel } from "./panels/AlertsPanel";
import { AuditPanel } from "./panels/AuditPanel";
import { DevicesPanel } from "./panels/DevicesPanel";
import { DraftsPanel } from "./panels/DraftsPanel";
import { PhonePanel } from "./panels/PhonePanel";
import { ProjectsPanel } from "./panels/ProjectsPanel";
import { SettingsPanel } from "./panels/SettingsPanel";
import { StatusPanel } from "./panels/StatusPanel";
import { ToolsPanel } from "./panels/ToolsPanel";
import { VoicePanel } from "./panels/VoicePanel";
import { useDesktopHost } from "./hooks/useDesktopHost";
import { useJarvis } from "./state/jarvisStore";

export default function App() {
  const bootstrap = useJarvis((s) => s.bootstrap);
  const connection = useJarvis((s) => s.connection);
  const panel = useJarvis((s) => s.panel);

  useDesktopHost();

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  if (connection === "unpaired" || connection === "unauthorized") return <PairingScreen />;

  return (
    <div className="app">
      <div className="grid-field" aria-hidden="true" />
      <Dashboard />
      <ApprovalDialog />
      <AlertScreen />
      <CallScreen />
      {panel === "status" && <StatusPanel />}
      {panel === "devices" && <DevicesPanel />}
      {panel === "tools" && <ToolsPanel />}
      {panel === "audit" && <AuditPanel />}
      {panel === "projects" && <ProjectsPanel />}
      {panel === "drafts" && <DraftsPanel />}
      {panel === "settings" && <SettingsPanel />}
      {panel === "voice" && <VoicePanel />}
      {panel === "alerts" && <AlertsPanel />}
      {panel === "phone" && <PhonePanel />}
    </div>
  );
}
