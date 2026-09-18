# JARVIS

<p align="center"><img src="docs/screenshot-desktop.png" alt="JARVIS: a dark navy screen with a glowing cyan orb, status READY, a session log and a command bar" width="860"></p>

A **self-contained** local AI assistant that really controls your Windows computer.
No cloud AI, no account, no API key, no subscription, no payment — anywhere, ever.
The one optional outbound piece is the relay that lets your phone reach the computer from
outside your home; it is free, off by default, and cannot read a single byte it carries.

Public page: <https://benmor042012-maker.github.io/jarvis/> (explains and links the download; a web page can never control a computer — the installed agent does).

<div dir="rtl">

## התחלה מהירה

```
git clone https://github.com/benmor042012-maker/jarvis.git
cd jarvis
npm run setup     # מתקין, בונה ומריץ את כל הבדיקות
npm start         # פותח את ג'רביס
```

ב-Windows אפשר פשוט ללחוץ פעמיים על **`INSTALL-JARVIS.bat`**.

דרוש Node.js 18+. בינה מלאכותית מקומית היא אופציונלית: אם יש Ollama או LocalAI — ג'רביס משתמש בהם;
אם אין — הוא אומר **MOCK MODE** במפורש ועובר למתכנן כללים דטרמיניסטי, בלי להעמיד פנים.

להתקנת המוח המקומי בפקודה אחת (חינם, בלי חשבון ובלי מפתח):

```
npm run ai
```

הוא בודק אם Ollama מותקן ורץ, ממליץ על מודל לפי הזיכרון של המחשב, ומוריד אותו.

כדי שג'רביס יבין עברית בקול — פקודה אחת, או לחיצה כפולה על **`INSTALL-VOICE.bat`**:

```
npm run voice
```

הוא מוריד את מנוע הדיבור ומודל שמבין עברית, ואז שואל את ג'רביס עצמו אם הוא באמת שומע —
ואומר "מוכן" רק אחרי שבדק.

**כדי שהוא יתעורר תוך שנייה:** בחלון ג'רביס → **Voice** → *Teach JARVIS your wake word*, ותגידו
את מילת ההערה שלוש פעמים. מאז הוא מזהה אותה בחלון עצמו תוך אלפית שנייה, בלי תמלול בכלל —
מנוע הדיבור עובד רק על הפקודה עצמה. ההקלטות לא יוצאות מהמחשב ולא נשמרות כקול: נשמרים כמה מאות
מספרים שמתארים את צורת הצליל.

**לדיבור — קחו את `small` (466 מגה, חינם).** הוא עונה בערך בשנייה, וזה מה שהופך את זה לשיחה.
`turbo` מדייק יותר, אבל לוקח כמה שניות למשפט על מחשב רגיל — קחו אותו רק אם דיוק חשוב לכם יותר
ממהירות. אם המודל שמותקן איטי מדי כאן, ג'רביס עובר לבד למודל המהיר יותר שכבר קיים אצלכם ואומר
שהוא עשה את זה. `base` ו-`tiny` פשוט טועים בעברית, וההתקנה מציעה להחליף אותם.

| מצב | מה מותר |
|---|---|
| **Safe** | קריאה בלבד, פעולות הפיכות |
| **Assistant** | ברירת מחדל; בינוני וגבוה מבקשים אישור |
| **Advanced** | מדיניות משלך לכל כלי; סיכון גבוה עדיין שואל תמיד |
| **Emergency stopped** | שום דבר לא רץ |

עצירת חירום: <kbd>Ctrl+Shift+Esc</kbd> מכל מקום, או כפתור **STOP**.

</div>

---

## What it is

Three pieces, all on your machine:

| Piece | What it does |
| --- | --- |
| **Agent core** (`desktop/src/core`) | Tool registry, permission policy, signed command protocol, device pairing, executor, audit log, local HTTP server. Pure Node, no dependencies. |
| **Desktop shell** (`desktop/main.js`) | Electron: tray, hide-to-tray, Windows auto-start, global emergency-stop hotkey, the native second confirmation for high-risk actions, and the built-in browser used for form automation. |
| **Interface** (`client/`) | The React UI with the J.A.R.V.I.S orb. Served by the agent at `http://127.0.0.1:8765` — the same page your phone opens after pairing, over Wi-Fi or through the optional relay. |

