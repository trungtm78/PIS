-- Authored by hand (not generated): the duties of posting to the national procurement network (EGP-2, BID-25, docs/egp-connector.md sections 7 and 12).
-- Điều 19-20 NĐ 214/2025 oblige the investor to post the plan, the notice, the result, the contract, the evaluation of the contractor, its violations and its reputation events, each by a deadline. The platform never
-- posts: a person posts on the network by hand and writes down what the network answered. Three tables keep that:
--   * `egp_posting_obligation`: one duty, with the clock the work-clock engine reads (the deadline is fixed when it opens, from the rule EGP_POSTING_DEADLINES, with the version of the rule and whether its numbers are
--     unverified), its state, the people who prepared and who submitted (never the same person: a CHECK), the packet that was prepared (the fields and their SHA-256) and, for the contractor evaluation and violations,
--     the batch of the contractor export of CTR-24 whose file is that packet;
--   * `egp_posting_receipt`: the reference the network gave, one for each obligation, never changed, never deleted; the reference is unique in the tenant (a number typed twice is a slip);
--   * `egp_posting_event`: what was done to an obligation and by whom, append-only.
-- The facts that open an obligation are read from the register and the key (kind, source of the fact, the instant it happened) makes opening idempotent.

CREATE TABLE machvon.egp_posting_obligation (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  subject_code text NOT NULL,
  source_ref uuid NOT NULL,
  trigger_event text NOT NULL,
  triggered_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  rule_code text NOT NULL,
  rule_version integer NOT NULL,
  rule_source text NOT NULL,
  remind_before_days integer NOT NULL,
  legal_status text NOT NULL,
  state text NOT NULL DEFAULT 'DUE',
  owner_id uuid NOT NULL,
  prepared_by uuid,
  prepared_at timestamptz,
  packet jsonb,
  packet_sha256 char(64),
  export_batch_id uuid,
  submitted_by uuid,
  submitted_at timestamptz,
  rejected_at timestamptz,
  rejection_reason text,
  cancelled_by uuid,
  cancelled_at timestamptz,
  cancel_reason text,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, export_batch_id) REFERENCES machvon.contractor_export_batch (tenant_id, id),
  CONSTRAINT egp_posting_kind_chk CHECK (kind IN ('PLAN', 'NOTICE', 'RESULT', 'CONTRACT_INFO', 'CONTRACTOR_PERFORMANCE', 'VIOLATION', 'REPUTATION_EVENT', 'CONTRACTOR_RESPONSE')),
  CONSTRAINT egp_posting_subject_chk CHECK (subject_type IN ('PLAN', 'NOTICE', 'RESULT', 'CONTRACT', 'CONTRACTOR')),
  CONSTRAINT egp_posting_subject_code_chk CHECK (subject_code = btrim(subject_code) AND subject_code <> '' AND char_length(subject_code) <= 100),
  CONSTRAINT egp_posting_trigger_chk CHECK (trigger_event IN ('DECISION_APPROVED', 'RESULT_ISSUED', 'CONTRACT_SIGNED', 'CONTRACT_COMPLETED', 'EVENT_OCCURRED', 'CONTRACTOR_NOTIFIED')),
  CONSTRAINT egp_posting_due_chk CHECK (due_at >= triggered_at),
  CONSTRAINT egp_posting_rule_chk CHECK (rule_code = kind AND rule_version >= 0 AND rule_source IN ('RULE', 'DEFAULT') AND remind_before_days BETWEEN 0 AND 365),
  CONSTRAINT egp_posting_legal_chk CHECK (legal_status IN ('UNVERIFIED', 'VERIFIED')),
  CONSTRAINT egp_posting_state_chk CHECK (state IN ('DUE', 'PREPARED', 'SUBMITTED', 'RECEIPTED', 'REJECTED', 'CANCELLED')),
  CONSTRAINT egp_posting_packet_chk CHECK ((packet IS NULL) = (packet_sha256 IS NULL) AND (packet IS NULL OR jsonb_typeof(packet) = 'object') AND (packet_sha256 IS NULL OR packet_sha256 ~ '^[0-9a-f]{64}$')),
  CONSTRAINT egp_posting_prepared_chk CHECK ((prepared_by IS NULL) = (prepared_at IS NULL) AND (state NOT IN ('PREPARED', 'SUBMITTED', 'RECEIPTED') OR (prepared_by IS NOT NULL AND packet IS NOT NULL))),
  CONSTRAINT egp_posting_submitted_chk CHECK ((submitted_by IS NULL) = (submitted_at IS NULL) AND (state NOT IN ('SUBMITTED', 'RECEIPTED') OR submitted_by IS NOT NULL)),
  CONSTRAINT egp_posting_maker_checker_chk CHECK (submitted_by IS NULL OR prepared_by IS NULL OR submitted_by <> prepared_by),
  CONSTRAINT egp_posting_rejected_chk CHECK ((rejection_reason IS NULL) = (rejected_at IS NULL) AND (state <> 'REJECTED' OR rejection_reason IS NOT NULL)),
  CONSTRAINT egp_posting_cancelled_chk CHECK ((state = 'CANCELLED') = (cancel_reason IS NOT NULL AND cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL) AND (cancel_reason IS NULL OR char_length(btrim(cancel_reason)) >= 20)),
  CONSTRAINT egp_posting_export_chk CHECK (export_batch_id IS NULL OR kind IN ('CONTRACTOR_PERFORMANCE', 'VIOLATION')),
  CONSTRAINT egp_posting_version_chk CHECK (version >= 1),
  CONSTRAINT egp_posting_fact_uq UNIQUE (tenant_id, kind, source_ref, triggered_at)
);
CREATE INDEX egp_posting_state_idx ON machvon.egp_posting_obligation (tenant_id, state, due_at, id);
CREATE INDEX egp_posting_subject_idx ON machvon.egp_posting_obligation (tenant_id, subject_id, kind);
CREATE INDEX egp_posting_owner_idx ON machvon.egp_posting_obligation (tenant_id, owner_id, state, due_at);
CREATE INDEX egp_posting_export_idx ON machvon.egp_posting_obligation (tenant_id, export_batch_id) WHERE export_batch_id IS NOT NULL;

