-- Authored by hand (not generated): the governance of the report forms and the obligation rules (ST-MNE-001, MNE F1, BR-MNE-01, BR-MNE-02).
-- A form revision and a rule revision are legal data with an effective period. Their content never changes after they are written: a
-- change is a new revision that takes over from a date. The maker and the checker are two different people, and the database has the
-- last word on both that and on the overlap of two published periods, whatever the application checked first.
--
-- The period is half open everywhere: `effective_until` is the first day the revision no longer applies (as in DOC and MDM).
-- A legal confirmation is not a second step: it is the `legal_confirmation_ref` that a revision carries. A revision without one is a
-- working assumption that waits for its confirmation (the screens and the exported files say so); confirming it is publishing the next
-- revision with the reference.

ALTER TABLE machvon.mne_report_form ADD COLUMN origin text NOT NULL DEFAULT 'TENANT';
ALTER TABLE machvon.mne_report_form ADD COLUMN pack_version text;
ALTER TABLE machvon.mne_report_form ADD COLUMN watermark_text text;
ALTER TABLE machvon.mne_report_form ADD COLUMN published_at timestamptz;
ALTER TABLE machvon.mne_report_form ADD COLUMN retired_at timestamptz;

ALTER TABLE machvon.mne_obligation_rule ADD COLUMN origin text NOT NULL DEFAULT 'TENANT';
ALTER TABLE machvon.mne_obligation_rule ADD COLUMN pack_version text;
ALTER TABLE machvon.mne_obligation_rule ADD COLUMN published_at timestamptz;
ALTER TABLE machvon.mne_obligation_rule ADD COLUMN retired_at timestamptz;

-- Only the platform pack has a pack version; a revision of the pack has no maker among the members, so it names no approver either.
ALTER TABLE machvon.mne_report_form
  ADD CONSTRAINT mne_form_origin_chk CHECK (origin IN ('PLATFORM_PACK', 'TENANT') AND (origin = 'PLATFORM_PACK') = (pack_version IS NOT NULL));
ALTER TABLE machvon.mne_obligation_rule
  ADD CONSTRAINT mne_rule_origin_chk CHECK (origin IN ('PLATFORM_PACK', 'TENANT') AND (origin = 'PLATFORM_PACK') = (pack_version IS NOT NULL));

-- Maker is not checker; a published tenant revision names its checker and when; a retired one says when it was taken over.
ALTER TABLE machvon.mne_report_form ADD CONSTRAINT mne_form_sod_chk CHECK (approved_by IS NULL OR approved_by <> created_by);
ALTER TABLE machvon.mne_obligation_rule ADD CONSTRAINT mne_rule_sod_chk CHECK (approved_by IS NULL OR approved_by <> created_by);
ALTER TABLE machvon.mne_report_form
  ADD CONSTRAINT mne_form_publish_chk CHECK (status = 'DRAFT' OR published_at IS NOT NULL AND (origin <> 'TENANT' OR approved_by IS NOT NULL));
ALTER TABLE machvon.mne_obligation_rule
  ADD CONSTRAINT mne_rule_publish_chk CHECK (status = 'DRAFT' OR published_at IS NOT NULL AND (origin <> 'TENANT' OR approved_by IS NOT NULL));
ALTER TABLE machvon.mne_report_form
  ADD CONSTRAINT mne_form_retire_chk CHECK ((status = 'RETIRED') = (retired_at IS NOT NULL) AND (status <> 'RETIRED' OR effective_until IS NOT NULL));
ALTER TABLE machvon.mne_obligation_rule
  ADD CONSTRAINT mne_rule_retire_chk CHECK ((status = 'RETIRED') = (retired_at IS NOT NULL) AND (status <> 'RETIRED' OR effective_until IS NOT NULL));

-- A form is a structure and a rule is a formula: both are objects, and a form names the formats it can be exported in.
ALTER TABLE machvon.mne_report_form
  ADD CONSTRAINT mne_form_shape_chk CHECK (jsonb_typeof(schema_json) = 'object' AND cardinality(export_formats) > 0 AND export_formats <@ ARRAY['XLSX', 'PDF', 'XML', 'CSV']);
ALTER TABLE machvon.mne_obligation_rule
  ADD CONSTRAINT mne_rule_shape_chk CHECK (jsonb_typeof(due_rule_json) = 'object');
