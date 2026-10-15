ALTER TABLE agent_messages
ADD COLUMN kind TEXT NOT NULL DEFAULT 'message'
CHECK (kind IN ('message', 'completion'));
