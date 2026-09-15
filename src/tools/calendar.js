// tools/calendar.js
// Google Calendar control — list, create, update, delete, find free slots.
// FREE: Google Calendar API has no cost for personal use.

import { googleFetch } from "../google.js";

const BASE = "https://www.googleapis.com/calendar/v3";
const TZ = "Asia/Jerusalem";

export const calendar_list_def = {
  name: "calendar_list_events",
  description:
    "מציג אירועים מיומן Google של המשתמש בטווח זמן. ברירת מחדל: מהיום עד 7 ימים קדימה. השתמש כשהמשתמש שואל 'מה יש לי היום/מחר/השבוע', 'מתי הפגישה עם X' וכדומה.",
  input_schema: {
    type: "object",
    properties: {
      from_iso: { type: "string", description: "תחילת הטווח ב-ISO 8601 (ברירת מחדל: עכשיו)" },
      to_iso: { type: "string", description: "סוף הטווח ב-ISO 8601 (ברירת מחדל: 7 ימים מעכשיו)" },
      query: { type: "string", description: "טקסט חופשי לסינון (שם אירוע/משתתף)" },
      max_results: { type: "number", description: "מקסימום תוצאות (ברירת מחדל 25)" },
    },
  },
};

export const calendar_create_def = {
  name: "calendar_create_event",
  description:
    "יוצר אירוע חדש ביומן Google. חובה: כותרת, התחלה וסיום ב-ISO 8601 עם אזור זמן (למשל 2026-09-16T10:00:00+03:00). אפשר להוסיף מיקום, תיאור, משתתפים (מיילים) ותזכורת בדקות. הפעל רק כשהמשתמש ביקש במפורש לקבוע/להוסיף אירוע.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      start_iso: { type: "string" },
      end_iso: { type: "string" },
      all_day_date: { type: "string", description: "לאירוע של יום שלם: תאריך YYYY-MM-DD במקום start/end" },
      location: { type: "string" },
      description: { type: "string" },
      attendees: { type: "array", items: { type: "string" }, description: "כתובות מייל של משתתפים" },
      reminder_minutes: { type: "number", description: "תזכורת X דקות לפני (ברירת מחדל 30)" },
    },
    required: ["title"],
  },
};

export const calendar_update_def = {
  name: "calendar_update_event",
  description:
    "מעדכן אירוע קיים ביומן לפי event_id (מתקבל מ-calendar_list_events). אפשר להזיז זמן, לשנות כותרת, מיקום או תיאור. הפעל רק כשהמשתמש ביקש לשנות/להזיז אירוע.",
  input_schema: {
    type: "object",
    properties: {
      event_id: { type: "string" },
      title: { type: "string" },
      start_iso: { type: "string" },
      end_iso: { type: "string" },
      location: { type: "string" },
      description: { type: "string" },
    },
    required: ["event_id"],
  },
};

export const calendar_delete_def = {
  name: "calendar_delete_event",
  description: "מוחק אירוע מהיומן לפי event_id. הפעל רק כשהמשתמש ביקש במפורש לבטל/למחוק אירוע.",
  input_schema: {
    type: "object",
    properties: { event_id: { type: "string" } },
    required: ["event_id"],
  },
};

export const calendar_free_def = {
  name: "calendar_find_free_time",
  description:
    "מוצא חלונות פנויים ביומן באורך מסוים (בדקות) בטווח ימים, בתוך שעות העבודה. שימושי ל'מתי אני פנוי לפגישה של שעה השבוע'.",
  input_schema: {
    type: "object",
    properties: {
      duration_minutes: { type: "number" },
      from_iso: { type: "string", description: "ברירת מחדל: עכשיו" },
      to_iso: { type: "string", description: "ברירת מחדל: 7 ימים" },
      work_start_hour: { type: "number", description: "ברירת מחדל 9" },
      work_end_hour: { type: "number", description: "ברירת מחדל 18" },
    },
    required: ["duration_minutes"],
  },
};

function fmt(ev) {
  const start = ev.start?.dateTime || ev.start?.date;
  const end = ev.end?.dateTime || ev.end?.date;
  return {
    event_id: ev.id,
    title: ev.summary || "(ללא כותרת)",
    start,
    end,
    all_day: !ev.start?.dateTime,
    location: ev.location || null,
    description: ev.description ? String(ev.description).slice(0, 500) : null,
    attendees: (ev.attendees || []).map((a) => a.email),
    link: ev.htmlLink || null,
  };
}

