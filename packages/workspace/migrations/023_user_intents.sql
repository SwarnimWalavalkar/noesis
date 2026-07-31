CREATE TABLE user_intents (
  intent_id TEXT PRIMARY KEY CHECK (length(intent_id) > 0),
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE RESTRICT,
  text TEXT NOT NULL CHECK (length(trim(text)) > 0),
  initial_mode TEXT NOT NULL CHECK (initial_mode IN ('turn', 'steer')),
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('turn', 'steer')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'dispatching', 'delivered', 'withdrawn')),
  queue_sequence INTEGER NOT NULL CHECK (queue_sequence > 0),
  queued_behind_turn_id TEXT,
  target_turn_id TEXT,
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
  promoted_at TEXT,
  delivered_at TEXT,
  withdrawn_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  CHECK (
    (status = 'pending' AND target_turn_id IS NULL AND delivered_at IS NULL AND withdrawn_at IS NULL) OR
    (
      status = 'dispatching'
      AND target_turn_id IS NOT NULL
      AND delivered_at IS NULL
      AND withdrawn_at IS NULL
    ) OR
    (
      status = 'delivered'
      AND target_turn_id IS NOT NULL
      AND delivered_at IS NOT NULL
      AND withdrawn_at IS NULL
    ) OR
    (
      status = 'withdrawn'
      AND target_turn_id IS NULL
      AND delivered_at IS NULL
      AND withdrawn_at IS NOT NULL
    )
  ),
  UNIQUE(session_id, queue_sequence)
) STRICT;

CREATE INDEX user_intents_pending_fifo
  ON user_intents(session_id, status, delivery_mode, queue_sequence);

CREATE INDEX user_intents_target
  ON user_intents(session_id, target_turn_id, intent_id);

CREATE TRIGGER user_intent_identity_immutable
BEFORE UPDATE OF
  intent_id,
  session_id,
  text,
  initial_mode,
  queue_sequence,
  queued_behind_turn_id,
  created_at
ON user_intents
WHEN OLD.intent_id IS NOT NEW.intent_id
  OR OLD.session_id IS NOT NEW.session_id
  OR OLD.text IS NOT NEW.text
  OR OLD.initial_mode IS NOT NEW.initial_mode
  OR OLD.queue_sequence IS NOT NEW.queue_sequence
  OR OLD.queued_behind_turn_id IS NOT NEW.queued_behind_turn_id
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'User intent identity and provenance are immutable');
END;
