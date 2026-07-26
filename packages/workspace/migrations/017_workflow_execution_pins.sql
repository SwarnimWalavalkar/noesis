ALTER TABLE workflow_runs
  ADD COLUMN catalog_id TEXT;

ALTER TABLE workflow_runs
  ADD COLUMN catalog_digest TEXT CHECK (
    catalog_digest IS NULL OR length(catalog_digest) = 64
  );

ALTER TABLE workflow_runs
  ADD COLUMN permission_digest TEXT CHECK (
    permission_digest IS NULL OR length(permission_digest) = 64
  );

ALTER TABLE workflow_runs
  ADD COLUMN provider TEXT;

ALTER TABLE workflow_runs
  ADD COLUMN model TEXT;

ALTER TABLE workflow_runs
  ADD COLUMN thinking_level TEXT CHECK (
    thinking_level IS NULL
    OR thinking_level IN ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')
  );

CREATE TRIGGER workflow_execution_pins_immutable
BEFORE UPDATE OF
  catalog_id,
  catalog_digest,
  permission_digest,
  provider,
  model,
  thinking_level
ON workflow_runs
WHEN OLD.catalog_id IS NOT NEW.catalog_id
  OR OLD.catalog_digest IS NOT NEW.catalog_digest
  OR OLD.permission_digest IS NOT NEW.permission_digest
  OR OLD.provider IS NOT NEW.provider
  OR OLD.model IS NOT NEW.model
  OR OLD.thinking_level IS NOT NEW.thinking_level
BEGIN
  SELECT RAISE(ABORT, 'Workflow execution pins are immutable');
END;