CREATE TABLE machvon.egp_posting_receipt (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  obligation_id uuid NOT NULL,
  receipt_ref text NOT NULL,
  receipted_at timestamptz NOT NULL,
  recorded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, obligation_id) REFERENCES machvon.egp_posting_obligation (tenant_id, id),
  CONSTRAINT egp_posting_receipt_ref_chk CHECK (receipt_ref = btrim(receipt_ref) AND receipt_ref <> '' AND char_length(receipt_ref) <= 100),
  CONSTRAINT egp_posting_receipt_obligation_uq UNIQUE (tenant_id, obligation_id),
  CONSTRAINT egp_posting_receipt_ref_uq UNIQUE (tenant_id, receipt_ref)
);

CREATE TABLE machvon.egp_posting_event (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  obligation_id uuid NOT NULL,
  action text NOT NULL,
  actor_id uuid NOT NULL,
  reason text,
  state_after text NOT NULL,
  obligation_version bigint NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, obligation_id) REFERENCES machvon.egp_posting_obligation (tenant_id, id),
  CONSTRAINT egp_posting_event_action_chk CHECK (action IN ('OPENED', 'PREPARED', 'SUBMITTED', 'RECEIPTED', 'REJECTED', 'CANCELLED')),
  CONSTRAINT egp_posting_event_state_chk CHECK (state_after IN ('DUE', 'PREPARED', 'SUBMITTED', 'RECEIPTED', 'REJECTED', 'CANCELLED')),
  CONSTRAINT egp_posting_event_reason_chk CHECK (reason IS NULL OR (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 2000)),
  CONSTRAINT egp_posting_event_version_chk CHECK (obligation_version >= 1)
);
CREATE INDEX egp_posting_event_obligation_idx ON machvon.egp_posting_event (tenant_id, obligation_id, obligation_version, occurred_at);
CREATE INDEX egp_posting_event_actor_idx ON machvon.egp_posting_event (tenant_id, actor_id, occurred_at DESC);

