DROP INDEX jobs_experiment_created;

CREATE INDEX jobs_experiment_created
ON jobs(kind, json_extract(payload_json, '$.experimentId'), created_at, job_id);
