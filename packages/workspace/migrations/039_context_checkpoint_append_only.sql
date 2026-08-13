CREATE TRIGGER context_checkpoints_identity_insert
BEFORE INSERT ON context_checkpoints
WHEN EXISTS (
  SELECT 1 FROM context_checkpoints WHERE checkpoint_id = NEW.checkpoint_id
)
BEGIN
  SELECT RAISE(ABORT, 'context checkpoint identity already exists');
END;

CREATE TRIGGER context_checkpoint_sources_activated_insert
BEFORE INSERT ON context_checkpoint_sources
WHEN EXISTS (
  SELECT 1 FROM session_context_state WHERE active_checkpoint_id = NEW.checkpoint_id
)
BEGIN
  SELECT RAISE(ABORT, 'active context checkpoint sources are immutable');
END;
