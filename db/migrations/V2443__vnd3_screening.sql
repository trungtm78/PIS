-- Authored by hand (not generated): continuous screening of the contractor registry against the lists of parties that may not be dealt with (VND-3, research V14; docs/vendor-investigation.md section 4).
-- The list of the national procurement network is read where the file import already keeps it (egp_record, kind RESTRICTION). The other lists (the multilateral banks, politically exposed persons, a list of the tenant)
-- enter through screening_list_import / screening_list_entry. A run compares every contractor with every entry in force with the rule VENDOR_SCREENING and writes the hits; a hit above the hold line holds the contractor
-- (the gate refuses new work) until a person confirms it (which opens the debarment case of VND-1) or dismisses it with a reason. A dismissal is asked again when the entry changed or the dismissal ran out. Every move is in
-- screening_hit_event, append-only. The screening never bans and never merges by itself.

CREATE TABLE machvon.screening_list_import (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source IN ('WORLD_BANK', 'ADB', 'PEP', 'OTHER_LIST')),
  as_of date NOT NULL,
  reference text NOT NULL CHECK (reference = btrim(reference) AND char_length(reference) BETWEEN 3 AND 300),
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  entry_count integer NOT NULL CHECK (entry_count >= 0),
  withdrawn_count integer NOT NULL DEFAULT 0 CHECK (withdrawn_count >= 0),
  imported_by uuid NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, imported_by) REFERENCES machvon.membership (tenant_id, id)
);
-- Idempotent means: the LATEST import of a source with the same content is the same import. A list that comes back after another one (the same content again) is a new import that lists its entries again.
CREATE INDEX screening_import_content_idx ON machvon.screening_list_import (tenant_id, source, content_sha256);
CREATE INDEX screening_import_actor_idx ON machvon.screening_list_import (tenant_id, imported_by);
CREATE INDEX screening_import_time_idx ON machvon.screening_list_import (tenant_id, source, imported_at DESC);

ALTER TABLE machvon.screening_list_import ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.screening_list_import FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.screening_list_import AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.screening_list_import AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.screening_list_import FROM machvon_app;
CREATE TRIGGER screening_list_import_append_only BEFORE UPDATE OR DELETE ON machvon.screening_list_import FOR EACH ROW EXECUTE FUNCTION machvon.vnd3_append_only();

COMMENT ON TABLE machvon.screening_list_import IS 'VND-3: one import of a list of parties that may not be dealt with (not the national list, which the file import keeps); idempotent when it repeats the latest import of its source.';

CREATE TABLE machvon.screening_list_entry (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source IN ('WORLD_BANK', 'ADB', 'PEP', 'OTHER_LIST')),
  source_ref text NOT NULL CHECK (source_ref = btrim(source_ref) AND char_length(source_ref) BETWEEN 1 AND 200),
  name text CHECK (name IS NULL OR (name = btrim(name) AND char_length(name) BETWEEN 1 AND 300)),
  tax_code text CHECK (tax_code IS NULL OR (tax_code = btrim(tax_code) AND char_length(tax_code) BETWEEN 3 AND 40)),
  valid_from date,
  valid_until date,
  row_hash char(64) NOT NULL CHECK (row_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'WITHDRAWN')),
  import_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, import_id) REFERENCES machvon.screening_list_import (tenant_id, id),
  CONSTRAINT screening_entry_ref_uq UNIQUE (tenant_id, source, source_ref),
  CONSTRAINT screening_entry_identity_chk CHECK (name IS NOT NULL OR tax_code IS NOT NULL),
  CONSTRAINT screening_entry_period_chk CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_until >= valid_from)
);
CREATE INDEX screening_entry_import_idx ON machvon.screening_list_entry (tenant_id, import_id);
CREATE INDEX screening_entry_tax_idx ON machvon.screening_list_entry (tenant_id, tax_code) WHERE tax_code IS NOT NULL;

ALTER TABLE machvon.screening_list_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.screening_list_entry FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.screening_list_entry AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.screening_list_entry AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE machvon.screening_list_entry FROM machvon_app;

COMMENT ON TABLE machvon.screening_list_entry IS 'VND-3: an entry of a list of parties that may not be dealt with; one row per source and reference, withdrawn when a later import no longer lists it.';

CREATE TABLE machvon.screening_run (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('NIGHTLY', 'PROFILE_CHANGE', 'LIST_IMPORT', 'MANUAL')),
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  contractors integer NOT NULL CHECK (contractors >= 0),
  entries integer NOT NULL CHECK (entries >= 0),
  hits_new integer NOT NULL CHECK (hits_new >= 0),
  hits_reopened integer NOT NULL CHECK (hits_reopened >= 0),
  hits_resolved integer NOT NULL CHECK (hits_resolved >= 0),
  holds integer NOT NULL CHECK (holds >= 0),
  policy_version text NOT NULL,
  requested_by uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT screening_run_period_chk CHECK (finished_at >= started_at)
);
CREATE INDEX screening_run_requester_idx ON machvon.screening_run (tenant_id, requested_by) WHERE requested_by IS NOT NULL;
CREATE INDEX screening_run_time_idx ON machvon.screening_run (tenant_id, finished_at DESC);

ALTER TABLE machvon.screening_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.screening_run FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.screening_run AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.screening_run AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.screening_run FROM machvon_app;
CREATE TRIGGER screening_run_append_only BEFORE UPDATE OR DELETE ON machvon.screening_run FOR EACH ROW EXECUTE FUNCTION machvon.vnd3_append_only();

COMMENT ON TABLE machvon.screening_run IS 'VND-3: one run of the screening: what it compared and what it found.';

