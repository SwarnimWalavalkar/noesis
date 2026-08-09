ALTER TABLE workflow_runs
  ADD COLUMN definition_dependencies_digest TEXT CHECK (
    definition_dependencies_digest IS NULL OR length(definition_dependencies_digest) = 64
  );

CREATE TRIGGER workflow_definition_dependencies_immutable
BEFORE UPDATE OF definition_dependencies_digest
ON workflow_runs
WHEN OLD.definition_dependencies_digest IS NOT NEW.definition_dependencies_digest
BEGIN
  SELECT RAISE(ABORT, 'Workflow definition dependency pin is immutable');
END;
