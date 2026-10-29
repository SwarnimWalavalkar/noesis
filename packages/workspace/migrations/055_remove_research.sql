-- Learning is one system: Capabilities, their revisions, outcomes, feedback, and gates, plus the
-- runtime.reflect_capability and runtime.review_session jobs. Experiments, preflights,
-- evaluations, feedback signals, working adjustments, compounding replay measurements, the
-- capability learning cutover, staged definitions, and job lineage are gone.
-- The runner applies migrations with foreign keys off, so children are removed explicitly, and
-- it fails the migration unless PRAGMA foreign_key_check passes before commit.

-- Jobs of every retired kind, and their lineage. Lineage only ever linked research jobs.
DROP TABLE job_observations;
DROP TABLE job_lineage;
DELETE FROM jobs WHERE kind NOT IN ('runtime.reflect_capability', 'runtime.review_session');

-- Reflection payloads no longer carry working adjustment fields. Strip them so pending
-- reflections still decode strictly and completed ones match the current payload shape.
UPDATE jobs
SET payload_json = json_remove(
  payload_json,
  '$.turn.servedWorkingAdjustmentOutcomes',
  '$.turn.expectedActiveAdjustmentId'
)
WHERE kind = 'runtime.reflect_capability';

-- Job indexes that only served retired job kinds and payload fields.
DROP INDEX IF EXISTS jobs_reflection_session_created;
DROP INDEX IF EXISTS jobs_experiment_created;
DROP INDEX IF EXISTS jobs_experiment_scope_created;
DROP INDEX IF EXISTS jobs_source_session_created;

-- Search documents built from completed experiments. The index rebuilds from authority.
DELETE FROM search_fts WHERE document_id IN (
  SELECT document_id FROM search_documents WHERE source_table = 'experiments'
);
DELETE FROM search_embeddings WHERE document_id IN (
  SELECT document_id FROM search_documents WHERE source_table = 'experiments'
);
DELETE FROM search_documents WHERE source_table = 'experiments';

DROP TABLE compounding_replay_operations;
DROP TABLE compounding_replay_runs;
DROP TABLE compounding_replay_budgets;
DROP TABLE capability_learning_cutover_failures;
DROP TABLE capability_learning_cutovers;
DROP TABLE active_project_adjustments;
DROP TABLE working_adjustments;
DROP TABLE feedback_signals;
DROP TABLE evaluations;
DROP TABLE preflight_reports;
DROP TABLE preflight_plans;
DROP TABLE experiment_trials;
DROP TABLE experiments;
DROP TABLE staged_definitions;
