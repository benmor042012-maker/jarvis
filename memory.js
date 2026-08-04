// memory.js
// כל היגיון הזיכרון של Jarvis. D1 הוא מקור האמת, Vectorize הוא אינדקס שליפה.

const EMBED_MODEL = "@cf/baai/bge-m3";        // 1024 מימדים, תמיכה טובה בעברית
const EXTRACT_MODEL = "claude-haiku-4-5-20251001"; // קריאה זולה, מחליטה מה לזכור
const CORE_LIMIT = 20;                         // כמה זיכרונות core לטעון תמיד
const TOPK = 6;                                // כמה זיכרונות אסוציאטיביים לשלוף
const MIN_SCORE = 0.4;                         // סף דמיון מינימלי לשליפה סמנטית

const EXTRACTOR_SYSTEM = `אתה מנוע חילוץ זיכרונות עבור Jarvis. קרא את חילופי הדברים והחלט מה שווה לזכור לטווח ארוך.
החזר JSON array בלבד, בלי טקסט נוסף ובלי code fences.
כל פריט: {"type":"semantic|preference|episodic|procedural","subject":"מפתח_קנוני","content":"משפט בעברית","salience":1-5}.
type: semantic=עובדה יציבה, preference=העדפה, episodic=אירוע, procedural=שיטת עבודה חוזרת.
subject: מזהה קנוני קצר לזיהוי כפילויות, למשל user.profession או pref.answer_length. אותו נושא = אותו subject.
שמור רק פריטים יציבים, ספציפיים ורלוונטיים מעבר לשיחה הנוכחית.
אל תשמור חישובים חד-פעמיים, הקשר רגעי, או מידע שכבר ברור. אם אין מה לשמור, החזר [].`;

// יוצר embedding למחרוזת בודדת ומחזיר וקטור
export async function embed(env, text) {
  const r = await env.AI.run(EMBED_MODEL, { text: [text] });
  return r.data[0];
}

// שליפה דו-שכבתית: core שתמיד נטען + associative רלוונטי להקשר
export async function retrieveMemories(env, userId, queryText) {
  // שכבת core: זהות והעדפות בעלי salience גבוה
  const coreRes = await env.DB.prepare(
    `SELECT id, type, content FROM memories
     WHERE user_id = ? AND status = 'active' AND type IN ('semantic','preference')
     ORDER BY salience DESC, last_accessed_at DESC
     LIMIT ?`
  ).bind(userId, CORE_LIMIT).all();
  const core = coreRes.results || [];
  const coreIds = new Set(core.map((m) => m.id));

  // שכבת associative: top-K סמנטי מ-Vectorize
  let associative = [];
  if (queryText && queryText.trim()) {
    try {
      const vec = await embed(env, queryText);
      const q = await env.VECTORIZE.query(vec, {
        topK: TOPK,
        filter: { user_id: userId },
        returnMetadata: "all",
      });
      const ids = (q.matches || [])
        .filter((m) => m.score >= MIN_SCORE)
        .map((m) => m.metadata?.memory_id)
        .filter((id) => id && !coreIds.has(id)); // בלי כפילות מול core
      if (ids.length) {
        const ph = ids.map(() => "?").join(",");
        const rows = await env.DB.prepare(
          `SELECT id, type, content FROM memories
           WHERE id IN (${ph}) AND status = 'active'`
        ).bind(...ids).all();
        associative = rows.results || [];
      }
    } catch (e) {
      // שליפה סמנטית היא bonus, לא לחסום את הצ'אט אם היא נכשלת
      console.error("associative retrieval failed", e);
    }
  }
  return { core, associative };
}

// בונה בלוק <memory> להזרקה ל-system prompt
export function buildMemoryBlock(core, associative) {
  if (!core.length && !associative.length) return "";
  const lines = [];
  if (core.length) {
    lines.push("מה שאתה יודע על המשתמש:");
    core.forEach((m) => lines.push(`- ${m.content}`));
  }
  if (associative.length) {
    lines.push("");
    lines.push("זיכרונות רלוונטיים להקשר הנוכחי:");
    associative.forEach((m) => lines.push(`- ${m.content}`));
  }
  return `<memory>\n${lines.join("\n")}\n</memory>`;
}

