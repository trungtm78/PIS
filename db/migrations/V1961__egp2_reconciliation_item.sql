-- Authored by hand (not generated): the reconciliation of our data against what the files of the national procurement network said (EGP-2, BID-26, docs/egp-connector.md sections 6 and 12).
-- `egp_record` keeps what a file said; this table keeps every field on which it and our register disagree, each as an item with an owner who answers for it and, when it is settled, a resolution:
--   ACCEPT_EXTERNAL (the network is right: our record is then changed by the owner of that record through its own command, never from here), CORRECT_OURS (ours is right: check whether a corrected posting is due),
--   DISPUTE (the network is wrong: the letter to the operator is the evidence), WAIVE (leave it, with a reason and a day to look at it again within a year).
-- Maker is not checker, at the database too: the owner and the person who resolves are never among the people who made our record or loaded the file (`maker_ids`).
-- One OPEN item for a field of a subject at a time (a partial unique index) and the fingerprint of both values makes a second reading of the same records open nothing; a settled difference comes back only when a
-- figure moved, or when a waiver reaches its review day. The row is the item for good: an open item changes only by being resolved, a resolved item never changes.

CREATE TABLE machvon.egp_reconciliation_item (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  subject_code text NOT NULL,
  external_code text NOT NULL,
  field text NOT NULL,
  difference_kind text NOT NULL,
  ours text,
  theirs text,
  delta text,
  fingerprint char(64) NOT NULL,
  source_record_id uuid,
  import_id uuid,
  state text NOT NULL DEFAULT 'OPEN',
  owner_id uuid NOT NULL,
  maker_ids uuid[] NOT NULL,
  opened_by uuid NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL,
  resolution_kind text,
  resolved_by uuid,
  resolved_at timestamptz,
  reason text,
  evidence_ref text,
  review_on date,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, source_record_id) REFERENCES machvon.egp_record (tenant_id, id),
  FOREIGN KEY (tenant_id, import_id) REFERENCES machvon.file_import (tenant_id, id),
  CONSTRAINT egp_reconciliation_subject_chk CHECK (subject_type IN ('PROJECT', 'PLAN', 'PACKAGE', 'NOTICE', 'RESULT', 'CONTRACT', 'CONTRACTOR')),
  CONSTRAINT egp_reconciliation_text_chk CHECK (subject_code = btrim(subject_code) AND subject_code <> '' AND char_length(subject_code) <= 100 AND external_code = btrim(external_code) AND external_code <> '' AND char_length(external_code) <= 100
    AND field ~ '^[a-z][a-z0-9_]{1,59}$'),
  CONSTRAINT egp_reconciliation_kind_chk CHECK (difference_kind IN ('VALUE_MISMATCH', 'MISSING_OURS', 'MISSING_THEIRS')),
  CONSTRAINT egp_reconciliation_values_chk CHECK (
    (difference_kind = 'VALUE_MISMATCH' AND ours IS NOT NULL AND theirs IS NOT NULL)
    OR (difference_kind = 'MISSING_OURS' AND ours IS NULL AND theirs IS NOT NULL)
    OR (difference_kind = 'MISSING_THEIRS' AND ours IS NOT NULL AND theirs IS NULL)),
  CONSTRAINT egp_reconciliation_fingerprint_chk CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT egp_reconciliation_state_chk CHECK (state IN ('OPEN', 'RESOLVED')),
  CONSTRAINT egp_reconciliation_makers_chk CHECK (cardinality(maker_ids) >= 1 AND NOT (owner_id = ANY (maker_ids))),
  CONSTRAINT egp_reconciliation_due_chk CHECK (due_at > opened_at),
  CONSTRAINT egp_reconciliation_resolution_chk CHECK (
    (state = 'OPEN' AND resolution_kind IS NULL AND resolved_by IS NULL AND resolved_at IS NULL AND reason IS NULL AND evidence_ref IS NULL AND review_on IS NULL)
    OR (state = 'RESOLVED' AND resolution_kind IN ('ACCEPT_EXTERNAL', 'CORRECT_OURS', 'DISPUTE', 'WAIVE') AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND reason IS NOT NULL
        AND char_length(reason) >= (CASE WHEN resolution_kind IN ('DISPUTE', 'WAIVE') THEN 20 ELSE 10 END) AND char_length(reason) <= 1000
        AND (resolution_kind <> 'DISPUTE' OR evidence_ref IS NOT NULL)
        AND (resolution_kind = 'WAIVE') = (review_on IS NOT NULL)
        AND NOT (resolved_by = ANY (maker_ids)))),
  CONSTRAINT egp_reconciliation_evidence_chk CHECK (evidence_ref IS NULL OR (evidence_ref = btrim(evidence_ref) AND char_length(evidence_ref) BETWEEN 1 AND 200)),
  CONSTRAINT egp_reconciliation_version_chk CHECK (version >= 1)
);
CREATE UNIQUE INDEX egp_reconciliation_open_uq ON machvon.egp_reconciliation_item (tenant_id, subject_type, subject_id, field) WHERE state = 'OPEN';
CREATE INDEX egp_reconciliation_state_idx ON machvon.egp_reconciliation_item (tenant_id, state, due_at, id);
CREATE INDEX egp_reconciliation_owner_idx ON machvon.egp_reconciliation_item (tenant_id, owner_id, state, due_at);
CREATE INDEX egp_reconciliation_subject_idx ON machvon.egp_reconciliation_item (tenant_id, subject_id, field, opened_at DESC);
CREATE INDEX egp_reconciliation_fingerprint_idx ON machvon.egp_reconciliation_item (tenant_id, fingerprint);
CREATE INDEX egp_reconciliation_record_idx ON machvon.egp_reconciliation_item (tenant_id, source_record_id) WHERE source_record_id IS NOT NULL;
CREATE INDEX egp_reconciliation_import_idx ON machvon.egp_reconciliation_item (tenant_id, import_id) WHERE import_id IS NOT NULL;

