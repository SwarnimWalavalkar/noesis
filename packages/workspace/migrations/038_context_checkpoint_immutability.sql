DROP TRIGGER IF EXISTS context_checkpoints_session_immutable;

CREATE TRIGGER context_checkpoints_immutable_update
BEFORE UPDATE ON context_checkpoints
BEGIN
  SELECT RAISE(ABORT, 'context checkpoint is immutable');
END;

CREATE TRIGGER context_checkpoints_immutable_delete
BEFORE DELETE ON context_checkpoints
BEGIN
  SELECT RAISE(ABORT, 'context checkpoint is immutable');
END;

CREATE TRIGGER context_checkpoint_sources_immutable_update
BEFORE UPDATE ON context_checkpoint_sources
BEGIN
  SELECT RAISE(ABORT, 'context checkpoint source is immutable');
END;

CREATE TRIGGER context_checkpoint_sources_immutable_delete
BEFORE DELETE ON context_checkpoint_sources
BEGIN
  SELECT RAISE(ABORT, 'context checkpoint source is immutable');
END;
