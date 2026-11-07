-- Authored by hand (not generated): the store of the governance rules (G0-1 of docs/governance-roadmap-10of10.md, ADM): the thresholds, definitions and policies that the alert centre, the scores, the gates and the controls read, kept as
-- data with versions, periods and a second person's approval instead of constants in code. The params of each `rule_type` are checked by the kernel (packages/kernel/src/governance-rules.ts), the database keeps what it can say alone:
-- the shape of a row, the maker who is not the checker, one period for one code at a time, and that a version never changes after it is written (a change is a new version).
--
-- A version moves DRAFT -> SUBMITTED -> APPROVED -> RETIRED (a version can also be taken back to DRAFT, or retired before it was approved, which gives it an empty period). `unit_id` makes a version an override for an organization unit and the
-- units under it; null is the rule of the whole tenant. With no approved version in force the reader falls back to the built-in default of the kernel.
-- The period is half open: `effective_to` is the first day the version no longer applies.

CREATE TABLE machvon.governance_rule (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  -- An open registry: the table accepts any well-formed name and the kernel (packages/kernel/src/governance-rules.ts, one `register*` function per domain) says which names the platform knows and how their params are checked.
  rule_type text NOT NULL CHECK (rule_type ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  code text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  -- The number of the version inside one code (and one unit): 1, 2, 3 without gaps; stored on the decisions that used it.
  version integer NOT NULL CHECK (version >= 1),
  unit_id uuid,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'RETIRED')),
  params jsonb NOT NULL CHECK (jsonb_typeof(params) = 'object'),
  effective_from date NOT NULL,
  effective_to date,
  reason text NOT NULL CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 5 AND 500),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_by uuid,
  submitted_at timestamptz,
  approved_by uuid,
  approved_at timestamptz,
  retired_by uuid,
  retired_at timestamptz,
  retire_reason text CHECK (retire_reason IS NULL OR (retire_reason = btrim(retire_reason) AND char_length(retire_reason) BETWEEN 5 AND 500)),
  -- The number the commands send back in If-Match (the `version` above is the number of the rule version, not of this row).
  row_version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES machvon.organization_unit (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, submitted_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, retired_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT governance_rule_period_chk CHECK (effective_to IS NULL OR effective_to >= effective_from),
  -- Each status says what it needs: a submitted version names who submitted it; an approved one names a checker who is neither its maker nor its submitter; a retired one names who and when.
  CONSTRAINT governance_rule_submit_chk CHECK ((status = 'DRAFT') OR submitted_by IS NOT NULL OR (status = 'RETIRED' AND approved_at IS NULL)),
  CONSTRAINT governance_rule_approve_chk CHECK ((approved_by IS NULL) = (approved_at IS NULL) AND (status NOT IN ('APPROVED') OR approved_by IS NOT NULL)),
  CONSTRAINT governance_rule_sod_chk CHECK (approved_by IS NULL OR (approved_by <> created_by AND approved_by IS DISTINCT FROM submitted_by)),
  CONSTRAINT governance_rule_retire_chk CHECK ((status = 'RETIRED') = (retired_at IS NOT NULL) AND (retired_at IS NULL) = (retired_by IS NULL) AND (retired_at IS NULL) = (retire_reason IS NULL)),
  -- A version that was never approved has no period when it is retired: it never governed anything.
  CONSTRAINT governance_rule_unapproved_retire_chk CHECK (status <> 'RETIRED' OR approved_at IS NOT NULL OR effective_to = effective_from)
);

-- One number of one version for one code of one unit (the unit of the tenant-wide rule is the null id).
CREATE UNIQUE INDEX governance_rule_version_uq ON machvon.governance_rule (tenant_id, rule_type, code, coalesce(unit_id, '00000000-0000-0000-0000-000000000000'::uuid), version);

