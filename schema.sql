CREATE TABLE IF NOT EXISTS memories (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  type             TEXT NOT NULL,            -- semantic | preference | episodic | procedural
  subject          TEXT,                     -- מפתח קנוני ל-dedup, למשל 'user.profession'
  content          TEXT NOT NULL,            -- הזיכרון בשפה טבעית
  salience         INTEGER DEFAULT 3,        -- 1..5, חשיבות, משמש לשליפה ולדעיכה
  confidence       REAL    DEFAULT 1.0,
  status           TEXT    DEFAULT 'active',  -- active | superseded | archived
  superseded_by    TEXT,                     -- מצביע לגרסה החדשה כשעובדה משתנה
  source_session   TEXT,
  created_at       INTEGER NOT NULL,
  last_accessed_at INTEGER,
  access_count     INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_user_status ON memories(user_id, status);
CREATE INDEX IF NOT EXISTS idx_subject     ON memories(user_id, subject);
