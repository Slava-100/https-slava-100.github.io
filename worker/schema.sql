-- D1 schema for Halloween Mini App

CREATE TABLE IF NOT EXISTS party (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pool TEXT NOT NULL DEFAULT '[]',
  round INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO party (id, pool, round, seq, version)
VALUES (1, '[]', 0, 0, 0);

CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  photo TEXT NOT NULL DEFAULT '',
  team TEXT NOT NULL,
  round INTEGER NOT NULL,
  at INTEGER NOT NULL,
  n INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_participants_team ON participants(team);
CREATE INDEX IF NOT EXISTS idx_participants_n ON participants(n);
