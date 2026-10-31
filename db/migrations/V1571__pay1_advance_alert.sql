-- Authored by hand (not generated): the acknowledgement of the alert of an advance that is not recovered in time (ST-PAY-011, PAY 3.2 step 4 and 5, BR-PAY-11).
-- The day the advance became overdue and the highest alert level that went are in V002 (overdue_since, last_alert_level). This adds the plan the person who answers for the advance gave and the day it is due,
-- and keeps the columns agreeing: an alert at the level of overdue has the day it became overdue, and a plan is given for an advance that is overdue, as one note, one day, one person and one moment together.
-- Nothing here marks an advance as recovered: the plan is a note, and the amounts move only by the recoveries.

ALTER TABLE machvon.contract_advance
  ADD COLUMN alert_note text,
  ADD COLUMN alert_plan_due_on date,
  ADD COLUMN alert_acknowledged_by uuid,
  ADD COLUMN alert_acknowledged_at timestamptz;

ALTER TABLE machvon.contract_advance
  ADD CONSTRAINT contract_advance_alert_ack_chk CHECK (
    (alert_note IS NULL) = (alert_plan_due_on IS NULL) AND (alert_note IS NULL) = (alert_acknowledged_by IS NULL) AND (alert_note IS NULL) = (alert_acknowledged_at IS NULL)
    AND (alert_note IS NULL OR (alert_note = btrim(alert_note) AND alert_note <> '' AND char_length(alert_note) <= 2000 AND overdue_since IS NOT NULL))
  ),
  ADD CONSTRAINT contract_advance_alert_level_chk CHECK (last_alert_level < 3 OR overdue_since IS NOT NULL),
  ADD CONSTRAINT contract_advance_alert_ack_fk FOREIGN KEY (tenant_id, alert_acknowledged_by) REFERENCES machvon.membership (tenant_id, id);

CREATE INDEX contract_advance_alert_ack_by_idx ON machvon.contract_advance (tenant_id, alert_acknowledged_by);
-- The board of the overdue advances reads the ones that were alerted and are still owed.
CREATE INDEX contract_advance_alerted_idx ON machvon.contract_advance (tenant_id, last_alert_level) WHERE last_alert_level > 0;