-- No two versions that governed (or govern) a day for the same code and the same unit overlap: a successor starts the day the version before it ends. An empty period (a retired draft) overlaps nothing.
ALTER TABLE machvon.governance_rule
  ADD CONSTRAINT governance_rule_no_overlap EXCLUDE USING gist (
    tenant_id WITH =,
    rule_type WITH =,
    code WITH =,
    (coalesce(unit_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&
  ) WHERE (approved_at IS NOT NULL);

-- The lookup of the version in force: by type and code, newest first.
CREATE INDEX governance_rule_in_force_idx ON machvon.governance_rule (tenant_id, rule_type, code, effective_from DESC) WHERE approved_at IS NOT NULL;
CREATE INDEX governance_rule_list_idx ON machvon.governance_rule (tenant_id, rule_type, code, version DESC);
CREATE INDEX governance_rule_status_idx ON machvon.governance_rule (tenant_id, status, created_at DESC);

ALTER TABLE machvon.governance_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.governance_rule FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.governance_rule AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.governance_rule AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Kept for good: a decision names the version it used years later.
REVOKE DELETE, TRUNCATE ON TABLE machvon.governance_rule FROM machvon_app;

-- The guard. A version keeps its content (type, code, version, unit, params, start, reason, maker); the moves are the ones of the life of a version, each writing its own columns once.
CREATE FUNCTION machvon.guard_governance_rule() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_mutable constant text[] := ARRAY['status', 'effective_to', 'submitted_by', 'submitted_at', 'approved_by', 'approved_at', 'retired_by', 'retired_at', 'retire_reason', 'row_version'];
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'governance rules are never deleted (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;

  IF (to_jsonb(NEW) - v_mutable) IS DISTINCT FROM (to_jsonb(OLD) - v_mutable) THEN
    RAISE EXCEPTION 'the content of a governance rule never changes: write a new version (UPDATE on %.% by %)', TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;

  IF NOT (
    OLD.status = NEW.status
    OR (OLD.status = 'DRAFT' AND NEW.status IN ('SUBMITTED', 'RETIRED'))
    OR (OLD.status = 'SUBMITTED' AND NEW.status IN ('DRAFT', 'APPROVED', 'RETIRED'))
    OR (OLD.status = 'APPROVED' AND NEW.status = 'RETIRED')
  ) THEN
    RAISE EXCEPTION 'a governance rule cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;

  -- The approval is written once, by the move to APPROVED; a withdrawal clears the submission and nothing else may.
  IF NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
    IF NOT (OLD.status = 'SUBMITTED' AND NEW.status = 'APPROVED' AND OLD.approved_at IS NULL) THEN
      RAISE EXCEPTION 'the approval of a governance rule is written once, by the move to APPROVED' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF NEW.submitted_by IS DISTINCT FROM OLD.submitted_by OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
    IF NOT ((OLD.status = 'DRAFT' AND NEW.status = 'SUBMITTED') OR (OLD.status = 'SUBMITTED' AND NEW.status = 'DRAFT' AND NEW.submitted_by IS NULL AND NEW.submitted_at IS NULL)) THEN
      RAISE EXCEPTION 'the submission of a governance rule moves with its status only' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- The period of an approved version only shortens (a successor takes over, or it is retired): never moved later or widened.
  IF NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN
    IF NOT (OLD.approved_at IS NOT NULL AND NEW.effective_to IS NOT NULL AND (OLD.effective_to IS NULL OR NEW.effective_to < OLD.effective_to))
       AND NOT (OLD.approved_at IS NULL AND NEW.status = 'RETIRED') THEN
      RAISE EXCEPTION 'the period of an approved governance rule only ends sooner' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.retired_at IS DISTINCT FROM OLD.retired_at AND NOT (OLD.status <> 'RETIRED' AND NEW.status = 'RETIRED') THEN
    RAISE EXCEPTION 'the retirement of a governance rule is written once' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER governance_rule_guard BEFORE UPDATE OR DELETE ON machvon.governance_rule
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_governance_rule();

COMMENT ON TABLE machvon.governance_rule IS 'Versioned governance rules (G0-1): thresholds, definitions and policies as data; maker is not checker; a version never changes, a change is a new version.';
