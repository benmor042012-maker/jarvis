# JARVIS

<p align="center"><img src="docs/screenshot-desktop.png" alt="JARVIS dashboard: a dark navy screen with a glowing cyan orb, status READY, an activity panel and a command bar" width="820"></p>

<div dir="rtl">

## התחלה מהירה

לג'רביס שלושה חלקים. כל אחד עצמאי, ואפשר להפעיל רק את מה שרוצים.

### 1. המוח בענן — כדי שג'רביס יענה בכלל

```
npm run setup
```

פקודה אחת שעושה הכל: מתחברת ל-Cloudflare, יוצרת את מסד הנתונים ואת אינדקס הזיכרון,
מבקשת את מפתח Claude, ומעלה את השרת. אפשר להריץ אותה שוב בבטחה.

בסיום היא נותנת כתובת. **פתח אותה בדפדפן** ותראה דף בעברית שאומר בדיוק מה פעיל ומה חסר:

```
https://<הכתובת-שלך>.workers.dev/setup
```

זה הדף שפותרים איתו כל תקלה. אם ג'רביס לא עונה — הוא יגיד למה.

### 2. הדף לדיבור — שיחה בקול בעברית

<https://benmor042012-maker.github.io/jarvis/>

עובד מכל דפדפן, גם בנייד. מדבר, זוכר, מזכיר, מחפש באינטרנט.

### 3. שליטה במחשב

| מה | איך מפעילים |
|---|---|
| **אפליקציית שליטה במחשב** (מסך, עכבר, מקלדת, ווטסאפ) | `desktop\INSTALL-JARVIS.bat` |
| **אפליקציית הפעולות הבטוחות** (הממשק שבתמונה למעלה) | `START-JARVIS-APP.bat` או `npm run app` |

שתיהן מתקינות לבד את מה שחסר בהרצה הראשונה.

### תוספות אופציונליות

- **יומן Google ו-Gmail** + תדריך בוקר אוטומטי ב-6:00 — ראה [SETUP-GOOGLE.md](SETUP-GOOGLE.md)
- **בוט טלגרם** — `npx wrangler secret put TELEGRAM_BOT_TOKEN` ואז פתח `<הכתובת>/telegram/setup`

## פתרון תקלות

| מה קורה | מה לעשות |
|---|---|
| ג'רביס לא עונה כלום | פתח `<הכתובת>/setup`. מה שמסומן ב-✕ הוא הבעיה. |
| "חסר ANTHROPIC_API_KEY" | `npx wrangler secret put ANTHROPIC_API_KEY` |
| עונה, אבל לא זוכר ולא מזכיר | מסד הנתונים לא מחובר. הרץ `npm run setup` שוב. |
| "לא הצלחתי להגיע לשרת" | השרת לא הועלה. הרץ `npm run setup`. |
| האפליקציה המקומית נסגרת מיד | הרץ מ-cmd ותראה את השגיאה. בדרך כלל חסר Node.js או Python. |
| "address already in use" | ג'רביס כבר רץ. פתח <http://localhost:8000>, או `set PORT=8010 && npm run app` |

ג'רביס אף פעם לא מוחק קבצים, לא מריץ פקודות חופשיות, לא נוגע בסיסמאות ולא קונה כלום. זה חסום בקוד.

</div>

---

## The local safe-action app

A cinematic, Iron-Man-style assistant that runs entirely on your machine: a React + TypeScript
front end with an animated HUD orb, and a small FastAPI back end that plans **safe, allowlisted
actions** and executes them only after the permission policy (and you) say so.

- Works out of the box in **mock mode** (no key, no network): a rule-based planner understands
  "open youtube", "launch notepad", "search for report", "read file notes.txt",
  "create file todo.txt with buy milk".
- Add an **OpenAI-compatible** API key (OpenAI, Ollama, LM Studio, OpenRouter, …) and the same
  UI is driven by a real model. The key lives only in the server process / your `.env`.
