-- AC-10 owns bounded real-use observations and protected experiment outcomes.
CREATE TABLE experiment_observations (
  observation_id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id) ON DELETE RESTRICT,
  signal_id TEXT NOT NULL UNIQUE REFERENCES feedback_signals(signal_id) ON DELETE RESTRICT,
  outcome_id TEXT NOT NULL REFERENCES outcomes(outcome_id) ON DELETE RESTRICT,
  preflight_id TEXT NOT NULL REFERENCES preflight_reports(preflight_id) ON DELETE RESTRICT,
  experiment_activation_id TEXT NOT NULL REFERENCES activations(activation_id) ON DELETE RESTRICT,
  serving_activation_id TEXT NOT NULL REFERENCES activations(activation_id) ON DELETE RESTRICT,
  activation_revision INTEGER NOT NULL CHECK (activation_revision > 0),
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  capability_revision_json TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  precedence TEXT NOT NULL CHECK (precedence IN ('none', 'correction', 'preference', 'user_veto')),
  user_decision TEXT CHECK (user_decision IS NULL OR user_decision IN ('keep', 'revise', 'revert')),
  hard_regression INTEGER NOT NULL CHECK (hard_regression IN (0, 1)),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX experiment_observations_window
  ON experiment_observations(experiment_id, created_at DESC, observation_id DESC);

CREATE TABLE experiment_research_runs (
  run_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id) ON DELETE RESTRICT,
  strategy_id TEXT NOT NULL,
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  proposal TEXT CHECK (proposal IS NULL OR proposal IN ('keep', 'revise', 'revert')),
  cited_observation_ids_json TEXT NOT NULL DEFAULT '[]',
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  failure_message TEXT,
  retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(experiment_id, strategy_id, input_digest)
) STRICT;

CREATE TABLE experiment_outcomes (
  operation_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  experiment_id TEXT NOT NULL UNIQUE REFERENCES experiments(experiment_id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('keep', 'revise', 'revert')),
  strategy_id TEXT NOT NULL,
  research_run_id TEXT REFERENCES experiment_research_runs(run_id) ON DELETE RESTRICT,
  expected_activation_id TEXT NOT NULL REFERENCES activations(activation_id) ON DELETE RESTRICT,
  expected_activation_revision INTEGER NOT NULL CHECK (expected_activation_revision > 0),
  restore_source_activation_id TEXT REFERENCES activations(activation_id) ON DELETE RESTRICT,
  restored_activation_id TEXT REFERENCES activations(activation_id) ON DELETE RESTRICT,
  successor_experiment_id TEXT REFERENCES experiments(experiment_id) ON DELETE RESTRICT,
  evidence_refs_json TEXT NOT NULL,
  operation_digest TEXT NOT NULL CHECK (length(operation_digest) = 64),
  committed_at TEXT NOT NULL
) STRICT;

CREATE TABLE successor_lineage_inputs (
  input_id TEXT PRIMARY KEY,
  predecessor_experiment_id TEXT NOT NULL UNIQUE REFERENCES experiments(experiment_id) ON DELETE RESTRICT,
  successor_experiment_id TEXT NOT NULL UNIQUE REFERENCES experiments(experiment_id) ON DELETE RESTRICT,
  predecessor_activation_id TEXT NOT NULL REFERENCES activations(activation_id) ON DELETE RESTRICT,
  predecessor_revision_json TEXT NOT NULL,
  baseline_revision_json TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
