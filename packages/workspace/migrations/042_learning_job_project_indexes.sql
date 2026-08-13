CREATE INDEX jobs_reflection_project_created
ON jobs(kind, json_extract(payload_json, '$.turn.project.projectId'), created_at DESC, job_id DESC);

CREATE INDEX jobs_source_session_created
ON jobs(json_extract(payload_json, '$.sourceSessionId'), created_at DESC, job_id DESC);

CREATE INDEX jobs_experiment_scope_created
ON jobs(json_extract(payload_json, '$.experimentId'), created_at DESC, job_id DESC);
