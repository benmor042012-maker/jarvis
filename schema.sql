-- JARVIS schema: memories + reminders
-- Apply with: wrangler d1 execute jarvis-memory --file=schema.sql

CREATE TABLE IF NOT EXISTS memories (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  type             TEXT NOT NULL,            -- semantic | preference | episodic | procedural
  subject          TEXT,                     -- קנוני dedup key, e.g. 'user.profession'
  content          TEXT NOT NULL,
  salience         INTEGER DEFAULT 3,        -- 1..5
  confidence       REAL    DEFAULT 1.0,
  status           TEXT    DEFAULT 'active', -- active | superseded | archived
  superseded_by    TEXT,
  source_session   TEXT,
  created_at       INTEGER NOT NULL,
  last_accessed_at INTEGER,
  access_count     INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_user_status ON memories(user_id, status);
CREATE INDEX IF NOT EXISTS idx_subject     ON memories(user_id, subject);

CREATE TABLE IF NOT EXISTS reminders (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  text         TEXT NOT NULL,
  fire_at      INTEGER NOT NULL,             -- epoch ms
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | fired | cancelled
  created_at   INTEGER NOT NULL,
  fired_at     INTEGER,
  delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_reminders_pending ON reminders(status, fire_at);
CREATE INDEX IF NOT EXISTS idx_reminders_user    ON reminders(user_id, status);

-- Google OAuth refresh tokens (one per user). Access tokens are minted on demand.
CREATE TABLE IF NOT EXISTS google_tokens (
  user_id       TEXT PRIMARY KEY,
  refresh_token TEXT NOT NULL,
  email         TEXT,
  scopes        TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Morning briefings ("Jarvis calls you at 6:00"). One per user per local day.
CREATE TABLE IF NOT EXISTS briefings (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  day            TEXT NOT NULL,               -- YYYY-MM-DD, Asia/Jerusalem
  text           TEXT NOT NULL,
  drafts_created INTEGER DEFAULT 0,
  created_at     INTEGER NOT NULL,
  spoken_at      INTEGER                      -- set when web/desktop read it aloud
);
CREATE INDEX IF NOT EXISTS idx_briefings_user_day ON briefings(user_id, day);

-- Short conversation history for the Telegram bot.
CREATE TABLE IF NOT EXISTS telegram_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    TEXT NOT NULL,
  role       TEXT NOT NULL,                   -- user | assistant
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tg_chat ON telegram_history(chat_id, created_at);
