CREATE TABLE frozen_turn_plans (
  plan_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  activation_id TEXT NOT NULL REFERENCES activations(activation_id) ON DELETE RESTRICT,
  activation_revision INTEGER NOT NULL CHECK (activation_revision > 0),
  plan_json TEXT NOT NULL,
  canonical_digest TEXT NOT NULL CHECK (length(canonical_digest) = 64),
  created_at TEXT NOT NULL,
  UNIQUE(session_id, turn_id),
  UNIQUE(turn_id, canonical_digest)
) STRICT;

CREATE INDEX frozen_turn_plans_activation
  ON frozen_turn_plans(activation_id, activation_revision, created_at);
