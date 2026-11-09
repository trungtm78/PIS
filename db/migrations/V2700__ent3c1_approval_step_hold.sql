-- Authored by hand (not generated): the hold of a step of the staged approval (ENT-3c, eng-review R22). The PUSH step hands a package to the receiver; the step is not done until the receiver answers. While it waits the task stays
-- Pending, the instance stays Running, and this row says why: AWAITING_RECEIPT (the package was written), PUSH_FAILED (it could not be written, the same key is tried again), PUSHED (the receipt was accepted and the decision
-- was finished), REJECTED (the receiver refused it) or CANCELLED (the instance ended meanwhile). The person who made the decision is kept, so that the decision is finished as theirs when the receipt comes (the receipt is
-- recorded by somebody else). The push itself is `hpm_push` of the enterprise edition; the id is kept without a foreign key because the table exists for that edition only.

CREATE TABLE machvon.approval_step_hold (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workflow_instance_id uuid NOT NULL,
  task_id uuid NOT NULL,
  step_key text NOT NULL,
  state text NOT NULL,
  held_by uuid NOT NULL,
  on_behalf_of_id uuid,
  delegation_id uuid,
  decision_reason text,
  push_id uuid,
  push_key text,
  push_status text,
  resource_revision integer,
  attempts integer NOT NULL DEFAULT 1,
  receipt_by uuid,
  receipt_at timestamptz,
  receipt_reference text,
  released_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, workflow_instance_id) REFERENCES machvon.workflow_instance (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES machvon.approval_task (tenant_id, id),
  CONSTRAINT approval_step_hold_state_chk CHECK (state IN ('AWAITING_RECEIPT', 'PUSH_FAILED', 'PUSHED', 'REJECTED', 'CANCELLED')),
  CONSTRAINT approval_step_hold_step_chk CHECK (step_key = btrim(step_key) AND step_key <> '' AND char_length(step_key) <= 80),
  CONSTRAINT approval_step_hold_push_status_chk CHECK (push_status IS NULL OR push_status IN ('PENDING', 'WRITTEN', 'FAILED', 'ACCEPTED', 'REJECTED')),
  CONSTRAINT approval_step_hold_revision_chk CHECK (resource_revision IS NULL OR resource_revision >= 1),
  CONSTRAINT approval_step_hold_attempts_chk CHECK (attempts >= 1),
  CONSTRAINT approval_step_hold_reason_chk CHECK (decision_reason IS NULL OR (decision_reason = btrim(decision_reason) AND char_length(decision_reason) BETWEEN 1 AND 2000)),
  CONSTRAINT approval_step_hold_released_chk CHECK ((state = 'PUSHED') = (released_at IS NOT NULL)),
  CONSTRAINT approval_step_hold_receipt_chk CHECK ((receipt_at IS NULL) = (receipt_by IS NULL) AND (receipt_at IS NULL) = (receipt_reference IS NULL) AND (state <> 'REJECTED' OR receipt_at IS NOT NULL)),
  CONSTRAINT approval_step_hold_maker_checker_chk CHECK (receipt_by IS NULL OR receipt_by <> held_by),
  CONSTRAINT approval_step_hold_version_chk CHECK (version >= 1)
);

-- One open hold for a task: a retry after a failure moves the same row, it never opens a second one.
CREATE UNIQUE INDEX approval_step_hold_open_uq ON machvon.approval_step_hold (tenant_id, task_id) WHERE state IN ('AWAITING_RECEIPT', 'PUSH_FAILED');
CREATE INDEX approval_step_hold_task_idx ON machvon.approval_step_hold (tenant_id, task_id, created_at DESC);
CREATE INDEX approval_step_hold_instance_idx ON machvon.approval_step_hold (tenant_id, workflow_instance_id, created_at DESC);
CREATE INDEX approval_step_hold_push_idx ON machvon.approval_step_hold (tenant_id, push_id) WHERE push_id IS NOT NULL;
CREATE INDEX approval_step_hold_behalf_idx ON machvon.approval_step_hold (tenant_id, on_behalf_of_id) WHERE on_behalf_of_id IS NOT NULL;
CREATE INDEX approval_step_hold_delegation_idx ON machvon.approval_step_hold (tenant_id, delegation_id) WHERE delegation_id IS NOT NULL;
CREATE INDEX approval_step_hold_state_idx ON machvon.approval_step_hold (tenant_id, state, updated_at DESC);

-- A hold keeps who held the step and for which task; its state moves along the edges of a hold only, and one that ended is final.
CREATE FUNCTION machvon.guard_approval_step_hold() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.workflow_instance_id IS DISTINCT FROM OLD.workflow_instance_id OR NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.step_key IS DISTINCT FROM OLD.step_key
     OR NEW.held_by IS DISTINCT FROM OLD.held_by OR NEW.on_behalf_of_id IS DISTINCT FROM OLD.on_behalf_of_id OR NEW.delegation_id IS DISTINCT FROM OLD.delegation_id
     OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a hold keeps the task and the person it was made for' USING ERRCODE = '23514';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'the attempts of a hold never go back' USING ERRCODE = '23514';
  END IF;
  IF OLD.state IN ('PUSHED', 'REJECTED', 'CANCELLED') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'a hold that ended is final' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state = 'AWAITING_RECEIPT' AND NEW.state IN ('PUSH_FAILED', 'PUSHED', 'REJECTED', 'CANCELLED'))
    OR (OLD.state = 'PUSH_FAILED' AND NEW.state IN ('AWAITING_RECEIPT', 'PUSHED', 'REJECTED', 'CANCELLED'))) THEN
    RAISE EXCEPTION 'a hold does not move from % to %', OLD.state, NEW.state USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER approval_step_hold_guard BEFORE UPDATE ON machvon.approval_step_hold FOR EACH ROW EXECUTE FUNCTION machvon.guard_approval_step_hold();

ALTER TABLE machvon.approval_step_hold ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.approval_step_hold FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.approval_step_hold AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.approval_step_hold AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.approval_step_hold FROM machvon_app;

COMMENT ON TABLE machvon.approval_step_hold IS 'ENT-3c: the PUSH step of a staged approval waits for the receipt of the receiver; the task stays Pending until the receipt releases it (eng-review R22).';
