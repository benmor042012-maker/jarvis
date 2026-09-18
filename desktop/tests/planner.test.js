const test = require("node:test");
const assert = require("node:assert/strict");
const { rulePlan } = require("../src/core/planner/rules");
const { extractJson, systemPrompt } = require("../src/core/planner/local-model");

const cases = [
  ["open youtube", "open_url"], ["פתח יוטיוב", "open_url"], ["open example.com", "open_url"], ["open notepad", "open_app"], ["פתח מחשבון", "open_app"],
  ["create file todo.txt with buy milk", "write_file"], ["צור תיקייה חשבוניות", "create_folder"], ["read file todo.txt", "read_file"], ["search for invoice", "search_files"],
  ["move a.txt to b.txt", "move_file"], ["delete old.txt", "delete_file"], ["take a screenshot", "screenshot"], ["type hello", "keyboard_type"], ["press ctrl+s", "key_combo"],
  ["click at 10,20", "mouse_click"], ["scroll down 5", "mouse_scroll"], ["copy hello to clipboard", "clipboard_write"], ["what is in the clipboard", "clipboard_read"],
  ["run powershell: Get-Date", "run_powershell"], ["run node -v", "run_command"], ["what time is it", "current_time"], ["calculate 2+2", "calculate"], ["remember dan likes tea", "remember"],
  ["remind me in 5 minutes to stretch", "set_reminder"], ["draft email to a@b.c subject: hi: hello", "create_email_draft"], ["schedule dentist at 2030-01-02T10:00", "create_calendar_draft"],
  ["focus chrome", "focus_window"], ["close notepad", "close_app"], ["list windows", "list_windows"],
];

for (const [cmd, tool] of cases) test(`rule planner: "${cmd}" -> ${tool}`, () => { const p = rulePlan(cmd); assert.equal(p.actions[0]?.tool, tool, JSON.stringify(p)); });

test("refusals and unknowns produce no actions", () => {
  for (const c of ["buy a laptop", "enter my password", "disable the antivirus", "asdf qwerty"]) assert.equal(rulePlan(c).actions.length, 0, c);
  assert.equal(rulePlan("asdf qwerty").unknown, true);
  assert.equal(rulePlan("draft a message to the customer about the delay").suggest, "drafts");
  assert.equal(rulePlan("build a website for my bakery").suggest, "projects");
});

test("model JSON extraction tolerates fences and prose", () => {
  assert.deepEqual(extractJson('Sure! ```json\n{"message":"hi","actions":[]}\n```'), { message: "hi", actions: [] });
  assert.throws(() => extractJson("no json here"));
  assert.match(systemPrompt([{ name: "t", risk: "low", description: "d", schema: { properties: {} } }], "he"), /Hebrew/);
});

test("project requests route to the builder in Hebrew and English", () => {
  for (const c of ["תעשה לי אתר בשביל מסעדה אטלקית", "בנה לי אתר", "תכין לי דף נחיתה", "אני רוצה אפליקציה לניהול לקוחות", "צור לי אתר תדמית", "build me a website for a bakery", "make an api for orders", "i want a mobile app", "design a landing page"]) {
    assert.equal(rulePlan(c).suggest, "projects", c);
  }
});

test("project routing does not swallow ordinary commands", () => {
  const untouched = [
    ["open notepad", "open_app"],
    ["פתח פנקס רשימות", "open_app"],
    ["create file a.txt with hi", "write_file"],
    ["צור קובץ רשימה.txt עם חלב", "write_file"],
    ["חפש קובץ אתר", "search_files"],
    ["delete old.txt", "delete_file"],
  ];
  for (const [cmd, tool] of untouched) {
    const p = rulePlan(cmd);
    assert.equal(p.suggest ?? null, null, cmd);
    assert.equal(p.actions[0]?.tool, tool, cmd);
  }
  assert.equal(rulePlan("תעשה לי קפה").unknown, true);
});

