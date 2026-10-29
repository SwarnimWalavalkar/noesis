-- Turn planning reads Capability bindings directly. The activation snapshot, its genesis
-- baseline, turn pins, and the experiment feedback tables that referenced activations are gone.
-- The runner applies migrations with foreign keys off and fails the migration unless
-- PRAGMA foreign_key_check passes before commit.

-- Subagent history decodes frozen plans that still carry activation fields; remove it.
DELETE FROM sub_agent_timeline_entries;
DELETE FROM sub_agent_model_calls;
DELETE FROM agent_messages;
DELETE FROM sub_agent_tasks;
DELETE FROM sub_agents;

-- Rebuild frozen_turn_plans without its activation columns. foreground_turns and
-- compounding_replay_runs keep referencing it by name.
CREATE TABLE frozen_turn_plans_v2 (
  plan_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  plan_json TEXT NOT NULL,
  canonical_digest TEXT NOT NULL CHECK (length(canonical_digest) = 64),
  created_at TEXT NOT NULL,
  UNIQUE(session_id, turn_id),
  UNIQUE(turn_id, canonical_digest)
) STRICT;
INSERT INTO frozen_turn_plans_v2(
  plan_id, session_id, turn_id, schema_version, plan_json, canonical_digest, created_at
)
SELECT plan_id, session_id, turn_id, schema_version, plan_json, canonical_digest, created_at
FROM frozen_turn_plans;
DROP TABLE frozen_turn_plans;
ALTER TABLE frozen_turn_plans_v2 RENAME TO frozen_turn_plans;

DROP TABLE outcome_activation_publications;
DROP TABLE successor_lineage_inputs;
DROP TABLE experiment_outcomes;
DROP TABLE experiment_research_runs;
DROP TABLE experiment_observations;
DROP TABLE turn_activation_pins;
DROP TABLE activation_approvals;
DROP TABLE activation_materializations;
DROP TABLE activation_operations;
DROP TABLE activation_state;
DROP TABLE activation_pointers;
DROP TABLE activations;

-- The genesis baseline's definition pointers and publications.
DELETE FROM definition_current_pointers WHERE namespace = 'genesis_baseline';
