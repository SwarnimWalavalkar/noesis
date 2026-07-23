ALTER TABLE file_revisions ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'normal'
  CHECK (sensitivity IN ('normal', 'private', 'secret'));
ALTER TABLE file_revisions ADD COLUMN provenance_refs_json TEXT NOT NULL DEFAULT '[]';

-- Historical evaluation evidence predates explicit classification; fail closed on migration.
UPDATE file_revisions SET sensitivity = 'private' WHERE revision_kind = 'evidence';

CREATE TABLE definition_publications (
  publication_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  definition_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  revision_id TEXT NOT NULL UNIQUE,
  staged_path TEXT NOT NULL UNIQUE,
  working_path TEXT NOT NULL,
  snapshot_path TEXT NOT NULL UNIQUE,
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  status TEXT NOT NULL CHECK (status IN ('staged', 'committed', 'published', 'rejected')),
  created_at TEXT NOT NULL,
  published_at TEXT
) STRICT;
CREATE INDEX definition_publications_definition
  ON definition_publications(namespace, definition_id, status);

ALTER TABLE activation_pointers ADD COLUMN capability_revision_json TEXT;
