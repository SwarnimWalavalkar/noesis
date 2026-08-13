CREATE TEMP TABLE context_checkpoint_session_integrity_preflight_v2 (
  valid INTEGER NOT NULL CHECK (valid = 1)
) STRICT;

INSERT INTO context_checkpoint_session_integrity_preflight_v2(valid)
SELECT CASE WHEN EXISTS (
  SELECT 1
  FROM context_checkpoints AS checkpoint
  LEFT JOIN context_checkpoints AS previous
    ON previous.checkpoint_id = checkpoint.previous_checkpoint_id
  LEFT JOIN messages AS retained
    ON retained.message_id = checkpoint.first_retained_message_id
  LEFT JOIN messages AS covered
    ON covered.message_id = checkpoint.last_covered_message_id
  WHERE (checkpoint.previous_checkpoint_id IS NOT NULL AND (
      previous.checkpoint_id IS NULL OR previous.session_id != checkpoint.session_id
    ))
    OR (checkpoint.first_retained_message_id IS NOT NULL AND (
      retained.message_id IS NULL OR retained.session_id != checkpoint.session_id
    ))
    OR covered.message_id IS NULL
    OR covered.session_id != checkpoint.session_id
  UNION ALL
  SELECT 1
  FROM context_checkpoint_sources AS source
  LEFT JOIN context_checkpoints AS checkpoint ON checkpoint.checkpoint_id = source.checkpoint_id
  LEFT JOIN messages AS message ON message.message_id = source.message_id
  WHERE checkpoint.checkpoint_id IS NULL
    OR message.message_id IS NULL
    OR message.session_id != checkpoint.session_id
  UNION ALL
  SELECT 1
  FROM session_context_state AS state
  LEFT JOIN context_checkpoints AS checkpoint ON checkpoint.checkpoint_id = state.active_checkpoint_id
  WHERE checkpoint.checkpoint_id IS NULL OR checkpoint.session_id != state.session_id
) THEN 0 ELSE 1 END;

DROP TABLE context_checkpoint_session_integrity_preflight_v2;

CREATE TRIGGER context_checkpoints_session_immutable
BEFORE UPDATE OF session_id ON context_checkpoints
WHEN NEW.session_id != OLD.session_id
BEGIN
  SELECT RAISE(ABORT, 'context checkpoint session is immutable');
END;
