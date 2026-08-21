ALTER TABLE workflow_runs
  ADD COLUMN context_artifact_id TEXT REFERENCES artifacts(artifact_id) ON DELETE RESTRICT;

ALTER TABLE workflow_runs
  ADD COLUMN context_digest TEXT CHECK (
    context_digest IS NULL OR (
      typeof(context_digest) = 'text'
      AND length(CAST(context_digest AS BLOB)) = 64
      AND context_digest NOT GLOB '*[^0-9a-f]*'
      AND instr(CAST(context_digest AS BLOB), X'00') = 0
    )
  );

ALTER TABLE workflow_runs
  ADD COLUMN context_character_length INTEGER CHECK (
    context_character_length IS NULL OR context_character_length >= 0
  );

ALTER TABLE workflow_runs
  ADD COLUMN context_byte_length INTEGER CHECK (
    context_byte_length IS NULL OR context_byte_length >= 0
  );

CREATE TRIGGER workflow_context_pin_immutable
BEFORE UPDATE OF context_artifact_id, context_digest, context_character_length, context_byte_length
ON workflow_runs
WHEN OLD.context_artifact_id IS NOT NEW.context_artifact_id
  OR OLD.context_digest IS NOT NEW.context_digest
  OR OLD.context_character_length IS NOT NEW.context_character_length
  OR OLD.context_byte_length IS NOT NEW.context_byte_length
BEGIN
  SELECT RAISE(ABORT, 'Workflow context pin is immutable');
END;

CREATE TRIGGER workflow_context_pin_insert_valid
BEFORE INSERT ON workflow_runs
WHEN (
  (NEW.context_artifact_id IS NULL) +
  (NEW.context_digest IS NULL) +
  (NEW.context_character_length IS NULL) +
  (NEW.context_byte_length IS NULL)
) NOT IN (0, 4)
OR (
  NEW.context_artifact_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM artifacts
    WHERE artifact_id = NEW.context_artifact_id
      AND content_digest = NEW.context_digest
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Invalid workflow context pin');
END;

CREATE TABLE model_calls (
  model_call_id TEXT PRIMARY KEY,
  parent_execution_id TEXT NOT NULL REFERENCES codemode_executions(execution_id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  turn_id TEXT,
  context_artifact_id TEXT REFERENCES artifacts(artifact_id) ON DELETE RESTRICT,
  request_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE RESTRICT,
  output_artifact_id TEXT REFERENCES artifacts(artifact_id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  thinking_level TEXT NOT NULL CHECK (
    thinking_level IN ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')
  ),
  context_refs_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled', 'interrupted')),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
  estimated_cost REAL CHECK (estimated_cost IS NULL OR estimated_cost >= 0),
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (
    (status = 'running' AND completed_at IS NULL)
    OR
    (status != 'running' AND completed_at IS NOT NULL)
  ),
  CHECK (
    status != 'completed' OR output_artifact_id IS NOT NULL
  ),
  CHECK (
    (
      (input_tokens IS NULL) +
      (output_tokens IS NULL) +
      (total_tokens IS NULL) +
      (estimated_cost IS NULL)
    ) IN (0, 4)
  )
) STRICT;

CREATE INDEX model_calls_execution_started
  ON model_calls(parent_execution_id, started_at, model_call_id);

CREATE INDEX model_calls_session_started
  ON model_calls(session_id, started_at, model_call_id);

CREATE TRIGGER model_call_lineage_insert
BEFORE INSERT ON model_calls
WHEN NOT EXISTS (
  SELECT 1
  FROM codemode_executions AS execution
  WHERE execution.execution_id = NEW.parent_execution_id
    AND execution.session_id = NEW.session_id
    AND execution.turn_id IS NEW.turn_id
)
BEGIN
  SELECT RAISE(ABORT, 'Model call does not belong to its parent execution');
END;

CREATE TRIGGER model_call_identity_insert_once
BEFORE INSERT ON model_calls
WHEN EXISTS (
  SELECT 1 FROM model_calls WHERE model_call_id = NEW.model_call_id
)
BEGIN
  SELECT RAISE(ABORT, 'Model call identity already exists');
END;

CREATE TRIGGER model_call_identity_immutable
BEFORE UPDATE OF
  parent_execution_id,
  session_id,
  turn_id,
  context_artifact_id,
  request_artifact_id,
  provider,
  model,
  thinking_level,
  context_refs_json,
  started_at
ON model_calls
WHEN OLD.parent_execution_id IS NOT NEW.parent_execution_id
  OR OLD.session_id IS NOT NEW.session_id
  OR OLD.turn_id IS NOT NEW.turn_id
  OR OLD.context_artifact_id IS NOT NEW.context_artifact_id
  OR OLD.request_artifact_id IS NOT NEW.request_artifact_id
  OR OLD.provider IS NOT NEW.provider
  OR OLD.model IS NOT NEW.model
  OR OLD.thinking_level IS NOT NEW.thinking_level
  OR OLD.context_refs_json IS NOT NEW.context_refs_json
  OR OLD.started_at IS NOT NEW.started_at
BEGIN
  SELECT RAISE(ABORT, 'Model call identity is immutable');
END;
