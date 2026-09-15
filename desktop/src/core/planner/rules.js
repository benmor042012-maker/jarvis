// Deterministic rule-based planner (Hebrew + English). This is the fallback
// when no local model is installed, and the reference behaviour tests rely on.
// It returns { message, actions:[{tool, params}], suggest? } and never runs
// anything itself.

const URL_WORDS = { "youtube": "https://www.youtube.com", "יוטיוב": "https://www.youtube.com", "google": "https://www.google.com", "גוגל": "https://www.google.com", "github": "https://github.com", "גיטהאב": "https://github.com", "wikipedia": "https://www.wikipedia.org", "ויקיפדיה": "https://he.wikipedia.org", "gmail": "https://mail.google.com", "ג'ימייל": "https://mail.google.com", "whatsapp": "https://web.whatsapp.com", "וואטסאפ": "https://web.whatsapp.com", "ווצאפ": "https://web.whatsapp.com" };
const APP_WORDS = { "notepad": "notepad", "text editor": "notepad", "פנקס": "notepad", "פנקס רשימות": "notepad", "calculator": "calculator", "calc": "calculator", "מחשבון": "calculator", "explorer": "explorer", "file explorer": "explorer", "files": "explorer", "סייר הקבצים": "explorer", "סייר": "explorer", "קבצים": "explorer", "paint": "paint", "צייר": "paint", "wordpad": "wordpad", "terminal": "terminal", "cmd": "terminal", "command prompt": "terminal", "טרמינל": "terminal", "browser": "browser", "chrome": "browser", "edge": "browser", "דפדפן": "browser", "vscode": "vscode", "vs code": "vscode", "code": "vscode", "settings": "settings", "הגדרות": "settings", "snipping": "snipping" };

// Refusals are about the action being asked for, not words inside file contents.
const REFUSE = /^(?:please\s+)?(?:buy|purchase|pay|order|subscribe|קנה|תקנה|לקנות|שלם|תשלם|הזמן|תזמין)(?:\s|$)|credit card|כרטיס אשראי|\bpassword\b|סיסמ[הא]|disable (?:the )?(?:antivirus|firewall|defender)|בטל (?:את )?(?:האנטי|חומת האש)|format [a-z]:/i;

