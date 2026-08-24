ALTER TABLE codemode_executions ADD COLUMN project_id TEXT;
ALTER TABLE codemode_executions ADD COLUMN program_project_id TEXT;
ALTER TABLE codemode_executions ADD COLUMN program_mode TEXT CHECK (program_mode IS NULL OR program_mode = 'script');
ALTER TABLE codemode_executions ADD COLUMN program_name TEXT;
ALTER TABLE codemode_executions ADD COLUMN program_revision INTEGER CHECK (program_revision IS NULL OR program_revision > 0);
ALTER TABLE codemode_executions ADD COLUMN program_definition_revision_id TEXT REFERENCES file_revisions(revision_id) ON DELETE RESTRICT;

CREATE TRIGGER codemode_execution_parent_project_insert
BEFORE INSERT ON codemode_executions
WHEN NEW.parent_execution_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM codemode_executions AS parent
    WHERE parent.execution_id = NEW.parent_execution_id
      AND parent.project_id IS NEW.project_id
  )
BEGIN
  SELECT RAISE(ABORT, 'Codemode execution parent does not belong to its project');
END;

CREATE TRIGGER workflow_phase_execution_project_insert
BEFORE INSERT ON workflow_phase_runs
WHEN NEW.execution_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM workflow_runs AS run
    JOIN codemode_executions AS execution
      ON execution.execution_id = NEW.execution_id
    WHERE run.run_id = NEW.run_id
      AND run.project_id IS execution.project_id
  )
BEGIN
  SELECT RAISE(ABORT, 'Workflow phase execution does not belong to its run project');
END;

CREATE TRIGGER workflow_phase_execution_project_update
BEFORE UPDATE OF run_id, execution_id ON workflow_phase_runs
WHEN NEW.execution_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM workflow_runs AS run
    JOIN codemode_executions AS execution
      ON execution.execution_id = NEW.execution_id
    WHERE run.run_id = NEW.run_id
      AND run.project_id IS execution.project_id
  )
BEGIN
  SELECT RAISE(ABORT, 'Workflow phase execution does not belong to its run project');
END;

CREATE TRIGGER codemode_program_identity_valid_insert
BEFORE INSERT ON codemode_executions
WHEN NOT (
  (
    NEW.program_project_id IS NULL
    AND NEW.program_mode IS NULL
    AND NEW.program_name IS NULL
    AND NEW.program_revision IS NULL
    AND NEW.program_definition_revision_id IS NULL
  )
  OR (
    NEW.program_project_id IS NOT NULL
    AND NEW.project_id IS NEW.program_project_id
    AND NEW.program_mode = 'script'
    AND NEW.program_name IS NOT NULL
    AND NEW.program_revision IS NOT NULL
    AND NEW.program_definition_revision_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM definition_revision_metadata AS metadata
      JOIN file_revisions AS definition
        ON definition.revision_id = metadata.definition_revision_id
      JOIN json_each(definition.provenance_refs_json) AS provenance
      JOIN file_revisions AS source
        ON source.revision_id = json_extract(provenance.value, '$.revisionId')
      WHERE metadata.namespace = 'program:' || NEW.program_project_id || ':' || NEW.program_mode
        AND metadata.definition_id = NEW.program_name
        AND metadata.revision = NEW.program_revision
        AND metadata.definition_revision_id = NEW.program_definition_revision_id
        AND json_extract(provenance.value, '$.kind') = 'file_revision'
        AND source.content_digest = NEW.source_digest
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'program execution identity must reference one exact Program revision');
END;

CREATE TRIGGER codemode_program_identity_immutable
BEFORE UPDATE OF project_id, program_project_id, program_mode, program_name, program_revision, program_definition_revision_id
ON codemode_executions
WHEN OLD.project_id IS NOT NEW.project_id
  OR OLD.program_project_id IS NOT NEW.program_project_id
  OR OLD.program_mode IS NOT NEW.program_mode
  OR OLD.program_name IS NOT NEW.program_name
  OR OLD.program_revision IS NOT NEW.program_revision
  OR OLD.program_definition_revision_id IS NOT NEW.program_definition_revision_id
BEGIN
  SELECT RAISE(ABORT, 'program execution identity is immutable');
END;

CREATE INDEX codemode_executions_project_session_started
  ON codemode_executions(project_id, session_id, started_at, execution_id);
