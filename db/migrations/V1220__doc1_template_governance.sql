-- Authored by hand (not generated): the governance of the template library (ST-DOC-006, BR-DOC-09, BR-DOC-10, DOC F12).
-- A template revision is data with an effective period. Its content never changes after it is written: a change is a new
-- revision. The drafter, the publisher and the legal confirmer are three separate steps, and nobody takes two of them on
-- the same revision. The legal confirmation keeps the evidence document, who confirmed and when; it is written once.

ALTER TABLE machvon.document_template ADD COLUMN published_at timestamptz;
ALTER TABLE machvon.document_template ADD COLUMN legal_evidence_document_id uuid;
ALTER TABLE machvon.document_template ADD COLUMN legal_confirmation_note text;
ALTER TABLE machvon.document_template ADD COLUMN retired_at timestamptz;
ALTER TABLE machvon.document_template ADD COLUMN retired_by uuid;
ALTER TABLE machvon.document_template ADD COLUMN retirement_reason text;

ALTER TABLE machvon.document_template
  ADD CONSTRAINT document_template_evidence_fk FOREIGN KEY (tenant_id, legal_evidence_document_id) REFERENCES machvon.document (tenant_id, id);
CREATE INDEX document_template_legal_evidence_idx ON machvon.document_template (tenant_id, legal_evidence_document_id);

-- A retired revision says when, by whom and why. A tenant revision that is published or superseded names its approver.
ALTER TABLE machvon.document_template
  ADD CONSTRAINT document_template_retire_chk CHECK (status <> 'RETIRED' OR (retired_at IS NOT NULL AND retired_by IS NOT NULL AND retirement_reason IS NOT NULL));
ALTER TABLE machvon.document_template
  ADD CONSTRAINT document_template_publish_chk CHECK (origin <> 'TENANT' OR status NOT IN ('PUBLISHED', 'SUPERSEDED') OR approved_by IS NOT NULL);
-- Only the platform pack has a pack version.
ALTER TABLE machvon.document_template
  ADD CONSTRAINT document_template_pack_chk CHECK (origin <> 'TENANT' OR pack_version IS NULL);

CREATE FUNCTION machvon.guard_document_template() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  moved boolean;
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'document templates are never deleted (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user
      USING ERRCODE = '42501';
  END IF;

  -- The content of a revision (its text, legal basis, layout and start date) is fixed when it is written.
  IF (to_jsonb(NEW) - ARRAY['status', 'confirmation_status', 'effective_until', 'approved_by', 'published_at', 'legal_confirmation_ref',
        'legal_confirmed_by', 'legal_confirmed_at', 'legal_evidence_document_id', 'legal_confirmation_note', 'retired_at', 'retired_by',
        'retirement_reason', 'updated_at', 'updated_by', 'version'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status', 'confirmation_status', 'effective_until', 'approved_by', 'published_at', 'legal_confirmation_ref',
        'legal_confirmed_by', 'legal_confirmed_at', 'legal_evidence_document_id', 'legal_confirmation_note', 'retired_at', 'retired_by',
        'retirement_reason', 'updated_at', 'updated_by', 'version']) THEN
    RAISE EXCEPTION 'the content of a document template revision never changes (UPDATE on %.% by %)', TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user
      USING ERRCODE = '42501';
  END IF;

  IF NOT (OLD.status = NEW.status
          OR (OLD.status = 'DRAFT' AND NEW.status IN ('PUBLISHED', 'RETIRED'))
          OR (OLD.status = 'PUBLISHED' AND NEW.status IN ('RETIRED', 'SUPERSEDED'))) THEN
    RAISE EXCEPTION 'a document template cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;

  -- The approval is written once, by the move to PUBLISHED.
  moved := OLD.status = 'DRAFT' AND NEW.status = 'PUBLISHED';
  IF moved THEN
    IF NEW.approved_by IS NULL OR NEW.published_at IS NULL THEN
      RAISE EXCEPTION 'publishing a document template names the approver and the time' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'the approval of a document template is written once' USING ERRCODE = '42501';
  END IF;

  -- A published period is only ever shortened (a successor takes over from a date), never moved or widened.
  IF NEW.effective_until IS DISTINCT FROM OLD.effective_until THEN
    IF NOT (OLD.status = 'PUBLISHED' AND NEW.status = 'PUBLISHED' AND NEW.effective_until IS NOT NULL
            AND (OLD.effective_until IS NULL OR NEW.effective_until < OLD.effective_until)) THEN
      RAISE EXCEPTION 'the period of a document template can only be shortened while it is published' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- The legal confirmation: PENDING_CONFIRMATION to CONFIRMED once, on a published revision, with its evidence, by someone
  -- who neither drafted nor published it. It is never undone here.
  IF NEW.confirmation_status IS DISTINCT FROM OLD.confirmation_status THEN
    IF NOT (OLD.confirmation_status = 'PENDING_CONFIRMATION' AND NEW.confirmation_status = 'CONFIRMED'
            AND OLD.status = 'PUBLISHED' AND NEW.status = 'PUBLISHED') THEN
      RAISE EXCEPTION 'a document template can only be confirmed once, while it is published' USING ERRCODE = '42501';
    END IF;
    IF NEW.legal_evidence_document_id IS NULL OR NEW.legal_confirmed_by IS NULL OR NEW.legal_confirmed_by = OLD.created_by
       OR NEW.legal_confirmed_by IS NOT DISTINCT FROM OLD.approved_by THEN
      RAISE EXCEPTION 'the legal confirmation needs its evidence and a confirmer who is neither the drafter nor the publisher' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.legal_confirmation_ref IS DISTINCT FROM OLD.legal_confirmation_ref
     OR NEW.legal_confirmed_by IS DISTINCT FROM OLD.legal_confirmed_by
     OR NEW.legal_confirmed_at IS DISTINCT FROM OLD.legal_confirmed_at
     OR NEW.legal_evidence_document_id IS DISTINCT FROM OLD.legal_evidence_document_id
     OR NEW.legal_confirmation_note IS DISTINCT FROM OLD.legal_confirmation_note THEN
    RAISE EXCEPTION 'the legal confirmation of a document template is written once' USING ERRCODE = '42501';
  END IF;

  -- The retirement is written once, by the move to RETIRED.
  IF NOT (OLD.status <> 'RETIRED' AND NEW.status = 'RETIRED')
     AND (NEW.retired_at IS DISTINCT FROM OLD.retired_at OR NEW.retired_by IS DISTINCT FROM OLD.retired_by
          OR NEW.retirement_reason IS DISTINCT FROM OLD.retirement_reason) THEN
    RAISE EXCEPTION 'the retirement of a document template is written once' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER document_template_guard BEFORE UPDATE OR DELETE ON machvon.document_template
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_document_template();
CREATE TRIGGER document_template_no_truncate BEFORE TRUNCATE ON machvon.document_template
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_document_template();

REVOKE TRUNCATE ON TABLE machvon.document_template FROM machvon_app;
