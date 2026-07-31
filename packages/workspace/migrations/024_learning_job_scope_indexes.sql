CREATE INDEX jobs_reflection_session_created
ON jobs(kind, json_extract(payload_json, '$.turn.sessionId'), created_at, job_id)
WHERE kind = 'runtime.reflect_turn';

CREATE INDEX jobs_experiment_created
ON jobs(kind, json_extract(payload_json, '$.experimentId'), created_at, job_id)
WHERE kind IN ('runtime.author_revision', 'runtime.preflight');
