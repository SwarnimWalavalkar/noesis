CREATE TABLE working_adjustments (
  adjustment_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  project_root TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_from_turn_id TEXT NOT NULL
    REFERENCES foreground_turns(turn_id)
    ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, adjustment_id)
) STRICT;

CREATE INDEX working_adjustments_project_created
  ON working_adjustments(project_id, created_at, adjustment_id);

CREATE TABLE active_project_adjustments (
  project_id TEXT PRIMARY KEY,
  adjustment_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id, adjustment_id)
    REFERENCES working_adjustments(project_id, adjustment_id)
    ON DELETE RESTRICT
) STRICT;
