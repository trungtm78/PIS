-- Authored by hand (not generated): the contractor registry (ST-BID-002, BID 3 F2).
-- The tables contractor and contractor_restriction come from the generated schema (V002, with the extension columns of BID); this adds what
-- the registry relies on: the values a verification may take, the honest record of how an identity was verified (the document a person
-- checked, and what the official lookup said and through which adapter), the guards that keep an identity for good, and a restriction
-- that is a legal record: it is added, its end may be brought forward, and it is never rewritten or deleted.

-- How the tax id was verified. EVIDENCE_DOCUMENT: a person checked the registration certificate the evidence document holds.
-- EVIDENCE_DOCUMENT_AND_LOOKUP: the same, and an official lookup answered MATCH through an adapter whose own status is VERIFIED. A lookup
-- through an adapter that is PROPOSED, MOCK or MISSING is kept as what it was but never turns into the second kind (a missing lookup is not
-- a VERIFIED one: the comparison is made on coalesced values, because a CHECK that evaluates to NULL passes).
ALTER TABLE machvon.contractor
  ADD COLUMN verification_basis text,
  ADD COLUMN lookup_adapter_status text,
  ADD COLUMN lookup_outcome text,
  ADD COLUMN lookup_checked_at timestamptz;

ALTER TABLE machvon.contractor
  ADD CONSTRAINT contractor_verification_status_chk CHECK (verification_status IN ('UNVERIFIED', 'VERIFIED', 'REJECTED')),
  ADD CONSTRAINT contractor_tax_identifier_chk CHECK (tax_identifier ~ '^[0-9]{10}(-[0-9]{3})?$'),
  ADD CONSTRAINT contractor_sod_chk CHECK (verified_by IS NULL OR created_by IS NULL OR verified_by <> created_by),
  ADD CONSTRAINT contractor_lookup_chk CHECK (
    (lookup_adapter_status IS NULL) = (lookup_outcome IS NULL)
    AND (lookup_outcome IS NULL) = (lookup_checked_at IS NULL)
    AND (lookup_adapter_status IS NULL OR lookup_adapter_status IN ('VERIFIED', 'PROPOSED', 'MOCK', 'MISSING'))
    AND (lookup_outcome IS NULL OR lookup_outcome IN ('MATCH', 'NOT_FOUND', 'NAME_MISMATCH', 'UNAVAILABLE'))
  ),
  ADD CONSTRAINT contractor_basis_chk CHECK (
    verification_basis IS NULL
    OR (verification_status = 'VERIFIED'
        AND (verification_basis = 'EVIDENCE_DOCUMENT'
             OR (verification_basis = 'EVIDENCE_DOCUMENT_AND_LOOKUP' AND coalesce(lookup_adapter_status, '') = 'VERIFIED' AND coalesce(lookup_outcome, '') = 'MATCH')))
  );

CREATE INDEX contractor_tax_identifier_idx ON machvon.contractor (tenant_id, tax_identifier);

-- An identity is kept for good: the tax id never changes, a decision is final (a verified contractor stays verified, a rejected one stays
-- rejected: a mistake is answered by a new registration and, for duplicates, by a merge in master data), and a contractor becomes verified
-- only with the person, the time and the evidence of the decision. Rows seeded as VERIFIED by fixtures do not go through this transition.
CREATE FUNCTION machvon.guard_contractor_identity() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.tax_identifier IS DISTINCT FROM OLD.tax_identifier THEN
    RAISE EXCEPTION 'a contractor keeps its tax id' USING ERRCODE = '23514';
  END IF;
  IF OLD.verification_status IN ('VERIFIED', 'REJECTED') AND NEW.verification_status IS DISTINCT FROM OLD.verification_status THEN
    RAISE EXCEPTION 'the verification decision of a contractor is final' USING ERRCODE = '23514';
  END IF;
  IF NEW.verification_status = 'VERIFIED' AND OLD.verification_status IS DISTINCT FROM 'VERIFIED'
     AND (NEW.verified_by IS NULL OR NEW.verified_at IS NULL OR NEW.verification_evidence_document_id IS NULL OR NEW.verification_basis IS NULL) THEN
    RAISE EXCEPTION 'a contractor is verified by a person, at a time, on evidence' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER contractor_identity_guard BEFORE UPDATE ON machvon.contractor
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_contractor_identity();

-- The last day of a restriction is a day on which it still applies, so a restriction of one day has the same first and last day.
ALTER TABLE machvon.contractor_restriction DROP CONSTRAINT contractor_restriction_range_chk;
ALTER TABLE machvon.contractor_restriction
  ADD CONSTRAINT contractor_restriction_range_chk CHECK (effective_until IS NULL OR effective_until >= effective_from);

CREATE INDEX contractor_restriction_in_force_idx ON machvon.contractor_restriction (tenant_id, contractor_id, effective_from, effective_until);

-- A restriction is a legal record: nothing about who, what, on which decision and from when can be rewritten, and it is never deleted.
-- Its end date and its note may change (a decision may bring the end forward); the rest of the row stays as it was written.
CREATE FUNCTION machvon.guard_contractor_restriction() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a restriction of a contractor is never deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW.contractor_id, NEW.kind, NEW.source, NEW.effective_from, NEW.decision_document_id, NEW.import_batch_id, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.contractor_id, OLD.kind, OLD.source, OLD.effective_from, OLD.decision_document_id, OLD.import_batch_id, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'a restriction of a contractor is not rewritten' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER contractor_restriction_guard BEFORE UPDATE OR DELETE ON machvon.contractor_restriction
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_contractor_restriction();

REVOKE DELETE, TRUNCATE ON TABLE machvon.contractor_restriction FROM machvon_app;