// מעדכן last_accessed_at ו-access_count לזיכרונות שנשלפו (מזין את הדעיכה)
export async function touchAccessed(env, mems) {
  const ids = mems.map((m) => m.id).filter(Boolean);
  if (!ids.length) return;
  const ph = ids.map(() => "?").join(",");
  await env.DB.prepare(
    `UPDATE memories SET last_accessed_at = ?, access_count = access_count + 1
     WHERE id IN (${ph})`
  ).bind(Date.now(), ...ids).run();
}

// מסלול הכתיבה: Extract -> Reconcile -> Store
export async function extractAndStore(env, userId, userMsg, assistantMsg) {
  const transcript = `משתמש: ${userMsg}\nJarvis: ${assistantMsg}`;
  let candidates;
  try {
    const raw = await callAnthropic(env, {
      model: EXTRACT_MODEL,
      max_tokens: 1024,
      system: EXTRACTOR_SYSTEM,
      messages: [{ role: "user", content: transcript }],
    });
    const text = (raw.content || [])
      .map((b) => b.text || "")
      .join("")
      .replace(/```json|```/g, "")
      .trim();
    candidates = JSON.parse(text);
  } catch (e) {
    console.error("extraction failed", e);
    return;
  }
  if (!Array.isArray(candidates)) return;
  for (const c of candidates) {
    if (c && c.content) await reconcileAndStore(env, userId, c);
  }
}

// בודק כפילות/סתירה מול הקיים ואז שומר ל-D1 + Vectorize
async function reconcileAndStore(env, userId, mem) {
  const now = Date.now();
  const id = crypto.randomUUID();
  const type = mem.type || "semantic";
  const salience = Number.isInteger(mem.salience) ? mem.salience : 3;

  // dedup לפי subject: אותו נושא קיים -> עדכון, לא כפילות
  if (mem.subject) {
    const existing = await env.DB.prepare(
      `SELECT id, content FROM memories
       WHERE user_id = ? AND subject = ? AND status = 'active'`
    ).bind(userId, mem.subject).first();
    if (existing) {
      if (existing.content.trim() === mem.content.trim()) return; // זהה, דלג
      // סתירה או עדכון: מסמנים את הישן superseded ומורידים מ-Vectorize
      await env.DB.prepare(
        `UPDATE memories SET status = 'superseded', superseded_by = ? WHERE id = ?`
      ).bind(id, existing.id).run();
      try { await env.VECTORIZE.deleteByIds([existing.id]); } catch (e) {}
    }
  }

  await env.DB.prepare(
    `INSERT INTO memories
       (id, user_id, type, subject, content, salience, created_at, last_accessed_at, access_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).bind(id, userId, type, mem.subject || null, mem.content, salience, now, now).run();

  const vec = await embed(env, mem.content);
  await env.VECTORIZE.upsert([
    { id, values: vec, metadata: { memory_id: id, user_id: userId, type } },
  ]);
}

// לולאת תחזוקה: מדעיך זיכרונות אפיזודיים ישנים עם salience נמוך
export async function consolidate(env) {
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - THIRTY_DAYS;
  const stale = await env.DB.prepare(
    `SELECT id FROM memories
     WHERE status = 'active' AND type = 'episodic' AND salience <= 2
       AND (last_accessed_at IS NULL OR last_accessed_at < ?)`
  ).bind(cutoff).all();
  for (const row of stale.results || []) {
    await env.DB.prepare(
      `UPDATE memories SET status = 'archived' WHERE id = ?`
    ).bind(row.id).run();
    try { await env.VECTORIZE.deleteByIds([row.id]); } catch (e) {}
  }
  // הרחבה עתידית: מיזוג אשכולות אפיזודיים לעובדה סמנטית אחת דרך קריאת LLM
}

// קריאה ל-Anthropic דרך המפתח שמאוחסן כ-secret ב-Worker
export async function callAnthropic(env, body) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  return r.json();
}
