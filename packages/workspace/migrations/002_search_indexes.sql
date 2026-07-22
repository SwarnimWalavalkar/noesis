CREATE TABLE search_documents (
  document_id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('database_row', 'file_revision')),
  source_table TEXT,
  source_id TEXT NOT NULL,
  source_field TEXT NOT NULL,
  session_id TEXT,
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'private', 'secret')),
  occurred_at TEXT NOT NULL,
  body TEXT NOT NULL,
  citation_json TEXT NOT NULL,
  CHECK (
    (source_kind = 'database_row' AND source_table IS NOT NULL) OR
    (source_kind = 'file_revision' AND source_table IS NULL)
  )
) STRICT;
CREATE UNIQUE INDEX search_documents_canonical_source
  ON search_documents(source_kind, COALESCE(source_table, ''), source_id, source_field);
CREATE INDEX search_documents_session ON search_documents(session_id, occurred_at, document_id);

CREATE VIRTUAL TABLE search_fts USING fts5(
  document_id UNINDEXED,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE search_embeddings (
  document_id TEXT NOT NULL REFERENCES search_documents(document_id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  vector_json TEXT NOT NULL,
  PRIMARY KEY(document_id, model_id)
) STRICT;
