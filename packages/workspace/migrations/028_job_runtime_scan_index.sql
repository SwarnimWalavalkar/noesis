CREATE INDEX jobs_status_kind_created
ON jobs(status, kind, created_at, job_id);
