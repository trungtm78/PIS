-- Authored by hand (not generated): the governance of the reporting periods (ST-DIS-001, DIS 3 F4, BR-DIS-09).
-- V002 gave reporting_period its columns, the status check, the lock check (locked_at is set if and only if the period is LOCKED), the
-- exclusion against overlapping periods and the unique code. What a period still lacked is the evidence of the calendar it came from and
-- the rules that make "status" the one source of truth: a period only moves forward, a locked one never changes again, and the dates,
-- the deadline and the calendar version it was generated with are fixed for good (a new calendar changes the periods generated after it).

-- The id of the calendar version (master type CALENDAR) the period was generated from. calendar_version (V002) is its revision number.
-- Lateness is judged by this version for ever after, never by the calendar in force today (BR-DIS-09).
ALTER TABLE machvon.reporting_period ADD COLUMN calendar_version_id uuid;
ALTER TABLE machvon.reporting_period
  ADD CONSTRAINT reporting_period_calendar_version_chk CHECK (calendar_version_id IS NOT NULL);
ALTER TABLE machvon.reporting_period
  ADD CONSTRAINT reporting_period_calendar_version_fk FOREIGN KEY (tenant_id, calendar_version_id) REFERENCES machvon.master_record_version (tenant_id, id);

ALTER TABLE machvon.reporting_period
  ADD CONSTRAINT reporting_period_fiscal_year_chk CHECK (fiscal_year IS NOT NULL AND fiscal_year BETWEEN 1970 AND 9999);
ALTER TABLE machvon.reporting_period
  ADD CONSTRAINT reporting_period_code_chk CHECK (code <> '' AND code = btrim(code));

-- The timestamps follow the status: an OPEN period was never closed, and a locked one has a locker who is a member (or the job).
ALTER TABLE machvon.reporting_period
  ADD CONSTRAINT reporting_period_soft_close_chk CHECK ((status = 'OPEN') = (soft_closed_at IS NULL));
ALTER TABLE machvon.reporting_period
  ADD CONSTRAINT reporting_period_locker_chk CHECK ((status = 'LOCKED') = (locked_by IS NOT NULL));
ALTER TABLE machvon.reporting_period
  ADD CONSTRAINT reporting_period_lock_order_chk CHECK (locked_at IS NULL OR locked_at >= soft_closed_at);

CREATE INDEX reporting_period_calendar_version_idx ON machvon.reporting_period (tenant_id, calendar_version_id);
CREATE INDEX reporting_period_start_idx ON machvon.reporting_period (tenant_id, start_date DESC, id DESC);
-- The job that closes and locks looks only at the periods that are not locked yet.
CREATE INDEX reporting_period_pending_idx ON machvon.reporting_period (tenant_id, deadline_at) WHERE status <> 'LOCKED';

-- Kept for good (retention: for ever): a report, an audit row and a snapshot name the period years later.
REVOKE DELETE, TRUNCATE ON TABLE machvon.reporting_period FROM machvon_app;

-- Nothing writes the status directly: an update must be one step of the state machine (OPEN to SOFT_CLOSED, SOFT_CLOSED to LOCKED) that
-- raises the version by one, and a locked period never changes again. Reopening a locked period is a period_reopen for a scope (ST-DIS-002),
-- never a change of this row.
CREATE FUNCTION machvon.guard_reporting_period_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.calendar_code IS DISTINCT FROM OLD.calendar_code
     OR NEW.period_type IS DISTINCT FROM OLD.period_type
     OR NEW.fiscal_year IS DISTINCT FROM OLD.fiscal_year
     OR NEW.start_date IS DISTINCT FROM OLD.start_date
     OR NEW.end_date IS DISTINCT FROM OLD.end_date
     OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at
     OR NEW.calendar_version IS DISTINCT FROM OLD.calendar_version
     OR NEW.calendar_version_id IS DISTINCT FROM OLD.calendar_version_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'a reporting period is fixed when it is generated: its dates, deadline and calendar version never change' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'LOCKED' THEN
    RAISE EXCEPTION 'a locked reporting period never changes' USING ERRCODE = '23514';
  END IF;
  IF NOT ((OLD.status = 'OPEN' AND NEW.status = 'SOFT_CLOSED') OR (OLD.status = 'SOFT_CLOSED' AND NEW.status = 'LOCKED')) THEN
    RAISE EXCEPTION 'a reporting period moves only from OPEN to SOFT_CLOSED and from SOFT_CLOSED to LOCKED' USING ERRCODE = '23514';
  END IF;
  IF OLD.soft_closed_at IS NOT NULL AND NEW.soft_closed_at IS DISTINCT FROM OLD.soft_closed_at THEN
    RAISE EXCEPTION 'the time a reporting period was soft closed never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
    RAISE EXCEPTION 'a change of a reporting period raises its version by one' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER reporting_period_guard BEFORE UPDATE ON machvon.reporting_period
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_reporting_period_update();
