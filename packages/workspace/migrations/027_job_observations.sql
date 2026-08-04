CREATE TABLE job_observations (
  child_job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
  parent_job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
  source_session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(child_job_id, parent_job_id, source_session_id)
) STRICT;

INSERT INTO job_observations(child_job_id, parent_job_id, source_session_id, observed_at)
SELECT child.job_id, parent.job_id, source.session_id, child.created_at
FROM jobs AS child
JOIN jobs AS parent
  ON parent.job_id = json_extract(child.payload_json, '$.parentJobId')
JOIN sessions AS source
  ON source.session_id = json_extract(child.payload_json, '$.sourceSessionId')
WHERE json_type(child.payload_json, '$.parentJobId') = 'text'
  AND json_type(child.payload_json, '$.sourceSessionId') = 'text';

CREATE INDEX job_observations_session_child
ON job_observations(source_session_id, child_job_id, parent_job_id);

CREATE INDEX job_observations_parent_child
ON job_observations(parent_job_id, child_job_id);
