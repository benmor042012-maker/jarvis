import { useJarvis } from "../state/jarvisStore";

export function Header() {
  const online = useJarvis((s) => s.serverOnline);
  const settings = useJarvis((s) => s.settings);
  const openSettings = useJarvis((s) => s.openSettings);

  const state = online === null ? "unknown" : !online ? "offline" : settings?.mock_mode ? "mock" : "online";
  const label = online === null ? "Connecting" : !online ? "Server offline" : settings?.mock_mode ? "Mock mode" : "Connected";

  return (
    <header className="header">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <span>JARVIS</span>
      </div>
      <div className="header-meta">
        <span className="pill" data-state={state} role="status">
          <span className="dot" aria-hidden="true" />
          {label}
        </span>
        {settings && !settings.mock_mode && <span className="pill pill-model">{settings.model}</span>}
        {settings && <span className="pill pill-model">{settings.permission_mode} mode</span>}
        <button type="button" className="icon-btn" onClick={() => {
            openSettings(true);
          }} aria-label="Open settings" title="Settings">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
        </button>
      </div>
    </header>
  );
}
