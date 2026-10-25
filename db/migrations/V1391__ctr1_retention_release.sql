-- Authored by hand (not generated): the release of the retention held back from a payment, by line of the BOQ (ST-CTR-010, CTR 3.5, BR-CTR-09, UAT-AC309, UAT-AC397).
-- The table retention_hold, the release that is at most the amount held, the status that is RELEASED exactly when everything was released, the audit of a release, the unique hold of a line of a
-- request and the guard that a hold goes only with the request that is returned are in V002 and V1564. This adds the day the reminder of the earliest release day was sent, that a release names
-- who released it, when, why and by whose hand it was not held, that the status follows the amount released, the guard of the edges of the status and of what a hold is, the words of the reason,
-- and the reminder event that the notification core turns into in-app notifications (docs/notification-event-types.md).

ALTER TABLE machvon.retention_hold
  ADD COLUMN due_notified_on date;

ALTER TABLE machvon.retention_hold
  ADD CONSTRAINT retention_hold_released_by_fk FOREIGN KEY (tenant_id, released_by) REFERENCES machvon.membership (tenant_id, id),
  -- Whatever was released was released by somebody other than the person who put it on hold, at a time, for a reason.
  ADD CONSTRAINT retention_hold_release_actor_chk CHECK (
    (released_vnd = 0) = (released_by IS NULL)
    AND (released_by IS NULL) = (released_at IS NULL)
    AND (released_by IS NULL OR released_by <> created_by)
  ),
  ADD CONSTRAINT retention_hold_release_reason_chk CHECK (release_reason IS NULL OR (release_reason = btrim(release_reason) AND release_reason <> '' AND char_length(release_reason) <= 2000)),
  -- The status says how much of the hold is released: nothing, some of it, all of it (a hold that was forfeited is the one status that is not about the amount).
  ADD CONSTRAINT retention_hold_progress_chk CHECK (
    CASE status
      WHEN 'HELD' THEN released_vnd = 0
      WHEN 'PARTIALLY_RELEASED' THEN released_vnd > 0 AND released_vnd < held_vnd
      WHEN 'RELEASED' THEN released_vnd = held_vnd
      ELSE true
    END
  );

CREATE FUNCTION machvon.guard_retention_hold() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.contract_id, NEW.boq_item_id, NEW.acceptance_id, NEW.payment_request_id, NEW.party_id, NEW.held_vnd, NEW.release_condition, NEW.release_not_before, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.contract_id, OLD.boq_item_id, OLD.acceptance_id, OLD.payment_request_id, OLD.party_id, OLD.held_vnd, OLD.release_condition, OLD.release_not_before, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what a hold of retention is never changes' USING ERRCODE = '23514';
  END IF;
  -- What was released is never taken back: the hold only grows towards released, and a release that was made keeps its author, its day and its reason until the next one replaces them.
  IF NEW.released_vnd < OLD.released_vnd THEN
    RAISE EXCEPTION 'what was released is not taken back' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('RELEASED', 'FORFEITED') AND (NEW.status, NEW.released_vnd) IS DISTINCT FROM (OLD.status, OLD.released_vnd) THEN
    RAISE EXCEPTION 'a hold that is over does not change' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
      FROM (VALUES ('HELD', 'PARTIALLY_RELEASED'), ('HELD', 'RELEASED'), ('HELD', 'FORFEITED'), ('PARTIALLY_RELEASED', 'RELEASED'), ('PARTIALLY_RELEASED', 'FORFEITED')) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'this move of the status of a hold is not allowed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER retention_hold_guard BEFORE UPDATE ON machvon.retention_hold
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_retention_hold();

-- The reminder that goes to the people who hold the contract on the day the money may first be released (the earliest day set on the hold), once per hold.
INSERT INTO machvon.notification_event_type (id, event_type, owning_module, schema_version, payload_schema, allowed_purposes, data_classification, status)
VALUES (
  gen_random_uuid(),
  'ctr.retention.due.v1',
  'CTR',
  1,
  '{"type":"object","required":["tenant_id","hold_id","contract_id","boq_item_id","release_condition","release_not_before"],"properties":{"tenant_id":{"type":"string","format":"uuid"},"hold_id":{"type":"string","format":"uuid"},"contract_id":{"type":"string","format":"uuid"},"boq_item_id":{"type":"string","format":"uuid"},"release_condition":{"type":"string","enum":["WARRANTY_END","COMPLETION","MANUAL_DECISION"]},"release_not_before":{"type":"string","format":"date"}}}'::jsonb,
  ARRAY['REMINDER', 'OPERATIONAL'],
  'INTERNAL',
  'Active'
)
ON CONFLICT (event_type, schema_version) DO NOTHING;
