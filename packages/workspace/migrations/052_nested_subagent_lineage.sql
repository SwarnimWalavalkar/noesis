DROP TRIGGER sub_agent_lineage_insert;

CREATE TRIGGER sub_agent_lineage_insert
BEFORE INSERT ON sub_agents
WHEN NOT EXISTS (
  SELECT 1
  FROM sessions AS child, codemode_executions AS execution
  WHERE child.session_id = NEW.child_session_id
    AND json_extract(child.metadata_json, '$.kind') = 'subagent'
    AND execution.execution_id = NEW.origin_execution_id
    AND execution.session_id = NEW.origin_session_id
    AND (
      (
        NEW.parent_agent_id IS NULL
        AND execution.turn_id = NEW.origin_turn_id
        AND EXISTS (
          SELECT 1
          FROM foreground_turns AS turn
          WHERE turn.turn_id = NEW.origin_turn_id
            AND turn.session_id = NEW.origin_session_id
        )
      )
      OR (
        NEW.parent_agent_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM sub_agents AS parent
          WHERE parent.agent_id = NEW.parent_agent_id
            AND parent.project_id = NEW.project_id
            AND parent.child_session_id = NEW.origin_session_id
            AND parent.origin_turn_id = NEW.origin_turn_id
            AND parent.status != 'closed'
        )
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'Subagent origin or child-session lineage is invalid');
END;
