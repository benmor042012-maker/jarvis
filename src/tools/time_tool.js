// tools/time_tool.js
// Current time. Defaults to Asia/Jerusalem.

export const time_def = {
  name: "current_time",
  description:
    "מחזיר את התאריך והשעה הנוכחיים באזור זמן ישראל (Asia/Jerusalem). השתמש כשהמשתמש שואל 'מה השעה', 'איזה יום היום', וכדומה.",
  input_schema: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description: "IANA timezone, ברירת מחדל Asia/Jerusalem",
      },
    },
  },
};

export async function current_time({ timezone } = {}) {
  const tz = timezone || "Asia/Jerusalem";
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("he-IL", {
    timeZone: tz,
    dateStyle: "full",
    timeStyle: "long",
  });
  const iso = now.toISOString();
  return {
    timezone: tz,
    now_iso: iso,
    now_local: fmt.format(now),
    weekday_he: new Intl.DateTimeFormat("he-IL", { timeZone: tz, weekday: "long" }).format(now),
    hour_local: new Intl.DateTimeFormat("he-IL", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(now),
    epoch_ms: now.getTime(),
  };
}
