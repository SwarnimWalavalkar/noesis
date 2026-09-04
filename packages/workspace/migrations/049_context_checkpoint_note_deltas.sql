ALTER TABLE context_checkpoints
ADD COLUMN summary_kind TEXT NOT NULL DEFAULT 'legacy_snapshot'
CHECK (summary_kind IN ('legacy_snapshot', 'note_delta'));