-- A duty keeps what it is (its kind, its subject, the fact that started the clock, the deadline and the rule behind it); it moves only along the edges of the state machine and each move raises the version by one.
-- The edges are the ones of `EGP_OBLIGATION_MOVES` in the kernel; RECEIPTED and CANCELLED are final.
CREATE FUNCTION machvon.guard_egp_posting_obligation() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.subject_type IS DISTINCT FROM OLD.subject_type OR NEW.subject_id IS DISTINCT FROM OLD.subject_id OR NEW.subject_code IS DISTINCT FROM OLD.subject_code
     OR NEW.source_ref IS DISTINCT FROM OLD.source_ref OR NEW.trigger_event IS DISTINCT FROM OLD.trigger_event OR NEW.triggered_at IS DISTINCT FROM OLD.triggered_at OR NEW.due_at IS DISTINCT FROM OLD.due_at
     OR NEW.rule_code IS DISTINCT FROM OLD.rule_code OR NEW.rule_version IS DISTINCT FROM OLD.rule_version OR NEW.rule_source IS DISTINCT FROM OLD.rule_source OR NEW.remind_before_days IS DISTINCT FROM OLD.remind_before_days
     OR NEW.legal_status IS DISTINCT FROM OLD.legal_status OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a posting obligation keeps its kind, its subject, its deadline and the rule behind it' USING ERRCODE = '23514';
  END IF;
  IF OLD.state IN ('RECEIPTED', 'CANCELLED') THEN
    RAISE EXCEPTION 'a receipted or cancelled posting obligation is final' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state IN ('DUE', 'REJECTED') AND NEW.state = 'PREPARED')
    OR (OLD.state = 'PREPARED' AND NEW.state = 'SUBMITTED')
    OR (OLD.state = 'SUBMITTED' AND NEW.state IN ('RECEIPTED', 'REJECTED'))
    OR (OLD.state IN ('DUE', 'PREPARED', 'REJECTED') AND NEW.state = 'CANCELLED')) THEN
    RAISE EXCEPTION 'a posting obligation does not move from % to %', OLD.state, NEW.state USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'a change of a posting obligation raises its version by one' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER egp_posting_obligation_guard BEFORE UPDATE ON machvon.egp_posting_obligation FOR EACH ROW EXECUTE FUNCTION machvon.guard_egp_posting_obligation();

CREATE FUNCTION machvon.egp_posting_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'a receipt and the history of a posting obligation are append-only' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER egp_posting_receipt_append_only BEFORE UPDATE OR DELETE ON machvon.egp_posting_receipt FOR EACH ROW EXECUTE FUNCTION machvon.egp_posting_append_only();
CREATE TRIGGER egp_posting_event_append_only BEFORE UPDATE OR DELETE ON machvon.egp_posting_event FOR EACH ROW EXECUTE FUNCTION machvon.egp_posting_append_only();

ALTER TABLE machvon.egp_posting_obligation ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.egp_posting_obligation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.egp_posting_obligation AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.egp_posting_obligation AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.egp_posting_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.egp_posting_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.egp_posting_receipt AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.egp_posting_receipt AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.egp_posting_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.egp_posting_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.egp_posting_event AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.egp_posting_event AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.egp_posting_obligation FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.egp_posting_receipt FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.egp_posting_event FROM machvon_app;

COMMENT ON TABLE machvon.egp_posting_obligation IS 'EGP-2: a duty to post information on the national procurement network, with its deadline from the rule EGP_POSTING_DEADLINES, its state, the packet prepared and the people who prepared and submitted it (never the same).';
COMMENT ON TABLE machvon.egp_posting_receipt IS 'EGP-2: the reference the network gave for a posting; one for each obligation, unique in the tenant, append-only.';
COMMENT ON TABLE machvon.egp_posting_event IS 'EGP-2: what was done to a posting obligation and by whom; append-only.';
