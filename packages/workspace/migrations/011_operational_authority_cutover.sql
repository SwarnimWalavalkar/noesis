CREATE TABLE operational_cutovers (
  cutover_name TEXT NOT NULL,
  cutover_version INTEGER NOT NULL CHECK (cutover_version > 0),
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64),
  completed_at TEXT NOT NULL,
  PRIMARY KEY(cutover_name, cutover_version)
) STRICT;

CREATE TABLE authority_grants (
  grant_id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  effects_json TEXT NOT NULL,
  resource_prefixes_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  max_uses INTEGER NOT NULL CHECK (max_uses > 0),
  max_cost REAL NOT NULL CHECK (max_cost >= 0),
  issued_at TEXT NOT NULL,
  source_event_id TEXT UNIQUE
) STRICT;

CREATE TABLE authority_operations (
  operation_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  operation_fingerprint TEXT NOT NULL CHECK (length(operation_fingerprint) = 64),
  principal TEXT NOT NULL,
  effect TEXT NOT NULL,
  resource TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  estimated_cost REAL NOT NULL CHECK (estimated_cost >= 0),
  grant_id TEXT REFERENCES authority_grants(grant_id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (
    status IN ('reserved', 'completed', 'failed', 'denied', 'unresolved')
  ),
  result_json TEXT,
  failure TEXT,
  receipt_lineage_id TEXT UNIQUE,
  source_event_id TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (status = 'completed' AND result_json IS NOT NULL AND failure IS NULL) OR
    (status = 'failed' AND result_json IS NULL AND failure IS NOT NULL) OR
    (status IN ('reserved', 'denied', 'unresolved') AND result_json IS NULL)
  )
) STRICT;

CREATE INDEX authority_operations_grant
  ON authority_operations(grant_id, status, created_at, operation_id);

CREATE TABLE foreground_turns (
  turn_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL UNIQUE REFERENCES frozen_turn_plans(plan_id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'aborted', 'failed')),
  outcome_id TEXT UNIQUE REFERENCES outcomes(outcome_id) ON DELETE RESTRICT,
  admitted_at TEXT NOT NULL,
  settled_at TEXT,
  CHECK ((status = 'running') = (settled_at IS NULL))
) STRICT;

CREATE INDEX foreground_turns_session
  ON foreground_turns(session_id, admitted_at, turn_id);
