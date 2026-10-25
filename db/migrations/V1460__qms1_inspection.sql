-- Authored by hand (not generated): the inspections of work under a contract (ST-QMS-004, QMS 3.2, BR-QMS-04 and BR-QMS-05).
-- The table inspection comes from the generated schema (V002, with the foreign keys to the project, the contract, the item of the BOQ and the site diary, and the checks of the status and of the
-- kind). This adds what the commands rely on: the roles that will sign the minutes (a snapshot of the regime in force on the day of the request, which never changes after it), whether that
-- regime still waits for its confirmation, who takes part in the inspection, why it was cancelled, the shape of each status (a result only with a recorded inspection, and with its note), one open request for
-- the same work on the same day, and the guard of the edges of the status.

ALTER TABLE machvon.inspection
  ADD COLUMN required_roles jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN regime_awaiting_confirmation boolean NOT NULL DEFAULT false,
  ADD COLUMN regime_cxn text,
  ADD COLUMN participant_membership_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN cancel_reason text,
  ADD COLUMN cancelled_at timestamptz;

-- The words are trimmed and bounded; the lists are lists.
ALTER TABLE machvon.inspection
  ADD CONSTRAINT inspection_text_chk CHECK (
    title = btrim(title) AND title <> '' AND char_length(title) <= 2000
    AND (location_text IS NULL OR (location_text = btrim(location_text) AND location_text <> '' AND char_length(location_text) <= 2000))
    AND (result_note IS NULL OR (result_note = btrim(result_note) AND result_note <> '' AND char_length(result_note) <= 2000))
    AND (cancel_reason IS NULL OR (cancel_reason = btrim(cancel_reason) AND cancel_reason <> '' AND char_length(cancel_reason) <= 2000))
  ),
  ADD CONSTRAINT inspection_lists_chk CHECK (jsonb_typeof(required_roles) = 'array' AND jsonb_typeof(participant_membership_ids) = 'array' AND jsonb_typeof(checklist) = 'array'),
  ADD CONSTRAINT inspection_scheduled_chk CHECK (status NOT IN ('SCHEDULED', 'RESULT_RECORDED') OR (scheduled_at IS NOT NULL AND jsonb_array_length(participant_membership_ids) > 0)),
  ADD CONSTRAINT inspection_cancel_chk CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL AND cancelled_at IS NOT NULL) AND (status = 'CANCELLED' OR (cancel_reason IS NULL AND cancelled_at IS NULL))),
  ADD CONSTRAINT inspection_recorded_chk CHECK (
    (status = 'RESULT_RECORDED') = (result IS NOT NULL AND result_note IS NOT NULL AND result_recorded_by IS NOT NULL AND result_recorded_at IS NOT NULL)
    AND (status = 'RESULT_RECORDED' OR (result IS NULL AND result_recorded_by IS NULL AND result_recorded_at IS NULL))
  ),
  ADD CONSTRAINT inspection_regime_chk CHECK (regime_awaiting_confirmation = (regime_cxn IS NOT NULL));

-- One request is open for the same work, of the same kind, on the same day: a second is a duplicate (a work with no item of the BOQ is one work).
CREATE UNIQUE INDEX inspection_open_uq ON machvon.inspection (tenant_id, contract_id, coalesce(boq_item_id, '00000000-0000-0000-0000-000000000000'::uuid), inspection_type, requested_for)
  WHERE status IN ('REQUESTED', 'SCHEDULED');

-- What an inspection says it is never changes: the contract, the work, the kind, the number, who asked and for which day, the regime and the roles and the checklist it was given. The status
-- moves along REQUESTED, SCHEDULED, RESULT_RECORDED (or CANCELLED from the first two); a recorded or cancelled inspection is kept as it is; and the result is written once, with the status.
CREATE FUNCTION machvon.guard_inspection() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.project_id, NEW.contract_id, NEW.boq_item_id, NEW.inspection_no, NEW.inspection_type, NEW.title, NEW.location_text, NEW.requested_by, NEW.requested_for,
      NEW.regime_rule_version_id, NEW.required_roles, NEW.regime_awaiting_confirmation, NEW.regime_cxn, NEW.site_diary_id, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.project_id, OLD.contract_id, OLD.boq_item_id, OLD.inspection_no, OLD.inspection_type, OLD.title, OLD.location_text, OLD.requested_by, OLD.requested_for,
      OLD.regime_rule_version_id, OLD.required_roles, OLD.regime_awaiting_confirmation, OLD.regime_cxn, OLD.site_diary_id, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what an inspection says never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('RESULT_RECORDED', 'CANCELLED') THEN
    RAISE EXCEPTION 'an inspection that is over is kept as it is' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
      FROM (VALUES ('REQUESTED', 'SCHEDULED'), ('REQUESTED', 'CANCELLED'), ('SCHEDULED', 'RESULT_RECORDED'), ('SCHEDULED', 'CANCELLED')) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'INSPECTION_STATE_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER inspection_guard BEFORE UPDATE ON machvon.inspection
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_inspection();

-- The inspections of a contract are part of its dossier: no command deletes one, and the runtime role no longer can.
REVOKE DELETE, TRUNCATE ON TABLE machvon.inspection FROM machvon_app;
