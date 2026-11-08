-- Authored by hand (not generated): the debarment case, the workflow that ends in a restriction on a contractor (VND-1, research V2; docs/vendor-management.md section 5).
-- `contractor_restriction` (BID, V1340) is the legal record the gates read; until now it was written from a decision by hand or from a file of the national network. A restriction now has a case behind it:
--   PROPOSED (the proposal received; the clock of the decision starts) -> NOTICE_SENT (the contractor is told and has a window to answer) -> RESPONSE_RECEIVED (an answer, or none after the window)
--   -> DECIDED (BAN or DISMISS by a person other than the one who proposed, on a decision paper that is in force) -> EFFECTIVE (the restriction rows are written) -> EXPIRED | LIFTED, or DISMISSED.
-- A case against a joint venture reaches every member (or only the culpable ones for the groups the policy excepts); each member gets its own restriction row, and `restriction_case_member` says which row came from which case.
-- Every move is in `restriction_case_event`, append-only. The time limits are the rule `VENDOR_DEBARMENT` counted on the published working calendar, with the policy version kept on the case.
-- `contractor_restriction` gains what the case and an appeal need: the case it came from, and `lifted_at`: a restriction that was lifted does not block even on the day it started (its dates stay as written).

CREATE TABLE machvon.restriction_case (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  case_no text NOT NULL CHECK (case_no ~ '^RC-[0-9]{4}-[0-9]{5}$'),
  subject_kind text NOT NULL CHECK (subject_kind IN ('CONTRACTOR', 'JOINT_VENTURE')),
  contractor_id uuid,
  joint_venture_id uuid,
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('INVESTOR_PROPOSAL', 'INSPECTION_CONCLUSION', 'AUDIT_CONCLUSION', 'PETITION_RESOLUTION', 'EGP_IMPORT', 'OWN_INITIATIVE')),
  trigger_ref text CHECK (trigger_ref IS NULL OR (trigger_ref = btrim(trigger_ref) AND char_length(trigger_ref) BETWEEN 1 AND 200)),
  egp_record_id uuid,
  violation_groups text[] NOT NULL CHECK (cardinality(violation_groups) BETWEEN 1 AND 5),
  violation_summary text NOT NULL CHECK (violation_summary = btrim(violation_summary) AND char_length(violation_summary) BETWEEN 20 AND 2000),
  violation_on date NOT NULL,
  proposed_by uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  received_on date NOT NULL,
  proposal_document_id uuid,
  decide_by timestamptz NOT NULL,
  policy_version text NOT NULL,
  status text NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED', 'NOTICE_SENT', 'RESPONSE_RECEIVED', 'DECIDED', 'EFFECTIVE', 'EXPIRED', 'LIFTED', 'DISMISSED')),
  notified_by uuid,
  notified_at timestamptz,
  notice_document_id uuid,
  response_due_at timestamptz,
  response_outcome text CHECK (response_outcome IS NULL OR response_outcome IN ('RESPONDED', 'NO_RESPONSE')),
  response_document_id uuid,
  response_summary text CHECK (response_summary IS NULL OR (response_summary = btrim(response_summary) AND char_length(response_summary) BETWEEN 5 AND 2000)),
  response_recorded_at timestamptz,
  decision text CHECK (decision IS NULL OR decision IN ('BAN', 'DISMISS')),
  decided_by uuid,
  decided_at timestamptz,
  decision_document_id uuid,
  decision_reason text CHECK (decision_reason IS NULL OR (decision_reason = btrim(decision_reason) AND char_length(decision_reason) BETWEEN 10 AND 2000)),
  decision_scope text CHECK (decision_scope IS NULL OR decision_scope IN ('TENANT', 'PROVINCE', 'NATIONWIDE')),
  ban_months integer CHECK (ban_months IS NULL OR ban_months BETWEEN 1 AND 600),
  effective_from date,
  effective_until date,
  culpable_member_ids uuid[] NOT NULL DEFAULT '{}',
  decided_late boolean,
  effect_by uuid,
  effect_at timestamptz,
  ended_by uuid,
  ended_at timestamptz,
  end_reason text CHECK (end_reason IS NULL OR (end_reason = btrim(end_reason) AND char_length(end_reason) BETWEEN 5 AND 2000)),
  lift_document_id uuid,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_id) REFERENCES machvon.contractor (tenant_id, id),
  FOREIGN KEY (tenant_id, joint_venture_id) REFERENCES machvon.joint_venture (tenant_id, id),
  FOREIGN KEY (tenant_id, proposed_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT restriction_case_no_uq UNIQUE (tenant_id, case_no),
  CONSTRAINT restriction_case_subject_chk CHECK ((subject_kind = 'CONTRACTOR') = (contractor_id IS NOT NULL) AND (subject_kind = 'JOINT_VENTURE') = (joint_venture_id IS NOT NULL)),
  CONSTRAINT restriction_case_notice_chk CHECK ((notified_at IS NULL) = (response_due_at IS NULL) AND (notified_at IS NULL) = (notified_by IS NULL) AND (response_due_at IS NULL OR response_due_at > notified_at)),
  CONSTRAINT restriction_case_response_chk CHECK ((response_outcome IS NULL) = (response_recorded_at IS NULL) AND (response_outcome IS NULL OR notified_at IS NOT NULL)),
  CONSTRAINT restriction_case_decision_chk CHECK (
    (decision IS NULL) = (decided_by IS NULL) AND (decision IS NULL) = (decided_at IS NULL) AND (decision IS NULL) = (decision_reason IS NULL) AND (decision IS NULL) = (decided_late IS NULL)
    AND (decision IS NULL OR response_outcome IS NOT NULL)
    AND (decision IS NULL OR decision = 'DISMISS' OR (effective_from IS NOT NULL AND decision_document_id IS NOT NULL))
    AND ((decision = 'BAN') = (ban_months IS NOT NULL))
    AND ((decision = 'BAN') = (effective_until IS NOT NULL))
    AND ((decision = 'BAN') = (decision_scope IS NOT NULL))
    AND (effective_until IS NULL OR effective_until >= effective_from)
  ),
  -- What takes a contractor out of public procurement is looked at by a second person.
  CONSTRAINT restriction_case_sod_chk CHECK (decided_by IS NULL OR decided_by <> proposed_by),
  CONSTRAINT restriction_case_effect_chk CHECK ((effect_at IS NULL) = (effect_by IS NULL)),
  CONSTRAINT restriction_case_end_chk CHECK ((ended_at IS NULL) = (end_reason IS NULL) AND (ended_at IS NULL) = (ended_by IS NULL))
);
CREATE INDEX restriction_case_contractor_idx ON machvon.restriction_case (tenant_id, contractor_id, status) WHERE contractor_id IS NOT NULL;
CREATE INDEX restriction_case_venture_idx ON machvon.restriction_case (tenant_id, joint_venture_id) WHERE joint_venture_id IS NOT NULL;
CREATE INDEX restriction_case_status_idx ON machvon.restriction_case (tenant_id, status, decide_by);
CREATE INDEX restriction_case_egp_idx ON machvon.restriction_case (tenant_id, egp_record_id) WHERE egp_record_id IS NOT NULL;
CREATE INDEX restriction_case_proposal_doc_idx ON machvon.restriction_case (tenant_id, proposal_document_id) WHERE proposal_document_id IS NOT NULL;
CREATE INDEX restriction_case_notice_doc_idx ON machvon.restriction_case (tenant_id, notice_document_id) WHERE notice_document_id IS NOT NULL;
CREATE INDEX restriction_case_response_doc_idx ON machvon.restriction_case (tenant_id, response_document_id) WHERE response_document_id IS NOT NULL;
CREATE INDEX restriction_case_decision_doc_idx ON machvon.restriction_case (tenant_id, decision_document_id) WHERE decision_document_id IS NOT NULL;
CREATE INDEX restriction_case_lift_doc_idx ON machvon.restriction_case (tenant_id, lift_document_id) WHERE lift_document_id IS NOT NULL;
-- One open case about a contractor and a violation at a time: the same proposal is not opened twice.
CREATE UNIQUE INDEX restriction_case_open_uq ON machvon.restriction_case (tenant_id, contractor_id, violation_on, trigger_kind, COALESCE(trigger_ref, '')) WHERE contractor_id IS NOT NULL AND status IN ('PROPOSED', 'NOTICE_SENT', 'RESPONSE_RECEIVED', 'DECIDED');

