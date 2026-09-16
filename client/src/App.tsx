import { useEffect } from "react";

import { ActivityLog } from "./components/ActivityLog";
import { AlertScreen } from "./components/AlertScreen";
import { ApprovalDialog } from "./components/ApprovalDialog";
import { CallScreen } from "./components/CallScreen";
import { Header } from "./components/Header";
import { JarvisOrb } from "./components/JarvisOrb";
import { PairingScreen } from "./components/PairingScreen";
import { VoiceBar } from "./components/VoiceBar";
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
  const orb = useJarvis((s) => s.orb);
  const statusText = useJarvis((s) => s.statusText);
  const status = useJarvis((s) => s.status);
  const panel = useJarvis((s) => s.panel);
  const log = useJarvis((s) => s.log);
  const pending = useJarvis((s) => s.pendingPlans);
  const approvalOpen = useJarvis((s) => s.approvalOpen);
  const openApproval = useJarvis((s) => s.openApproval);
  const reconnectIn = useJarvis((s) => s.reconnectIn);

  useDesktopHost();

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  if (connection === "unpaired" || connection === "unauthorized") return <PairingScreen />;

  const lastMessage = [...log].reverse().find((e) => e.kind === "assistant" || e.kind === "error" || e.kind === "warn");
  const subtext =
    connection === "offline"
      ? `The JARVIS agent is not reachable. It cannot control the computer while it is off, asleep, disconnected or stopped.${reconnectIn !== null ? ` Retrying in ${String(reconnectIn)}s.` : ""}`
      : connection === "connecting"
        ? "Contacting the agent on this computer…"
        : status?.emergency
          ? `Emergency stop is active (${status.emergency_source ?? "unknown source"}). Nothing will run until it is cleared on the computer.`
          : pending.length
            ? `${String(pending.length)} plan(s) waiting for your approval.`
            : lastMessage?.text;

  return (
    <div className="app">
      <div className="grid-field" aria-hidden="true" />
      <Header />
      <main className="stage" aria-label="Assistant">
        <JarvisOrb state={orb} statusText={statusText} {...(subtext ? { subtext } : {})} />
        {pending.length > 0 && !approvalOpen && (
          <button type="button" className="btn btn-primary" onClick={() => { openApproval(pending[0]?.plan_id ?? null); }}>
            Review {pending.length} pending approval{pending.length === 1 ? "" : "s"}
          </button>
        )}
      </main>
      <ActivityLog />
      <VoiceBar />
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
