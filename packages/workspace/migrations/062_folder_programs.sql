-- A Capability or skill folder can hold Programs. A run of one records its folder, which owns the
-- definition, and the project it ran in.
ALTER TABLE codemode_executions ADD COLUMN program_folder_id TEXT;

DROP TRIGGER codemode_program_identity_valid_insert;

CREATE TRIGGER codemode_program_identity_valid_insert
BEFORE INSERT ON codemode_executions
WHEN NOT (
  (
    NEW.program_project_id IS NULL
    AND NEW.program_folder_id IS NULL
    AND NEW.program_mode IS NULL
    AND NEW.program_name IS NULL
    AND NEW.program_revision IS NULL
    AND NEW.program_definition_revision_id IS NULL
  )
  OR (
    (NEW.program_project_id IS NULL OR NEW.project_id IS NEW.program_project_id)
    AND (NEW.program_project_id IS NULL OR NEW.program_folder_id IS NULL)
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
      WHERE metadata.namespace = 'program:' || CASE
            WHEN NEW.program_folder_id IS NOT NULL THEN 'folder:' || NEW.program_folder_id
            ELSE COALESCE(NEW.program_project_id, 'global')
          END || ':' || NEW.program_mode
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

DROP TRIGGER codemode_program_identity_immutable;

CREATE TRIGGER codemode_program_identity_immutable
BEFORE UPDATE OF project_id, program_project_id, program_folder_id, program_mode, program_name, program_revision, program_definition_revision_id
ON codemode_executions
WHEN OLD.project_id IS NOT NEW.project_id
  OR OLD.program_project_id IS NOT NEW.program_project_id
  OR OLD.program_folder_id IS NOT NEW.program_folder_id
  OR OLD.program_mode IS NOT NEW.program_mode
  OR OLD.program_name IS NOT NEW.program_name
  OR OLD.program_revision IS NOT NEW.program_revision
  OR OLD.program_definition_revision_id IS NOT NEW.program_definition_revision_id
BEGIN
  SELECT RAISE(ABORT, 'program execution identity is immutable');
END;

DROP TRIGGER workflow_run_program_identity_valid_insert;

CREATE TRIGGER workflow_run_program_identity_valid_insert
BEFORE INSERT ON workflow_runs
WHEN NEW.project_id IS NULL OR NOT EXISTS (
  SELECT 1
  FROM definition_revision_metadata AS metadata
  WHERE (
      metadata.namespace IN ('program:' || NEW.project_id || ':workflow', 'program:global:workflow')
      OR metadata.namespace GLOB 'program:folder:*:workflow'
    )
    AND metadata.definition_id = NEW.workflow_name
    AND metadata.revision = NEW.workflow_revision
    AND metadata.definition_revision_id = NEW.definition_revision_id
)
BEGIN
  SELECT RAISE(ABORT, 'Workflow run must reference one exact workflow-mode Program revision');
END;
