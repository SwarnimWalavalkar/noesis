CREATE TABLE runtime_owner (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner_id TEXT NOT NULL,
  pid INTEGER NOT NULL CHECK (pid > 0),
  acquired_at TEXT NOT NULL
) STRICT;
