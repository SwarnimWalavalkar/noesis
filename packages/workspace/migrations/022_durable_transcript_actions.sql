ALTER TABLE tool_calls ADD COLUMN turn_id TEXT;
ALTER TABLE tool_calls ADD COLUMN parent_tool_call_id TEXT;
ALTER TABLE tool_calls ADD COLUMN execution_id TEXT;
ALTER TABLE tool_calls ADD COLUMN update_json TEXT;
ALTER TABLE tool_calls ADD COLUMN action_sequence INTEGER;

UPDATE tool_calls
SET
  turn_id = json_extract(request_json, '$.turnId'),
  execution_id = json_extract(request_json, '$.executionId'),
  action_sequence = rowid
WHERE json_valid(request_json);

UPDATE tool_calls
SET action_sequence = rowid
WHERE action_sequence IS NULL;

CREATE INDEX tool_calls_turn_created
  ON tool_calls(session_id, turn_id, action_sequence, tool_call_id);
CREATE INDEX tool_calls_execution
  ON tool_calls(execution_id, created_at, tool_call_id);

CREATE TRIGGER tool_call_lineage_insert
BEFORE INSERT ON tool_calls
WHEN (
  NEW.turn_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM foreground_turns
    WHERE turn_id = NEW.turn_id
      AND session_id = NEW.session_id
  )
) OR (
  NEW.parent_tool_call_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM tool_calls AS parent
    WHERE parent.tool_call_id = NEW.parent_tool_call_id
      AND parent.session_id = NEW.session_id
      AND parent.turn_id IS NEW.turn_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Tool call lineage does not belong to its session and turn');
END;

CREATE TRIGGER tool_call_lineage_immutable
BEFORE UPDATE OF
  session_id,
  turn_id,
  parent_tool_call_id,
  tool_name,
  request_json,
  action_sequence,
  created_at
ON tool_calls
WHEN OLD.session_id IS NOT NEW.session_id
  OR OLD.turn_id IS NOT NEW.turn_id
  OR OLD.parent_tool_call_id IS NOT NEW.parent_tool_call_id
  OR OLD.tool_name IS NOT NEW.tool_name
  OR OLD.request_json IS NOT NEW.request_json
  OR OLD.action_sequence IS NOT NEW.action_sequence
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'Tool call identity and lineage are immutable');
END;
