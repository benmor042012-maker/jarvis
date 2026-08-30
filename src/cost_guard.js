// cost_guard.js
// Tracks external services JARVIS uses, and whether they cost money.
// Exposed via GET /cost-report.

import { TOOLS } from "./tools/index.js";

export function costReport(env) {
  const services = [
    {
      name: "Anthropic Claude API",
      status: env.ANTHROPIC_API_KEY ? "מחובר" : "לא מחובר",
      paid: true,
      note: "עיקר העלות. חיוב לפי טוקנים. חלופה חינם: אין ל-Claude ברמת איכות דומה.",
    },
    {
      name: "Cloudflare Workers",
      status: "מחובר (הפרוקסי הזה עצמו)",
      paid: false,
      note: "Free tier: 100K בקשות ליום.",
    },
    {
      name: "Cloudflare D1 (SQLite)",
      status: "מחובר",
      paid: false,
      note: "Free tier: 5M קריאות/יום, 100K כתיבות/יום. משמש לזיכרון ולתזכורות.",
    },
    {
      name: "Cloudflare Vectorize",
      status: "מחובר",
      paid: false,
      note: "Free tier נדיב לחיפוש סמנטי.",
    },
    {
      name: "Cloudflare Workers AI",
      status: "מחובר",
      paid: false,
      note: "Free tier לאמבדינגים (bge-m3). לא נדרש credit.",
    },
    {
      name: "DuckDuckGo Search (HTML)",
      status: "מחובר",
      paid: false,
      note: "ללא API key. שימוש הוגן — אין להריץ crawlers מסיביים.",
    },
    {
      name: "Open-Meteo Weather",
      status: "מחובר",
      paid: false,
      note: "חינמי לחלוטין לשימוש לא מסחרי.",
    },
    {
      name: "Browser Speech Recognition (STT)",
      status: env.STT_MODE || "browser (חינם)",
      paid: false,
      note: "רץ במכשיר של המשתמש. אם תרצה STT server-side, זה יעלה כסף (Whisper API).",
    },
    {
      name: "Browser Speech Synthesis (TTS)",
      status: env.TTS_MODE || "browser (חינם)",
      paid: false,
      note: "רץ במכשיר של המשתמש. שידרוג ל-ElevenLabs/OpenAI TTS = תשלום.",
    },
    {
      name: "Gmail / Google Calendar",
      status: "לא מחובר (דורש OAuth ידני)",
      paid: false,
      note: "חינם אחרי הגדרת OAuth. פתוח לתוסף עתידי.",
    },
  ];

  const tools = Object.entries(TOOLS).map(([name, t]) => ({
    name,
    paid: t.paid,
    source: t.source,
  }));

  return {
    generated_at: new Date().toISOString(),
    policy: "JARVIS לא מפעיל שום שירות בתשלום שלא סומן במפורש PAID_TOOLS_ENABLED=true.",
    services,
    tools,
  };
}
