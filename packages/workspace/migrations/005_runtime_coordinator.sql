ALTER TABLE jobs ADD COLUMN payload_refs_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE jobs ADD COLUMN operation_id TEXT NOT NULL DEFAULT '';
ALTER TABLE jobs ADD COLUMN idempotency_key TEXT NOT NULL DEFAULT '';
ALTER TABLE jobs ADD COLUMN not_before TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
ALTER TABLE jobs ADD COLUMN lease_token TEXT;
ALTER TABLE jobs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 1 CHECK (max_attempts > 0);
ALTER TABLE jobs ADD COLUMN estimated_cost REAL NOT NULL DEFAULT 0 CHECK (estimated_cost >= 0);
ALTER TABLE jobs ADD COLUMN result_json TEXT;
ALTER TABLE jobs ADD COLUMN last_error_json TEXT;
ALTER TABLE jobs ADD COLUMN completed_at TEXT;

UPDATE jobs
SET operation_id = 'legacy:' || job_id,
    idempotency_key = 'legacy:' || job_id,
    not_before = created_at
WHERE operation_id = '' OR idempotency_key = '';

CREATE UNIQUE INDEX jobs_operation_identity ON jobs(operation_id);
CREATE UNIQUE INDEX jobs_idempotency_identity ON jobs(idempotency_key);
CREATE INDEX jobs_claimable
  ON jobs(status, not_before, lease_until, created_at, job_id);

-- SQLite v1's decision column predates approval_required. The canonical report JSON carries
-- the four-way decision; this flag keeps the indexed operational state explicit until AC-09
-- owns preflight interpretation and may replace the compatibility representation.
ALTER TABLE preflight_reports ADD COLUMN approval_required INTEGER NOT NULL DEFAULT 0
  CHECK (approval_required IN (0, 1));