CREATE FUNCTION machvon.guard_egp_reconciliation_item() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.state = 'RESOLVED' THEN
    RAISE EXCEPTION 'a resolved reconciliation item never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.subject_type IS DISTINCT FROM OLD.subject_type OR NEW.subject_id IS DISTINCT FROM OLD.subject_id OR NEW.subject_code IS DISTINCT FROM OLD.subject_code OR NEW.external_code IS DISTINCT FROM OLD.external_code
     OR NEW.field IS DISTINCT FROM OLD.field OR NEW.difference_kind IS DISTINCT FROM OLD.difference_kind OR NEW.ours IS DISTINCT FROM OLD.ours OR NEW.theirs IS DISTINCT FROM OLD.theirs OR NEW.delta IS DISTINCT FROM OLD.delta
     OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.maker_ids IS DISTINCT FROM OLD.maker_ids OR NEW.opened_by IS DISTINCT FROM OLD.opened_by
     OR NEW.opened_at IS DISTINCT FROM OLD.opened_at OR NEW.due_at IS DISTINCT FROM OLD.due_at OR NEW.source_record_id IS DISTINCT FROM OLD.source_record_id OR NEW.import_id IS DISTINCT FROM OLD.import_id THEN
    RAISE EXCEPTION 'a reconciliation item keeps the statement it was opened on' USING ERRCODE = '23514';
  END IF;
  IF NEW.state <> 'RESOLVED' OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'an open reconciliation item changes only by being resolved, with a new version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER egp_reconciliation_item_guard BEFORE UPDATE ON machvon.egp_reconciliation_item FOR EACH ROW EXECUTE FUNCTION machvon.guard_egp_reconciliation_item();

ALTER TABLE machvon.egp_reconciliation_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.egp_reconciliation_item FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.egp_reconciliation_item AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.egp_reconciliation_item AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.egp_reconciliation_item FROM machvon_app;

COMMENT ON TABLE machvon.egp_reconciliation_item IS 'EGP-2: a field on which our register and what a file of the national network said disagree: an owner who is not a maker, and a resolution (accept the external figure, correct ours, dispute, waive).';
