CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  parent_session_id TEXT REFERENCES sessions(session_id),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'completed', 'aborted', 'failed')),
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  runtime TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TABLE messages (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content TEXT NOT NULL,
  sensitivity TEXT NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('normal', 'private', 'secret')),
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE INDEX messages_session_created ON messages(session_id, created_at, message_id);

CREATE TABLE tool_calls (
  tool_call_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(message_id) ON DELETE SET NULL,
  tool_name TEXT NOT NULL,
  request_json TEXT NOT NULL,
  response_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('requested', 'running', 'completed', 'failed', 'denied', 'ambiguous')),
  sensitivity TEXT NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('normal', 'private', 'secret')),
  created_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;
CREATE INDEX tool_calls_session_created ON tool_calls(session_id, created_at, tool_call_id);

CREATE TABLE outcomes (
  outcome_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  turn_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'corrected', 'failed', 'unknown')),
  summary TEXT NOT NULL,
  sensitivity TEXT NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('normal', 'private', 'secret')),
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE INDEX outcomes_session_created ON outcomes(session_id, created_at, outcome_id);

CREATE TABLE jobs (
  job_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'running', 'completed', 'failed', 'cancelled', 'budget_exhausted')),
  lease_owner TEXT,
  lease_until TEXT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  budget_remaining REAL NOT NULL DEFAULT 0 CHECK (budget_remaining >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE experiments (
  experiment_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('hypothesis', 'authoring', 'preflight', 'observing', 'completed')),
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE experiment_trials (
  trial_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id) ON DELETE RESTRICT,
  comparison_group_id TEXT NOT NULL,
  arm TEXT NOT NULL CHECK (arm IN ('baseline', 'candidate')),
  status TEXT NOT NULL CHECK (status IN ('planned', 'running', 'completed', 'failed')),
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX experiment_trials_experiment ON experiment_trials(experiment_id, trial_id);

CREATE TABLE preflight_plans (
  plan_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id) ON DELETE RESTRICT,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE preflight_reports (
  preflight_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL REFERENCES preflight_plans(plan_id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('pass', 'block', 'inconclusive')),
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE evaluations (
  evaluation_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id) ON DELETE RESTRICT,
  preflight_id TEXT NOT NULL REFERENCES preflight_reports(preflight_id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX evaluations_experiment ON evaluations(experiment_id, evaluation_id);

CREATE TABLE feedback_signals (
  signal_id TEXT PRIMARY KEY,
  experiment_id TEXT REFERENCES experiments(experiment_id) ON DELETE RESTRICT,
  capability_revision_id TEXT,
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'private', 'secret')),
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE activations (
  activation_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision > 0),
  previous_activation_id TEXT REFERENCES activations(activation_id),
  definitions_json TEXT NOT NULL,
  capability_revisions_json TEXT NOT NULL,
  preflight_id TEXT REFERENCES preflight_reports(preflight_id),
  created_at TEXT NOT NULL,
  UNIQUE(revision)
) STRICT;

CREATE TABLE activation_pointers (
  pointer_id TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL UNIQUE,
  activation_id TEXT NOT NULL REFERENCES activations(activation_id) ON DELETE RESTRICT,
  capability_revision_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE search_configuration (
  configuration_id TEXT PRIMARY KEY CHECK (configuration_id = 'default'),
  lexical_limit INTEGER NOT NULL CHECK (lexical_limit BETWEEN 1 AND 1000),
  semantic_limit INTEGER NOT NULL CHECK (semantic_limit BETWEEN 0 AND 1000),
  rerank_limit INTEGER NOT NULL CHECK (rerank_limit BETWEEN 0 AND 100),
  max_excerpt_chars INTEGER NOT NULL CHECK (max_excerpt_chars BETWEEN 32 AND 8000),
  include_private INTEGER NOT NULL DEFAULT 0 CHECK (include_private IN (0, 1)),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE activity_log (
  activity_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'noesis', 'external_system', 'system')),
  activity_kind TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  references_json TEXT NOT NULL DEFAULT '[]',
  occurred_at TEXT NOT NULL
) STRICT;
CREATE INDEX activity_log_subject ON activity_log(subject_kind, subject_id, occurred_at);

CREATE TABLE file_revisions (
  revision_id TEXT PRIMARY KEY,
  revision_kind TEXT NOT NULL CHECK (revision_kind IN ('definition', 'candidate', 'active', 'evidence')),
  working_path TEXT NOT NULL,
  snapshot_path TEXT NOT NULL UNIQUE,
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  predecessor_revision_id TEXT REFERENCES file_revisions(revision_id) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'noesis', 'external_system', 'system')),
  reason TEXT,
  recorded_at TEXT NOT NULL,
  evidence_kind TEXT CHECK (evidence_kind IS NULL OR evidence_kind IN ('input', 'output', 'tool_trace', 'judgment', 'report')),
  supersedes_revision_id TEXT REFERENCES file_revisions(revision_id) ON DELETE RESTRICT,
  CHECK ((revision_kind = 'evidence') = (evidence_kind IS NOT NULL))
) STRICT;
CREATE INDEX file_revisions_working_path ON file_revisions(working_path, recorded_at, revision_id);

CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  actor_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'noesis', 'external_system', 'system')),
  relationship_refs_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE staged_definitions (
  stage_id TEXT PRIMARY KEY,
  target_area TEXT NOT NULL CHECK (target_area IN ('candidate', 'active')),
  relative_path TEXT NOT NULL,
  staged_path TEXT NOT NULL UNIQUE,
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  actor_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'noesis', 'external_system', 'system')),
  reason TEXT,
  created_at TEXT NOT NULL,
  registered_revision_id TEXT REFERENCES file_revisions(revision_id)
) STRICT;

CREATE TABLE import_runs (
  source_id TEXT PRIMARY KEY,
  source_root TEXT NOT NULL,
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64),
  imported_at TEXT NOT NULL,
  report_json TEXT NOT NULL
) STRICT;

INSERT INTO search_configuration(
  configuration_id, lexical_limit, semantic_limit, rerank_limit, max_excerpt_chars, include_private, updated_at
) VALUES ('default', 40, 40, 12, 1200, 0, '1970-01-01T00:00:00.000Z');
