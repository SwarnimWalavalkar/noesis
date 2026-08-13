CREATE TABLE context_checkpoint_seals (
  checkpoint_id TEXT PRIMARY KEY REFERENCES context_checkpoints(checkpoint_id) ON DELETE RESTRICT,
  sealed_at TEXT NOT NULL
) STRICT;

INSERT INTO context_checkpoint_seals(checkpoint_id, sealed_at)
SELECT checkpoint_id, created_at FROM context_checkpoints;

DROP TRIGGER context_checkpoint_sources_activated_insert;

CREATE TRIGGER context_checkpoint_sources_sealed_insert
BEFORE INSERT ON context_checkpoint_sources
WHEN EXISTS (
  SELECT 1 FROM context_checkpoint_seals WHERE checkpoint_id = NEW.checkpoint_id
)
BEGIN
  SELECT RAISE(ABORT, 'sealed context checkpoint sources are immutable');
END;

CREATE TRIGGER context_checkpoint_seals_immutable_update
BEFORE UPDATE ON context_checkpoint_seals
BEGIN
  SELECT RAISE(ABORT, 'context checkpoint seal is immutable');
END;

CREATE TRIGGER context_checkpoint_seals_immutable_delete
BEFORE DELETE ON context_checkpoint_seals
BEGIN
  SELECT RAISE(ABORT, 'context checkpoint seal is immutable');
END;
