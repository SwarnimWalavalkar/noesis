CREATE TABLE codemode_executions (
  execution_id TEXT PRIMARY KEY,
  parent_execution_id TEXT,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  turn_id TEXT,
  catalog_id TEXT NOT NULL,
  catalog_digest TEXT NOT NULL CHECK (length(catalog_digest) = 64),
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64),
  status TEXT NOT NULL CHECK (
    status IN ('running', 'completed', 'failed', 'cancelled', 'interrupted')
  ),
  result_json TEXT,
  error TEXT,
  call_count INTEGER NOT NULL DEFAULT 0 CHECK (call_count >= 0),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (
    (status = 'running' AND completed_at IS NULL)
    OR
    (status != 'running' AND completed_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX codemode_executions_session_started
  ON codemode_executions(session_id, started_at, execution_id);
CREATE INDEX codemode_executions_parent
  ON codemode_executions(parent_execution_id, execution_id);
