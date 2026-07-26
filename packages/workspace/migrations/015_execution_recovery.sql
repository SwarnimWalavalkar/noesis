ALTER TABLE codemode_executions
  ADD COLUMN logical_execution_id TEXT;

UPDATE codemode_executions
SET logical_execution_id = execution_id
WHERE logical_execution_id IS NULL;

CREATE INDEX codemode_executions_logical
  ON codemode_executions(logical_execution_id, started_at, execution_id);

ALTER TABLE workflow_phase_runs
  ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0);

ALTER TABLE workflow_phase_runs
  ADD COLUMN logical_execution_id TEXT;

CREATE INDEX workflow_phase_runs_logical
  ON workflow_phase_runs(logical_execution_id)
  WHERE logical_execution_id IS NOT NULL;
