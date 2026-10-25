-- Authored by hand (not generated): the closing, the lapse and the time-boxed reopening of a fiscal year (ST-CAP-008, CAP 3.1 F6, BR-CAP-04).
-- V002 gave `fiscal_year_control` its three states, one row per year and the rule that a year is LOCKED exactly when it has a locking time. A locked year cannot be changed
-- silently, so the database holds what the command relies on, whatever the application checked first:
--   * a year moves OPEN -> SOFT_CLOSED -> LOCKED, or OPEN -> LOCKED; a locked year is reopened (OPEN again, for a window of at most 168 hours, by someone other than the person
--     who locked it, with a reason of 20 characters at least) and is locked again when the window ends; a soft-closed year is never reopened; a year is never deleted and
--     never changes its number;
--   * a reopening leaves its reason, its approver and its window together, and the window never exceeds a week;
--   * the capital that lapses when a year is locked is written to the ledger as LAPSE entries of one closing (`lock_ref_id`); an entry that lapses capital names the line and
--     the project, as an entry that allocates or reduces does (V1363).

ALTER TABLE machvon.fiscal_year_control
  ADD COLUMN soft_closed_by uuid,
  ADD COLUMN close_reason text,
  ADD COLUMN reopened_at timestamptz,
  ADD COLUMN lock_ref_id uuid;

ALTER TABLE machvon.fiscal_year_control
  ADD CONSTRAINT fiscal_year_range_chk CHECK (plan_year BETWEEN 1990 AND 2100),
  ADD CONSTRAINT fiscal_year_soft_chk CHECK (status <> 'SOFT_CLOSED' OR soft_closed_at IS NOT NULL),
  ADD CONSTRAINT fiscal_year_close_reason_chk CHECK (close_reason IS NULL OR (close_reason = btrim(close_reason) AND char_length(close_reason) BETWEEN 5 AND 2000)),
  ADD CONSTRAINT fiscal_year_reopen_chk CHECK (
    (reopen_reason IS NULL) = (reopened_until IS NULL)
    AND (reopen_reason IS NULL) = (reopen_approved_by IS NULL)
    AND (reopen_reason IS NULL) = (reopened_at IS NULL)
    AND (reopen_reason IS NULL OR (reopen_reason = btrim(reopen_reason) AND char_length(reopen_reason) BETWEEN 20 AND 2000))
    AND (reopened_until IS NULL OR (reopened_until > reopened_at AND reopened_until <= reopened_at + interval '168 hours'))
  );

CREATE FUNCTION machvon.guard_fiscal_year_control() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a fiscal year control is kept for good: a year is closed and reopened, never removed' USING ERRCODE = '23514';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.plan_year IS DISTINCT FROM OLD.plan_year THEN
    RAISE EXCEPTION 'a fiscal year control keeps its year for good' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'OPEN' AND NEW.status IN ('SOFT_CLOSED', 'LOCKED'))
    OR (OLD.status = 'SOFT_CLOSED' AND NEW.status = 'LOCKED')
    OR (OLD.status = 'LOCKED' AND NEW.status = 'OPEN')) THEN
    RAISE EXCEPTION 'a fiscal year does not move from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'LOCKED' AND NEW.status = 'OPEN' THEN
    -- Reopening: a reason, a window and an approver other than the person who locked the year (the job that locks a year again counts as a person of its own).
    IF NEW.reopen_reason IS NOT DISTINCT FROM OLD.reopen_reason AND NEW.reopened_at IS NOT DISTINCT FROM OLD.reopened_at THEN
      RAISE EXCEPTION 'a locked year is reopened with a new reason and a new window' USING ERRCODE = '23514';
    END IF;
    IF NEW.reopen_approved_by IS NOT DISTINCT FROM OLD.locked_by THEN
      RAISE EXCEPTION 'the person who locked a year does not reopen it' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER fiscal_year_control_guard BEFORE UPDATE OR DELETE ON machvon.fiscal_year_control
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_fiscal_year_control();

REVOKE DELETE, TRUNCATE ON TABLE machvon.fiscal_year_control FROM machvon_app;

-- An entry that lapses capital is for a line of a project (the reconciliation of the balances reads it by both).
ALTER TABLE machvon.capital_ledger_entry
  ADD CONSTRAINT capital_ledger_lapse_line_chk CHECK (entry_type <> 'LAPSE' OR (allocation_line_id IS NOT NULL AND project_id IS NOT NULL));

-- The closings are found by the reference their entries carry, and the years whose reopening has ended by the end of the window.
CREATE INDEX fiscal_year_control_lock_ref_idx ON machvon.fiscal_year_control (tenant_id, lock_ref_id);
CREATE INDEX fiscal_year_control_reopen_idx ON machvon.fiscal_year_control (tenant_id, reopened_until) WHERE status = 'OPEN' AND reopened_until IS NOT NULL;
