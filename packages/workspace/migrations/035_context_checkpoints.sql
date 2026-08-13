CREATE TABLE context_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE RESTRICT,
  previous_checkpoint_id TEXT REFERENCES context_checkpoints(checkpoint_id) ON DELETE RESTRICT,
  summary TEXT NOT NULL CHECK (length(summary) > 0),
  summary_digest TEXT NOT NULL CHECK (length(summary_digest) = 64),
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64),
  first_retained_message_id TEXT REFERENCES messages(message_id) ON DELETE RESTRICT,
  last_covered_message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE RESTRICT,
  token_budget INTEGER NOT NULL CHECK (token_budget > 0),
  estimated_summary_tokens INTEGER NOT NULL CHECK (estimated_summary_tokens > 0),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'private', 'secret')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  thinking_level TEXT NOT NULL CHECK (thinking_level IN ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')),
  usage_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE context_checkpoint_sources (
  checkpoint_id TEXT NOT NULL REFERENCES context_checkpoints(checkpoint_id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE RESTRICT,
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  PRIMARY KEY(checkpoint_id, ordinal),
  UNIQUE(checkpoint_id, message_id)
) STRICT;

CREATE TABLE session_context_state (
  session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE RESTRICT,
  active_checkpoint_id TEXT NOT NULL UNIQUE REFERENCES context_checkpoints(checkpoint_id) ON DELETE RESTRICT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX context_checkpoints_session_created
  ON context_checkpoints(session_id, created_at, checkpoint_id);
