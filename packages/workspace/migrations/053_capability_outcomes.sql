-- How a Capability did when a turn used it, as judged by reflection on that exchange.
-- Rows exist only for turns that used the Capability; silent turns get no row.
CREATE TABLE capability_outcomes (
  outcome_id TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL REFERENCES capabilities(capability_id),
  capability_revision_id TEXT NOT NULL REFERENCES capability_revisions(capability_revision_id),
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  result TEXT NOT NULL CHECK(result IN ('helped', 'hurt', 'unclear')),
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (capability_revision_id, turn_id)
) STRICT;

CREATE INDEX capability_outcomes_revision_idx
  ON capability_outcomes(capability_revision_id, created_at DESC, outcome_id DESC);

CREATE INDEX capability_outcomes_capability_idx
  ON capability_outcomes(capability_id, created_at DESC, outcome_id DESC);
