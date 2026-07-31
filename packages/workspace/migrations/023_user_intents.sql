CREATE TABLE user_intents (
  intent_id TEXT PRIMARY KEY CHECK (length(intent_id) > 0),
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE RESTRICT,
  text TEXT,
  content_digest TEXT NOT NULL CHECK (
    length(content_digest) = 64
    AND content_digest NOT GLOB '*[^0-9a-f]*'
  ),
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('turn', 'steer')),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'held', 'dispatching', 'unresolved', 'delivered', 'withdrawn')
  ),
  queue_sequence INTEGER NOT NULL CHECK (queue_sequence > 0),
  queued_behind_turn_id TEXT,
  target_turn_id TEXT,
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
  held_at TEXT,
  promoted_at TEXT,
  delivered_at TEXT,
  unresolved_at TEXT,
  withdrawn_at TEXT,
  steer_origin TEXT CHECK (steer_origin IS NULL OR steer_origin IN ('explicit', 'queued')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  CHECK (
    (status = 'pending'
      AND text IS NOT NULL AND length(trim(text)) > 0
      AND delivery_mode = 'turn'
      AND target_turn_id IS NULL
      AND held_at IS NULL AND delivered_at IS NULL AND unresolved_at IS NULL AND withdrawn_at IS NULL) OR
    (status = 'held'
      AND text IS NOT NULL AND length(trim(text)) > 0
      AND delivery_mode = 'steer'
      AND target_turn_id IS NOT NULL
      AND held_at IS NOT NULL AND promoted_at IS NULL
      AND delivered_at IS NULL AND unresolved_at IS NULL AND withdrawn_at IS NULL
      AND steer_origin IS NOT NULL) OR
    (status = 'dispatching'
      AND text IS NOT NULL AND length(trim(text)) > 0
      AND target_turn_id IS NOT NULL
      AND delivered_at IS NULL AND unresolved_at IS NULL AND withdrawn_at IS NULL) OR
    (status = 'unresolved'
      AND text IS NOT NULL AND length(trim(text)) > 0
      AND target_turn_id IS NOT NULL
      AND delivered_at IS NULL AND unresolved_at IS NOT NULL AND withdrawn_at IS NULL) OR
    (status = 'delivered'
      AND text IS NULL
      AND target_turn_id IS NOT NULL
      AND delivered_at IS NOT NULL AND unresolved_at IS NULL AND withdrawn_at IS NULL) OR
    (status = 'withdrawn'
      AND text IS NOT NULL AND length(trim(text)) > 0
      AND delivery_mode = 'turn'
      AND target_turn_id IS NULL
      AND delivered_at IS NULL AND unresolved_at IS NULL AND withdrawn_at IS NOT NULL)
  ),
  CHECK (
    (delivery_mode = 'turn' AND promoted_at IS NULL AND steer_origin IS NULL) OR
    (delivery_mode = 'steer' AND steer_origin IS NOT NULL
      AND (
        (status = 'held' AND promoted_at IS NULL) OR
        (status = 'unresolved' AND held_at IS NOT NULL AND promoted_at IS NULL) OR
        (status NOT IN ('held', 'unresolved') AND promoted_at IS NOT NULL) OR
        (status = 'unresolved' AND promoted_at IS NOT NULL)
      ))
  ),
  UNIQUE(session_id, queue_sequence)
) STRICT;

CREATE INDEX user_intents_pending_fifo
  ON user_intents(session_id, status, delivery_mode, queue_sequence);

CREATE INDEX user_intents_target
  ON user_intents(session_id, target_turn_id, intent_id);

CREATE TABLE turn_timeline_entries (
  turn_id TEXT NOT NULL REFERENCES foreground_turns(turn_id) ON DELETE RESTRICT,
  timeline_sequence INTEGER NOT NULL CHECK (timeline_sequence >= 0),
  entry_kind TEXT NOT NULL CHECK (entry_kind IN ('message', 'tool_call')),
  entry_id TEXT NOT NULL CHECK (length(entry_id) > 0),
  PRIMARY KEY(turn_id, timeline_sequence),
  UNIQUE(entry_kind, entry_id)
) STRICT;

CREATE TRIGGER user_intent_identity_immutable
BEFORE UPDATE OF
  intent_id,
  session_id,
  content_digest,
  queue_sequence,
  queued_behind_turn_id,
  created_at
ON user_intents
WHEN OLD.intent_id IS NOT NEW.intent_id
  OR OLD.session_id IS NOT NEW.session_id
  OR OLD.content_digest IS NOT NEW.content_digest
  OR OLD.queue_sequence IS NOT NEW.queue_sequence
  OR OLD.queued_behind_turn_id IS NOT NEW.queued_behind_turn_id
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'User intent identity and provenance are immutable');
END;

CREATE TRIGGER user_intent_text_delivery_only
BEFORE UPDATE OF text ON user_intents
WHEN NOT (
  OLD.text IS NEW.text OR
  (OLD.text IS NOT NULL
    AND NEW.text IS NULL
    AND OLD.status IN ('dispatching', 'unresolved')
    AND NEW.status = 'delivered')
)
BEGIN
  SELECT RAISE(ABORT, 'User intent text may only be cleared by delivery');
END;
