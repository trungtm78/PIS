-- Authored by hand (not generated): the independence and conflict of interest of the people and the bidders of a package (VND-2, research V5; docs/vendor-controls-independence-finance.md).
--   * `vendor_person_interest`: what a member of staff declares about themselves (a relative who represents or owns a contractor, a share held, a former employment, an advisory role). It is never rewritten: it ends.
--     The identity number of a relative is kept only as a blind index of the field cipher (HMAC), never stored.
--   * `vendor_independence_check`: one run of the detection for a package (who ran it, the rule version, a digest of the facts, the panel and the staff it covered). Append-only.
--   * `vendor_independence_finding`: a link the detection found (kind, strength, the two sides by id, the evidence as codes and numbers only). A person other than the one who raised it decides it once: cleared, recused
--     or blocked, with a reason. A finding found again by a later run is carried over with its decision, so a decision is never asked twice.

CREATE TABLE machvon.vendor_person_interest (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  membership_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('RELATIVE', 'SHAREHOLDING', 'FORMER_EMPLOYMENT', 'ADVISORY')),
  related_name text CHECK (related_name IS NULL OR (related_name = btrim(related_name) AND char_length(related_name) BETWEEN 2 AND 300)),
  related_name_key char(64) CHECK (related_name_key IS NULL OR related_name_key ~ '^[0-9a-f]{64}$'),
  related_identity_key char(64) CHECK (related_identity_key IS NULL OR related_identity_key ~ '^[0-9a-f]{64}$'),
  relation text CHECK (relation IS NULL OR (relation = btrim(relation) AND char_length(relation) BETWEEN 2 AND 100)),
  contractor_id uuid,
  tax_head text CHECK (tax_head IS NULL OR tax_head ~ '^[0-9]{10}$'),
  share_pct numeric(5,2) CHECK (share_pct IS NULL OR (share_pct >= 0 AND share_pct <= 100)),
  since_on date NOT NULL DEFAULT current_date,
  ended_on date,
  ended_reason text CHECK (ended_reason IS NULL OR (ended_reason = btrim(ended_reason) AND char_length(ended_reason) BETWEEN 5 AND 500)),
  document_id uuid,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_id) REFERENCES machvon.contractor (tenant_id, id),
  CONSTRAINT vendor_person_interest_period_chk CHECK (ended_on IS NULL OR ended_on >= since_on OR kind = 'FORMER_EMPLOYMENT'),
  CONSTRAINT vendor_person_interest_subject_chk CHECK (
    (kind = 'RELATIVE' AND related_name IS NOT NULL AND related_name_key IS NOT NULL)
    OR (kind <> 'RELATIVE' AND (contractor_id IS NOT NULL OR tax_head IS NOT NULL))
  ),
  CONSTRAINT vendor_person_interest_share_chk CHECK (kind <> 'SHAREHOLDING' OR share_pct IS NOT NULL)
);
CREATE INDEX vendor_person_interest_member_idx ON machvon.vendor_person_interest (tenant_id, membership_id, ended_on);
CREATE INDEX vendor_person_interest_contractor_idx ON machvon.vendor_person_interest (tenant_id, contractor_id) WHERE contractor_id IS NOT NULL;
CREATE INDEX vendor_person_interest_document_idx ON machvon.vendor_person_interest (tenant_id, document_id) WHERE document_id IS NOT NULL;

CREATE TABLE machvon.vendor_independence_check (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  package_id uuid NOT NULL,
  run_by uuid NOT NULL,
  run_at timestamptz NOT NULL DEFAULT now(),
  rule_version text NOT NULL,
  rule_unverified boolean NOT NULL,
  inputs_digest char(64) NOT NULL CHECK (inputs_digest ~ '^[0-9a-f]{64}$'),
  panel_ids uuid[] NOT NULL DEFAULT '{}',
  staff_ids uuid[] NOT NULL DEFAULT '{}',
  owner_tax_head text CHECK (owner_tax_head IS NULL OR owner_tax_head ~ '^[0-9]{10}$'),
  bidders_count integer NOT NULL CHECK (bidders_count >= 0),
  findings_count integer NOT NULL CHECK (findings_count >= 0),
  strong_count integer NOT NULL CHECK (strong_count >= 0),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, package_id) REFERENCES machvon.procurement_package (tenant_id, id)
);
CREATE INDEX vendor_independence_check_package_idx ON machvon.vendor_independence_check (tenant_id, package_id, run_at DESC);
CREATE INDEX vendor_independence_check_runner_idx ON machvon.vendor_independence_check (tenant_id, run_by, run_at DESC);