The GitHub Pages site is documentation only. Browsers block page access to files, mouse and
keyboard; that is a browser security guarantee and nothing can work around it.

## What it can do

**Computer control** (typed tools, each with a schema, risk level, timeout, cancellation,
permission rule and audit redaction policy):

| Category | Tools | Risk |
| --- | --- | --- |
| Apps | `open_app`, `open_url`, `open_file` / `close_app` | low / medium |
| Files | `list_files`, `read_file`, `create_folder`, `search_files`, `list_trash` / `write_file`, `move_file` / `overwrite_file`, `delete_file` | low / medium / high |
| Screen | `screen_info`, `list_windows`, `focus_window`, `minimize_window`, `maximize_window` / `screenshot`, `close_window` | low / medium |
| Input | `mouse_move`, `mouse_scroll` / `mouse_click`, `mouse_drag`, `key_combo`, `keyboard_type` | low / medium |
| Clipboard | `clipboard_write` / `clipboard_read` | low / medium |
| Shell | `run_command`, `run_powershell` | high |
| Browser | `browser_fill_form` (preview, never submits) / `browser_submit_form` | medium / high |
| Drafts | `create_email_draft` (.eml), `create_calendar_draft` (.ics) — never sent | low |
| Info & memory | `current_time`, `calculate`, `remember`, `recall`, `forget`, `set_reminder`, `list_reminders`, `cancel_reminder` | low / medium |

**Project builder** — websites, APIs, desktop apps, PWAs and installer configs from deterministic
templates plus the local model, in isolated folders under `~/.jarvis/projects`, with git
checkpoints, real test/build runs, secret scanning and dependency/license checks. It never
publishes or uploads: that stays yours to do.

**Customer drafts** — Hebrew and English templates, tone changes, optional local-model rewriting
and translation, opt-out list, duplicate prevention and rate-limit simulation.
Labelled **DRAFT ONLY — NOTHING IS SENT**, because there is no sending code in the product at all.

**Voice** — JARVIS is controlled by voice; the keyboard is a fallback you open deliberately.
The page records through an AudioWorklet, cuts what it hears into utterances with a local
voice detector, and posts them to the agent, which transcribes them with a speech engine
**installed on your computer** (whisper.cpp, or Vosk when its optional binding is present).
Say **"תתעורר"** to wake it, then your command. Say **"עצור"**, **"תעצור"** or **"חירום"**
to stop everything — those are matched on the transcript, so they work with no AI model at all.
Quiet hours, a maximum listening time, false-wake protection and configurable phrases are in
Settings → Voice. No audio is uploaded anywhere and none is kept: the agent writes one temporary
WAV for the engine and deletes it immediately unless you switch "keep recordings" on.

**Customer alerts** — customer records on your computer are scored by fixed rules (urgent
wording, complaints, missed deadlines, days without an answer, and what you marked as a
priority), so alerting works with no model installed and in offline mode. An alert reaches the
screen, a Windows notification, a local sound, speech, and any paired phone on your Wi-Fi that
has the JARVIS page open. Only the customer's **name** is said out loud; the reason and the
record stay on screen. Everything is labelled **LOCAL WI-FI ALERTS — NO EXTERNAL MESSAGES**.

