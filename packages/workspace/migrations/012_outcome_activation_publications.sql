-- Revert commits authoritative activation pointers before publishing their mutable active files.
CREATE TABLE outcome_activation_publications (
  operation_id TEXT NOT NULL REFERENCES experiment_outcomes(operation_id) ON DELETE RESTRICT,
  publication_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('publish', 'delete')),
  working_path TEXT NOT NULL,
  source_revision_json TEXT,
  staged_path TEXT,
  content_digest TEXT,
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  PRIMARY KEY(operation_id, publication_key),
  UNIQUE(operation_id, working_path),
  CHECK (
    (action = 'publish' AND source_revision_json IS NOT NULL AND staged_path IS NOT NULL
      AND content_digest IS NOT NULL AND length(content_digest) = 64)
    OR
    (action = 'delete' AND source_revision_json IS NULL AND staged_path IS NULL
      AND content_digest IS NULL)
  )
) STRICT;

CREATE INDEX outcome_activation_publications_pending
  ON outcome_activation_publications(published, operation_id);
