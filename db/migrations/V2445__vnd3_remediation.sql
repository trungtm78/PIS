-- Authored by hand (not generated): the plan of remediation of a contractor (VND-3, research V17; docs/vendor-investigation.md section 7).
-- After a poor evaluation, a non-conformance or a clarification, staff propose a plan: actions with a due day each. The contractor agrees to it on the portal (its commitment is its own), does the actions and marks them done
-- with a note and a paper; staff verify each action (never the person who marked it done: it is the contractor, so this holds by who they are, and the database holds that the verifier is not the person who marked it).
-- The plan is completed only when every action is verified; it fails or is cancelled with a reason. Every move is in contractor_remediation_event, append-only. Nothing is deleted.

CREATE TABLE machvon.contractor_remediation_plan (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  contractor_id uuid NOT NULL,
  contract_id uuid,
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('POOR_EVALUATION', 'NON_CONFORMANCE', 'SCREENING', 'DISPUTE', 'MANUAL')),
  trigger_ref uuid,
  title text NOT NULL CHECK (title = btrim(title) AND char_length(title) BETWEEN 3 AND 200),
  objective text NOT NULL CHECK (char_length(objective) BETWEEN 10 AND 2000),
  status text NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED', 'AGREED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED')),
  proposed_by uuid NOT NULL,
  proposed_at timestamptz NOT NULL DEFAULT now(),
  agreed_by uuid,
  agreed_at timestamptz,
  started_at timestamptz,
  closed_at timestamptz,
  closed_reason text CHECK (closed_reason IS NULL OR (closed_reason = btrim(closed_reason) AND char_length(closed_reason) BETWEEN 5 AND 2000)),
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_id) REFERENCES machvon.contractor (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES machvon.contract (tenant_id, id),
  FOREIGN KEY (tenant_id, proposed_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, agreed_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT remediation_plan_agree_chk CHECK ((agreed_at IS NULL) = (agreed_by IS NULL) AND (status NOT IN ('AGREED', 'IN_PROGRESS', 'COMPLETED') OR agreed_at IS NOT NULL)),
  CONSTRAINT remediation_plan_close_chk CHECK ((status IN ('COMPLETED', 'FAILED', 'CANCELLED')) = (closed_at IS NOT NULL) AND (status NOT IN ('FAILED', 'CANCELLED') OR closed_reason IS NOT NULL))
);
CREATE INDEX remediation_plan_contractor_idx ON machvon.contractor_remediation_plan (tenant_id, contractor_id, status);
CREATE INDEX remediation_plan_contract_idx ON machvon.contractor_remediation_plan (tenant_id, contract_id) WHERE contract_id IS NOT NULL;
CREATE INDEX remediation_plan_proposer_idx ON machvon.contractor_remediation_plan (tenant_id, proposed_by);
CREATE INDEX remediation_plan_agreer_idx ON machvon.contractor_remediation_plan (tenant_id, agreed_by) WHERE agreed_by IS NOT NULL;
CREATE INDEX remediation_plan_trigger_idx ON machvon.contractor_remediation_plan (tenant_id, trigger_ref) WHERE trigger_ref IS NOT NULL;

ALTER TABLE machvon.contractor_remediation_plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.contractor_remediation_plan FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.contractor_remediation_plan AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.contractor_remediation_plan AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE machvon.contractor_remediation_plan FROM machvon_app;

COMMENT ON TABLE machvon.contractor_remediation_plan IS 'VND-3: a plan of remediation of a contractor: proposed by staff, agreed by the contractor, completed only when every action is verified.';

CREATE TABLE machvon.contractor_remediation_action (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL,
  contractor_id uuid NOT NULL,
  seq smallint NOT NULL CHECK (seq BETWEEN 1 AND 50),
  description text NOT NULL CHECK (description = btrim(description) AND char_length(description) BETWEEN 5 AND 1000),
  due_on date NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'DONE', 'VERIFIED')),
  done_by uuid,
  done_at timestamptz,
  done_note text CHECK (done_note IS NULL OR (done_note = btrim(done_note) AND char_length(done_note) BETWEEN 1 AND 2000)),
  evidence_document_id uuid,
  verified_by uuid,
  verified_at timestamptz,
  verify_note text CHECK (verify_note IS NULL OR (verify_note = btrim(verify_note) AND char_length(verify_note) BETWEEN 1 AND 2000)),
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, plan_id) REFERENCES machvon.contractor_remediation_plan (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_id) REFERENCES machvon.contractor (tenant_id, id),
  FOREIGN KEY (tenant_id, done_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, verified_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT remediation_action_seq_uq UNIQUE (tenant_id, plan_id, seq),
  CONSTRAINT remediation_action_done_chk CHECK ((done_at IS NULL) = (done_by IS NULL) AND (status IN ('DONE', 'VERIFIED')) = (done_at IS NOT NULL)),
  CONSTRAINT remediation_action_verify_chk CHECK ((status = 'VERIFIED') = (verified_at IS NOT NULL) AND (verified_at IS NULL) = (verified_by IS NULL)),
  CONSTRAINT remediation_action_sod_chk CHECK (verified_by IS NULL OR done_by IS NULL OR verified_by <> done_by)
);
CREATE INDEX remediation_action_contractor_idx ON machvon.contractor_remediation_action (tenant_id, contractor_id, status, due_on);
CREATE INDEX remediation_action_open_idx ON machvon.contractor_remediation_action (tenant_id, due_on) WHERE status <> 'VERIFIED';
CREATE INDEX remediation_action_doer_idx ON machvon.contractor_remediation_action (tenant_id, done_by) WHERE done_by IS NOT NULL;
CREATE INDEX remediation_action_verifier_idx ON machvon.contractor_remediation_action (tenant_id, verified_by) WHERE verified_by IS NOT NULL;
CREATE INDEX remediation_action_document_idx ON machvon.contractor_remediation_action (tenant_id, evidence_document_id) WHERE evidence_document_id IS NOT NULL;

