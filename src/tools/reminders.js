// tools/reminders.js
// Persistent D1-backed reminders. Cron scans and marks fired.
// FREE — D1 is Cloudflare's free tier.

export const reminder_set_def = {
  name: "reminder_set",
  description:
    "יוצר תזכורת מתמידה. מקבל טקסט תזכורת וזמן בפורמט ISO 8601 (למשל 2026-04-20T17:00:00+03:00) או offset יחסי בשניות. התזכורת שורדת גם אם הדף נסגר.",
  input_schema: {
    type: "object",
    properties: {
      text: { type: "string", description: "מה להזכיר, בעברית" },
      at_iso: {
        type: "string",
        description: "מועד ב-ISO 8601 עם timezone",
      },
      in_seconds: {
        type: "number",
        description: "לחלופין: כמה שניות מעכשיו לירות (עדיף at_iso)",
      },
    },
    required: ["text"],
  },
};

export const reminder_list_def = {
  name: "reminder_list",
  description: "מציג תזכורות פעילות של המשתמש (עתידיות שעדיין לא ירו).",
  input_schema: { type: "object", properties: {} },
};

export const reminder_cancel_def = {
  name: "reminder_cancel",
  description: "מבטל תזכורת לפי ID (מקבלים ID מ-reminder_list או מ-reminder_set).",
  input_schema: {
    type: "object",
    properties: { id: { type: "string", description: "ID של התזכורת" } },
    required: ["id"],
  },
};

export async function reminder_set(env, userId, { text, at_iso, in_seconds }) {
  let fireAt;
  if (at_iso) {
    const t = new Date(at_iso).getTime();
    if (!Number.isFinite(t)) return { error: "at_iso לא בפורמט תקין" };
    fireAt = t;
  } else if (Number.isFinite(in_seconds) && in_seconds > 0) {
    fireAt = Date.now() + Math.floor(in_seconds * 1000);
  } else {
    return { error: "נדרש at_iso או in_seconds" };
  }
  if (fireAt <= Date.now()) return { error: "המועד כבר עבר" };

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO reminders (id, user_id, text, fire_at, status, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`
  ).bind(id, userId, String(text).slice(0, 500), fireAt, Date.now()).run();
  return { id, fire_at: new Date(fireAt).toISOString(), text };
}

export async function reminder_list(env, userId) {
  const rows = await env.DB.prepare(
    `SELECT id, text, fire_at, status FROM reminders
     WHERE user_id = ? AND status = 'pending'
     ORDER BY fire_at ASC LIMIT 50`
  ).bind(userId).all();
  const reminders = (rows.results || []).map((r) => ({
    id: r.id,
    text: r.text,
    fire_at: new Date(r.fire_at).toISOString(),
    fires_in_seconds: Math.max(0, Math.round((r.fire_at - Date.now()) / 1000)),
  }));
  return { reminders };
}

export async function reminder_cancel(env, userId, { id }) {
  const r = await env.DB.prepare(
    `UPDATE reminders SET status = 'cancelled' WHERE id = ? AND user_id = ?`
  ).bind(id, userId).run();
  return { cancelled: r.meta.changes > 0, id };
}

// Endpoint the frontend polls: which of my reminders fired since I last polled?
export async function reminder_poll(env, userId) {
  const rows = await env.DB.prepare(
    `SELECT id, text, fire_at FROM reminders
     WHERE user_id = ? AND status = 'fired' AND delivered_at IS NULL
     ORDER BY fire_at ASC LIMIT 50`
  ).bind(userId).all();
  const fired = rows.results || [];
  if (fired.length) {
    const ids = fired.map((r) => r.id);
    const ph = ids.map(() => "?").join(",");
    await env.DB.prepare(
      `UPDATE reminders SET delivered_at = ? WHERE id IN (${ph})`
    ).bind(Date.now(), ...ids).run();
  }
  return { fired: fired.map((r) => ({ id: r.id, text: r.text, fire_at: new Date(r.fire_at).toISOString() })) };
}

// Cron worker uses this to mark due reminders as fired.
export async function tickReminders(env) {
  const now = Date.now();
  const due = await env.DB.prepare(
    `SELECT id FROM reminders WHERE status = 'pending' AND fire_at <= ? LIMIT 200`
  ).bind(now).all();
  const ids = (due.results || []).map((r) => r.id);
  if (!ids.length) return { fired: 0 };
  const ph = ids.map(() => "?").join(",");
  await env.DB.prepare(
    `UPDATE reminders SET status = 'fired', fired_at = ? WHERE id IN (${ph})`
  ).bind(now, ...ids).run();
  return { fired: ids.length };
}
