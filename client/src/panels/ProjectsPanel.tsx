import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../api";
import { Dialog } from "../components/Dialog";
import { describeError } from "../lib/protocol";
import { useAction } from "../lib/useAction";
import { useJarvis, desktopBridge } from "../state/jarvisStore";
import type { AgentEvent, ProjectInfo, ProjectTask, ProjectTemplate } from "../types";

export function ProjectsPanel() {
  const setPanel = useJarvis((s) => s.setPanel);
  const language = useJarvis((s) => s.settings?.language ?? "he");
  const offline = useJarvis((s) => s.status?.offline_mode ?? false);
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [task, setTask] = useState<ProjectTask | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", template: "website", description: "", run_tests: true, run_build: true });
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const pollRef = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const [t, p] = await Promise.all([api.projectTemplates(), api.projects()]);
      setTemplates(t.templates);
      setProjects(p.projects);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // Live progress from the agent's event stream, plus a poll as a safety net.
  useEffect(() => {
    const onEvent = (e: Event) => {
      const detail = (e as CustomEvent<AgentEvent>).detail;
      if (detail.type === "project" && task && detail.task_id === task.task_id) void refresh(task.task_id);
    };
    window.addEventListener("jarvis-event", onEvent);
    return () => {
      window.removeEventListener("jarvis-event", onEvent);
    };
  });

  const refresh = async (id: string) => {
    try {
      const t = (await api.project(id)).task;
      setTask(t);
      if (t.status === "running" || t.status === "cancelling") {
        window.clearTimeout(pollRef.current);
        pollRef.current = window.setTimeout(() => void refresh(id), 1200);
      } else {
        void load();
      }
    } catch (err) {
      setError(describeError(err));
    }
  };

  useEffect(() => () => { window.clearTimeout(pollRef.current); }, []);

  const [plan, planState] = useAction(async () => {
    setPreviewUrl(null);
    const t = await api.planProject({ name: form.name, template: form.template, description: form.description, run_tests: form.run_tests, run_build: form.run_build });
    setTask(t.task);
  });

  const [run, runState] = useAction(async () => {
    if (!task) return;
    await api.runProject(task.task_id, task.hash);
    await refresh(task.task_id);
  });

  const [cancel] = useAction(async () => {
    if (!task) return;
    await api.cancelProject(task.task_id);
    await refresh(task.task_id);
  });

  const openPreview = async () => {
    if (!task?.preview) return;
    const { token } = await api.previewToken();
    setPreviewUrl(`${task.preview.url}?token=${encodeURIComponent(token)}`);
  };

  const bridge = desktopBridge();

  return (
    <Dialog title="Project builder" onClose={() => { setPanel(null); }} wide>
      <p className="help">
        Projects are built locally from deterministic templates, plus the local model if one is installed. Each project gets its own folder under ~/.jarvis/projects with git checkpoints. JARVIS never publishes or uploads anything — that stays yours to do.
      </p>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}

      <form
        className="settings-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void plan();
        }}
      >
        <label className="field">
          <span>Project name</span>
          <input value={form.name} onChange={(e) => { setForm({ ...form, name: e.target.value }); }} placeholder="bakery-site" required />
        </label>
        <label className="field">
          <span>Type</span>
          <select value={form.template} onChange={(e) => { setForm({ ...form, template: e.target.value }); }}>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {language === "en" ? t.title.en : t.title.he}
              </option>
            ))}
          </select>
        </label>
        <label className="field span-2">
          <span>What it should do</span>
          <textarea rows={2} value={form.description} onChange={(e) => { setForm({ ...form, description: e.target.value }); }} placeholder="A one-page site for a bakery with an about section and a contact form" />
        </label>
        <div className="row span-2">
          <label className="check">
            <input type="checkbox" checked={form.run_tests} onChange={(e) => { setForm({ ...form, run_tests: e.target.checked }); }} /> Run tests
          </label>
          <label className="check">
            <input type="checkbox" checked={form.run_build} onChange={(e) => { setForm({ ...form, run_build: e.target.checked }); }} /> Run build
          </label>
          <button type="submit" className="btn btn-primary" disabled={planState.phase === "loading" || !form.name.trim()}>
            {planState.phase === "loading" ? "Planning…" : "Show me the plan"}
          </button>
        </div>
        {planState.error && (
          <p role="alert" className="error-text span-2">
            {planState.error}
          </p>
        )}
      </form>

      {templates.find((t) => t.id === form.template)?.needs_network_install && (
        <p className="banner banner-warn">This template installs open-source packages the first time, so it needs the internet once.{offline ? " Offline mode is on, so the install step will be skipped and reported, not faked." : ""}</p>
      )}

      {task && (
        <section>
          <h3>Plan — nothing has run yet</h3>
          <p className={task.mock ? "banner banner-warn" : "banner"}>{task.model_note}</p>
          <dl className="kv">
            <dt>Workspace</dt>
            <dd>{task.workspace}</dd>
            <dt>Prompt</dt>
            <dd>{task.prompt || "(none — template only)"}</dd>
            <dt>Files</dt>
            <dd>{task.files.length ? task.files.map((f) => `${f.path} (${String(f.bytes)} B)`).join(", ") : "generated by the model"}</dd>
            <dt>Commands</dt>
            <dd>{task.commands.length ? task.commands.map((c) => `${c.step}: ${c.argv.join(" ")}${c.offline_blocked ? " (skipped: offline)" : ""}`).join(" · ") : "none"}</dd>
            <dt>Tools</dt>
            <dd>{task.tools.join(" · ")}</dd>
            <dt>Permissions</dt>
            <dd>{task.permissions.join(" · ")}</dd>
            <dt>Expected changes</dt>
            <dd>{task.expected_changes}</dd>
            <dt>Git</dt>
            <dd>{task.git}</dd>
            <dt>Publishing</dt>
            <dd>{task.publish}</dd>
            <dt>Status</dt>
            <dd>{task.status}{task.error ? ` — ${task.error}` : ""}</dd>
          </dl>
          <div className="row">
            {task.status === "planned" && (
              <button type="button" className="btn btn-primary" onClick={() => void run()} disabled={runState.phase === "loading"}>
                {runState.phase === "loading" ? "Starting…" : "Approve and build"}
              </button>
            )}
            {(task.status === "running" || task.status === "cancelling") && (
              <button type="button" className="btn btn-danger" onClick={() => void cancel()}>
                {task.status === "cancelling" ? "Cancelling…" : "Cancel"}
              </button>
            )}
            {task.preview && task.status === "completed" && (
              <button type="button" className="btn" onClick={() => void openPreview()}>
                Preview
              </button>
            )}
            {bridge && task.status === "completed" && (
              <button type="button" className="btn" onClick={() => void bridge.openPath(task.workspace)}>
                Open folder
              </button>
            )}
          </div>
          {runState.error && (
            <p role="alert" className="error-text">
              {runState.error}
            </p>
          )}

          {task.progress.length > 0 && (
            <>
              <h3>Progress</h3>
              <pre className="progress-log">{task.progress.map((p) => `[${new Date(p.at).toLocaleTimeString()}] ${p.text}`).join("\n")}</pre>
            </>
          )}

          {task.changed_files.length > 0 && (
            <p className="help">
              <strong>Changed files:</strong> {task.changed_files.join(", ")}
            </p>
          )}
          {task.checkpoints.length > 0 && <p className="help">Git checkpoints: {task.checkpoints.map((c) => `${c.label} ${c.commit}`).join(" · ")}</p>}
          {task.scan && (
            <p className={task.scan.secrets.length || task.scan.dangerous.length ? "banner banner-warn" : "banner banner-ok"}>
              Scan: {task.scan.secrets.length} secret finding(s), {task.scan.dangerous.length} dangerous dependency(ies), {task.scan.unknown_license.length} unknown license(s)
              {task.scan.unknown_license.length ? `: ${task.scan.unknown_license.slice(0, 5).join(", ")}` : ""}
            </p>
          )}
          {previewUrl && <iframe className="preview" title="Project preview" src={previewUrl} sandbox="allow-scripts allow-forms" />}
        </section>
      )}

      <section>
        <h3>Existing projects</h3>
        {projects.length === 0 ? (
          <p className="log-empty">No projects yet.</p>
        ) : (
          <ul className="list">
            {projects.map((p) => (
              <li key={p.name} className="list-item">
                <div>
                  <strong>{p.name}</strong>
                  <span className="help">
                    {p.template} · {p.path}
                  </span>
                </div>
                {bridge && (
                  <button type="button" className="btn" onClick={() => void bridge.openPath(p.path)}>
                    Open folder
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </Dialog>
  );
}
