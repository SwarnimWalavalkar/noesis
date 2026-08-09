CREATE TABLE migration_033_workflow_digest_validation (
  valid INTEGER NOT NULL CHECK (valid = 1)
) STRICT;

INSERT INTO migration_033_workflow_digest_validation(valid)
SELECT CASE
  WHEN EXISTS (
    SELECT 1
    FROM workflow_runs
    WHERE definition_dependencies_digest IS NOT NULL
      AND (
        typeof(definition_dependencies_digest) != 'text'
        OR length(CAST(definition_dependencies_digest AS BLOB)) != 64
        OR EXISTS (
          WITH RECURSIVE byte_positions(position) AS (
            SELECT 1
            UNION ALL
            SELECT position + 1
            FROM byte_positions
            WHERE position < 64
          )
          SELECT 1
          FROM byte_positions
          WHERE hex(substr(CAST(definition_dependencies_digest AS BLOB), position, 1))
            NOT IN (
              '30', '31', '32', '33', '34', '35', '36', '37', '38', '39',
              '61', '62', '63', '64', '65', '66'
            )
        )
      )
  ) THEN 0
  ELSE 1
END;

DROP TABLE migration_033_workflow_digest_validation;

CREATE TRIGGER workflow_definition_dependency_digest_insert
BEFORE INSERT ON workflow_runs
WHEN NEW.definition_dependencies_digest IS NOT NULL
  AND (
    typeof(NEW.definition_dependencies_digest) != 'text'
    OR length(CAST(NEW.definition_dependencies_digest AS BLOB)) != 64
    OR EXISTS (
      WITH RECURSIVE byte_positions(position) AS (
        SELECT 1
        UNION ALL
        SELECT position + 1
        FROM byte_positions
        WHERE position < 64
      )
      SELECT 1
      FROM byte_positions
      WHERE hex(substr(CAST(NEW.definition_dependencies_digest AS BLOB), position, 1))
        NOT IN (
          '30', '31', '32', '33', '34', '35', '36', '37', '38', '39',
          '61', '62', '63', '64', '65', '66'
        )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'Workflow definition dependency digest must be stored as 64 lowercase hexadecimal ASCII bytes');
END;

CREATE TRIGGER workflow_definition_dependency_digest_update
BEFORE UPDATE OF definition_dependencies_digest ON workflow_runs
WHEN NEW.definition_dependencies_digest IS NOT NULL
  AND (
    typeof(NEW.definition_dependencies_digest) != 'text'
    OR length(CAST(NEW.definition_dependencies_digest AS BLOB)) != 64
    OR EXISTS (
      WITH RECURSIVE byte_positions(position) AS (
        SELECT 1
        UNION ALL
        SELECT position + 1
        FROM byte_positions
        WHERE position < 64
      )
      SELECT 1
      FROM byte_positions
      WHERE hex(substr(CAST(NEW.definition_dependencies_digest AS BLOB), position, 1))
        NOT IN (
          '30', '31', '32', '33', '34', '35', '36', '37', '38', '39',
          '61', '62', '63', '64', '65', '66'
        )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'Workflow definition dependency digest must be stored as 64 lowercase hexadecimal ASCII bytes');
END;