**Phone calls** — after you approve the exact number on screen, a paired phone opens its dialer
with the number filled in and **you** press call. That is the whole mechanism, and the Phone
panel lists what is and is not possible, one line each, with the reason. See
[Calling, honestly](#calling-honestly).

## Security model

Every command from any device carries a signed envelope:

```json
{ "v": 1, "id": "<uuid>", "device_id": "…", "ts": 0, "expires": 0, "nonce": "…",
  "params": {}, "params_hash": "<sha256>", "signature": "<hmac-sha256>", "session": "…" }
```

The agent rejects anything **malformed, expired, replayed, duplicated, unauthorized or modified**.
Then every command follows the same path: receive → build a readable plan → show every action,
target, parameter, risk and reversibility → ask for approval when required → bind that approval to
the exact plan hash → execute with a timeout and a cancel signal → write a redacted audit event →
return `completed`, `partial`, `failed`, `cancelled`, `denied`, `expired` or `offline`.

- High-risk actions approved from a phone also need a **second confirmation on the computer**.
- The server binds to `127.0.0.1` unless you enable LAN access; there is no relay and no tunnel.
- Public `Host` headers are refused (DNS-rebinding defence), and only the UI's own origin gets CORS.
- Shell tools take an argv array, never a shell string; PowerShell receives user values through
  environment variables, so nothing is ever concatenated into a script.
- Cancellation and the emergency stop kill the **whole child-process tree**.
- Passwords, cookies, private keys and secret-looking files are blocked by path policy.
- The audit log never stores clipboard contents, typed text, file contents or screenshots — only
  sizes, paths and outcomes.

## Phone access

Enable LAN access in Settings, then **Devices → Pair a new device**: the computer shows an 8-digit
single-use code (and a QR) that expires in 5 minutes. From the phone you can see status, send
commands, approve plans, receive customer alerts, approve a call and open the dialer, read the
redacted log and revoke the device. When the computer is off,
asleep, disconnected or the agent is stopped, the phone says exactly that — it never shows a fake
connected state.

### From outside the house

On the same Wi-Fi the phone talks to the computer directly. From anywhere else it cannot: your
home router has no route in, and nothing here opens a public port. A **relay** bridges that gap —
the computer dials *out* and holds a long poll, so the phone's message has somewhere to meet it.

Deploy your own in one command (`cd relay && npx wrangler deploy` — free tier, see
[`relay/README.md`](relay/README.md)), paste the address into **Devices → Control this computer
from your phone**, and turn it on. Until you do, the agent never dials out.

The relay is a pipe, not a participant:

- Every frame is sealed end to end with AES-256-GCM under a key derived from the paired device's
  own secret. The relay sees opaque bytes and a random room id.
- Relayed messages go through `server.dispatch` — the *same* verifier as the local link. A hostile
  relay cannot forge a command, replay one, tamper with its parameters, or promote a phone to
  owner; those four refusals are tests, not claims (`desktop/tests/relay.test.js`).
- It can delay or drop a message. That is the whole of its power, and the phone shows it as a
  timeout rather than inventing a result.

## Calling, honestly

| Can JARVIS… | Answer | Why |
| --- | --- | --- |
| Place a call from the computer | **No** | A PC has no cellular modem. Placing a call would need a telephony or VoIP provider, which costs money and sends your call through someone else's servers. |
| Open the dialer on your phone, number ready | **Yes** | The approved number is sent to the paired phone over your own Wi-Fi and opened as a `tel:` link. |
| Press the call button for you | **No** | A web page may open the dialer, but Android never lets it press call. Doing it for you would need an installed Android app. |
| Know whether the call connected | **No** | Android does not tell a web page what happened after the dialer opens. JARVIS records what **you** tell it, and there is no "connected" state anywhere in the code. |
| Answer an incoming call | **No** | Answering needs the `ANSWER_PHONE_CALLS` permission (Android 8+) in an installed, user-approved app. This project ships no Android app, so the request is refused with that reason instead of pretending. |
| Record call audio | **No** | Not recorded, not stored, not by default and not at all. |

Simulation mode runs the whole flow — request, approval screen, outcome, notes, a draft reply —
without ever opening a dialer, and every screen says SIMULATION. Nothing here uses WhatsApp,
Telegram, SMS or email.

## Commands

```bash
npm run setup           # install + build + test
npm run ai              # optional: install the local AI brain (Ollama + a model)
npm run voice           # optional: install local speech recognition (whisper.cpp + a model)
node scripts/make-icons.mjs  # redraw the window and tray icons (they are generated, not artwork)
npm start               # desktop agent (or headless if Electron is missing)
npm run headless        # agent without a window (Linux/servers/CI)
npm test                # agent test suite
npm run verify          # tests + lint + typecheck + build + self-contained scan
npm run e2e             # the interface in a real browser (needs Playwright; skips without it)
npm run build:installer # Windows installer into desktop/dist
```

## Where your data lives

```
~/.jarvis/
  config.json     settings
  devices.json    paired devices (secrets encrypted by the OS when available)
  workspace/      the folder file tools may touch by default
  projects/       project builder workspaces
  drafts/         customer drafts, .eml and .ics files
  logs/           redacted audit log, one file per day
  trash/          what "delete" actually does
  temp/           screenshots (and one WAV at a time while it is being transcribed)
  customers.json  customer records, used only to decide what is urgent
  alerts.json     alerts raised, acknowledged and resolved
  speech/         where JARVIS looks for a local speech engine and its model
```

Voice transcripts are kept in memory by the running agent (the last 200) and in the audit log as
counts, never as audio. Call notes and draft replies are text you wrote. All of it is covered by
**Delete local data**.

Export or delete all of it from **Activity log → Export my data / Delete local data**.

## Limits, stated honestly

- Mouse, keyboard, window and screen-info tools use Windows APIs. On macOS and Linux they report
  themselves unavailable with the reason; the rest of JARVIS keeps working.
- Browser automation needs the Electron window (it uses the built-in Chromium). Headless mode says so.
- **A taught wake word answers immediately; the speech engine is for what you say next.** Running
  every sound through whisper.cpp to find out whether it was the wake phrase costs seconds on an
  ordinary computer, and a wake answered five seconds late reads as one that was ignored. Voice →
  *Teach JARVIS your wake word* records the phrase three times and from then on matches the shape of
  the sound in the page itself (MFCC features, dynamic time warping) in about a millisecond — no
  model, no download, no network. The tolerance comes from how much your own three recordings differ.
  Without it, everything still works; waking just waits for the engine.
- **Voice needs a speech engine installed on the computer.** `npm run voice` (or a double-click on
  `INSTALL-VOICE.bat`) fetches it and a multilingual model for you, then asks JARVIS whether it can
  actually hear you before saying it is ready. It recommends `small`, which answers in about a
  second: for talking to, a model that is right every time in fifteen seconds is worse than one that
  mishears a word now and then and keeps up. `turbo` is offered for accuracy, and `base`/`tiny` are
  offered the upgrade because they get Hebrew wrong outright. If the installed model turns out to be
  too slow on this computer, JARVIS moves to the fastest one already installed beside it and says so
  — it never downloads or deletes anything on its own. Without one nothing is transcribed, and JARVIS names
  the missing component and the exact free steps rather than guessing at what you said. An
  English-only model (`*.en.bin`) is refused for Hebrew with that reason.
- **Speaking out loud uses the voices installed in Windows.** Chrome also offers voices that are
  synthesised on Google's servers; those are excluded on purpose, so if no local voice exists for
  your language JARVIS says so and stays silent instead of sending your text away.
- **A phone over Wi-Fi cannot use its microphone for JARVIS, and cannot show a system
  notification.** Browsers only allow both over https or from localhost, and the page your phone
  opens is plain `http://192.168.…`. That is a browser rule, not a setting. The phone still shows
  the alert on screen with a sound while the page is open, approves calls and opens the dialer —
  none of which need a permission. Talk to JARVIS from the computer itself.
- **Installing JARVIS as an app on the phone** (the offline shell) needs the same secure context,
  so it is unavailable over plain http for the same reason.
- Headless mode cannot show the native second confirmation, so high-risk plans approved remotely
  are refused there rather than run unconfirmed.
- Local models are smaller than hosted assistants: they can misunderstand and are slower. Every plan
  is validated against the tool schemas and shown to you before anything runs, and you can always
  fall back to the deterministic rule planner.
- A computer that is off, asleep without wake support, or disconnected cannot be controlled.

## License

MIT.
