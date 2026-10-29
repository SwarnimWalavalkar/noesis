-- Conversations brought in by the removed JSONL importer kept their turns under legacyEventId,
-- with no foreground turn rows. Rewrite those messages into the self-describing history shape a
-- forked session uses, so resumed sessions keep replaying them without a legacy reader. The
-- importer marked a completed exchange with an outcome whose status is unknown, and gave both of
-- its messages the same timestamp, so the question is ordered before its answer explicitly.

WITH imported AS (
  SELECT
    message.message_id,
    message.session_id,
    json_extract(message.metadata_json, '$.legacyEventId') AS event_id,
    ROW_NUMBER() OVER (
      PARTITION BY message.session_id
      ORDER BY message.created_at, CASE message.role WHEN 'user' THEN 0 ELSE 1 END, message.message_id
    ) - 1 AS sequence
  FROM messages AS message
  WHERE message.role IN ('user', 'assistant')
    AND json_type(message.metadata_json, '$.legacyEventId') = 'text'
    AND json_type(message.metadata_json, '$.turnId') IS NULL
    AND EXISTS (
      SELECT 1 FROM outcomes AS outcome
      WHERE outcome.session_id = message.session_id
        AND outcome.status = 'unknown'
        AND json_extract(outcome.metadata_json, '$.legacyEventId')
          = json_extract(message.metadata_json, '$.legacyEventId')
    )
)
UPDATE messages
SET metadata_json = json_set(
  json_remove(messages.metadata_json, '$.legacyEventId'),
  '$.replayEligible', json('true'),
  '$.historyKind', 'turn',
  '$.historyTurnKey', imported.session_id || ':' || imported.event_id,
  '$.historySequence', imported.sequence,
  '$.inheritedFromSessionId', imported.session_id,
  '$.inheritedFromMessageId', imported.message_id
)
FROM imported
WHERE messages.message_id = imported.message_id;