CREATE TABLE machvon.screening_hit (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  contractor_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('NATIONAL_DEBARMENT', 'WORLD_BANK', 'ADB', 'PEP', 'OTHER_LIST')),
  entry_ref text NOT NULL CHECK (entry_ref = btrim(entry_ref) AND char_length(entry_ref) BETWEEN 1 AND 200),
  egp_record_id uuid,
  list_entry_id uuid,
  entry_row_hash char(64) NOT NULL CHECK (entry_row_hash ~ '^[0-9a-f]{64}$'),
  entry_name text CHECK (entry_name IS NULL OR (entry_name = btrim(entry_name) AND char_length(entry_name) BETWEEN 1 AND 300)),
  entry_tax_code text CHECK (entry_tax_code IS NULL OR (entry_tax_code = btrim(entry_tax_code) AND char_length(entry_tax_code) BETWEEN 3 AND 40)),
  entry_valid_from date,
  entry_valid_until date,
  score smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
  basis text[] NOT NULL CHECK (cardinality(basis) >= 1),
  similarity numeric(4,3) CHECK (similarity IS NULL OR similarity BETWEEN 0 AND 1),
  hold boolean NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CONFIRMED', 'DISMISSED', 'RESOLVED')),
  run_id uuid NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text CHECK (decision_reason IS NULL OR (decision_reason = btrim(decision_reason) AND char_length(decision_reason) BETWEEN 5 AND 2000)),
  decided_row_hash char(64),
  case_id uuid,
  reopened_count integer NOT NULL DEFAULT 0 CHECK (reopened_count >= 0),
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_id) REFERENCES machvon.contractor (tenant_id, id),
  FOREIGN KEY (tenant_id, egp_record_id) REFERENCES machvon.egp_record (tenant_id, id),
  FOREIGN KEY (tenant_id, list_entry_id) REFERENCES machvon.screening_list_entry (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES machvon.screening_run (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES machvon.restriction_case (tenant_id, id),
  CONSTRAINT screening_hit_entry_uq UNIQUE (tenant_id, contractor_id, source, entry_ref),
  CONSTRAINT screening_hit_origin_chk CHECK ((source = 'NATIONAL_DEBARMENT') = (egp_record_id IS NOT NULL) AND (source = 'NATIONAL_DEBARMENT') <> (list_entry_id IS NOT NULL)),
  CONSTRAINT screening_hit_decision_chk CHECK ((decided_at IS NULL) = (decided_by IS NULL) AND (status NOT IN ('CONFIRMED', 'DISMISSED') OR decided_at IS NOT NULL)),
  CONSTRAINT screening_hit_dismiss_chk CHECK (status <> 'DISMISSED' OR (decision_reason IS NOT NULL AND char_length(decision_reason) >= 20))
);
CREATE INDEX screening_hit_queue_idx ON machvon.screening_hit (tenant_id, status, score DESC, first_seen_at);
CREATE INDEX screening_hit_contractor_idx ON machvon.screening_hit (tenant_id, contractor_id, status);
CREATE INDEX screening_hold_idx ON machvon.screening_hit (tenant_id, contractor_id) WHERE hold AND status IN ('PENDING', 'CONFIRMED');
CREATE INDEX screening_hit_record_idx ON machvon.screening_hit (tenant_id, egp_record_id) WHERE egp_record_id IS NOT NULL;
CREATE INDEX screening_hit_entry_idx ON machvon.screening_hit (tenant_id, list_entry_id) WHERE list_entry_id IS NOT NULL;
CREATE INDEX screening_hit_run_idx ON machvon.screening_hit (tenant_id, run_id);
CREATE INDEX screening_hit_decider_idx ON machvon.screening_hit (tenant_id, decided_by) WHERE decided_by IS NOT NULL;
CREATE INDEX screening_hit_case_idx ON machvon.screening_hit (tenant_id, case_id) WHERE case_id IS NOT NULL;

ALTER TABLE machvon.screening_hit ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.screening_hit FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.screening_hit AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.screening_hit AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE machvon.screening_hit FROM machvon_app;

COMMENT ON TABLE machvon.screening_hit IS 'VND-3: a contractor that matches an entry of a list of parties that may not be dealt with, with the score and the reason, the hold it puts on the contractor and the decision of a person.';

CREATE TABLE machvon.screening_hit_event (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  hit_id uuid NOT NULL,
  move text NOT NULL CHECK (move IN ('FOUND', 'RESCORED', 'CONFIRM', 'DISMISS', 'RESOLVE', 'REOPEN')),
  from_status text,
  to_status text NOT NULL,
  actor_id uuid,
  reason text CHECK (reason IS NULL OR char_length(reason) <= 2000),
  score smallint NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, hit_id) REFERENCES machvon.screening_hit (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES machvon.membership (tenant_id, id)
);
CREATE INDEX screening_event_hit_idx ON machvon.screening_hit_event (tenant_id, hit_id, at);
CREATE INDEX screening_event_actor_idx ON machvon.screening_hit_event (tenant_id, actor_id, at DESC) WHERE actor_id IS NOT NULL;

ALTER TABLE machvon.screening_hit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.screening_hit_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.screening_hit_event AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.screening_hit_event AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.screening_hit_event FROM machvon_app;
CREATE TRIGGER screening_hit_event_append_only BEFORE UPDATE OR DELETE ON machvon.screening_hit_event FOR EACH ROW EXECUTE FUNCTION machvon.vnd3_append_only();

COMMENT ON TABLE machvon.screening_hit_event IS 'VND-3: the append-only history of a hit of the screening.';
