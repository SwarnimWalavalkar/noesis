-- The legacy JSONL import and its one-time operational cutover are gone. Drop the tables that
-- recorded them and the columns that tied authority rows to imported journal events.
-- The runner applies migrations with foreign keys off and fails the migration unless
-- PRAGMA foreign_key_check passes before commit.

DROP TABLE import_runs;
DROP TABLE operational_cutovers;

CREATE TABLE authority_grants_v2 (
  grant_id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  effects_json TEXT NOT NULL,
  resource_prefixes_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  max_uses INTEGER NOT NULL CHECK (max_uses > 0),
  max_cost REAL NOT NULL CHECK (max_cost >= 0),
  issued_at TEXT NOT NULL
) STRICT;
INSERT INTO authority_grants_v2(
  grant_id, principal, effects_json, resource_prefixes_json, expires_at, max_uses, max_cost, issued_at
)
SELECT grant_id, principal, effects_json, resource_prefixes_json, expires_at, max_uses, max_cost, issued_at
FROM authority_grants;
DROP TABLE authority_grants;
ALTER TABLE authority_grants_v2 RENAME TO authority_grants;

CREATE TABLE authority_operations_v2 (
  operation_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  operation_fingerprint TEXT NOT NULL CHECK (length(operation_fingerprint) = 64),
  principal TEXT NOT NULL,
  effect TEXT NOT NULL,
  resource TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  estimated_cost REAL NOT NULL CHECK (estimated_cost >= 0),
  grant_id TEXT REFERENCES authority_grants(grant_id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (
    status IN ('reserved', 'completed', 'failed', 'denied', 'unresolved')
  ),
  result_json TEXT,
  failure TEXT,
  receipt_lineage_id TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (status = 'completed' AND result_json IS NOT NULL AND failure IS NULL) OR
    (status = 'failed' AND result_json IS NULL AND failure IS NOT NULL) OR
    (status IN ('reserved', 'denied', 'unresolved') AND result_json IS NULL)
  )
) STRICT;
INSERT INTO authority_operations_v2(
  operation_id, idempotency_key, operation_fingerprint, principal, effect, resource, request_digest,
  estimated_cost, grant_id, status, result_json, failure, receipt_lineage_id, created_at, updated_at
)
SELECT operation_id, idempotency_key, operation_fingerprint, principal, effect, resource, request_digest,
  estimated_cost, grant_id, status, result_json, failure, receipt_lineage_id, created_at, updated_at
FROM authority_operations;
DROP TABLE authority_operations;
ALTER TABLE authority_operations_v2 RENAME TO authority_operations;

CREATE INDEX authority_operations_grant
  ON authority_operations(grant_id, status, created_at, operation_id);
