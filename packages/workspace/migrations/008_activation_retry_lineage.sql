ALTER TABLE activation_operations ADD COLUMN superseded_by_operation_id TEXT;

CREATE INDEX activation_operations_superseded
  ON activation_operations(superseded_by_operation_id, updated_at, operation_id);
