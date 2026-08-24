DROP TRIGGER workflow_phase_lineage_immutable;

CREATE TRIGGER workflow_phase_lineage_immutable
BEFORE UPDATE OF
  run_id,
  phase_index,
  phase_name,
  attempt,
  logical_execution_id,
  execution_id,
  input_json
ON workflow_phase_runs
WHEN OLD.run_id IS NOT NEW.run_id
  OR OLD.phase_index IS NOT NEW.phase_index
  OR OLD.phase_name IS NOT NEW.phase_name
  OR (
    OLD.logical_execution_id IS NOT NULL
    AND OLD.logical_execution_id IS NOT NEW.logical_execution_id
    AND NOT (
      OLD.status = 'failed'
      AND NEW.status = 'running'
      AND NEW.attempt = OLD.attempt + 1
      AND NEW.logical_execution_id IS NOT NULL
      AND OLD.input_json IS NOT NEW.input_json
    )
  )
  OR (
    OLD.logical_execution_id IS NOT NULL
    AND OLD.input_json IS NOT NEW.input_json
    AND OLD.logical_execution_id IS NEW.logical_execution_id
  )
  OR NEW.attempt < OLD.attempt
  OR NEW.attempt > OLD.attempt + 1
  OR (
    NEW.attempt = OLD.attempt + 1
    AND NOT (
      (OLD.status = 'pending' AND NEW.status = 'running')
      OR (OLD.status = 'failed' AND NEW.status = 'running')
    )
  )
  OR (
    NEW.attempt = OLD.attempt
    AND OLD.execution_id IS NOT NULL
    AND OLD.execution_id IS NOT NEW.execution_id
  )
  OR (
    NEW.attempt = OLD.attempt + 1
    AND NEW.execution_id IS OLD.execution_id
    AND NEW.execution_id IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'Workflow phase run and execution lineage is immutable');
END;

CREATE TRIGGER workflow_phase_logical_execution_required_insert
BEFORE INSERT ON workflow_phase_runs
WHEN (NEW.status != 'pending' AND NEW.logical_execution_id IS NULL)
  OR (NEW.status = 'pending' AND NEW.logical_execution_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'Workflow phase status and logical execution identity do not match');
END;

CREATE TRIGGER workflow_phase_logical_execution_required_update
BEFORE UPDATE OF status, logical_execution_id ON workflow_phase_runs
WHEN (NEW.status != 'pending' AND NEW.logical_execution_id IS NULL)
  OR (NEW.status = 'pending' AND NEW.logical_execution_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'Workflow phase status and logical execution identity do not match');
END;

CREATE TRIGGER workflow_run_program_identity_valid_insert
BEFORE INSERT ON workflow_runs
WHEN NOT EXISTS (
  SELECT 1
  FROM definition_revision_metadata AS metadata
  WHERE metadata.namespace = 'program:' || NEW.project_id || ':workflow'
    AND metadata.definition_id = NEW.workflow_name
    AND metadata.revision = NEW.workflow_revision
    AND metadata.definition_revision_id = NEW.definition_revision_id
)
BEGIN
  SELECT RAISE(ABORT, 'Workflow run must reference one exact workflow-mode Program revision');
END;

CREATE TRIGGER workflow_run_program_identity_immutable
BEFORE UPDATE OF workflow_name, workflow_revision, definition_revision_id
ON workflow_runs
WHEN OLD.workflow_name IS NOT NEW.workflow_name
  OR OLD.workflow_revision IS NOT NEW.workflow_revision
  OR OLD.definition_revision_id IS NOT NEW.definition_revision_id
BEGIN
  SELECT RAISE(ABORT, 'Workflow run Program identity is immutable');
END;
