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
