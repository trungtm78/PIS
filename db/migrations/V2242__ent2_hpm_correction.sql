-- Authored by hand (not generated): the correction that lets an accepted period be replaced at HPM (ENT-2, eng-review R8). Replacing a period that the receiver already accepted needs two things: the period reopened (an approved
-- `period_reopen` of DIS whose window is still open) and this approved correction, proposed by one person and decided by another. The decision is audited in ADM-11 by the command; this table is the state it leaves.
-- An approved correction is used once: the push that replaces the period consumes it.

CREATE TABLE machvon.hpm_correction (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  layout_code text NOT NULL,
  period text NOT NULL,
  from_revision integer NOT NULL,
  period_reopen_id uuid NOT NULL,
  reason text NOT NULL,
  state text NOT NULL DEFAULT 'PROPOSED',
  proposed_by uuid NOT NULL,
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text,
  consumed_by_push_id uuid,
  consumed_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT hpm_correction_layout_chk CHECK (layout_code ~ '^[A-Z][A-Z0-9_-]{1,59}$'),
  CONSTRAINT hpm_correction_period_chk CHECK (period ~ '^\d{4}(-(M(0[1-9]|1[0-2])|Q[1-4]|H[12]|(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])))?$'),
  CONSTRAINT hpm_correction_revision_chk CHECK (from_revision BETWEEN 1 AND 10000),
  CONSTRAINT hpm_correction_reason_chk CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 10 AND 2000),
  CONSTRAINT hpm_correction_state_chk CHECK (state IN ('PROPOSED', 'APPROVED', 'REJECTED', 'CONSUMED')),
  CONSTRAINT hpm_correction_decision_chk CHECK (
    (state = 'PROPOSED') = (decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL)
    AND (decision_reason IS NULL OR (decision_reason = btrim(decision_reason) AND char_length(decision_reason) BETWEEN 10 AND 2000))
  ),
  CONSTRAINT hpm_correction_maker_checker_chk CHECK (decided_by IS NULL OR decided_by <> proposed_by),
  CONSTRAINT hpm_correction_consumed_chk CHECK ((state = 'CONSUMED') = (consumed_by_push_id IS NOT NULL AND consumed_at IS NOT NULL)),
  CONSTRAINT hpm_correction_version_chk CHECK (version >= 1)
);

CREATE INDEX hpm_correction_series_idx ON machvon.hpm_correction (tenant_id, layout_code, period, state, created_at DESC);
CREATE INDEX hpm_correction_reopen_idx ON machvon.hpm_correction (tenant_id, period_reopen_id);
CREATE INDEX hpm_correction_push_idx ON machvon.hpm_correction (tenant_id, consumed_by_push_id) WHERE consumed_by_push_id IS NOT NULL;
CREATE INDEX hpm_correction_actor_idx ON machvon.hpm_correction (tenant_id, proposed_by, created_at DESC);
-- One proposal at a time for a period and a revision: a second proposal waits for the first to be decided.
CREATE UNIQUE INDEX hpm_correction_open_uq ON machvon.hpm_correction (tenant_id, layout_code, period, from_revision) WHERE state IN ('PROPOSED', 'APPROVED');

CREATE FUNCTION machvon.guard_hpm_correction() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.layout_code IS DISTINCT FROM OLD.layout_code OR NEW.period IS DISTINCT FROM OLD.period OR NEW.from_revision IS DISTINCT FROM OLD.from_revision OR NEW.period_reopen_id IS DISTINCT FROM OLD.period_reopen_id
     OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a correction keeps what was proposed' USING ERRCODE = '23514';
  END IF;
  IF OLD.state IN ('REJECTED', 'CONSUMED') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'a correction that was rejected or used is final' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT ((OLD.state = 'PROPOSED' AND NEW.state IN ('APPROVED', 'REJECTED')) OR (OLD.state = 'APPROVED' AND NEW.state = 'CONSUMED')) THEN
    RAISE EXCEPTION 'a correction does not move from % to %', OLD.state, NEW.state USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER hpm_correction_guard BEFORE UPDATE ON machvon.hpm_correction FOR EACH ROW EXECUTE FUNCTION machvon.guard_hpm_correction();

ALTER TABLE machvon.hpm_correction ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.hpm_correction FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.hpm_correction AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.hpm_correction AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.hpm_correction FROM machvon_app;

COMMENT ON TABLE machvon.hpm_correction IS 'ENT-2: the approved correction that, with a reopened period, lets a revision replace an accepted one at HPM; proposed and decided by two people; used once.';
