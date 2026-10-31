-- Authored by hand (not generated): the earmark of capital (ST-CAP-011, CAP 3.1 F4, BR-CAP-06, CAP-18).
-- V002 gave `fund_reservation` its columns, its states and the rule that a released reservation says why. A reservation moves capital between two columns of the balance of a line (reserved goes up with
-- RESERVE and down with RELEASE), so the database keeps what the commands rely on, whatever the application checked first:
--   * what was reserved never changes (the project, the year, the amount, the purpose, the reference, the last day, who made it): a change of mind is a new reservation. Only the line may change, and only while the
--     reservation is active: when a revision of the plan is published the balance moves to the line of the revision and the active reservations follow it (ST-CAP-001);
--   * a reservation leaves ACTIVE once, for CONSUMED, RELEASED or EXPIRED, and what is then left is kept as it is; the release and the expiry say when and by whom (the job is a member too);
--   * a reference is a kind and an id together, or neither; the reason of a release is five to 2000 characters; the amount is whole VND; the day it runs out lies after the day it was made;
--   * a reservation is never deleted.

ALTER TABLE machvon.fund_reservation
  ADD COLUMN plan_year integer,
  ADD COLUMN closed_at timestamptz,
  ADD COLUMN closed_by uuid;

-- The year of the line the reservation was made on: the ledger entry of the release carries it. Reservations written before this story (there are none in a database that has run it) get it from their line.
UPDATE machvon.fund_reservation r
   SET plan_year = a.plan_year
  FROM machvon.allocation_line al JOIN machvon.appropriation a ON a.tenant_id = al.tenant_id AND a.id = al.appropriation_id
 WHERE al.tenant_id = r.tenant_id AND al.id = r.allocation_line_id AND r.plan_year IS NULL;

ALTER TABLE machvon.fund_reservation
  ADD CONSTRAINT fund_reservation_reference_chk CHECK ((reference_kind IS NULL) = (reference_id IS NULL)),
  ADD CONSTRAINT fund_reservation_reference_kind_chk CHECK (reference_kind IS NULL OR (reference_kind = btrim(reference_kind) AND char_length(reference_kind) BETWEEN 1 AND 50)),
  ADD CONSTRAINT fund_reservation_reason_chk CHECK (release_reason IS NULL OR (release_reason = btrim(release_reason) AND char_length(release_reason) BETWEEN 5 AND 2000)),
  ADD CONSTRAINT fund_reservation_window_chk CHECK (expires_at > created_at),
  ADD CONSTRAINT fund_reservation_closed_chk CHECK ((status <> 'ACTIVE' OR closed_at IS NULL) AND (closed_at IS NULL) = (closed_by IS NULL)),
  ADD CONSTRAINT fund_reservation_line_fk FOREIGN KEY (tenant_id, allocation_line_id) REFERENCES machvon.allocation_line (tenant_id, id),
  ADD CONSTRAINT fund_reservation_project_fk FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id);

CREATE INDEX fund_reservation_line_idx ON machvon.fund_reservation (tenant_id, allocation_line_id, created_at DESC);
CREATE INDEX fund_reservation_expiry_idx ON machvon.fund_reservation (tenant_id, expires_at) WHERE status = 'ACTIVE';

CREATE FUNCTION machvon.guard_fund_reservation() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.project_id, NEW.plan_year, NEW.purpose, NEW.reference_kind, NEW.reference_id, NEW.amount_vnd, NEW.expires_at, NEW.avc_warning_acknowledged, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.project_id, OLD.plan_year, OLD.purpose, OLD.reference_kind, OLD.reference_id, OLD.amount_vnd, OLD.expires_at, OLD.avc_warning_acknowledged, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what was reserved does not change' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'RESERVATION_NOT_ACTIVE' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'ACTIVE' AND (NEW.release_reason, NEW.closed_at, NEW.closed_by) IS DISTINCT FROM (OLD.release_reason, OLD.closed_at, OLD.closed_by) THEN
    RAISE EXCEPTION 'an active reservation has no closing' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER fund_reservation_guard BEFORE UPDATE ON machvon.fund_reservation
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_fund_reservation();

REVOKE DELETE, TRUNCATE ON TABLE machvon.fund_reservation FROM machvon_app;
