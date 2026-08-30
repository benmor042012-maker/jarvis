// tools/memory_tools.js
// Explicit memory tools — user asked "remember X" / "what do you remember" / "forget".

import {
  rememberExplicit,
  forgetBySubject,
  forgetById,
  forgetAll,
  retrieveMemories,
} from "../memory.js";

export const memory_write_def = {
  name: "memory_write",
  description:
    "שמור עובדה חשובה בזיכרון ארוך טווח על המשתמש. השתמש כשהמשתמש אומר 'תזכור ש...', 'שים לב ש...', או כשמתגלה מידע יציב שיהיה חשוב בעתיד (העדפה, פרויקט, אנשי קשר).",
  input_schema: {
    type: "object",
    properties: {
      content: { type: "string", description: "העובדה בעברית, משפט קצר" },
      subject: {
        type: "string",
        description: "מזהה קנוני קצר (למשל 'user.job' או 'project.current'). אותו נושא = דריסה של גרסה ישנה.",
      },
      type: {
        type: "string",
        enum: ["semantic", "preference", "episodic", "procedural"],
        description: "semantic=עובדה, preference=העדפה, episodic=אירוע, procedural=שיטת עבודה",
      },
      salience: { type: "integer", description: "1..5 חשיבות, ברירת מחדל 4" },
    },
    required: ["content"],
  },
};

export const memory_search_def = {
  name: "memory_search",
  description:
    "חפש בזיכרון ארוך טווח. השתמש רק כשהמשתמש שואל במפורש מה אתה זוכר, או כשאתה זקוק להקשר נוסף מעבר לזיכרונות שכבר מוזרקים ב-<memory>.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "מה לחפש בזיכרון" },
    },
    required: ["query"],
  },
};

export const memory_forget_def = {
  name: "memory_forget",
  description:
    "מוחק זיכרון. השתמש רק כשהמשתמש אומר במפורש לשכוח משהו. אם 'all' — מוחק הכל (בקש אישור לפני).",
  input_schema: {
    type: "object",
    properties: {
      subject: { type: "string", description: "המזהה הקנוני של הזיכרון לשכוח" },
      id: { type: "string", description: "או ה-ID הישיר של הזיכרון" },
      all: { type: "boolean", description: "אם true - מוחק את כל הזיכרונות של המשתמש" },
    },
  },
};

export async function memory_write(env, userId, args) {
  const id = await rememberExplicit(env, userId, args.content, {
    subject: args.subject,
    type: args.type,
    salience: args.salience,
  });
  return { saved: true, id };
}

export async function memory_search(env, userId, { query }) {
  const { core, associative } = await retrieveMemories(env, userId, query || "");
  return {
    core: core.map((m) => ({ id: m.id, type: m.type, content: m.content })),
    associative: associative.map((m) => ({ id: m.id, type: m.type, content: m.content })),
  };
}

export async function memory_forget(env, userId, { subject, id, all }) {
  if (all) {
    const n = await forgetAll(env, userId);
    return { forgot: n, mode: "all" };
  }
  if (id) {
    await forgetById(env, id);
    return { forgot: 1, mode: "id", id };
  }
  if (subject) {
    const n = await forgetBySubject(env, userId, subject);
    return { forgot: n, mode: "subject", subject };
  }
  return { error: "צריך subject או id או all" };
}
