CREATE TABLE capabilities (
  capability_id TEXT PRIMARY KEY,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE capability_revisions (
  capability_revision_id TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL REFERENCES capabilities(capability_id),
  predecessor_revision_id TEXT,
  revision_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(capability_id, capability_revision_id),
  FOREIGN KEY(capability_id, predecessor_revision_id)
    REFERENCES capability_revisions(capability_id, capability_revision_id)
) STRICT;

CREATE INDEX capability_revisions_lineage_idx
  ON capability_revisions(capability_id, created_at, capability_revision_id);

CREATE TRIGGER capability_revisions_immutable_update
BEFORE UPDATE ON capability_revisions
BEGIN
  SELECT RAISE(ABORT, 'capability revisions are immutable');
END;

CREATE TRIGGER capability_revisions_immutable_insert
BEFORE INSERT ON capability_revisions
WHEN EXISTS (
  SELECT 1 FROM capability_revisions
  WHERE capability_revision_id = NEW.capability_revision_id
)
BEGIN
  SELECT RAISE(ABORT, 'capability revision identities are immutable');
END;

CREATE TRIGGER capability_revisions_immutable_delete
BEFORE DELETE ON capability_revisions
BEGIN
  SELECT RAISE(ABORT, 'capability revisions are immutable');
END;

CREATE TABLE capability_bindings (
  capability_id TEXT PRIMARY KEY REFERENCES capabilities(capability_id),
  revision_json TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  activation_mode TEXT NOT NULL CHECK(activation_mode IN ('relevant', 'always')),
  state TEXT NOT NULL CHECK(state IN ('active', 'paused')),
  binding_revision INTEGER NOT NULL CHECK(binding_revision > 0),
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX capability_bindings_global_scope_idx
  ON capability_bindings(state, updated_at DESC, capability_id)
  WHERE json_extract(scope_json, '$.kind') = 'global';

CREATE INDEX capability_bindings_project_scope_idx
  ON capability_bindings(
    state,
    json_extract(scope_json, '$.project.projectId'),
    json_extract(scope_json, '$.project.root'),
    updated_at DESC,
    capability_id
  )
  WHERE json_extract(scope_json, '$.kind') = 'project';

CREATE INDEX capability_bindings_session_scope_idx
  ON capability_bindings(
    state,
    json_extract(scope_json, '$.sessionId'),
    updated_at DESC,
    capability_id
  )
  WHERE json_extract(scope_json, '$.kind') = 'session';

CREATE TABLE capability_feedback (
  feedback_id TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL REFERENCES capabilities(capability_id),
  revision_json TEXT NOT NULL,
  feedback_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX capability_feedback_capability_idx
  ON capability_feedback(capability_id, created_at DESC, feedback_id DESC);

CREATE TABLE capability_gate_requests (
  gate_request_id TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL REFERENCES capabilities(capability_id),
  revision_json TEXT NOT NULL,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'denied', 'superseded')),
  created_at TEXT NOT NULL,
  settled_at TEXT
) STRICT;

CREATE UNIQUE INDEX capability_gate_one_pending_idx
  ON capability_gate_requests(capability_id)
  WHERE status = 'pending';

CREATE TABLE capability_learning_cutovers (
  cutover_version INTEGER PRIMARY KEY CHECK(cutover_version = 1),
  completed_at TEXT NOT NULL
) STRICT;

CREATE TABLE capability_learning_cutover_failures (
  source_project_id TEXT NOT NULL,
  source_adjustment_id TEXT NOT NULL,
  failure TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY(source_project_id, source_adjustment_id)
) STRICT;
