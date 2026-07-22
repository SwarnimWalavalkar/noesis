CREATE TABLE activation_state (
  state_id TEXT PRIMARY KEY CHECK (state_id = 'current'),
  activation_id TEXT NOT NULL REFERENCES activations(activation_id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO activation_state(state_id, activation_id, revision, updated_at)
SELECT 'current', activation_id, revision, created_at
FROM activations
ORDER BY revision DESC
LIMIT 1;

CREATE TABLE activation_operations (
  operation_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  activation_id TEXT NOT NULL UNIQUE,
  experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id) ON DELETE RESTRICT,
  candidate_revision_json TEXT NOT NULL,
  manifest_revision_json TEXT NOT NULL,
  preflight_id TEXT NOT NULL REFERENCES preflight_reports(preflight_id) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL REFERENCES preflight_plans(plan_id) ON DELETE RESTRICT,
  binding_json TEXT NOT NULL,
  binding_digest TEXT NOT NULL CHECK (length(binding_digest) = 64),
  policy_snapshot_json TEXT NOT NULL,
  policy_digest TEXT NOT NULL CHECK (length(policy_digest) = 64),
  decision TEXT NOT NULL CHECK (decision IN ('block', 'approval_required', 'eligible_auto_activate')),
  status TEXT NOT NULL CHECK (status IN ('blocked', 'staged', 'pending_approval', 'approved', 'rejected', 'committed')),
  expected_activation_revision INTEGER NOT NULL CHECK (expected_activation_revision >= 0),
  previous_activation_id TEXT REFERENCES activations(activation_id) ON DELETE RESTRICT,
  approval_id TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  committed_at TEXT
) STRICT;
CREATE INDEX activation_operations_status ON activation_operations(status, created_at, operation_id);

CREATE TABLE activation_materializations (
  operation_id TEXT NOT NULL REFERENCES activation_operations(operation_id) ON DELETE RESTRICT,
  slot_key TEXT NOT NULL,
  stage_id TEXT NOT NULL UNIQUE REFERENCES staged_definitions(stage_id) ON DELETE RESTRICT,
  source_revision_json TEXT NOT NULL,
  active_revision_json TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  PRIMARY KEY(operation_id, slot_key)
) STRICT;

CREATE TABLE activation_approvals (
  approval_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE REFERENCES activation_operations(operation_id) ON DELETE RESTRICT,
  binding_digest TEXT NOT NULL CHECK (length(binding_digest) = 64),
  policy_digest TEXT NOT NULL CHECK (length(policy_digest) = 64),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  decision_actor TEXT,
  CHECK ((status = 'pending') = (decided_at IS NULL AND decision_actor IS NULL))
) STRICT;

CREATE TABLE turn_activation_pins (
  turn_key TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  activation_id TEXT NOT NULL REFERENCES activations(activation_id) ON DELETE RESTRICT,
  activation_revision INTEGER NOT NULL CHECK (activation_revision > 0),
  definitions_json TEXT NOT NULL,
  capability_revisions_json TEXT NOT NULL,
  pinned_at TEXT NOT NULL,
  UNIQUE(session_id, turn_id)
) STRICT;
