CREATE TABLE workflow_runs (
  run_id TEXT PRIMARY KEY,
  workflow_name TEXT NOT NULL,
  workflow_revision INTEGER NOT NULL CHECK (workflow_revision > 0),
  definition_revision_id TEXT NOT NULL REFERENCES file_revisions(revision_id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  turn_id TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('running', 'paused', 'completed', 'failed', 'cancelled')
  ),
  current_phase INTEGER NOT NULL DEFAULT 0 CHECK (current_phase >= 0),
  input_json TEXT NOT NULL,
  output_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE INDEX workflow_runs_session_created
  ON workflow_runs(session_id, created_at, run_id);

CREATE TABLE workflow_phase_runs (
  run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
  phase_index INTEGER NOT NULL CHECK (phase_index >= 0),
  phase_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'running', 'completed', 'failed', 'cancelled')
  ),
  input_json TEXT NOT NULL,
  output_json TEXT,
  execution_id TEXT REFERENCES codemode_executions(execution_id) ON DELETE SET NULL,
  error TEXT,
  started_at TEXT,
  completed_at TEXT,
  PRIMARY KEY(run_id, phase_index)
) STRICT;
