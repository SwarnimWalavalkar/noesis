-- Session search is plain BM25 over a stemmed FTS index. The model calling it writes the queries.
DROP TABLE search_embeddings;

ALTER TABLE search_configuration DROP COLUMN semantic_limit;
ALTER TABLE search_configuration DROP COLUMN rerank_limit;

-- search_fts is a projection of search_documents, so the new tokenizer rebuilds it from there.
DROP TABLE search_fts;
CREATE VIRTUAL TABLE search_fts USING fts5(
  document_id UNINDEXED,
  body,
  tokenize = 'porter unicode61 remove_diacritics 2'
);
INSERT INTO search_fts(document_id, body) SELECT document_id, body FROM search_documents;