ALTER TABLE machvon.mne_report_form
  ADD CONSTRAINT mne_form_text_chk CHECK (form_code = btrim(form_code) AND form_code <> '' AND doc_template_code = btrim(doc_template_code) AND doc_template_code <> '');
ALTER TABLE machvon.mne_obligation_rule
  ADD CONSTRAINT mne_rule_text_chk CHECK (rule_code = btrim(rule_code) AND rule_code <> '' AND btrim(recipient) <> '');

-- No two published periods of one code overlap (a retired revision keeps the period it was in force: a report still names it).
ALTER TABLE machvon.mne_report_form
  ADD CONSTRAINT mne_form_no_overlap EXCLUDE USING gist (
    tenant_id WITH =,
    form_code WITH =,
    daterange(effective_from, effective_until, '[)') WITH &&
  ) WHERE (status <> 'DRAFT');
ALTER TABLE machvon.mne_obligation_rule
  ADD CONSTRAINT mne_rule_no_overlap EXCLUDE USING gist (
    tenant_id WITH =,
    rule_code WITH =,
    daterange(effective_from, effective_until, '[)') WITH &&
  ) WHERE (status <> 'DRAFT');

-- The lookup of the revision in force on a date.
CREATE INDEX mne_form_in_force_idx ON machvon.mne_report_form (tenant_id, form_code, effective_from) WHERE status <> 'DRAFT';
CREATE INDEX mne_rule_in_force_idx ON machvon.mne_obligation_rule (tenant_id, frequency, effective_from) WHERE status <> 'DRAFT';
-- The calendar lists the obligations of a year by due date.
CREATE INDEX mne_report_obligation_due_idx ON machvon.mne_report (tenant_id, report_year, due_date, id) WHERE obligation_rule_id IS NOT NULL;

-- Kept for good (retention: for ever): a report names the revision it was made with years later.
REVOKE DELETE, TRUNCATE ON TABLE machvon.mne_report_form FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.mne_obligation_rule FROM machvon_app;

-- The guard of both tables. A revision keeps its content; the only moves are the publication (DRAFT to PUBLISHED, once, by the checker),
-- the takeover (PUBLISHED to RETIRED with the day the successor starts) and the shortening of a published period.
CREATE FUNCTION machvon.guard_mne_dated_revision() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_mutable constant text[] := ARRAY['status', 'effective_until', 'approved_by', 'published_at', 'retired_at', 'updated_at', 'updated_by', 'version'];
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'MNE forms and rules are never deleted (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;

  IF (to_jsonb(NEW) - v_mutable) IS DISTINCT FROM (to_jsonb(OLD) - v_mutable) THEN
    RAISE EXCEPTION 'the content of a revision never changes: publish a new revision (UPDATE on %.% by %)', TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;

  IF NOT (OLD.status = NEW.status OR (OLD.status = 'DRAFT' AND NEW.status = 'PUBLISHED') OR (OLD.status = 'PUBLISHED' AND NEW.status = 'RETIRED')) THEN
    RAISE EXCEPTION 'a revision cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;

  -- The approval is written once, by the move to PUBLISHED.
  IF OLD.status = 'DRAFT' AND NEW.status = 'PUBLISHED' THEN
    IF NEW.approved_by IS NULL OR NEW.published_at IS NULL OR NEW.approved_by = OLD.created_by THEN
      RAISE EXCEPTION 'publishing a revision names a checker other than its maker, and the time' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'the approval of a revision is written once' USING ERRCODE = '42501';
  END IF;

  -- A published period only ever ends, and only with the takeover (a successor starts on that date): never moved or widened.
  IF NEW.effective_until IS DISTINCT FROM OLD.effective_until THEN
    IF NOT (OLD.status = 'PUBLISHED' AND NEW.status = 'RETIRED' AND NEW.effective_until IS NOT NULL AND (OLD.effective_until IS NULL OR NEW.effective_until < OLD.effective_until)) THEN
      RAISE EXCEPTION 'the period of a revision only ends with its takeover by a successor' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- The takeover is written once, by the move to RETIRED.
  IF NOT (OLD.status = 'PUBLISHED' AND NEW.status = 'RETIRED') AND NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
    RAISE EXCEPTION 'the retirement of a revision is written once' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER mne_report_form_guard BEFORE UPDATE OR DELETE ON machvon.mne_report_form
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_mne_dated_revision();
CREATE TRIGGER mne_obligation_rule_guard BEFORE UPDATE OR DELETE ON machvon.mne_obligation_rule
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_mne_dated_revision();
