DROP TRIGGER codemode_execution_lineage_immutable;

CREATE TRIGGER codemode_execution_lineage_immutable
BEFORE UPDATE OF
  logical_execution_id,
  parent_execution_id,
  session_id,
  turn_id,
  source_digest,
  source_artifact_id
ON codemode_executions
WHEN OLD.logical_execution_id IS NOT NEW.logical_execution_id
  OR OLD.parent_execution_id IS NOT NEW.parent_execution_id
  OR OLD.session_id IS NOT NEW.session_id
  OR OLD.turn_id IS NOT NEW.turn_id
  OR OLD.source_digest IS NOT NEW.source_digest
  OR OLD.source_artifact_id IS NOT NEW.source_artifact_id
BEGIN
  SELECT RAISE(ABORT, 'Codemode execution lineage is immutable');
END;

CREATE TRIGGER workflow_run_turn_lineage_update
BEFORE UPDATE OF session_id, turn_id ON workflow_runs
WHEN OLD.session_id IS NOT NEW.session_id
  OR OLD.turn_id IS NOT NEW.turn_id
  OR (
    NEW.turn_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM foreground_turns
      WHERE turn_id = NEW.turn_id
        AND session_id = NEW.session_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'Workflow run session and turn lineage is immutable');
END;

DROP TRIGGER workflow_phase_execution_lineage_insert;
DROP TRIGGER workflow_phase_execution_lineage_update;

CREATE TRIGGER workflow_phase_execution_lineage_insert
BEFORE INSERT ON workflow_phase_runs
WHEN NEW.execution_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM workflow_runs AS run
    JOIN codemode_executions AS execution
      ON execution.execution_id = NEW.execution_id
    WHERE run.run_id = NEW.run_id
      AND run.session_id = execution.session_id
      AND execution.logical_execution_id IS NEW.logical_execution_id
  )
BEGIN
  SELECT RAISE(ABORT, 'Workflow phase execution does not belong to its logical run lineage');
END;

CREATE TRIGGER workflow_phase_execution_lineage_update
BEFORE UPDATE OF run_id, logical_execution_id, execution_id ON workflow_phase_runs
WHEN NEW.execution_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM workflow_runs AS run
    JOIN codemode_executions AS execution
      ON execution.execution_id = NEW.execution_id
    WHERE run.run_id = NEW.run_id
      AND run.session_id = execution.session_id
      AND execution.logical_execution_id IS NEW.logical_execution_id
  )
BEGIN
  SELECT RAISE(ABORT, 'Workflow phase execution does not belong to its logical run lineage');
END;

CREATE TRIGGER workflow_phase_lineage_immutable
BEFORE UPDATE OF
  run_id,
  attempt,
  logical_execution_id,
  execution_id
ON workflow_phase_runs
WHEN OLD.run_id IS NOT NEW.run_id
  OR (
    OLD.logical_execution_id IS NOT NULL
    AND OLD.logical_execution_id IS NOT NEW.logical_execution_id
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
