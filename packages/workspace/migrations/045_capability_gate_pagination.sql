CREATE INDEX capability_gate_requests_capability_page_idx
  ON capability_gate_requests(capability_id, created_at DESC, gate_request_id DESC);
