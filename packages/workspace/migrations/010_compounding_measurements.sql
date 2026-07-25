CREATE TABLE compounding_replay_budgets (
  budget_id TEXT PRIMARY KEY,
  maximum_calls INTEGER NOT NULL CHECK (maximum_calls >= 0),
  maximum_tokens INTEGER NOT NULL CHECK (maximum_tokens >= 0),
  maximum_cost REAL NOT NULL CHECK (maximum_cost >= 0),
  reserved_calls INTEGER NOT NULL DEFAULT 0 CHECK (reserved_calls >= 0),
  reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
  reserved_cost REAL NOT NULL DEFAULT 0 CHECK (reserved_cost >= 0),
  created_at TEXT NOT NULL,
  CHECK (reserved_calls <= maximum_calls),
  CHECK (reserved_tokens <= maximum_tokens),
  CHECK (reserved_cost <= maximum_cost)
) STRICT;

CREATE TABLE compounding_replay_runs (
  replay_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES frozen_turn_plans(plan_id) ON DELETE RESTRICT,
  budget_id TEXT NOT NULL REFERENCES compounding_replay_budgets(budget_id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('running', 'excluded', 'paired')),
  record_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (
    (status = 'running' AND record_json IS NULL AND completed_at IS NULL) OR
    (status != 'running' AND record_json IS NOT NULL AND completed_at IS NOT NULL)
  )
) STRICT;

CREATE TABLE compounding_replay_operations (
  operation_id TEXT PRIMARY KEY,
  replay_id TEXT NOT NULL REFERENCES compounding_replay_runs(replay_id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('served_arm', 'baseline_arm', 'judge')),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  maximum_tokens INTEGER NOT NULL CHECK (maximum_tokens >= 0),
  maximum_cost REAL NOT NULL CHECK (maximum_cost >= 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'completed', 'failed', 'denied')),
  result_evidence_json TEXT,
  used_tokens INTEGER CHECK (used_tokens IS NULL OR used_tokens >= 0),
  actual_cost REAL CHECK (actual_cost IS NULL OR actual_cost >= 0),
  failure TEXT,
  reserved_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(replay_id, role),
  CHECK (
    (status = 'completed' AND result_evidence_json IS NOT NULL AND completed_at IS NOT NULL) OR
    (status != 'completed' AND result_evidence_json IS NULL)
  )
) STRICT;

CREATE INDEX compounding_replay_runs_plan
  ON compounding_replay_runs(plan_id, created_at, replay_id);

CREATE INDEX compounding_replay_operations_replay
  ON compounding_replay_operations(replay_id, role, status);