- Every action is validated against a strict schema, an action-type allowlist, a URL host
  allowlist, a fixed app allowlist and workspace path containment. Confirmation for medium/high
  risk is enforced **on the server**, not just in the UI.
- No shell execution, no deletes, no credential access, no messaging, no unrestricted computer
  control. That is by design.

> This directory also contains the earlier JARVIS projects (`index.html` + Cloudflare Worker in
> `src/`, and the Electron agent in `desktop/`). They are independent of the app described here.

---

### Quick start

One command, from a clean checkout: `npm run app` (or double-click `START-JARVIS-APP.bat` on
Windows). It creates the Python environment, installs both halves, builds the UI and serves
everything at <http://localhost:8000>. The rest of this section is the manual equivalent.

Requirements: **Python 3.10+** and **Node 18+**.

```bash
# 1. clone
git clone https://github.com/benmor042012-maker/jarvis.git
cd jarvis

# 2. back end
python -m venv .venv
. .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt

# 3. front end
cd client && npm install && cd ..

# 4. configure (optional — leave the key empty for mock mode)
cp .env.example .env

# 5. run, two terminals
uvicorn server.main:app --reload --port 8000          # terminal A
cd client && npm run dev                              # terminal B  → http://localhost:5173
```

Open <http://localhost:5173>. The header shows **Mock mode** until a key is set.

### Loading the `.env`

The server reads plain environment variables. Either export them, or load the file:

```bash
set -a; . ./.env; set +a; uvicorn server.main:app --port 8000      # bash/zsh
```

On Windows PowerShell: `Get-Content .env | ForEach-Object { if ($_ -match '^(\w+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2]) } }` then start uvicorn.

You can also paste the key in **Settings** inside the app. It is sent once over localhost, kept in
server memory, never written to disk by the app and never sent back to the browser (only a
masked hint like `••••ab12`).

---

## Using it

| Say / type                                   | Action              | Risk   | Default behaviour (`ask` mode) |
| -------------------------------------------- | ------------------- | ------ | ------------------------------ |
| `open youtube`, `go to github.com`           | `open_url`          | low    | runs                           |
| `search for invoice`                         | `search_files`      | low    | runs                           |
| `read file notes.txt`                        | `read_text_file`    | low    | runs                           |
| `launch notepad` / `open calculator`         | `open_app`          | medium | confirmation dialog            |
| `create file todo.txt with buy milk`         | `create_text_file`  | medium | confirmation dialog            |
| `delete …`, `send email …`, `run …`          | refused             |        | nothing runs                   |

Keyboard: `/` focuses the command bar, `Enter` runs, `Esc` stops a running task or closes a dialog.
The microphone button (Chrome/Edge) asks for permission first and only listens while pressed.

**Permission modes** (Settings → Automation permission mode):

- `manual` — confirm every action.
- `ask` — run low risk, confirm medium and high. *(default)*
- `auto` — run low and medium, confirm high.

Allowed sites and apps are listed in Settings. Change them with `JARVIS_ALLOWED_URL_HOSTS` in
`.env`; apps are a fixed table in `server/permissions.py` (argv only, never a shell).

---

## Configuration

See [`.env.example`](.env.example). Non-secret settings changed in the UI persist to
`server/data/settings.json` (git-ignored). The API key never does.

| Variable                   | Meaning                                                    |
| -------------------------- | ---------------------------------------------------------- |
| `JARVIS_API_KEY`           | Provider key. Empty → mock mode. (`OPENAI_API_KEY` also read.) |
| `JARVIS_BASE_URL`          | OpenAI-compatible base, e.g. `http://localhost:11434/v1`   |
| `JARVIS_MODEL`             | Model name                                                 |
| `JARVIS_WORKSPACE_DIR`     | The only folder file actions may touch                     |
| `JARVIS_PERMISSION_MODE`   | `manual` / `ask` / `auto`                                  |
| `JARVIS_ALLOWED_URL_HOSTS` | Comma-separated hosts for `open_url`                       |
| `JARVIS_MOCK`              | `true` forces mock mode even with a key                    |