function isoOrNull(s) {
  if (!s) return null;
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export async function calendar_list_events(env, userId, { from_iso, to_iso, query, max_results } = {}) {
  const from = isoOrNull(from_iso) || new Date().toISOString();
  const to = isoOrNull(to_iso) || new Date(Date.now() + 7 * 864e5).toISOString();
  const params = new URLSearchParams({
    timeMin: from,
    timeMax: to,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(Math.min(Math.max(1, max_results || 25), 100)),
    timeZone: TZ,
  });
  if (query) params.set("q", query);
  const r = await googleFetch(env, userId, `${BASE}/calendars/primary/events?${params}`);
  if (!r.ok) return r.data;
  return { from, to, events: (r.data.items || []).map(fmt) };
}

export async function calendar_create_event(env, userId, a = {}) {
  if (!a.title) return { error: "title נדרש" };
  const body = { summary: a.title };
  if (a.all_day_date) {
    const next = new Date(a.all_day_date + "T00:00:00Z");
    next.setUTCDate(next.getUTCDate() + 1);
    body.start = { date: a.all_day_date };
    body.end = { date: next.toISOString().slice(0, 10) };
  } else {
    if (!a.start_iso) return { error: "start_iso או all_day_date נדרש" };
    const start = new Date(a.start_iso);
    if (!Number.isFinite(start.getTime())) return { error: "start_iso לא תקין" };
    const end = a.end_iso ? new Date(a.end_iso) : new Date(start.getTime() + 60 * 60000);
    if (!Number.isFinite(end.getTime()) || end <= start) return { error: "end_iso לא תקין" };
    body.start = { dateTime: start.toISOString(), timeZone: TZ };
    body.end = { dateTime: end.toISOString(), timeZone: TZ };
  }
  if (a.location) body.location = a.location;
  if (a.description) body.description = a.description;
  if (Array.isArray(a.attendees) && a.attendees.length) body.attendees = a.attendees.map((email) => ({ email }));
  body.reminders = { useDefault: false, overrides: [{ method: "popup", minutes: Number.isFinite(a.reminder_minutes) ? a.reminder_minutes : 30 }] };

  const r = await googleFetch(env, userId, `${BASE}/calendars/primary/events?sendUpdates=all`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!r.ok) return r.data;
  return { created: true, event: fmt(r.data) };
}

export async function calendar_update_event(env, userId, a = {}) {
  if (!a.event_id) return { error: "event_id נדרש" };
  const patch = {};
  if (a.title) patch.summary = a.title;
  if (a.location !== undefined) patch.location = a.location;
  if (a.description !== undefined) patch.description = a.description;
  if (a.start_iso) {
    const s = new Date(a.start_iso);
    if (!Number.isFinite(s.getTime())) return { error: "start_iso לא תקין" };
    patch.start = { dateTime: s.toISOString(), timeZone: TZ };
  }
  if (a.end_iso) {
    const e = new Date(a.end_iso);
    if (!Number.isFinite(e.getTime())) return { error: "end_iso לא תקין" };
    patch.end = { dateTime: e.toISOString(), timeZone: TZ };
  }
  // If only start moved, keep the original duration.
  if (patch.start && !patch.end) {
    const cur = await googleFetch(env, userId, `${BASE}/calendars/primary/events/${encodeURIComponent(a.event_id)}`);
    if (cur.ok && cur.data.start?.dateTime && cur.data.end?.dateTime) {
      const dur = new Date(cur.data.end.dateTime) - new Date(cur.data.start.dateTime);
      patch.end = { dateTime: new Date(new Date(patch.start.dateTime).getTime() + dur).toISOString(), timeZone: TZ };
    }
  }
  const r = await googleFetch(env, userId, `${BASE}/calendars/primary/events/${encodeURIComponent(a.event_id)}?sendUpdates=all`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  if (!r.ok) return r.data;
  return { updated: true, event: fmt(r.data) };
}

export async function calendar_delete_event(env, userId, { event_id } = {}) {
  if (!event_id) return { error: "event_id נדרש" };
  const r = await googleFetch(env, userId, `${BASE}/calendars/primary/events/${encodeURIComponent(event_id)}?sendUpdates=all`, {
    method: "DELETE",
  });
  if (!r.ok) return r.data;
  return { deleted: true, event_id };
}

export async function calendar_find_free_time(env, userId, a = {}) {
  const dur = Math.max(5, Number(a.duration_minutes) || 60) * 60000;
  const from = new Date(isoOrNull(a.from_iso) || Date.now());
  const to = new Date(isoOrNull(a.to_iso) || from.getTime() + 7 * 864e5);
  const ws = Number.isFinite(a.work_start_hour) ? a.work_start_hour : 9;
  const we = Number.isFinite(a.work_end_hour) ? a.work_end_hour : 18;

  const r = await googleFetch(env, userId, `${BASE}/freeBusy`, {
    method: "POST",
    body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), timeZone: TZ, items: [{ id: "primary" }] }),
  });
  if (!r.ok) return r.data;
  const busy = (r.data.calendars?.primary?.busy || [])
    .map((b) => [new Date(b.start).getTime(), new Date(b.end).getTime()])
    .sort((x, y) => x[0] - y[0]);

  // Walk day by day in local time, carve out free windows inside work hours.
  const slots = [];
  const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hour12: false });
  let cursor = new Date(from);
  cursor.setUTCMinutes(0, 0, 0);
  const step = 15 * 60000;
  let t = cursor.getTime();
  while (t + dur <= to.getTime() && slots.length < 12) {
    const localHour = Number(hourFmt.format(new Date(t)).replace(/^24$/, "0"));
    const endLocalHour = Number(hourFmt.format(new Date(t + dur - 1)).replace(/^24$/, "0"));
    const inWork = localHour >= ws && endLocalHour < we && localHour <= endLocalHour;
    if (inWork && t >= Date.now()) {
      const clash = busy.some(([bs, be]) => bs < t + dur && be > t);
      if (!clash) {
        slots.push({ start: new Date(t).toISOString(), end: new Date(t + dur).toISOString() });
        t += dur; // don't spam overlapping slots
        continue;
      }
    }
    t += step;
  }
  return {
    duration_minutes: dur / 60000,
    timezone: TZ,
    free_slots: slots.map((s) => ({
      ...s,
      local: new Intl.DateTimeFormat("he-IL", { timeZone: TZ, weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(s.start)),
    })),
  };
}
