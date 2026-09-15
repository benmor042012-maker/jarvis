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
