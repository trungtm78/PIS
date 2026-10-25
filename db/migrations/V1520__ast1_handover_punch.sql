-- Authored by hand (not generated): the handover of a work to the unit that receives it and the punch list of what is still wrong with it (ST-AST-001, AST 3.1, BR-AST-01, UAT-AC388).
-- The tables handover and handover_punch_item, the checks that an accepted handover has no open critical item and its as-built dossier, that a rejected one says why, that a waived item
-- has its reason and its approver and that a verified one has its evidence are in V002. This adds who said an item was put right (so that somebody else verifies it), the words of the
-- verification and of the decision, the photo of the defect apart from the evidence that it was put right, the guard of the edges of both statuses, that a critical item is never waived, that the number of critical items open and the snapshot of the list are
-- kept by the database in the same transaction as the item, and that neither table is ever deleted from.

ALTER TABLE machvon.handover_punch_item
  ADD COLUMN defect_photo_id uuid,
  ADD COLUMN fixed_by uuid,
  ADD COLUMN fixed_at timestamptz,
  ADD COLUMN fixed_note text,
  ADD COLUMN verification_note text,
  ADD COLUMN reopen_count integer NOT NULL DEFAULT 0;

ALTER TABLE machvon.handover
  ADD COLUMN decision_note text,
  ADD COLUMN decision_evidence jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE machvon.handover_punch_item
  ADD CONSTRAINT punch_item_text_chk CHECK (
    description = btrim(description) AND description <> '' AND char_length(description) <= 2000
    AND (location_text IS NULL OR (location_text = btrim(location_text) AND location_text <> '' AND char_length(location_text) <= 2000))
    AND (fixed_note IS NULL OR (fixed_note = btrim(fixed_note) AND fixed_note <> '' AND char_length(fixed_note) <= 2000))
    AND (verification_note IS NULL OR (verification_note = btrim(verification_note) AND verification_note <> '' AND char_length(verification_note) <= 2000))
    AND (waiver_reason IS NULL OR (waiver_reason = btrim(waiver_reason) AND waiver_reason <> '' AND char_length(waiver_reason) <= 2000))
  ),
  -- An item that was answered says who answered it, when and with what words; the person who verifies it is somebody else.
  ADD CONSTRAINT punch_item_fixed_chk CHECK (status NOT IN ('FIXED', 'VERIFIED') OR (fixed_by IS NOT NULL AND fixed_at IS NOT NULL AND fixed_note IS NOT NULL)),
  ADD CONSTRAINT punch_item_verifier_chk CHECK (verified_by IS NULL OR fixed_by IS NULL OR verified_by <> fixed_by),
  -- A critical item is never waived, and whoever waives an item did not put it on the list.
  ADD CONSTRAINT punch_item_waiver_critical_chk CHECK (status <> 'WAIVED' OR severity <> 'CRITICAL'),
  ADD CONSTRAINT punch_item_waiver_actor_chk CHECK (waiver_approved_by IS NULL OR waiver_approved_by <> created_by),
  ADD CONSTRAINT punch_item_reopen_chk CHECK (reopen_count >= 0),
  ADD CONSTRAINT punch_item_fixed_by_fk FOREIGN KEY (tenant_id, fixed_by) REFERENCES machvon.membership (tenant_id, id),
  ADD CONSTRAINT punch_item_defect_photo_fk FOREIGN KEY (tenant_id, defect_photo_id) REFERENCES machvon.site_photo (tenant_id, id);

CREATE INDEX handover_punch_item_defect_photo_id_idx ON machvon.handover_punch_item (tenant_id, defect_photo_id);

ALTER TABLE machvon.handover
  ADD CONSTRAINT handover_text_chk CHECK (
    (handover_no IS NULL OR (handover_no = btrim(handover_no) AND handover_no <> '' AND char_length(handover_no) <= 2000))
    AND (rejection_reason IS NULL OR (rejection_reason = btrim(rejection_reason) AND rejection_reason <> '' AND char_length(rejection_reason) <= 2000))
    AND (decision_note IS NULL OR (decision_note = btrim(decision_note) AND decision_note <> '' AND char_length(decision_note) <= 2000))
  ),
  ADD CONSTRAINT handover_accepted_by_fk FOREIGN KEY (tenant_id, accepted_by) REFERENCES machvon.membership (tenant_id, id);

REVOKE DELETE, TRUNCATE ON TABLE machvon.handover FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.handover_punch_item FROM machvon_app;

