-- Authored by hand (not generated): the trace of the submission of a proposal (VND-3, research V6; docs/vendor-investigation.md section 3).
-- The screening of bid rigging compares where and with what the proposals of a package were handed in: the address and the device of the submission, and the fingerprint of each file (author, producing program, creation stamp).
-- Nothing of that was recorded before. The officer who receives a proposal may record it once; every value is a SHA-256 key made by the application (never the address, the user agent or the author), so two proposals of one
-- origin are found by equality and no personal value is stored. A trace is append-only: a wrong trace is not rewritten, and the screening reads what was recorded (a proposal without a trace is counted as "not recorded").

-- One guard for every append-only table of this lane.
CREATE FUNCTION machvon.vnd3_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'a record of the investigation lane is appended once and never changed or deleted' USING ERRCODE = '23514';
END;
$fn$;

CREATE TABLE machvon.proposal_submission_trace (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL,
  package_id uuid NOT NULL,
  contractor_id uuid NOT NULL,
  origin_key char(64) CHECK (origin_key ~ '^[0-9a-f]{64}$'),
  device_key char(64) CHECK (device_key ~ '^[0-9a-f]{64}$'),
  agent_key char(64) CHECK (agent_key ~ '^[0-9a-f]{64}$'),
  submitted_at timestamptz,
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, proposal_id) REFERENCES machvon.proposal (tenant_id, id),
  FOREIGN KEY (tenant_id, package_id) REFERENCES machvon.procurement_package (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_id) REFERENCES machvon.contractor (tenant_id, id),
  FOREIGN KEY (tenant_id, recorded_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT submission_trace_one_per_proposal UNIQUE (tenant_id, proposal_id)
);
CREATE INDEX submission_trace_package_idx ON machvon.proposal_submission_trace (tenant_id, package_id);
CREATE INDEX submission_trace_contractor_idx ON machvon.proposal_submission_trace (tenant_id, contractor_id);
CREATE INDEX submission_trace_recorder_idx ON machvon.proposal_submission_trace (tenant_id, recorded_by);
CREATE INDEX submission_trace_origin_idx ON machvon.proposal_submission_trace (tenant_id, origin_key) WHERE origin_key IS NOT NULL;
CREATE INDEX submission_trace_device_idx ON machvon.proposal_submission_trace (tenant_id, device_key) WHERE device_key IS NOT NULL;

ALTER TABLE machvon.proposal_submission_trace ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.proposal_submission_trace FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.proposal_submission_trace AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.proposal_submission_trace AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.proposal_submission_trace FROM machvon_app;
CREATE TRIGGER proposal_submission_trace_append_only BEFORE UPDATE OR DELETE ON machvon.proposal_submission_trace FOR EACH ROW EXECUTE FUNCTION machvon.vnd3_append_only();

COMMENT ON TABLE machvon.proposal_submission_trace IS 'VND-3: where a proposal was handed in (keys of the address, the device and the agent), recorded once by the receiving officer; read only by the screening for the auditors.';

CREATE TABLE machvon.proposal_submission_file (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  trace_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  file_key char(64) NOT NULL CHECK (file_key ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, trace_id) REFERENCES machvon.proposal_submission_trace (tenant_id, id),
  CONSTRAINT submission_file_unique UNIQUE (tenant_id, trace_id, document_version_id)
);
CREATE INDEX submission_file_document_idx ON machvon.proposal_submission_file (tenant_id, document_version_id);
CREATE INDEX submission_file_key_idx ON machvon.proposal_submission_file (tenant_id, file_key);

ALTER TABLE machvon.proposal_submission_file ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.proposal_submission_file FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.proposal_submission_file AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.proposal_submission_file AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.proposal_submission_file FROM machvon_app;
CREATE TRIGGER proposal_submission_file_append_only BEFORE UPDATE OR DELETE ON machvon.proposal_submission_file FOR EACH ROW EXECUTE FUNCTION machvon.vnd3_append_only();

COMMENT ON TABLE machvon.proposal_submission_file IS 'VND-3: the fingerprint key of each file of a recorded submission (author, producing program, creation stamp folded into one key).';
