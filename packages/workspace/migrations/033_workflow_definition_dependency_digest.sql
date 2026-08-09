CREATE TRIGGER workflow_definition_dependency_digest_insert
BEFORE INSERT ON workflow_runs
WHEN NEW.definition_dependencies_digest IS NOT NULL
  AND (
    length(NEW.definition_dependencies_digest) != 64
    OR NEW.definition_dependencies_digest GLOB '*[^0-9a-f]*'
  )
BEGIN
  SELECT RAISE(ABORT, 'Workflow definition dependency digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER workflow_definition_dependency_digest_update
BEFORE UPDATE OF definition_dependencies_digest ON workflow_runs
WHEN NEW.definition_dependencies_digest IS NOT NULL
  AND (
    length(NEW.definition_dependencies_digest) != 64
    OR NEW.definition_dependencies_digest GLOB '*[^0-9a-f]*'
  )
BEGIN
  SELECT RAISE(ABORT, 'Workflow definition dependency digest must be 64 lowercase hexadecimal characters');
END;
