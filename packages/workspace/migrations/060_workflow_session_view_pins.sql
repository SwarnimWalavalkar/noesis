-- The session-view digest a workflow run first read, so a resumed phase cannot silently see other bytes.
-- A pinned session may later be deleted, so session_id has no foreign key: the read fails on its own.
CREATE TABLE workflow_session_view_pins (
  run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  include_private INTEGER NOT NULL CHECK(include_private IN (0, 1)),
  digest TEXT NOT NULL CHECK(length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
  pinned_at TEXT NOT NULL,
  PRIMARY KEY (run_id, session_id, include_private)
) STRICT;