CREATE TABLE machvon.restriction_case_member (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL,
  contractor_id uuid NOT NULL,
  restriction_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES machvon.restriction_case (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_id) REFERENCES machvon.contractor (tenant_id, id),
  FOREIGN KEY (tenant_id, restriction_id) REFERENCES machvon.contractor_restriction (tenant_id, id),
  CONSTRAINT restriction_case_member_uq UNIQUE (tenant_id, case_id, contractor_id)
);
CREATE INDEX restriction_case_member_contractor_idx ON machvon.restriction_case_member (tenant_id, contractor_id);
CREATE INDEX restriction_case_member_restriction_idx ON machvon.restriction_case_member (tenant_id, restriction_id) WHERE restriction_id IS NOT NULL;

CREATE TABLE machvon.restriction_case_event (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL,
  move text NOT NULL CHECK (move IN ('PROPOSE', 'SEND_NOTICE', 'RECORD_RESPONSE', 'CLOSE_NO_RESPONSE', 'DECIDE', 'PUT_INTO_EFFECT', 'EXPIRE', 'LIFT', 'WITHDRAW')),
  from_status text,
  to_status text NOT NULL,
  actor_id uuid NOT NULL,
  note text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES machvon.restriction_case (tenant_id, id)
);
CREATE INDEX restriction_case_event_idx ON machvon.restriction_case_event (tenant_id, case_id, occurred_at, id);