function q(s) { return s.replace(/^["'“”‘’]|["'“”‘’]$/g, "").trim(); }
function plan(message, actions = [], extra = {}) { return { message, actions, ...extra }; }

function parseKeys(s) {
  return s.toLowerCase().replace(/\s+/g, "").split("+").filter(Boolean).map((k) => ({ control: "ctrl", cmd: "win", windows: "win", return: "enter", escape: "esc", del: "delete" }[k] || k));
}

function rulePlan(input, ctx = {}) {
  const text = String(input || "").trim();
  const low = text.toLowerCase();
  const he = /[֐-׿]/.test(text);
  if (!text) return plan(he ? "לא שמעתי כלום." : "I didn't get a command.");

  let m;
  if (REFUSE.test(low)) return plan(he ? "זה חסום: רכישות, תשלומים, סיסמאות והגדרות אבטחה לא נעשים דרכי, בשום מצב." : "That is blocked: purchases, payments, passwords and security settings are never done through me.");

  if (/^(hi|hello|hey|שלום|היי|הי|בוקר טוב|ערב טוב)\b/.test(low)) return plan(he ? "מחובר ומוכן. מה לעשות?" : "Online and ready. What should I do?");
  if (/^(help|what can you do|מה אתה יודע לעשות|עזרה)\b/.test(low)) {
    return plan(he ? "אפשר לבקש: פתח פנקס רשימות, פתח youtube, צלם מסך, הקלד 'טקסט', לחץ ctrl+s, צור קובץ notes.txt עם ..., קרא קובץ, חפש קובץ, העבר קובץ, מחק קובץ, העתק ללוח, מה השעה, חשב 12*7, זכור ..., תזכיר לי בעוד 10 דקות ..., נסח מייל אל ... ולמשימות גדולות: בונה הפרויקטים והטיוטות בתפריט." : "Try: open notepad, open youtube, take a screenshot, type 'text', press ctrl+s, create file notes.txt with ..., read file, search for, move file, delete file, copy to clipboard, what time is it, calculate 12*7, remember ..., remind me in 10 minutes to ..., draft email to ... For larger tasks use the Project Builder and Drafts panels.");
  }

  // Emergency / mode words are handled by UI, not by plans.
  if (/(emergency|stop everything|עצור הכל|עצירת חירום)/.test(low)) return plan(he ? "עצירת חירום היא כפתור STOP או המקש הגלובלי, לא פקודה טקסטואלית." : "Emergency stop is the STOP button or the global hotkey, not a text command.");

  // Time / calc
  if (/(what time|what's the time|what is the time|מה השעה|איזה יום|what day|what.s the date|מה התאריך)/.test(low)) return plan(he ? "בודק את השעה." : "Checking the time.", [{ tool: "current_time", params: {} }]);
  if ((m = low.match(/^(?:calculate|calc|compute|חשב|כמה זה|what is|what's)\s+([-0-9+*/%^().,\s a-z]+)$/)) && /[0-9]/.test(m[1]) && /[-+*/%^]|sqrt|pow/.test(m[1])) {
    return plan(he ? "מחשב." : "Calculating.", [{ tool: "calculate", params: { expression: m[1].trim().replace(/,/g, "") } }]);
  }

  // Memory
  if ((m = text.match(/^(?:remember|note that|זכור ש?|תזכור ש?|שמור בזיכרון ש?)\s+(.+)$/i))) return plan(he ? "שומר בזיכרון המקומי." : "Saving to local memory.", [{ tool: "remember", params: { text: m[1].trim() } }]);
  if (/^(what do you remember|מה אתה זוכר|list memory|הזיכרון שלך)/i.test(text)) return plan(he ? "מציג את הזיכרון." : "Here is what I remember.", [{ tool: "recall", params: { query: "" } }]);
  if ((m = text.match(/^(?:recall|do you remember|מה אתה זוכר על|האם אתה זוכר)\s+(.+)$/i))) return plan(he ? "מחפש בזיכרון." : "Searching memory.", [{ tool: "recall", params: { query: q(m[1]) } }]);
  if ((m = text.match(/^(?:forget|שכח)\s+(.+)$/i))) return plan(he ? "מוחק מהזיכרון." : "Removing from memory.", [{ tool: "forget", params: { query: q(m[1]) } }]);

  // Reminders
  if ((m = text.match(/^(?:remind me|תזכיר לי)\s+(?:in|בעוד)\s+(\d+)\s*(minutes?|min|mins|hours?|h|דקות|דקה|שעות|שעה)\s+(?:to\s+)?(.+)$/i))) {
    const n = Number(m[1]);
    const hours = /^(h|hour|hours|שעות|שעה)$/i.test(m[2]);
    return plan(he ? "מגדיר תזכורת מקומית." : "Setting a local reminder.", [{ tool: "set_reminder", params: { text: m[3].trim(), in_minutes: hours ? n * 60 : n } }]);
  }
  if (/^(list reminders|my reminders|תזכורות|אילו תזכורות|מה התזכורות)/i.test(text)) return plan(he ? "התזכורות שלך:" : "Your reminders:", [{ tool: "list_reminders", params: {} }]);
  if ((m = text.match(/^(?:cancel reminder|בטל תזכורת)\s+(.+)$/i))) return plan(he ? "מבטל תזכורת." : "Cancelling reminder.", [{ tool: "cancel_reminder", params: { id_or_text: q(m[1]) } }]);

  // Screen / windows
  if (/(take a screenshot|screenshot|capture the screen|צלם מסך|צילום מסך|תצלם את המסך)/.test(low)) return plan(he ? "צילום מסך דורש אישור." : "A screenshot needs your permission.", [{ tool: "screenshot", params: {} }]);
  if (/^(list windows|which windows|what windows are open|אילו חלונות פתוחים|רשימת חלונות|חלונות פתוחים)/i.test(text)) return plan(he ? "בודק חלונות פתוחים." : "Listing open windows.", [{ tool: "list_windows", params: {} }]);
  if ((m = text.match(/^(?:focus|switch to|go to window|bring up|עבור ל|עבור לחלון|תעבור ל|תראה לי את החלון|מקד)\s+(?:the\s+)?(?:window\s+)?(.+)$/i))) return plan(he ? "עובר לחלון." : "Focusing the window.", [{ tool: "focus_window", params: { title: q(m[1]) } }]);
  if ((m = text.match(/^(?:minimize|מזער)\s+(.+)$/i))) return plan(he ? "ממזער." : "Minimizing.", [{ tool: "minimize_window", params: { title: q(m[1]) } }]);
  if ((m = text.match(/^(?:maximize|הגדל)\s+(.+)$/i))) return plan(he ? "מגדיל." : "Maximizing.", [{ tool: "maximize_window", params: { title: q(m[1]) } }]);

  // Input
  if ((m = text.match(/^(?:type|write|הקלד|תקליד|כתוב)\s+(.+)$/i)) && !/^(?:file|קובץ)/i.test(m[1])) return plan(he ? "אקליד את הטקסט בחלון הפעיל (דורש אישור)." : "I'll type that into the focused window (needs approval).", [{ tool: "keyboard_type", params: { text: q(m[1]) } }]);
  if ((m = low.match(/^(?:press|hit|לחץ על|לחץ|תלחץ)\s+([a-z0-9]+(?:\s*\+\s*[a-z0-9]+){0,4})$/i)) && !/^(?:at|ב)\b/.test(m[1])) return plan(he ? "לוחץ על המקשים." : "Pressing the keys.", [{ tool: "key_combo", params: { keys: parseKeys(m[1]) } }]);
  if ((m = low.match(/^(?:(double|right)\s*-?\s*)?(?:click|לחץ|לחיצה(?: כפולה| ימנית)?)(?:\s+(?:at|on|ב|על))?\s*\(?\s*(-?\d+)\s*[, ]\s*(-?\d+)\s*\)?$/))) {
    return plan(he ? "לחיצת עכבר (דורש אישור)." : "Mouse click (needs approval).", [{ tool: "mouse_click", params: { x: Number(m[2]), y: Number(m[3]), button: m[1] === "right" || /ימנית/.test(low) ? "right" : "left", double: m[1] === "double" || /כפולה/.test(low) } }]);
  }
  if ((m = low.match(/^(?:scroll|גלול)\s*(up|down|למעלה|למטה)?(?:\s+(\d+))?$/))) return plan(he ? "גולל." : "Scrolling.", [{ tool: "mouse_scroll", params: { direction: /up|למעלה/.test(m[1] || "") ? "up" : "down", amount: Number(m[2] || 3) } }]);
  if ((m = low.match(/^(?:move (?:the )?mouse to|הזז את העכבר ל)\s*\(?\s*(-?\d+)\s*[, ]\s*(-?\d+)\s*\)?$/))) return plan(he ? "מזיז את העכבר." : "Moving the mouse.", [{ tool: "mouse_move", params: { x: Number(m[1]), y: Number(m[2]) } }]);

  // Clipboard
  if ((m = text.match(/^(?:copy|העתק)\s+(.+?)\s+(?:to (?:the )?clipboard|ללוח)$/i))) return plan(he ? "מעתיק ללוח." : "Copying to the clipboard.", [{ tool: "clipboard_write", params: { text: q(m[1]) } }]);
  if (/^(?:what(?:'s| is) (?:in|on) (?:the )?clipboard|read (?:the )?clipboard|מה בלוח|מה יש בלוח|קרא את הלוח)/i.test(text)) return plan(he ? "קריאת הלוח דורשת אישור." : "Reading the clipboard needs approval.", [{ tool: "clipboard_read", params: {} }]);

  // Files
  if ((m = text.match(/^(?:create|make|new|write|צור|תיצור|תצור|כתוב)\s+(?:a\s+)?(?:text\s+)?(?:file|note|קובץ|פתק)\s+(?:called\s+|named\s+|בשם\s+)?(\S+)(?:\s+(?:with|containing|that says|saying|עם|עם התוכן|שאומר|שכתוב בו)\s+([\s\S]+))?$/i))) {
    let p = m[1];
    if (!/\.[a-z0-9]{1,5}$/i.test(p)) p += ".txt";
    return plan(he ? `אצור את ${p} בתיקיית העבודה.` : `I'll create ${p} in the workspace.`, [{ tool: "write_file", params: { path: p, content: m[2] ? q(m[2]) : "" } }]);
  }
  if ((m = text.match(/^(?:create|make|new|צור|תיצור|תצור)\s+(?:a\s+)?(?:folder|directory|dir|תיקייה|תיקיה)\s+(?:called\s+|named\s+|בשם\s+)?(.+)$/i))) return plan(he ? "יוצר תיקייה." : "Creating the folder.", [{ tool: "create_folder", params: { path: q(m[1]) } }]);
  if ((m = text.match(/^(?:read|show|display|cat|קרא|הצג|תקרא)\s+(?:the\s+)?(?:file|note|קובץ|את הקובץ|את קובץ)\s+(.+)$/i))) return plan(he ? "קורא את הקובץ." : "Reading the file.", [{ tool: "read_file", params: { path: q(m[1]) } }]);
  if ((m = text.match(/^(?:list|show|הצג|רשימת|מה יש ב)\s*(?:the\s+)?(?:files|folder|directory|קבצים|תיקייה)(?:\s+(?:in|of|ב|בתיקייה)\s+(.+))?$/i))) return plan(he ? "מציג קבצים." : "Listing files.", [{ tool: "list_files", params: { folder: m[1] ? q(m[1]) : "" } }]);
  if ((m = text.match(/^(?:search|find|look for|חפש|תחפש|מצא)\s+(?:for\s+|files?\s+(?:named|called)?\s*|קובץ\s+|קבצים\s+|את\s+)?(.+?)(?:\s+(?:in|ב|בתיקייה)\s+(.+))?$/i))) return plan(he ? "מחפש קבצים." : "Searching files.", [{ tool: "search_files", params: { query: q(m[1]), folder: m[2] ? q(m[2]) : "" } }]);
  if ((m = text.match(/^(?:move|rename|העבר|שנה שם של|שנה את השם של)\s+(?:file\s+|קובץ\s+|את\s+)?(.+?)\s+(?:to|ל|אל)\s+(.+)$/i))) return plan(he ? "העברה/שינוי שם דורש אישור." : "Move/rename needs approval.", [{ tool: "move_file", params: { from: q(m[1]), to: q(m[2]) } }]);
  if ((m = text.match(/^(?:delete|remove|trash|מחק|תמחק|הסר)\s+(?:the\s+)?(?:file\s+|folder\s+|קובץ\s+|תיקייה\s+|את\s+)?(.+)$/i))) return plan(he ? "מחיקה מעבירה לסל של JARVIS ודורשת אישור." : "Deleting moves the item to the JARVIS trash and needs approval.", [{ tool: "delete_file", params: { path: q(m[1]) } }]);

  // Shell
  if ((m = text.match(/^(?:run powershell|powershell|הרץ powershell|הרץ פאוורשל)\s*[:\-]?\s*([\s\S]+)$/i))) return plan(he ? "סקריפט PowerShell — סיכון גבוה, דורש אישור ואישור נוסף במחשב." : "PowerShell script — high risk, needs approval and a second confirmation on the computer.", [{ tool: "run_powershell", params: { script: m[1].trim() } }]);
  if ((m = text.match(/^(?:run|execute|הרץ|הפעל פקודה)\s*[:\-]?\s+(\S+)((?:\s+\S+)*)$/i)) && !/^(?:powershell)/i.test(m[1])) {
    const args = m[2].trim() ? m[2].trim().split(/\s+/) : [];
    return plan(he ? "הרצת תוכנית — סיכון גבוה, דורש אישור." : "Running a program — high risk, needs approval.", [{ tool: "run_command", params: { program: m[1], args } }]);
  }

  // Drafts
  if ((m = text.match(/^(?:draft|write|compose|נסח|כתוב)\s+(?:an?\s+)?(?:email|mail|מייל|אימייל)\s*(?:to|אל|ל)?\s*([^:]*?)?(?:\s*(?:subject|נושא)\s*[:\-]\s*([^:]+?))?\s*[:\-]\s*([\s\S]+)$/i))) {
    return plan(he ? "טיוטת מייל בלבד — שום דבר לא נשלח." : "Email draft only — nothing is sent.", [{ tool: "create_email_draft", params: { to: q(m[1] || ""), subject: q(m[2] || ""), body: m[3].trim() } }]);
  }
  if ((m = text.match(/^(?:schedule|create (?:an? )?event|add (?:an? )?event|קבע|צור אירוע|קבע פגישה|תקבע)\s+(.+?)\s+(?:at|on|ב|בתאריך)\s+(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?)$/i))) {
    return plan(he ? "יוצר קובץ יומן (.ics) — לא נוסף ליומן בלי שתפתח אותו." : "Creating a calendar file (.ics) — nothing is added to a calendar until you open it.", [{ tool: "create_calendar_draft", params: { title: q(m[1]), start_iso: m[2].replace(" ", "T") } }]);
  }
  if (/(draft|נסח|טיוטה).*(message|customer|client|whatsapp|הודעה|ללקוח|לקוח)/i.test(text)) return plan(he ? "טיוטות ללקוחות נמצאות בלוח 'טיוטות' — שם רואים נמען, מטרה, טקסט ותזמון. שום דבר לא נשלח." : "Customer messages are drafted in the Drafts panel, which shows recipient, purpose, text and timing. Nothing is sent.", [], { suggest: "drafts" });
  if (/^(build|create|make|generate|בנה|תבנה|צור לי|תיצור לי)\b.*(website|web site|site|app|application|api|backend|installer|אתר|אפליקציה|אפליקצית|שרת|התקנה)/i.test(text)) return plan(he ? "פרויקטים נבנים בבונה הפרויקטים: שם רואים את התוכנית, הקבצים והכלים לפני אישור." : "Projects are built in the Project Builder, where you see the plan, files and tools before approving.", [], { suggest: "projects" });

  // Open: url / app / file
  if ((m = text.match(/^(?:open|launch|start|go to|visit|פתח|תפתח|הפעל|תפעיל|היכנס ל|גש ל)\s+(?:the\s+|את\s+)?(.+)$/i))) {
    const target = q(m[1]).replace(/[.!؟?]+$/, "");
    const tl = target.toLowerCase();
    for (const [word, url] of Object.entries(URL_WORDS)) if (tl === word || tl.startsWith(word + " ") || tl.endsWith(" " + word)) return plan(he ? `פותח ${word}.` : `Opening ${word}.`, [{ tool: "open_url", params: { url } }]);
    if (/^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(target)) return plan(he ? `פותח ${target}.` : `Opening ${target}.`, [{ tool: "open_url", params: { url: target } }]);
    for (const [word, app] of Object.entries(APP_WORDS).sort((a, b) => b[0].length - a[0].length)) if (tl === word || tl.includes(word)) return plan(he ? `פותח ${word}.` : `Opening ${word}.`, [{ tool: "open_app", params: { app } }]);
    if (/[\\/]|\.[a-z0-9]{1,5}$/i.test(target)) return plan(he ? "פותח את הקובץ." : "Opening the file.", [{ tool: "open_file", params: { path: target } }]);
    const apps = (ctx.apps || []).map((a) => a.id).join(", ");
    return plan(he ? `לא מצאתי מה לפתוח עבור "${target}". אפליקציות מאושרות: ${apps}.` : `I don't know how to open "${target}". Approved apps: ${apps}.`);
  }
  if ((m = text.match(/^(?:close|quit|exit|סגור|תסגור)\s+(?:the\s+|את\s+)?(.+)$/i))) {
    const tl = q(m[1]).toLowerCase();
    for (const [word, app] of Object.entries(APP_WORDS).sort((a, b) => b[0].length - a[0].length)) if (tl === word || tl.includes(word)) return plan(he ? "סגירת אפליקציה דורשת אישור." : "Closing an app needs approval.", [{ tool: "close_app", params: { app } }]);
    return plan(he ? "סוגר חלון (דורש אישור)." : "Closing the window (needs approval).", [{ tool: "close_window", params: { title: q(m[1]) } }]);
  }

  return plan(he ? "לא הבנתי את זה כפקודה. נסה 'עזרה' לרשימת דוגמאות." : "I didn't understand that as a command. Try 'help' for examples.", [], { unknown: true });
}

module.exports = { rulePlan, URL_WORDS, APP_WORDS };