CREATE FUNCTION machvon.guard_handover() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'HANDOVER_STATE_INVALID: a handover is drafted first' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.project_id, NEW.contract_id, NEW.recipient_unit_id, NEW.handover_kind, NEW.handover_no, NEW.quality_acceptance_id, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.project_id, OLD.contract_id, OLD.recipient_unit_id, OLD.handover_kind, OLD.handover_no, OLD.quality_acceptance_id, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what a handover is about never changes' USING ERRCODE = '23514';
  END IF;
  -- A handover that was decided is kept as it was decided; a rejected one is made again as a new file.
  IF OLD.status IN ('ACCEPTED', 'REJECTED', 'CANCELLED') THEN
    RAISE EXCEPTION 'HANDOVER_STATE_INVALID: a decided handover does not change' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
      FROM (VALUES ('DRAFT', 'INSPECTING'), ('DRAFT', 'PUNCH_PENDING'), ('DRAFT', 'ACCEPTED'), ('DRAFT', 'REJECTED'), ('DRAFT', 'CANCELLED'),
                   ('INSPECTING', 'PUNCH_PENDING'), ('INSPECTING', 'ACCEPTED'), ('INSPECTING', 'REJECTED'), ('INSPECTING', 'CANCELLED'),
                   ('PUNCH_PENDING', 'ACCEPTED'), ('PUNCH_PENDING', 'REJECTED'), ('PUNCH_PENDING', 'CANCELLED')) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'HANDOVER_STATE_INVALID: this move of the status is not allowed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER handover_guard BEFORE INSERT OR UPDATE ON machvon.handover
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_handover();

CREATE FUNCTION machvon.guard_handover_punch_item() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  parent text;
BEGIN
  SELECT status INTO parent FROM machvon.handover WHERE tenant_id = NEW.tenant_id AND id = NEW.handover_id;
  IF parent IS NULL OR parent NOT IN ('DRAFT', 'INSPECTING', 'PUNCH_PENDING') THEN
    RAISE EXCEPTION 'HANDOVER_STATE_INVALID: the punch list of a handover that was decided does not change' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'OPEN' THEN
      RAISE EXCEPTION 'PUNCH_STATE_INVALID: an item is open first' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.handover_id, NEW.item_no, NEW.description, NEW.severity, NEW.location_text, NEW.responsible_contractor_id, NEW.due_on, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.handover_id, OLD.item_no, OLD.description, OLD.severity, OLD.location_text, OLD.responsible_contractor_id, OLD.due_on, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what a punch item is about never changes' USING ERRCODE = '23514';
  END IF;
  -- An item that was verified or waived is final.
  IF OLD.status IN ('VERIFIED', 'WAIVED') THEN
    RAISE EXCEPTION 'PUNCH_STATE_INVALID: an item that was verified or waived does not change' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
      FROM (VALUES ('OPEN', 'FIXED'), ('OPEN', 'WAIVED'), ('FIXED', 'VERIFIED'), ('FIXED', 'OPEN'), ('FIXED', 'WAIVED')) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'PUNCH_STATE_INVALID: this move of the status is not allowed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER handover_punch_item_guard BEFORE INSERT OR UPDATE ON machvon.handover_punch_item
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_handover_punch_item();

-- The number of critical items still open and the snapshot of the list are the database's own count of the items, written in the same transaction as the item (BR-AST-01).
CREATE FUNCTION machvon.refresh_handover_punch() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  UPDATE machvon.handover h
     SET open_critical_punch_count = (
           SELECT count(*) FROM machvon.handover_punch_item i
            WHERE i.tenant_id = h.tenant_id AND i.handover_id = h.id AND i.severity = 'CRITICAL' AND i.status <> 'VERIFIED'
         ),
         punch_list = COALESCE((
           SELECT jsonb_agg(jsonb_build_object('item_no', i.item_no, 'severity', i.severity, 'status', i.status, 'due_on', i.due_on) ORDER BY i.item_no)
             FROM machvon.handover_punch_item i WHERE i.tenant_id = h.tenant_id AND i.handover_id = h.id
         ), '[]'::jsonb)
   WHERE h.tenant_id = NEW.tenant_id AND h.id = NEW.handover_id;
  RETURN NULL;
END;
$fn$;

CREATE TRIGGER handover_punch_item_refresh AFTER INSERT OR UPDATE ON machvon.handover_punch_item
  FOR EACH ROW EXECUTE FUNCTION machvon.refresh_handover_punch();