CREATE TABLE machvon.vendor_independence_finding (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  check_id uuid NOT NULL,
  package_id uuid NOT NULL,
  fingerprint text NOT NULL CHECK (char_length(fingerprint) BETWEEN 10 AND 300),
  kind text NOT NULL CHECK (char_length(kind) BETWEEN 3 AND 60),
  strength text NOT NULL CHECK (strength IN ('STRONG', 'MEDIUM')),
  parties jsonb NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  raised_by uuid NOT NULL,
  carried_from_id uuid,
  decision text CHECK (decision IS NULL OR decision IN ('CLEARED', 'RECUSED', 'BLOCKED')),
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text CHECK (decision_reason IS NULL OR (decision_reason = btrim(decision_reason) AND char_length(decision_reason) BETWEEN 20 AND 2000)),
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, check_id) REFERENCES machvon.vendor_independence_check (tenant_id, id),
  FOREIGN KEY (tenant_id, package_id) REFERENCES machvon.procurement_package (tenant_id, id),
  FOREIGN KEY (tenant_id, carried_from_id) REFERENCES machvon.vendor_independence_finding (tenant_id, id),
  CONSTRAINT vendor_independence_finding_uq UNIQUE (tenant_id, check_id, fingerprint),
  CONSTRAINT vendor_independence_finding_decision_chk CHECK (
    (decision IS NULL) = (decided_by IS NULL) AND (decision IS NULL) = (decided_at IS NULL) AND (decision IS NULL) = (decision_reason IS NULL)
    AND (decided_by IS NULL OR decided_by <> raised_by)
  )
);
CREATE INDEX vendor_independence_finding_check_idx ON machvon.vendor_independence_finding (tenant_id, check_id);
CREATE INDEX vendor_independence_finding_package_idx ON machvon.vendor_independence_finding (tenant_id, package_id, fingerprint);
CREATE INDEX vendor_independence_finding_open_idx ON machvon.vendor_independence_finding (tenant_id, package_id, strength) WHERE decision IS NULL;
CREATE INDEX vendor_independence_finding_carried_idx ON machvon.vendor_independence_finding (tenant_id, carried_from_id) WHERE carried_from_id IS NOT NULL;

-- An interest is never rewritten: it ends (once), and an end stays as it was made.
CREATE FUNCTION machvon.guard_vendor_person_interest() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an interest of a person is never deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW.membership_id, NEW.kind, NEW.related_name, NEW.related_name_key, NEW.related_identity_key, NEW.relation, NEW.contractor_id, NEW.tax_head, NEW.share_pct, NEW.since_on, NEW.document_id, NEW.created_by)
     IS DISTINCT FROM
     (OLD.membership_id, OLD.kind, OLD.related_name, OLD.related_name_key, OLD.related_identity_key, OLD.relation, OLD.contractor_id, OLD.tax_head, OLD.share_pct, OLD.since_on, OLD.document_id, OLD.created_by) THEN
    RAISE EXCEPTION 'an interest of a person is not rewritten: it ends and a new one is declared' USING ERRCODE = '23514';
  END IF;
  IF OLD.ended_reason IS NOT NULL AND (NEW.ended_on IS DISTINCT FROM OLD.ended_on OR NEW.ended_reason IS DISTINCT FROM OLD.ended_reason) THEN
    RAISE EXCEPTION 'an interest that has ended stays ended' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER vendor_person_interest_guard BEFORE UPDATE OR DELETE ON machvon.vendor_person_interest FOR EACH ROW EXECUTE FUNCTION machvon.guard_vendor_person_interest();

-- A check is a record of a run: never changed. A finding keeps what the detection found; the decision is made once and stays.
CREATE FUNCTION machvon.guard_vendor_independence() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a record of the independence check is never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'vendor_independence_check' THEN
    RAISE EXCEPTION 'a run of the independence check is not changed' USING ERRCODE = '23514';
  END IF;
  IF (NEW.check_id, NEW.package_id, NEW.fingerprint, NEW.kind, NEW.strength, NEW.parties, NEW.evidence, NEW.raised_by, NEW.carried_from_id)
     IS DISTINCT FROM
     (OLD.check_id, OLD.package_id, OLD.fingerprint, OLD.kind, OLD.strength, OLD.parties, OLD.evidence, OLD.raised_by, OLD.carried_from_id) THEN
    RAISE EXCEPTION 'a finding is not rewritten' USING ERRCODE = '23514';
  END IF;
  IF OLD.decision IS NOT NULL AND (NEW.decision IS DISTINCT FROM OLD.decision OR NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.decided_at IS DISTINCT FROM OLD.decided_at OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason) THEN
    RAISE EXCEPTION 'a decision on a finding stays as it was made' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER vendor_independence_check_guard BEFORE UPDATE OR DELETE ON machvon.vendor_independence_check FOR EACH ROW EXECUTE FUNCTION machvon.guard_vendor_independence();
CREATE TRIGGER vendor_independence_finding_guard BEFORE UPDATE OR DELETE ON machvon.vendor_independence_finding FOR EACH ROW EXECUTE FUNCTION machvon.guard_vendor_independence();

ALTER TABLE machvon.vendor_person_interest ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.vendor_person_interest FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.vendor_person_interest AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.vendor_person_interest AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.vendor_independence_check ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.vendor_independence_check FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.vendor_independence_check AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.vendor_independence_check AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.vendor_independence_finding ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.vendor_independence_finding FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.vendor_independence_finding AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.vendor_independence_finding AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.vendor_person_interest FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.vendor_independence_check FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.vendor_independence_finding FROM machvon_app;

COMMENT ON TABLE machvon.vendor_person_interest IS 'VND-2: what a member of staff declares about themselves (PERSONAL): a relative, a share, a former employment, an advisory role; ended, never rewritten.';
COMMENT ON TABLE machvon.vendor_independence_check IS 'VND-2: one run of the independence detection for a package; append-only.';
COMMENT ON TABLE machvon.vendor_independence_finding IS 'VND-2: a link the detection found between bidders, people and the owner organisation; decided once by a person other than the one who raised it.';
