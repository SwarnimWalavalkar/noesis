CREATE TABLE sub_agents (
  agent_id TEXT PRIMARY KEY CHECK (length(agent_id) > 0),
  child_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(session_id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL CHECK (length(project_id) > 0),
  origin_session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE RESTRICT,
  origin_turn_id TEXT NOT NULL REFERENCES foreground_turns(turn_id) ON DELETE RESTRICT,
  origin_execution_id TEXT NOT NULL REFERENCES codemode_executions(execution_id) ON DELETE RESTRICT,
  parent_agent_id TEXT REFERENCES sub_agents(agent_id) ON DELETE RESTRICT,
  name TEXT,
  status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'idle', 'suspended', 'closed')),
  frozen_plan_json TEXT NOT NULL,
  frozen_plan_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE RESTRICT,
  frozen_plan_digest TEXT NOT NULL CHECK (
    length(frozen_plan_digest) = 64 AND frozen_plan_digest NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
) STRICT;

CREATE INDEX sub_agents_project_updated
  ON sub_agents(project_id, updated_at DESC, agent_id);
CREATE INDEX sub_agents_parent
  ON sub_agents(parent_agent_id, created_at, agent_id);

CREATE TABLE sub_agent_tasks (
  task_id TEXT PRIMARY KEY CHECK (length(task_id) > 0),
  agent_id TEXT NOT NULL REFERENCES sub_agents(agent_id) ON DELETE RESTRICT,
  trigger_message_id TEXT NOT NULL UNIQUE
    REFERENCES agent_messages(message_id) DEFERRABLE INITIALLY DEFERRED,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'interrupted')
  ),
  result_artifact_id TEXT REFERENCES artifacts(artifact_id) ON DELETE RESTRICT,
  result_preview TEXT,
  error TEXT,
  usage_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  CHECK (
    (status = 'pending' AND started_at IS NULL AND completed_at IS NULL) OR
    (status = 'running' AND started_at IS NOT NULL AND completed_at IS NULL) OR
    (status IN ('completed', 'failed', 'cancelled', 'interrupted') AND completed_at IS NOT NULL)
  ),
  CHECK (status != 'completed' OR result_artifact_id IS NOT NULL),
  CHECK (status NOT IN ('failed', 'cancelled', 'interrupted') OR error IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX sub_agent_tasks_one_active
  ON sub_agent_tasks(agent_id)
  WHERE status IN ('pending', 'running');
CREATE INDEX sub_agent_tasks_agent_created
  ON sub_agent_tasks(agent_id, created_at, task_id);

CREATE TABLE agent_messages (
  message_id TEXT PRIMARY KEY CHECK (length(message_id) > 0),
  project_id TEXT NOT NULL CHECK (length(project_id) > 0),
  sender_kind TEXT NOT NULL CHECK (sender_kind IN ('foreground', 'subagent')),
  sender_id TEXT NOT NULL CHECK (length(sender_id) > 0),
  recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('foreground', 'subagent')),
  recipient_id TEXT NOT NULL CHECK (length(recipient_id) > 0),
  content TEXT NOT NULL CHECK (length(trim(content)) > 0),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'private', 'secret')),
  status TEXT NOT NULL CHECK (status IN ('accepted', 'claimed', 'delivered', 'failed')),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  task_id TEXT REFERENCES sub_agent_tasks(task_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  delivered_at TEXT,
  failed_at TEXT,
  failure TEXT,
  UNIQUE(recipient_kind, recipient_id, sequence),
  CHECK (
    (status = 'accepted' AND claimed_at IS NULL AND delivered_at IS NULL AND failed_at IS NULL) OR
    (status = 'claimed' AND claimed_at IS NOT NULL AND delivered_at IS NULL AND failed_at IS NULL) OR
    (status = 'delivered' AND claimed_at IS NOT NULL AND delivered_at IS NOT NULL AND failed_at IS NULL) OR
    (status = 'failed' AND failed_at IS NOT NULL AND failure IS NOT NULL)
  )
) STRICT;

CREATE INDEX agent_messages_recipient_fifo
  ON agent_messages(recipient_kind, recipient_id, status, sequence);
CREATE INDEX agent_messages_task
  ON agent_messages(task_id, sequence, message_id);

