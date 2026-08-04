DROP INDEX jobs_status_kind_created;
DROP INDEX jobs_created;

CREATE INDEX jobs_created_status_kind
ON jobs(created_at, job_id, status, kind);

CREATE TABLE job_lineage (
  child_job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
  parent_job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
  linked_at TEXT NOT NULL,
  PRIMARY KEY(child_job_id, parent_job_id)
) STRICT;

INSERT INTO job_lineage(child_job_id, parent_job_id, linked_at)
SELECT child_job_id, parent_job_id, min(observed_at)
FROM job_observations
GROUP BY child_job_id, parent_job_id;

INSERT OR IGNORE INTO job_lineage(child_job_id, parent_job_id, linked_at)
SELECT child.job_id, parent.job_id, child.created_at
FROM jobs AS child
JOIN jobs AS parent
  ON parent.job_id = json_extract(child.payload_json, '$.parentJobId')
WHERE json_type(child.payload_json, '$.parentJobId') = 'text';

WITH RECURSIVE inherited(child_job_id, parent_job_id, source_session_id, observed_at) AS (
  SELECT lineage.child_job_id,
         lineage.parent_job_id,
         observations.source_session_id,
         max(lineage.linked_at, observations.observed_at)
  FROM job_lineage AS lineage
  JOIN job_observations AS observations
    ON observations.child_job_id = lineage.parent_job_id
  UNION
  SELECT lineage.child_job_id,
         lineage.parent_job_id,
         inherited.source_session_id,
         max(lineage.linked_at, inherited.observed_at)
  FROM job_lineage AS lineage
  JOIN inherited ON inherited.child_job_id = lineage.parent_job_id
)
INSERT OR IGNORE INTO job_observations(
  child_job_id, parent_job_id, source_session_id, observed_at
)
SELECT child_job_id, parent_job_id, source_session_id, min(observed_at)
FROM inherited
GROUP BY child_job_id, parent_job_id, source_session_id;

CREATE INDEX job_lineage_parent_child
ON job_lineage(parent_job_id, child_job_id);
