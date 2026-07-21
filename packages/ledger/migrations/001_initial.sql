CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  sequence INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  occurred_at TEXT NOT NULL,
  principal TEXT NOT NULL,
  event_type TEXT NOT NULL,
  trail_id TEXT,
  payload_json TEXT NOT NULL,
  checksum TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trails (
  trail_id TEXT PRIMARY KEY,
  parent_trail_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  model TEXT NOT NULL,
  runtime TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  memory_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  supersedes TEXT,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS capabilities (
  capability_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  score REAL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (capability_id, version)
);

CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  schedule TEXT NOT NULL,
  grant_json TEXT NOT NULL,
  lease_until TEXT,
  budget_remaining REAL NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS event_search USING fts5(event_id, event_type, trail_id, payload);
