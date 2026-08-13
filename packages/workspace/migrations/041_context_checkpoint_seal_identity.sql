CREATE TRIGGER context_checkpoint_seals_identity_insert
BEFORE INSERT ON context_checkpoint_seals
WHEN EXISTS (
  SELECT 1 FROM context_checkpoint_seals WHERE checkpoint_id = NEW.checkpoint_id
)
BEGIN
  SELECT RAISE(ABORT, 'context checkpoint seal identity already exists');
END;
