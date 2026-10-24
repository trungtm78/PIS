-- Authored by hand (not generated): the guarantee register (ST-CTR-003, CTR 3.5, BR-CTR-10).
-- The table guarantee comes from the generated schema (V002, with the extension columns of CTR, the active-and-verified and the release
-- checks, and the unique number per issuer). This adds what the commands rely on, so that the database holds what the application
-- checked first:
--   * who verified a guarantee, how and on what evidence, and that it was not the person who registered it (maker-checker, BR-CTR-15);
--   * the status follows the verification: PENDING_VERIFICATION is UNVERIFIED, REJECTED is FAILED, every status after ACTIVE is VERIFIED;
--   * the status moves only along the transitions of CTR section 4, and what a guarantee says (issuer, number, amount, dates, document)
--     never changes: an extension is a new row that replaces the old one, which keeps its expiry;
--   * the release names its reason, the person (not the registrant) and its evidence;
--   * a guarantee is evidence of an obligation: the runtime role cannot delete it.
-- It also registers the reminder event that the notification core turns into in-app notifications (docs/notification-event-types.md).

ALTER TABLE machvon.guarantee
  ADD COLUMN verified_by uuid,
  ADD COLUMN verified_at timestamptz,
  ADD COLUMN verification_method text,
  ADD COLUMN verification_evidence_id uuid,
  ADD COLUMN release_reason text;

ALTER TABLE machvon.guarantee
  ADD CONSTRAINT guarantee_verification_evidence_fk FOREIGN KEY (tenant_id, verification_evidence_id) REFERENCES machvon.document_version (tenant_id, id);
CREATE INDEX guarantee_verification_evidence_id_idx ON machvon.guarantee (tenant_id, verification_evidence_id);

