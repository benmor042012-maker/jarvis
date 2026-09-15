import { useEffect } from "react";

import { ActivityLog } from "./components/ActivityLog";
import { CommandBar } from "./components/CommandBar";
import { Header } from "./components/Header";
import { JarvisOrb } from "./components/JarvisOrb";
import { PermissionDialog } from "./components/PermissionDialog";
import { SettingsPanel } from "./components/SettingsPanel";
import { useJarvis } from "./state/jarvisStore";

export default function App() {
  const orb = useJarvis((s) => s.orb);
  const statusText = useJarvis((s) => s.statusText);
  const bootstrap = useJarvis((s) => s.bootstrap);
  const online = useJarvis((s) => s.serverOnline);
  const pending = useJarvis((s) => s.pendingPlan);
  const log = useJarvis((s) => s.log);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const lastAssistant = [...log].reverse().find((e) => e.kind === "assistant" || e.kind === "error");
  const subtext =
    online === false
      ? "Local server offline. Start it with: uvicorn server.main:app --port 8000"
      : pending
        ? "Review the proposed actions before anything runs."
        : lastAssistant?.text;

  return (
    <div className="app">
      <div className="grid-field" aria-hidden="true" />
      <Header />
      <main className="stage" aria-label="Assistant">
        <JarvisOrb state={orb} statusText={statusText} {...(subtext ? { subtext } : {})} />
      </main>
      <ActivityLog />
      <CommandBar />
      <PermissionDialog />
      <SettingsPanel />
    </div>
  );
}