ALTER TABLE machvon.contractor_remediation_action ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.contractor_remediation_action FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.contractor_remediation_action AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.contractor_remediation_action AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE machvon.contractor_remediation_action FROM machvon_app;

COMMENT ON TABLE machvon.contractor_remediation_action IS 'VND-3: an action of a plan of remediation with its due day; marked done by the contractor, verified by staff.';

CREATE TABLE machvon.contractor_remediation_event (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL,
  contractor_id uuid NOT NULL,
  action_id uuid,
  move text NOT NULL CHECK (move IN ('PROPOSE', 'ADD_ACTION', 'AGREE', 'START', 'MARK_DONE', 'VERIFY', 'REOPEN_ACTION', 'COMPLETE', 'FAIL', 'CANCEL')),
  from_status text,
  to_status text NOT NULL,
  actor_id uuid NOT NULL,
  note text CHECK (note IS NULL OR char_length(note) <= 2000),
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, plan_id) REFERENCES machvon.contractor_remediation_plan (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_id) REFERENCES machvon.contractor (tenant_id, id),
  FOREIGN KEY (tenant_id, action_id) REFERENCES machvon.contractor_remediation_action (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES machvon.membership (tenant_id, id)
);
CREATE INDEX remediation_event_plan_idx ON machvon.contractor_remediation_event (tenant_id, plan_id, at);
CREATE INDEX remediation_event_contractor_idx ON machvon.contractor_remediation_event (tenant_id, contractor_id);
CREATE INDEX remediation_event_action_idx ON machvon.contractor_remediation_event (tenant_id, action_id) WHERE action_id IS NOT NULL;
CREATE INDEX remediation_event_actor_idx ON machvon.contractor_remediation_event (tenant_id, actor_id, at DESC);

ALTER TABLE machvon.contractor_remediation_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.contractor_remediation_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.contractor_remediation_event AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.contractor_remediation_event AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.contractor_remediation_event FROM machvon_app;
CREATE TRIGGER contractor_remediation_event_append_only BEFORE UPDATE OR DELETE ON machvon.contractor_remediation_event FOR EACH ROW EXECUTE FUNCTION machvon.vnd3_append_only();

COMMENT ON TABLE machvon.contractor_remediation_event IS 'VND-3: the append-only history of a plan of remediation.';
