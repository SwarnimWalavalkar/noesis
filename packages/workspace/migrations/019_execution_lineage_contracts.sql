CREATE TRIGGER codemode_execution_contract_insert
BEFORE INSERT ON codemode_executions
WHEN NEW.logical_execution_id IS NULL
  OR NEW.source_artifact_id IS NULL
  OR NOT EXISTS (
    SELECT 1
    FROM artifacts
    WHERE artifact_id = NEW.source_artifact_id
      AND content_digest = NEW.source_digest
  )
  OR (
    NEW.parent_execution_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM codemode_executions AS parent
      WHERE parent.execution_id = NEW.parent_execution_id
        AND parent.session_id = NEW.session_id
        AND parent.turn_id IS NEW.turn_id
    )
  )
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
  SELECT RAISE(ABORT, 'Invalid codemode execution identity or lineage');
END;

CREATE TRIGGER codemode_execution_lineage_immutable
BEFORE UPDATE OF
  logical_execution_id,
  parent_execution_id,
  session_id,
  turn_id,
  source_artifact_id
ON codemode_executions
WHEN OLD.logical_execution_id IS NOT NEW.logical_execution_id
  OR OLD.parent_execution_id IS NOT NEW.parent_execution_id
  OR OLD.session_id IS NOT NEW.session_id
  OR OLD.turn_id IS NOT NEW.turn_id
  OR OLD.source_artifact_id IS NOT NEW.source_artifact_id
BEGIN
  SELECT RAISE(ABORT, 'Codemode execution lineage is immutable');
END;

CREATE TRIGGER workflow_run_turn_lineage_insert
BEFORE INSERT ON workflow_runs
WHEN NEW.turn_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM foreground_turns
    WHERE turn_id = NEW.turn_id
      AND session_id = NEW.session_id
  )
BEGIN
  SELECT RAISE(ABORT, 'Workflow run turn does not belong to its session');
END;

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
  )
BEGIN
  SELECT RAISE(ABORT, 'Workflow phase execution does not belong to its run session');
END;

CREATE TRIGGER workflow_phase_execution_lineage_update
BEFORE UPDATE OF execution_id ON workflow_phase_runs
WHEN NEW.execution_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM workflow_runs AS run
    JOIN codemode_executions AS execution
      ON execution.execution_id = NEW.execution_id
    WHERE run.run_id = NEW.run_id
      AND run.session_id = execution.session_id
  )
BEGIN
  SELECT RAISE(ABORT, 'Workflow phase execution does not belong to its run session');
END;

CREATE TRIGGER workflow_phase_started_fields_insert
BEFORE INSERT ON workflow_phase_runs
WHEN (NEW.status = 'pending' AND NEW.started_at IS NOT NULL)
  OR (NEW.status = 'completed' AND NEW.started_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'Invalid workflow phase start fields');
END;

CREATE TRIGGER workflow_phase_started_fields_update
BEFORE UPDATE ON workflow_phase_runs
WHEN (NEW.status = 'pending' AND NEW.started_at IS NOT NULL)
  OR (NEW.status = 'completed' AND NEW.started_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'Invalid workflow phase start fields');
END;
