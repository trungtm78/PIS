-- Authored by hand (not generated): the warranty a work carries after its handover and the closure that lets the retention and the warranty guarantee be released (ST-AST-003, AST 3.3, BR-AST-03, BR-AST-05, UAT-AC390, UAT-AC392).
-- The tables warranty_obligation and warranty_claim, the end after the start, the status and severity lists, the claim number that is unique in an obligation, the verified claim that names its
-- verifier and the foreign keys are in V002. This adds the grade of the work and the minimum term that was applied, who closed the obligation and when, that the end of the warranty is the start plus
-- the term and that the term is not below the minimum it was judged by, that an obligation names a guarantee or an amount held back, the words of the texts, the guard of the edges of the status
-- (a closed obligation has no claim open, and no claim is opened on a closed obligation), that what an obligation is does not change once it is written, and that neither table is ever deleted from.

ALTER TABLE machvon.warranty_obligation
  ADD COLUMN construction_grade text,
  ADD COLUMN minimum_months integer,
  ADD COLUMN closed_by uuid,
  ADD COLUMN closed_at timestamptz,
  ADD COLUMN close_note text;

ALTER TABLE machvon.warranty_obligation
  ADD CONSTRAINT warranty_obligation_grade_chk CHECK (construction_grade IS NULL OR construction_grade IN ('SPECIAL', 'I', 'II', 'III', 'IV')),
  -- The term of the warranty is at least the minimum the rule in force stated, and the end is the start plus the term (the last day of the month when that month is shorter).
  ADD CONSTRAINT warranty_obligation_minimum_chk CHECK (minimum_months IS NULL OR (minimum_months > 0 AND period_months >= minimum_months)),
  ADD CONSTRAINT warranty_obligation_term_chk CHECK (ends_on = (starts_on + make_interval(months => period_months))::date),
  -- The obligation holds back an amount or is covered by a warranty guarantee.
  ADD CONSTRAINT warranty_obligation_cover_chk CHECK (retention_amount_vnd >= 0 AND (warranty_guarantee_id IS NOT NULL OR retention_amount_vnd > 0)),
  ADD CONSTRAINT warranty_obligation_text_chk CHECK (
    scope_description = btrim(scope_description) AND scope_description <> '' AND char_length(scope_description) <= 2000
    AND (close_note IS NULL OR (close_note = btrim(close_note) AND close_note <> '' AND char_length(close_note) <= 2000))
  ),
  ADD CONSTRAINT warranty_obligation_closed_chk CHECK ((status = 'CLOSED') = (closed_by IS NOT NULL AND closed_at IS NOT NULL)),
  ADD CONSTRAINT warranty_obligation_closed_by_fk FOREIGN KEY (tenant_id, closed_by) REFERENCES machvon.membership (tenant_id, id),
  ADD CONSTRAINT warranty_obligation_created_by_fk FOREIGN KEY (tenant_id, created_by) REFERENCES machvon.membership (tenant_id, id);

ALTER TABLE machvon.warranty_claim
  ADD CONSTRAINT warranty_claim_text_chk CHECK (
    claim_no = btrim(claim_no) AND claim_no <> '' AND char_length(claim_no) <= 2000
    AND defect_description = btrim(defect_description) AND defect_description <> '' AND char_length(defect_description) <= 2000
    AND (location_text IS NULL OR (location_text = btrim(location_text) AND location_text <> '' AND char_length(location_text) <= 2000))
  );

REVOKE DELETE, TRUNCATE ON TABLE machvon.warranty_obligation FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.warranty_claim FROM machvon_app;

CREATE FUNCTION machvon.guard_warranty_obligation() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  open_claims integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'WARRANTY_STATE_INVALID: an obligation is created active' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.project_id, NEW.contract_id, NEW.handover_id, NEW.asset_id, NEW.scope_description, NEW.starts_on, NEW.ends_on, NEW.period_months, NEW.warranty_guarantee_id,
      NEW.retention_amount_vnd, NEW.rule_version_id, NEW.construction_grade, NEW.minimum_months, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.project_id, OLD.contract_id, OLD.handover_id, OLD.asset_id, OLD.scope_description, OLD.starts_on, OLD.ends_on, OLD.period_months, OLD.warranty_guarantee_id,
      OLD.retention_amount_vnd, OLD.rule_version_id, OLD.construction_grade, OLD.minimum_months, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what a warranty obligation is never changes' USING ERRCODE = '23514';
  END IF;
  -- The closure of an obligation is kept as it was written.
  IF OLD.status = 'CLOSED' AND (NEW.status, NEW.closed_by, NEW.closed_at, NEW.close_note) IS DISTINCT FROM (OLD.status, OLD.closed_by, OLD.closed_at, OLD.close_note) THEN
    RAISE EXCEPTION 'WARRANTY_STATE_INVALID: a closed obligation does not change' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT EXISTS (
      SELECT 1
        FROM (VALUES ('ACTIVE', 'EXPIRED'), ('ACTIVE', 'CLOSED'), ('EXPIRED', 'CLOSED')) AS allowed (from_status, to_status)
       WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
    ) THEN
      RAISE EXCEPTION 'WARRANTY_STATE_INVALID: this move of the status is not allowed' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'CLOSED' THEN
      SELECT count(*) INTO open_claims
        FROM machvon.warranty_claim c
       WHERE c.tenant_id = NEW.tenant_id AND c.obligation_id = NEW.id AND c.status NOT IN ('VERIFIED', 'CLOSED');
      IF open_claims > 0 THEN
        RAISE EXCEPTION 'OPEN_WARRANTY_CLAIMS: % claims are still open', open_claims USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER warranty_obligation_guard BEFORE INSERT OR UPDATE ON machvon.warranty_obligation
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_warranty_obligation();

-- A claim is opened (or opened again) only on an obligation that is not closed. The obligation row is locked while the claim is written, so that the closure of the obligation and a new claim
-- cannot both pass their checks: whichever comes second sees the other.
CREATE FUNCTION machvon.guard_warranty_claim() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  held text;
BEGIN
  IF NEW.status IN ('VERIFIED', 'CLOSED') OR (TG_OP = 'UPDATE' AND OLD.status NOT IN ('VERIFIED', 'CLOSED')) THEN
    RETURN NEW;
  END IF;
  SELECT o.status INTO held FROM machvon.warranty_obligation o WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.obligation_id FOR SHARE;
  IF held = 'CLOSED' THEN
    RAISE EXCEPTION 'WARRANTY_STATE_INVALID: the obligation is closed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER warranty_claim_guard BEFORE INSERT OR UPDATE ON machvon.warranty_claim
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_warranty_claim();
