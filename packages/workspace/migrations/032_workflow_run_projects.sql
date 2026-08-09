ALTER TABLE workflow_runs
  ADD COLUMN project_id TEXT CHECK (
    project_id IS NULL OR length(project_id) > 0
  );

CREATE TRIGGER workflow_run_project_immutable
BEFORE UPDATE OF project_id
ON workflow_runs
WHEN OLD.project_id IS NOT NEW.project_id
BEGIN
  SELECT RAISE(ABORT, 'Workflow run project is immutable');
END;
