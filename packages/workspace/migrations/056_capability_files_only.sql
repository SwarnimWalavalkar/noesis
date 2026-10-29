-- A Capability revision is now exactly its instruction file plus at most one Program. Revisions in
-- the older bundle shape no longer decode, so learned Capabilities and everything that cites them
-- are reset. Files on disk stay: old and new Capability text under definitions/capabilities/ is
-- left in place so the user can bring it back (see docs/migrating-capabilities.md).
-- The runner applies migrations with foreign keys off and fails the migration unless
-- PRAGMA foreign_key_check passes before commit.

DELETE FROM capability_outcomes;
DELETE FROM capability_feedback;
DELETE FROM capability_gate_requests;
DELETE FROM capability_bindings;

-- Capability revisions are immutable. Drop the guards, clear the table, and restore them exactly.
DROP TRIGGER capability_revisions_immutable_update;
DROP TRIGGER capability_revisions_immutable_insert;
DROP TRIGGER capability_revisions_immutable_delete;
DELETE FROM capability_revisions;
CREATE TRIGGER capability_revisions_immutable_update
BEFORE UPDATE ON capability_revisions
BEGIN
  SELECT RAISE(ABORT, 'capability revisions are immutable');
END;

CREATE TRIGGER capability_revisions_immutable_insert
BEFORE INSERT ON capability_revisions
WHEN EXISTS (
  SELECT 1 FROM capability_revisions
  WHERE capability_revision_id = NEW.capability_revision_id
)
BEGIN
  SELECT RAISE(ABORT, 'capability revision identities are immutable');
END;

CREATE TRIGGER capability_revisions_immutable_delete
BEFORE DELETE ON capability_revisions
BEGIN
  SELECT RAISE(ABORT, 'capability revisions are immutable');
END;

DELETE FROM capabilities;

-- Reflections and session reviews that have not finished would cite the removed revisions.
-- Completed ones stay as history; nothing decodes their payloads strictly.
DELETE FROM jobs
WHERE kind IN ('runtime.reflect_capability', 'runtime.review_session')
  AND status <> 'completed';

-- Frozen plans now use schema version 2. Earlier rows stay as history with version 1.
CREATE TABLE frozen_turn_plans_v3 (
  plan_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version IN (1, 2)),
  plan_json TEXT NOT NULL,
  canonical_digest TEXT NOT NULL CHECK (length(canonical_digest) = 64),
  created_at TEXT NOT NULL,
  UNIQUE(session_id, turn_id),
  UNIQUE(turn_id, canonical_digest)
) STRICT;
INSERT INTO frozen_turn_plans_v3(
  plan_id, session_id, turn_id, schema_version, plan_json, canonical_digest, created_at
)
SELECT plan_id, session_id, turn_id, schema_version, plan_json, canonical_digest, created_at
FROM frozen_turn_plans;
DROP TABLE frozen_turn_plans;
ALTER TABLE frozen_turn_plans_v3 RENAME TO frozen_turn_plans;

-- Subagent history decodes frozen plans in the older shape; remove it.
DELETE FROM sub_agent_timeline_entries;
DELETE FROM sub_agent_model_calls;
DELETE FROM agent_messages;
DELETE FROM sub_agent_tasks;
DELETE FROM sub_agents;

-- The registry's router identity and pin/veto controls are gone.
DELETE FROM definition_current_pointers WHERE namespace IN ('capability_system', 'capability_control');
