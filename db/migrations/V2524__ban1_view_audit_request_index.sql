-- The view audit of a committee carries the request id of the call that showed the screen. The rule of the catalogue is that every *_id column leads an index after tenant_id; this serves the trace
-- from a request to what it showed.
CREATE INDEX committee_view_audit_request_idx ON machvon.committee_view_audit (tenant_id, request_id) WHERE request_id IS NOT NULL;
