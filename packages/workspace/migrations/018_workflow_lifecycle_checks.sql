CREATE TRIGGER workflow_run_lifecycle_check_insert
BEFORE INSERT ON workflow_runs
WHEN (
  NEW.status IN ('running', 'paused')
  AND NEW.completed_at IS NOT NULL
) OR (
  NEW.status IN ('completed', 'failed', 'cancelled')
  AND NEW.completed_at IS NULL
) OR (
  NEW.status = 'completed'
  AND NEW.output_json IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'Invalid workflow run lifecycle fields');
END;

CREATE TRIGGER workflow_run_lifecycle_check_update
BEFORE UPDATE ON workflow_runs
WHEN (
  NEW.status IN ('running', 'paused')
  AND NEW.completed_at IS NOT NULL
) OR (
  NEW.status IN ('completed', 'failed', 'cancelled')
  AND NEW.completed_at IS NULL
) OR (
  NEW.status = 'completed'
  AND NEW.output_json IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'Invalid workflow run lifecycle fields');
END;

CREATE TRIGGER workflow_phase_lifecycle_check_insert
BEFORE INSERT ON workflow_phase_runs
WHEN (
  NEW.status IN ('pending', 'running')
  AND NEW.completed_at IS NOT NULL
) OR (
  NEW.status IN ('completed', 'failed', 'cancelled')
  AND NEW.completed_at IS NULL
) OR (
  NEW.status = 'running'
  AND NEW.started_at IS NULL
) OR (
  NEW.status = 'completed'
  AND NEW.output_json IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'Invalid workflow phase lifecycle fields');
END;

CREATE TRIGGER workflow_phase_lifecycle_check_update
BEFORE UPDATE ON workflow_phase_runs
WHEN (
  NEW.status IN ('pending', 'running')
  AND NEW.completed_at IS NOT NULL
) OR (
  NEW.status IN ('completed', 'failed', 'cancelled')
  AND NEW.completed_at IS NULL
) OR (
  NEW.status = 'running'
  AND NEW.started_at IS NULL
) OR (
  NEW.status = 'completed'
  AND NEW.output_json IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'Invalid workflow phase lifecycle fields');
END;
