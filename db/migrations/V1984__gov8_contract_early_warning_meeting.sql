-- Authored by hand (not generated): the meetings that review the early-warning register of a contract and the issues of the register (GOV-8, roadmap G1-15, docs/ctr-early-warning.md).
--   * `contract_early_warning_meeting`: one row per meeting (the day it was held, who attended, the notes, the minutes if they are filed in DOC); the next meeting is due a rhythm after it (rule
--     `EARLY_WARNING_POLICY`, never a constant);
--   * `contract_early_warning_review`: what the meeting concluded about each warning that was open on the day (a meeting that skips an open warning did not review the register: the application checks that every
--     open warning is named once), with the state the warning was in;
--   * `contract_early_warning_issue`: each issue of the register: the first one after the contract starts (INITIAL), the one that follows a meeting (AFTER_MEETING) and any other (PERIODIC), with the warnings it
--     held (a snapshot) and its hash, so that what was issued on a day can be read back as it was.
-- All three are append-only for every role: a meeting that was held and a register that was issued are facts; a correction is a new row that says so.

CREATE TABLE machvon.contract_early_warning_meeting (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL,
  ordinal integer NOT NULL,
  held_on date NOT NULL,
  attendees text NOT NULL,
  notes text,
  minutes_document_version_id uuid,
  recorded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES machvon.contract (tenant_id, id),
  FOREIGN KEY (tenant_id, minutes_document_version_id) REFERENCES machvon.document_version (tenant_id, id),
  CONSTRAINT contract_early_warning_meeting_ordinal_chk CHECK (ordinal >= 1),
  CONSTRAINT contract_early_warning_meeting_text_chk CHECK (attendees = btrim(attendees) AND char_length(attendees) BETWEEN 5 AND 2000 AND (notes IS NULL OR (notes = btrim(notes) AND char_length(notes) BETWEEN 5 AND 2000))),
  CONSTRAINT contract_early_warning_meeting_order_uq UNIQUE (tenant_id, contract_id, ordinal),
  CONSTRAINT contract_early_warning_meeting_day_uq UNIQUE (tenant_id, contract_id, held_on)
);

CREATE INDEX contract_early_warning_meeting_minutes_document_version_id_idx ON machvon.contract_early_warning_meeting (tenant_id, minutes_document_version_id) WHERE minutes_document_version_id IS NOT NULL;

CREATE TABLE machvon.contract_early_warning_review (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  meeting_id uuid NOT NULL,
  warning_id uuid NOT NULL,
  outcome text NOT NULL,
  note text,
  status_at_meeting text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, meeting_id) REFERENCES machvon.contract_early_warning_meeting (tenant_id, id),
  FOREIGN KEY (tenant_id, warning_id) REFERENCES machvon.contract_early_warning (tenant_id, id),
  CONSTRAINT contract_early_warning_review_outcome_chk CHECK (outcome IN ('NO_CHANGE', 'UPDATED', 'ACTION_AGREED', 'CLOSURE_PROPOSED', 'ESCALATED')),
  CONSTRAINT contract_early_warning_review_status_chk CHECK (status_at_meeting IN ('RAISED', 'ASSESSED', 'MITIGATING')),
  CONSTRAINT contract_early_warning_review_note_chk CHECK (note IS NULL OR (note = btrim(note) AND char_length(note) BETWEEN 5 AND 2000)),
  CONSTRAINT contract_early_warning_review_once_uq UNIQUE (tenant_id, meeting_id, warning_id)
);

CREATE INDEX contract_early_warning_review_warning_id_idx ON machvon.contract_early_warning_review (tenant_id, warning_id, created_at DESC);

CREATE TABLE machvon.contract_early_warning_issue (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL,
  ordinal integer NOT NULL,
  kind text NOT NULL,
  issued_on date NOT NULL,
  meeting_id uuid,
  warning_count integer NOT NULL,
  open_count integer NOT NULL,
  content_hash char(64) NOT NULL,
  snapshot jsonb NOT NULL,
  issued_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES machvon.contract (tenant_id, id),
  FOREIGN KEY (tenant_id, meeting_id) REFERENCES machvon.contract_early_warning_meeting (tenant_id, id),
  CONSTRAINT contract_early_warning_issue_kind_chk CHECK (kind IN ('INITIAL', 'AFTER_MEETING', 'PERIODIC')),
  CONSTRAINT contract_early_warning_issue_meeting_chk CHECK ((kind = 'AFTER_MEETING') = (meeting_id IS NOT NULL)),
  CONSTRAINT contract_early_warning_issue_counts_chk CHECK (ordinal >= 1 AND warning_count >= 0 AND open_count >= 0 AND open_count <= warning_count),
  CONSTRAINT contract_early_warning_issue_hash_chk CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT contract_early_warning_issue_shape_chk CHECK (jsonb_typeof(snapshot) = 'array'),
  CONSTRAINT contract_early_warning_issue_order_uq UNIQUE (tenant_id, contract_id, ordinal)
);

CREATE UNIQUE INDEX contract_early_warning_issue_meeting_uq ON machvon.contract_early_warning_issue (tenant_id, meeting_id) WHERE meeting_id IS NOT NULL;

CREATE FUNCTION machvon.contract_early_warning_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'a meeting of the early-warning register, what it concluded and an issue of the register are append-only' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER contract_early_warning_meeting_append_only BEFORE UPDATE OR DELETE ON machvon.contract_early_warning_meeting FOR EACH ROW EXECUTE FUNCTION machvon.contract_early_warning_append_only();
CREATE TRIGGER contract_early_warning_review_append_only BEFORE UPDATE OR DELETE ON machvon.contract_early_warning_review FOR EACH ROW EXECUTE FUNCTION machvon.contract_early_warning_append_only();
CREATE TRIGGER contract_early_warning_issue_append_only BEFORE UPDATE OR DELETE ON machvon.contract_early_warning_issue FOR EACH ROW EXECUTE FUNCTION machvon.contract_early_warning_append_only();

ALTER TABLE machvon.contract_early_warning_meeting ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.contract_early_warning_meeting FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.contract_early_warning_meeting AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.contract_early_warning_meeting AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.contract_early_warning_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.contract_early_warning_review FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.contract_early_warning_review AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.contract_early_warning_review AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.contract_early_warning_issue ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.contract_early_warning_issue FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.contract_early_warning_issue AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.contract_early_warning_issue AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.contract_early_warning_meeting FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.contract_early_warning_review FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.contract_early_warning_issue FROM machvon_app;

COMMENT ON TABLE machvon.contract_early_warning_meeting IS 'GOV-8: a meeting that reviewed the early-warning register of a contract; append-only.';
COMMENT ON TABLE machvon.contract_early_warning_review IS 'GOV-8: what a meeting concluded about one warning; append-only.';
COMMENT ON TABLE machvon.contract_early_warning_issue IS 'GOV-8: an issue of the early-warning register of a contract with a snapshot of the warnings and its hash; append-only.';
