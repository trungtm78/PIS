-- Authored by hand (not generated): the clock of the Treasury control of a payment request (GOV-11a, G1-17, PAY 3.3).
-- A payment request that goes to the Treasury starts a clock: the Treasury answers the complete dossier within a number of working days (2 for a payment, 1 for an advance; the numbers are the governance rule
-- `PAYMENT_CLOCK`, flagged not confirmed). `payment_clock` keeps one row for each attempt: when it started, the due instant counted on the published working calendar (null when no calendar covered the days: the
-- clock then says so, it never guesses a day), the days and the policy version that decided, and how the attempt ended (settled, or returned with a reason of the standard list `PAYMENT_RETURN_REASON`).
-- The state (running, near, breached, met, met late) is never stored: it depends on the instant it is read, and is judged by the kernel (`judgePaymentClock`).
--   * one open clock for a request at a time, and one row for each attempt: a returned dossier ends its clock, and the next send starts attempt n + 1;
--   * what an attempt is (request, kind, attempt, start, days, policy) never changes; it ends once, with a time, a kind and (for a return) a reason code; a due instant that was null may be filled once;
--   * the rows are kept for good: the runtime role cannot delete or truncate them.

CREATE TABLE machvon.payment_clock (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  payment_request_id uuid NOT NULL,
  project_id uuid NOT NULL,
  contract_id uuid NOT NULL,
  owner_unit_id uuid NOT NULL,
  clock_kind text NOT NULL,
  attempt integer NOT NULL,
  started_at timestamptz NOT NULL,
  working_days integer NOT NULL,
  near_working_hours integer NOT NULL,
  due_at timestamptz,
  basis text NOT NULL,
  policy_version integer NOT NULL DEFAULT 0,
  ended_at timestamptz,
  end_kind text,
  return_reason_code text,
  returned_by_treasury boolean,
  ended_by uuid,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, payment_request_id) REFERENCES machvon.payment_request (tenant_id, id),
  CONSTRAINT payment_clock_kind_chk CHECK (clock_kind IN ('PAYMENT', 'ADVANCE')),
  CONSTRAINT payment_clock_attempt_chk CHECK (attempt >= 1),
  CONSTRAINT payment_clock_days_chk CHECK (working_days BETWEEN 1 AND 30 AND near_working_hours BETWEEN 1 AND 240 AND policy_version >= 0),
  CONSTRAINT payment_clock_basis_chk CHECK (basis IN ('WORKING_TIME', 'CALENDAR_UNAVAILABLE') AND ((basis = 'WORKING_TIME') = (due_at IS NOT NULL))),
  CONSTRAINT payment_clock_end_chk CHECK ((ended_at IS NULL) = (end_kind IS NULL) AND (end_kind IS NULL OR end_kind IN ('SETTLED', 'RETURNED')) AND (ended_at IS NULL) = (ended_by IS NULL)),
  CONSTRAINT payment_clock_return_chk CHECK ((return_reason_code IS NULL AND returned_by_treasury IS NULL) OR end_kind = 'RETURNED'),
  CONSTRAINT payment_clock_reason_chk CHECK (return_reason_code IS NULL OR return_reason_code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  CONSTRAINT payment_clock_version_chk CHECK (version >= 1),
  CONSTRAINT payment_clock_attempt_uq UNIQUE (tenant_id, payment_request_id, attempt)
);

CREATE UNIQUE INDEX payment_clock_open_uq ON machvon.payment_clock (tenant_id, payment_request_id) WHERE ended_at IS NULL;
CREATE INDEX payment_clock_request_idx ON machvon.payment_clock (tenant_id, payment_request_id, attempt DESC);
CREATE INDEX payment_clock_project_idx ON machvon.payment_clock (tenant_id, project_id, started_at DESC, id DESC);
CREATE INDEX payment_clock_contract_idx ON machvon.payment_clock (tenant_id, contract_id);
CREATE INDEX payment_clock_unit_idx ON machvon.payment_clock (tenant_id, owner_unit_id, started_at DESC, id DESC);
CREATE INDEX payment_clock_open_due_idx ON machvon.payment_clock (tenant_id, due_at, id) WHERE ended_at IS NULL;

CREATE FUNCTION machvon.guard_payment_clock() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a payment clock is kept' USING ERRCODE = '23514', CONSTRAINT = 'payment_clock_guard';
  END IF;
  IF NEW.payment_request_id <> OLD.payment_request_id OR NEW.project_id <> OLD.project_id OR NEW.contract_id <> OLD.contract_id OR NEW.owner_unit_id <> OLD.owner_unit_id
     OR NEW.clock_kind <> OLD.clock_kind OR NEW.attempt <> OLD.attempt OR NEW.started_at <> OLD.started_at OR NEW.working_days <> OLD.working_days
     OR NEW.near_working_hours <> OLD.near_working_hours OR NEW.policy_version <> OLD.policy_version OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'what a payment clock is does not change' USING ERRCODE = '23514', CONSTRAINT = 'payment_clock_identity_guard';
  END IF;
  IF OLD.ended_at IS NOT NULL AND (NEW.ended_at IS DISTINCT FROM OLD.ended_at OR NEW.end_kind IS DISTINCT FROM OLD.end_kind OR NEW.return_reason_code IS DISTINCT FROM OLD.return_reason_code
     OR NEW.returned_by_treasury IS DISTINCT FROM OLD.returned_by_treasury OR NEW.ended_by IS DISTINCT FROM OLD.ended_by OR NEW.due_at IS DISTINCT FROM OLD.due_at) THEN
    RAISE EXCEPTION 'an ended payment clock is not changed' USING ERRCODE = '23514', CONSTRAINT = 'payment_clock_ended_guard';
  END IF;
  IF OLD.due_at IS NOT NULL AND NEW.due_at IS DISTINCT FROM OLD.due_at THEN
    RAISE EXCEPTION 'the due instant of a payment clock is counted once' USING ERRCODE = '23514', CONSTRAINT = 'payment_clock_due_guard';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER payment_clock_guard BEFORE UPDATE OR DELETE ON machvon.payment_clock FOR EACH ROW EXECUTE FUNCTION machvon.guard_payment_clock();

ALTER TABLE machvon.payment_clock ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.payment_clock FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.payment_clock AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.payment_clock AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.payment_clock FROM machvon_app;

COMMENT ON TABLE machvon.payment_clock IS 'GOV-11a G1-17: one row for each attempt of a payment request at the Treasury: start, due instant on the working calendar, policy that decided and how it ended; the state is judged when read.';
