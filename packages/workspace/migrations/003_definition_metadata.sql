CREATE TABLE definition_revision_metadata (
  namespace TEXT NOT NULL,
  definition_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  definition_revision_id TEXT NOT NULL REFERENCES file_revisions(revision_id) ON DELETE RESTRICT,
  predecessor_revision_id TEXT REFERENCES file_revisions(revision_id) ON DELETE RESTRICT,
  activity_id TEXT NOT NULL UNIQUE REFERENCES activity_log(activity_id) ON DELETE RESTRICT,
  PRIMARY KEY(namespace, definition_id, revision),
  UNIQUE(namespace, definition_id, definition_revision_id),
  UNIQUE(namespace, definition_id, revision, definition_revision_id)
) STRICT;

CREATE TABLE definition_current_pointers (
  namespace TEXT NOT NULL,
  definition_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  definition_revision_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(namespace, definition_id),
  FOREIGN KEY(namespace, definition_id, revision, definition_revision_id)
    REFERENCES definition_revision_metadata(namespace, definition_id, revision, definition_revision_id)
    ON DELETE RESTRICT
) STRICT;