CREATE FUNCTION machvon.restriction_case_event_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'the history of a debarment case is append-only' USING ERRCODE = '23514';
END;
$fn$;
CREATE TRIGGER restriction_case_event_append_only BEFORE UPDATE OR DELETE ON machvon.restriction_case_event FOR EACH ROW EXECUTE FUNCTION machvon.restriction_case_event_append_only();

-- The subject, the violation and the proposal never change; a decision is made once and a case that has ended stays ended; the case is never deleted.
CREATE FUNCTION machvon.guard_restriction_case() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a debarment case is never deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW.case_no, NEW.subject_kind, NEW.contractor_id, NEW.joint_venture_id, NEW.trigger_kind, NEW.trigger_ref, NEW.egp_record_id, NEW.violation_groups, NEW.violation_summary, NEW.violation_on, NEW.proposed_by, NEW.received_at, NEW.received_on, NEW.decide_by, NEW.policy_version)
     IS DISTINCT FROM
     (OLD.case_no, OLD.subject_kind, OLD.contractor_id, OLD.joint_venture_id, OLD.trigger_kind, OLD.trigger_ref, OLD.egp_record_id, OLD.violation_groups, OLD.violation_summary, OLD.violation_on, OLD.proposed_by, OLD.received_at, OLD.received_on, OLD.decide_by, OLD.policy_version) THEN
    RAISE EXCEPTION 'a debarment case keeps its subject, its violation and its proposal' USING ERRCODE = '23514';
  END IF;
  IF OLD.decision IS NOT NULL AND (NEW.decision IS DISTINCT FROM OLD.decision OR NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.decided_at IS DISTINCT FROM OLD.decided_at OR NEW.decision_document_id IS DISTINCT FROM OLD.decision_document_id
      OR NEW.ban_months IS DISTINCT FROM OLD.ban_months OR NEW.effective_from IS DISTINCT FROM OLD.effective_from OR NEW.effective_until IS DISTINCT FROM OLD.effective_until) THEN
    RAISE EXCEPTION 'a decision of a debarment case is made once' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('EXPIRED', 'LIFTED', 'DISMISSED') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a debarment case that has ended stays ended' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER restriction_case_guard BEFORE UPDATE OR DELETE ON machvon.restriction_case FOR EACH ROW EXECUTE FUNCTION machvon.guard_restriction_case();

-- The legal record of the register: the case it came from and the lifting of it by an appeal. The guard of V1342 freezes the identity of the row and lets its end move earlier; these columns are free to be set, once.
ALTER TABLE machvon.contractor_restriction
  ADD COLUMN case_id uuid,
  ADD COLUMN lifted_at timestamptz,
  ADD COLUMN lifted_by uuid,
  ADD COLUMN lift_reason text;
ALTER TABLE machvon.contractor_restriction
  ADD CONSTRAINT contractor_restriction_lift_chk CHECK ((lifted_at IS NULL) = (lifted_by IS NULL) AND (lifted_at IS NULL) = (lift_reason IS NULL) AND (lift_reason IS NULL OR (lift_reason = btrim(lift_reason) AND char_length(lift_reason) BETWEEN 5 AND 2000))),
  ADD CONSTRAINT contractor_restriction_case_fk FOREIGN KEY (tenant_id, case_id) REFERENCES machvon.restriction_case (tenant_id, id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX contractor_restriction_case_idx ON machvon.contractor_restriction (tenant_id, case_id) WHERE case_id IS NOT NULL;

CREATE FUNCTION machvon.guard_contractor_restriction_lift() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.lifted_at IS NOT NULL AND (NEW.lifted_at IS DISTINCT FROM OLD.lifted_at OR NEW.lifted_by IS DISTINCT FROM OLD.lifted_by OR NEW.lift_reason IS DISTINCT FROM OLD.lift_reason) THEN
    RAISE EXCEPTION 'the lifting of a restriction stays as it was made' USING ERRCODE = '23514';
  END IF;
  IF NEW.case_id IS DISTINCT FROM OLD.case_id AND OLD.case_id IS NOT NULL THEN
    RAISE EXCEPTION 'a restriction keeps the case it came from' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER contractor_restriction_lift_guard BEFORE UPDATE ON machvon.contractor_restriction FOR EACH ROW EXECUTE FUNCTION machvon.guard_contractor_restriction_lift();

ALTER TABLE machvon.restriction_case ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.restriction_case FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.restriction_case AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.restriction_case AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.restriction_case_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.restriction_case_member FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.restriction_case_member AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.restriction_case_member AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.restriction_case_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.restriction_case_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.restriction_case_event AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.restriction_case_event AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.restriction_case FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.restriction_case_member FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.restriction_case_event FROM machvon_app;

COMMENT ON TABLE machvon.restriction_case IS 'VND-1: the workflow of a debarment: proposal, notice, response, decision within the time limit, effect, end; confidential until it is in effect.';
COMMENT ON TABLE machvon.restriction_case_member IS 'VND-1: the contractors a case reaches and the restriction row each received.';
COMMENT ON TABLE machvon.restriction_case_event IS 'VND-1: the append-only history of the moves of a debarment case.';
