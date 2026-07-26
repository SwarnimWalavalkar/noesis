ALTER TABLE codemode_executions
  ADD COLUMN source_artifact_id TEXT REFERENCES artifacts(artifact_id);

ALTER TABLE codemode_executions
  ADD COLUMN stdout_artifact_id TEXT REFERENCES artifacts(artifact_id);

ALTER TABLE codemode_executions
  ADD COLUMN stderr_artifact_id TEXT REFERENCES artifacts(artifact_id);

CREATE TRIGGER codemode_execution_source_artifact_immutable
BEFORE UPDATE OF source_artifact_id ON codemode_executions
WHEN OLD.source_artifact_id IS NOT NEW.source_artifact_id
BEGIN
  SELECT RAISE(ABORT, 'Codemode execution source artifact is immutable');
END;

CREATE TRIGGER codemode_execution_terminal_artifacts_immutable
BEFORE UPDATE OF stdout_artifact_id, stderr_artifact_id ON codemode_executions
WHEN OLD.status != 'running'
  AND (
    OLD.stdout_artifact_id IS NOT NEW.stdout_artifact_id
    OR OLD.stderr_artifact_id IS NOT NEW.stderr_artifact_id
  )
BEGIN
  SELECT RAISE(ABORT, 'Terminal codemode execution artifacts are immutable');
END;

CREATE TRIGGER codemode_execution_terminal_artifacts_required_on_insert
BEFORE INSERT ON codemode_executions
WHEN NEW.status IN ('completed', 'failed', 'cancelled')
  AND (
    NEW.source_artifact_id IS NULL
    OR NEW.stdout_artifact_id IS NULL
    OR NEW.stderr_artifact_id IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'Settled codemode execution requires source and log artifacts');
END;

CREATE TRIGGER codemode_execution_terminal_artifacts_required_on_update
BEFORE UPDATE OF status ON codemode_executions
WHEN NEW.status IN ('completed', 'failed', 'cancelled')
  AND (
    NEW.source_artifact_id IS NULL
    OR NEW.stdout_artifact_id IS NULL
    OR NEW.stderr_artifact_id IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'Settled codemode execution requires source and log artifacts');
END;