---

## API

All endpoints are local (`/api/*`); interactive docs at <http://localhost:8000/api/docs>.

| Method | Path                     | Purpose                                          |
| ------ | ------------------------ | ------------------------------------------------ |
| POST   | `/api/command`           | `{command}` → validated plan (see schema below)  |
| POST   | `/api/execute`           | `{actions, confirmed}` → job (202)               |
| GET    | `/api/jobs/{id}`         | poll job status / results                        |
| POST   | `/api/jobs/{id}/cancel`  | stop after the current action                    |
| GET/PUT| `/api/settings`          | read (masked) / update settings                  |
| POST   | `/api/settings/test`     | Connected / Missing key / Invalid key / Error    |
| GET    | `/api/health`            | liveness + mock flag                             |

Plan schema returned by `/api/command` (and the only thing a model may produce):

```json
{
  "message": "string",
  "requires_confirmation": true,
  "actions": [
    { "type": "open_url | open_app | search_files | read_text_file | create_text_file",
      "payload": {}, "risk": "low | medium | high" }
  ]
}
```

Errors are JSON: `403 {"error":"blocked"}` (allowlist), `409 {"error":"confirmation_required"}`,
`502 {"error":"provider_error"}` with a human-readable, secret-free `detail`.

---

## Project layout

```
client/                 React + TypeScript + Vite
  src/components/       JarvisOrb, CommandBar, ActivityLog, PermissionDialog, SettingsPanel, Header
  src/state/            jarvisStore.ts (zustand)
  src/styles/theme.css  design tokens, orb animation, reduced-motion, responsive layout
server/                 FastAPI
  main.py               routes, error handlers, static serving of client/dist
  schemas.py            Pydantic models (discriminated action union, strict)
  permissions.py        risk policy, URL/app allowlists, workspace path containment
  model_provider.py     ModelProvider protocol, MockProvider, OpenAICompatibleProvider
  action_planner.py     provider → validated, policy-checked plan
  action_executor.py    per-action handlers, server-side confirmation, cancellable jobs
  logging_utils.py      JSON logs with secret redaction
tests/                  pytest: schemas, permissions, path security, planner, executor, API
workspace/              default sandbox folder for file actions
```

---

## Commands

```bash
# install
python -m venv .venv && . .venv/bin/activate && pip install -r requirements-dev.txt
cd client && npm install && cd ..

# configure
cp .env.example .env          # edit as needed

# run (dev)
uvicorn server.main:app --reload --port 8000
cd client && npm run dev

# test / lint / typecheck
python -m pytest -q
ruff check server tests
cd client && npm run lint && npm run typecheck

# production build (server then serves the built UI at http://localhost:8000)
cd client && npm run build && cd ..
uvicorn server.main:app --port 8000
```

---

## Security model, in one paragraph

The browser never holds a secret and never talks to a model provider; it only talks to the local
server. The server holds the key in memory (or reads it from the environment), redacts anything
key-shaped from logs and error messages, and rejects any model output that is not exactly the
plan schema. Risk is assigned by server policy (a model can raise it, never lower it). Actions
outside the allowlist, URLs outside the allowed hosts, apps outside the fixed table and paths that
resolve outside the workspace (including symlink escapes and secret-looking names such as
`.env` or `*.pem`) are refused with a 403. Medium/high-risk actions without `confirmed: true`
are refused with a 409 even if a client tries to skip the dialog. Files are never overwritten or
deleted.

## Limitations

- `open_app` launches a fixed set of apps by platform-specific argv; on Linux it assumes
  `gedit`, `gnome-calculator`, `xdg-open`, `x-terminal-emulator`, `code` exist.
- Speech input relies on the browser's Web Speech API (Chrome/Edge). Firefox has no support, so
  the mic button is hidden there.
- The connection test calls `GET {base_url}/models`; a few gateways do not implement it and will
  report *Error* even when chat works.
- Jobs and the pasted API key live in server memory and are gone after a restart; use `.env` to
  persist the key.