ALTER TABLE machvon.guarantee
  ADD CONSTRAINT guarantee_text_chk CHECK (
    issuer = btrim(issuer) AND issuer <> ''
    AND (guarantee_no IS NULL OR (guarantee_no = btrim(guarantee_no) AND guarantee_no <> ''))
  ),
  ADD CONSTRAINT guarantee_validity_chk CHECK (valid_from IS NULL OR valid_from <= (expires_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date),
  ADD CONSTRAINT guarantee_alert_days_chk CHECK (last_alert_days IS NULL OR last_alert_days IN (30, 15, 7, 0)),
  ADD CONSTRAINT guarantee_extension_chk CHECK (extended_from_id IS DISTINCT FROM id),
  -- A guarantee is verified (or failed) by a person with a method and evidence, all at once, and never by the person who registered it.
  ADD CONSTRAINT guarantee_verification_chk CHECK (
    (verification_status = 'UNVERIFIED') = (verified_by IS NULL)
    AND (verified_by IS NULL) = (verified_at IS NULL)
    AND (verified_by IS NULL) = (verification_method IS NULL)
    AND (verified_by IS NULL) = (verification_evidence_id IS NULL)
    AND (verification_method IS NULL OR (verification_method = btrim(verification_method) AND verification_method <> ''))
  ),
  ADD CONSTRAINT guarantee_verification_maker_checker_chk CHECK (verified_by IS NULL OR created_by IS NULL OR verified_by <> created_by),
  ADD CONSTRAINT guarantee_status_verification_chk CHECK (
    CASE status
      WHEN 'PENDING_VERIFICATION' THEN verification_status = 'UNVERIFIED'
      WHEN 'REJECTED' THEN verification_status = 'FAILED'
      ELSE verification_status = 'VERIFIED'
    END
  ),
  -- The release is a decision with a reason, a person who is not the registrant, and evidence (guarantee_release_chk holds the evidence and the time).
  ADD CONSTRAINT guarantee_release_decision_chk CHECK (
    (status = 'RELEASED') = (released_by IS NOT NULL)
    AND (status = 'RELEASED') = (release_reason IS NOT NULL)
    AND (release_reason IS NULL OR (release_reason = btrim(release_reason) AND release_reason <> ''))
    AND (released_by IS NULL OR created_by IS NULL OR released_by <> created_by)
  );

-- A guarantee has one live replacement at a time (a replacement that failed its verification frees the place).
CREATE UNIQUE INDEX guarantee_live_successor_uq ON machvon.guarantee (tenant_id, extended_from_id)
  WHERE extended_from_id IS NOT NULL AND status <> 'REJECTED';

CREATE FUNCTION machvon.guard_guarantee_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.contract_id, NEW.kind, NEW.issuer, NEW.guarantee_no, NEW.party_id, NEW.amount_vnd, NEW.currency, NEW.valid_from, NEW.expires_at,
      NEW.document_version_id, NEW.extended_from_id, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.contract_id, OLD.kind, OLD.issuer, OLD.guarantee_no, OLD.party_id, OLD.amount_vnd, OLD.currency, OLD.valid_from, OLD.expires_at,
      OLD.document_version_id, OLD.extended_from_id, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what a guarantee says never changes: an extension is a new guarantee' USING ERRCODE = '23514';
  END IF;
  IF OLD.verified_by IS NOT NULL AND (NEW.verified_by, NEW.verified_at, NEW.verification_method, NEW.verification_evidence_id)
     IS DISTINCT FROM (OLD.verified_by, OLD.verified_at, OLD.verification_method, OLD.verification_evidence_id) THEN
    RAISE EXCEPTION 'the verification of a guarantee is final' USING ERRCODE = '23514';
  END IF;
  IF OLD.released_by IS NOT NULL AND (NEW.released_by, NEW.released_at, NEW.release_evidence_id, NEW.release_reason)
     IS DISTINCT FROM (OLD.released_by, OLD.released_at, OLD.release_evidence_id, OLD.release_reason) THEN
    RAISE EXCEPTION 'the release of a guarantee is final' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
      FROM (VALUES
        ('PENDING_VERIFICATION', 'ACTIVE'), ('PENDING_VERIFICATION', 'REJECTED'),
        ('ACTIVE', 'EXPIRED'), ('ACTIVE', 'RELEASED'), ('ACTIVE', 'CALLED'), ('ACTIVE', 'SUPERSEDED'),
        ('EXPIRED', 'RELEASED')
      ) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'GUARANTEE_STATE_INVALID' USING ERRCODE = '23514';
  END IF;
  -- A guarantee that is over (released, called, rejected or replaced) only keeps what was written; the alerts and the version stay with the live ones.
  IF OLD.status IN ('RELEASED', 'CALLED', 'REJECTED', 'SUPERSEDED') AND NEW.status = OLD.status AND NEW.last_alert_days IS DISTINCT FROM OLD.last_alert_days THEN
    RAISE EXCEPTION 'GUARANTEE_STATE_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER guarantee_update_guard BEFORE UPDATE ON machvon.guarantee
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_guarantee_update();

-- A guarantee is kept for good (CTR section 6: retention follows the project dossier, a legal hold blocks removal).
REVOKE DELETE, TRUNCATE ON TABLE machvon.guarantee FROM machvon_app;

-- The reminder that goes to the people who hold the contract when a guarantee comes close to its expiry (30, 15, 7 and 0 days before).
-- The payload names the guarantee, never the number or the issuer; the thresholds are the ones of CTR section 3.5.
INSERT INTO machvon.notification_event_type (id, event_type, owning_module, schema_version, payload_schema, allowed_purposes, data_classification, status)
VALUES (
  gen_random_uuid(),
  'ctr.guarantee.expiring.v1',
  'CTR',
  1,
  '{"type":"object","required":["tenant_id","guarantee_id","contract_id","kind","expires_on","days_left","threshold_days"],"properties":{"tenant_id":{"type":"string","format":"uuid"},"guarantee_id":{"type":"string","format":"uuid"},"contract_id":{"type":"string","format":"uuid"},"kind":{"type":"string","enum":["PERFORMANCE","ADVANCE","WARRANTY","INSURANCE"]},"expires_on":{"type":"string","format":"date"},"days_left":{"type":"integer","minimum":0,"maximum":30},"threshold_days":{"type":"integer","enum":[30,15,7,0]}}}'::jsonb,
  ARRAY['REMINDER', 'OPERATIONAL'],
  'INTERNAL',
  'Active'
)
ON CONFLICT (event_type, schema_version) DO NOTHING;
