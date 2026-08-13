CREATE TEMP TABLE context_checkpoint_session_integrity_preflight (
  valid INTEGER NOT NULL CHECK (valid = 1)
) STRICT;

INSERT INTO context_checkpoint_session_integrity_preflight(valid)
SELECT CASE WHEN EXISTS (
  SELECT 1
  FROM context_checkpoints AS checkpoint
  LEFT JOIN context_checkpoints AS previous
    ON previous.checkpoint_id = checkpoint.previous_checkpoint_id
  LEFT JOIN messages AS retained
    ON retained.message_id = checkpoint.first_retained_message_id
  LEFT JOIN messages AS covered
    ON covered.message_id = checkpoint.last_covered_message_id
  WHERE (checkpoint.previous_checkpoint_id IS NOT NULL AND previous.session_id != checkpoint.session_id)
    OR (checkpoint.first_retained_message_id IS NOT NULL AND retained.session_id != checkpoint.session_id)
    OR covered.session_id != checkpoint.session_id
  UNION ALL
  SELECT 1
  FROM context_checkpoint_sources AS source
  JOIN context_checkpoints AS checkpoint ON checkpoint.checkpoint_id = source.checkpoint_id
  JOIN messages AS message ON message.message_id = source.message_id
  WHERE message.session_id != checkpoint.session_id
  UNION ALL
  SELECT 1
  FROM session_context_state AS state
  JOIN context_checkpoints AS checkpoint ON checkpoint.checkpoint_id = state.active_checkpoint_id
  WHERE checkpoint.session_id != state.session_id
) THEN 0 ELSE 1 END;

DROP TABLE context_checkpoint_session_integrity_preflight;

CREATE TRIGGER context_checkpoints_session_refs_insert
BEFORE INSERT ON context_checkpoints
WHEN
  (NEW.previous_checkpoint_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM context_checkpoints
    WHERE checkpoint_id = NEW.previous_checkpoint_id AND session_id = NEW.session_id
  ))
  OR (NEW.first_retained_message_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM messages
    WHERE message_id = NEW.first_retained_message_id AND session_id = NEW.session_id
  ))
  OR NOT EXISTS (
    SELECT 1 FROM messages
    WHERE message_id = NEW.last_covered_message_id AND session_id = NEW.session_id
  )
BEGIN
  SELECT RAISE(ABORT, 'context checkpoint references must belong to its session');
END;

CREATE TRIGGER context_checkpoints_session_refs_update
BEFORE UPDATE ON context_checkpoints
WHEN
  (NEW.previous_checkpoint_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM context_checkpoints
    WHERE checkpoint_id = NEW.previous_checkpoint_id AND session_id = NEW.session_id
  ))
  OR (NEW.first_retained_message_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM messages
    WHERE message_id = NEW.first_retained_message_id AND session_id = NEW.session_id
  ))
  OR NOT EXISTS (
    SELECT 1 FROM messages
    WHERE message_id = NEW.last_covered_message_id AND session_id = NEW.session_id
  )
BEGIN
  SELECT RAISE(ABORT, 'context checkpoint references must belong to its session');
END;

CREATE TRIGGER context_checkpoint_sources_session_insert
BEFORE INSERT ON context_checkpoint_sources
WHEN NOT EXISTS (
  SELECT 1
  FROM context_checkpoints AS checkpoint
  JOIN messages AS message ON message.message_id = NEW.message_id
  WHERE checkpoint.checkpoint_id = NEW.checkpoint_id
    AND message.session_id = checkpoint.session_id
)
BEGIN
  SELECT RAISE(ABORT, 'context checkpoint source must belong to its session');
END;

CREATE TRIGGER context_checkpoint_sources_session_update
BEFORE UPDATE ON context_checkpoint_sources
WHEN NOT EXISTS (
  SELECT 1
  FROM context_checkpoints AS checkpoint
  JOIN messages AS message ON message.message_id = NEW.message_id
  WHERE checkpoint.checkpoint_id = NEW.checkpoint_id
    AND message.session_id = checkpoint.session_id
)
BEGIN
  SELECT RAISE(ABORT, 'context checkpoint source must belong to its session');
END;

CREATE TRIGGER session_context_state_checkpoint_session_insert
BEFORE INSERT ON session_context_state
WHEN NOT EXISTS (
  SELECT 1 FROM context_checkpoints
  WHERE checkpoint_id = NEW.active_checkpoint_id AND session_id = NEW.session_id
)
BEGIN
  SELECT RAISE(ABORT, 'active context checkpoint must belong to its session');
END;

CREATE TRIGGER session_context_state_checkpoint_session_update
BEFORE UPDATE ON session_context_state
WHEN NOT EXISTS (
  SELECT 1 FROM context_checkpoints
  WHERE checkpoint_id = NEW.active_checkpoint_id AND session_id = NEW.session_id
)
BEGIN
  SELECT RAISE(ABORT, 'active context checkpoint must belong to its session');
END;