CREATE TABLE sub_agent_timeline_entries (
  task_id TEXT NOT NULL REFERENCES sub_agent_tasks(task_id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  entry_kind TEXT NOT NULL CHECK (
    entry_kind IN ('message', 'reasoning', 'tool_call', 'model_call', 'mailbox')
  ),
  entry_id TEXT NOT NULL CHECK (length(entry_id) > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY(task_id, sequence),
  UNIQUE(entry_kind, entry_id)
) STRICT;

CREATE TABLE sub_agent_model_calls (
  model_call_id TEXT PRIMARY KEY CHECK (length(model_call_id) > 0),
  task_id TEXT NOT NULL REFERENCES sub_agent_tasks(task_id) ON DELETE RESTRICT,
  round INTEGER NOT NULL CHECK (round > 0),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  thinking_level TEXT NOT NULL CHECK (
    thinking_level IN ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')
  ),
  request_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE RESTRICT,
  output_artifact_id TEXT REFERENCES artifacts(artifact_id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled', 'interrupted')),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
  estimated_cost REAL CHECK (estimated_cost IS NULL OR estimated_cost >= 0),
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(task_id, round),
  CHECK (
    (status = 'running' AND completed_at IS NULL) OR
    (status != 'running' AND completed_at IS NOT NULL)
  ),
  CHECK (status != 'completed' OR output_artifact_id IS NOT NULL),
  CHECK (
    ((input_tokens IS NULL) + (output_tokens IS NULL) + (total_tokens IS NULL) +
      (estimated_cost IS NULL)) IN (0, 4)
  )
) STRICT;

CREATE INDEX sub_agent_model_calls_task_round
  ON sub_agent_model_calls(task_id, round);

CREATE TRIGGER sub_agent_identity_immutable
BEFORE UPDATE OF
  agent_id, child_session_id, project_id, origin_session_id, origin_turn_id,
  origin_execution_id, parent_agent_id, frozen_plan_json, frozen_plan_artifact_id,
  frozen_plan_digest, created_at
ON sub_agents
WHEN OLD.agent_id IS NOT NEW.agent_id
  OR OLD.child_session_id IS NOT NEW.child_session_id
  OR OLD.project_id IS NOT NEW.project_id
  OR OLD.origin_session_id IS NOT NEW.origin_session_id
  OR OLD.origin_turn_id IS NOT NEW.origin_turn_id
  OR OLD.origin_execution_id IS NOT NEW.origin_execution_id
  OR OLD.parent_agent_id IS NOT NEW.parent_agent_id
  OR OLD.frozen_plan_json IS NOT NEW.frozen_plan_json
  OR OLD.frozen_plan_artifact_id IS NOT NEW.frozen_plan_artifact_id
  OR OLD.frozen_plan_digest IS NOT NEW.frozen_plan_digest
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'Subagent identity and frozen plan are immutable');
END;

CREATE TRIGGER sub_agent_task_identity_immutable
BEFORE UPDATE OF task_id, agent_id, trigger_message_id, created_at
ON sub_agent_tasks
WHEN OLD.task_id IS NOT NEW.task_id
  OR OLD.agent_id IS NOT NEW.agent_id
  OR OLD.trigger_message_id IS NOT NEW.trigger_message_id
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'Subagent task identity is immutable');
END;

CREATE TRIGGER sub_agent_lineage_insert
BEFORE INSERT ON sub_agents
WHEN NOT EXISTS (
  SELECT 1
  FROM sessions AS child, sessions AS origin, foreground_turns AS turn,
       codemode_executions AS execution
  WHERE child.session_id = NEW.child_session_id
    AND json_extract(child.metadata_json, '$.kind') = 'subagent'
    AND origin.session_id = NEW.origin_session_id
    AND turn.turn_id = NEW.origin_turn_id
    AND turn.session_id = NEW.origin_session_id
    AND execution.execution_id = NEW.origin_execution_id
    AND execution.session_id = NEW.origin_session_id
    AND execution.turn_id = NEW.origin_turn_id
)
BEGIN
  SELECT RAISE(ABORT, 'Subagent origin or child-session lineage is invalid');
END;

CREATE TRIGGER sub_agent_message_recipient_insert
BEFORE INSERT ON agent_messages
WHEN (
  NEW.recipient_kind = 'subagent'
  AND NOT EXISTS (
    SELECT 1 FROM sub_agents
    WHERE agent_id = NEW.recipient_id AND project_id = NEW.project_id AND status != 'closed'
  )
) OR (
  NEW.recipient_kind = 'foreground'
  AND NOT EXISTS (SELECT 1 FROM sessions WHERE session_id = NEW.recipient_id)
)
BEGIN
  SELECT RAISE(ABORT, 'Agent message recipient is unavailable');
END;

CREATE TRIGGER sub_agent_message_sender_insert
BEFORE INSERT ON agent_messages
WHEN NEW.sender_kind = 'subagent' AND NOT EXISTS (
  SELECT 1 FROM sub_agents
  WHERE agent_id = NEW.sender_id AND project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'Agent message sender is unavailable');
END;

CREATE TRIGGER sub_agent_message_identity_immutable
BEFORE UPDATE OF
  message_id, project_id, sender_kind, sender_id, recipient_kind, recipient_id,
  content, sensitivity, sequence, task_id, created_at
ON agent_messages
WHEN OLD.message_id IS NOT NEW.message_id
  OR OLD.project_id IS NOT NEW.project_id
  OR OLD.sender_kind IS NOT NEW.sender_kind
  OR OLD.sender_id IS NOT NEW.sender_id
  OR OLD.recipient_kind IS NOT NEW.recipient_kind
  OR OLD.recipient_id IS NOT NEW.recipient_id
  OR OLD.content IS NOT NEW.content
  OR OLD.sensitivity IS NOT NEW.sensitivity
  OR OLD.sequence IS NOT NEW.sequence
  OR OLD.task_id IS NOT NEW.task_id
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'Agent message identity and content are immutable');
END;