test("Hebrew prepositions attach to the next word, with or without a hyphen", () => {
  // ל / ב are prefixes in Hebrew — "לbackup.txt", "ל-backup.txt", "במסמכים" —
  // so a rule that demands a space after them never matches real typing.
  const expect = (cmd, tool, params) => {
    const p = rulePlan(cmd);
    assert.equal(p.actions[0]?.tool, tool, `${cmd} -> ${JSON.stringify(p)}`);
    for (const [k, v] of Object.entries(params)) assert.equal(p.actions[0].params[k], v, `${cmd} .${k}`);
  };
  expect("העבר את אתר.txt ל-backup.txt", "move_file", { from: "אתר.txt", to: "backup.txt" });
  expect("העבר את a.txt לb.txt", "move_file", { from: "a.txt", to: "b.txt" });
  expect("העבר את a.txt ל b.txt", "move_file", { from: "a.txt", to: "b.txt" });
  expect("חפש חשבונית במסמכים", "search_files", { query: "חשבונית", folder: "מסמכים" });
  expect("חפש חשבונית בתיקיית מסמכים", "search_files", { query: "חשבונית", folder: "תיקיית מסמכים" });
  expect("חפש חשבונית", "search_files", { query: "חשבונית", folder: "" });
  expect("קבע פגישה ב-2030-01-02", "create_calendar_draft", { title: "פגישה", start_iso: "2030-01-02" });
  expect("קבע רופא שיניים בתאריך 2030-01-02", "create_calendar_draft", { title: "רופא שיניים" });
  expect("היכנס ל-youtube", "open_url", { url: "https://www.youtube.com" });
  expect("גש לגוגל", "open_url", { url: "https://www.google.com" });
  expect("הצג קבצים בתיקייה projects", "list_files", { folder: "projects" });
});

test("the English equivalents keep working", () => {
  const expect = (cmd, tool, params) => {
    const p = rulePlan(cmd);
    assert.equal(p.actions[0]?.tool, tool, `${cmd} -> ${JSON.stringify(p)}`);
    for (const [k, v] of Object.entries(params)) assert.equal(p.actions[0].params[k], v, `${cmd} .${k}`);
  };
  expect("move a.txt to b.txt", "move_file", { from: "a.txt", to: "b.txt" });
  expect("rename old.txt to new.txt", "move_file", { from: "old.txt", to: "new.txt" });
  expect("search for invoice in docs", "search_files", { query: "invoice", folder: "docs" });
  expect("schedule dentist at 2030-01-02", "create_calendar_draft", { title: "dentist" });
  expect("create file website.txt with hi", "write_file", { path: "website.txt", content: "hi" });
});

test("the computer's own controls answer in Hebrew with no model installed", () => {
  // Sound, playback, the screen and notes are asked for in one short sentence.
  // A rule planner handles all of them, so none of this waits for a local model
  // to be downloaded — or for one to be right.
  const cases = [
    ["תעלה את הקול", "set_volume", { direction: "up" }],
    ["תוריד את הקול 6", "set_volume", { direction: "down", steps: 6 }],
    ["turn the volume down", "set_volume", { direction: "down" }],
    ["השתק", "set_volume", { direction: "mute" }],
    ["תנגן", "media_control", { action: "play_pause" }],
    ["השיר הבא", "media_control", { action: "next" }],
    ["previous track", "media_control", { action: "previous" }],
    ["נעל את המסך", "lock_screen", {}],
    ["מה מצב המחשב", "system_status", {}],
    ["מה רשמתי", "notes_today", {}],
  ];
  for (const [command, tool, params] of cases) {
    const p = rulePlan(command, { language: "he" });
    assert.equal(p.actions[0]?.tool, tool, `"${command}" → ${JSON.stringify(p.actions)}`);
    for (const [k, v] of Object.entries(params)) assert.equal(p.actions[0].params[k], v, `"${command}" ${k}`);
  }

  // A note keeps the words as they were said.
  const note = rulePlan("תרשום שצריך להתקשר לדנה מחר", { language: "he" });
  assert.equal(note.actions[0]?.tool, "note_add");
  assert.equal(note.actions[0].params.text, "צריך להתקשר לדנה מחר");

  // And none of this stole an existing command.
  for (const [command, tool] of [["מה השעה", "current_time"], ["פתח פנקס רשימות", "open_app"]]) {
    const p = rulePlan(command, { language: "he" });
    assert.equal(p.actions[0]?.tool, tool, `"${command}" must still work`);
  }
});
