CREATE TABLE mcp_connection_cycles (
  connection_identity TEXT PRIMARY KEY,
  cycle INTEGER NOT NULL CHECK (cycle > 0),
  operation_id TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL
) STRICT;
