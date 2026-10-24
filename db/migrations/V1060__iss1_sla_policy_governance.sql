-- Authored by hand (not generated): the governance of the SLA policy versions (ST-ISS-001, BR-ISS-02).
-- An issue keeps the policy version it was created under, so a version is kept for good and its content never changes: a change is a
-- new revision of the same code that takes over from a date. Two policies never apply to the same category, severity and unit on the
-- same day; the database has the last word on that, whatever the application checked first.

-- The policy follows the category entry, not one version of it: renaming a category publishes a new master version, and the policies of
-- the category must still be found for the issues created after the rename. The version the policy was written against stays in
-- category_version_id as the evidence of what the category was called. The entry is never supplied by a writer: the database takes it
-- from the version, so the two cannot disagree (the foreign key of category_version_id already ties the version to its tenant).
ALTER TABLE machvon.issue_sla_policy ADD COLUMN category_record_id uuid;
CREATE INDEX issue_sla_policy_category_record_id_idx ON machvon.issue_sla_policy (tenant_id, category_record_id);

CREATE FUNCTION machvon.set_issue_sla_policy_category() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  SELECT v.master_record_id INTO NEW.category_record_id
    FROM machvon.master_record_version v
   WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.category_version_id;
  IF NEW.category_record_id IS NULL THEN
    RAISE EXCEPTION 'the category version of an SLA policy must belong to a master record' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER issue_sla_policy_category BEFORE INSERT ON machvon.issue_sla_policy
  FOR EACH ROW EXECUTE FUNCTION machvon.set_issue_sla_policy_category();

-- A policy ends after it begins; a retired one has an end date and an active one has none (the end date is the day the policy no longer applies).
ALTER TABLE machvon.issue_sla_policy
  ADD CONSTRAINT issue_sla_policy_period_chk CHECK (valid_until IS NULL OR valid_until > valid_from);
ALTER TABLE machvon.issue_sla_policy
  ADD CONSTRAINT issue_sla_policy_status_period_chk CHECK (status = 'DRAFT' OR ((status = 'RETIRED') = (valid_until IS NOT NULL)));
ALTER TABLE machvon.issue_sla_policy
  ADD CONSTRAINT issue_sla_policy_hours_chk CHECK (resolve_hours <= 2400 AND escalate_l3_pct <= 1000);

-- No overlap of the effective periods for one category, severity and unit (the unit NULL is the default of the tenant and is one value).
ALTER TABLE machvon.issue_sla_policy
  ADD CONSTRAINT issue_sla_policy_no_overlap EXCLUDE USING gist (
    tenant_id WITH =,
    category_record_id WITH =,
    severity WITH =,
    (coalesce(owner_unit_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    daterange(valid_from, valid_until, '[)') WITH &&
  ) WHERE (status <> 'DRAFT');

-- Kept for good: an issue, an audit row and a report may name the version years later.
REVOKE DELETE, TRUNCATE ON TABLE machvon.issue_sla_policy FROM machvon_app;

-- A published version never changes its content. It may be ended (status RETIRED with the end date, once) and nothing else.
CREATE FUNCTION machvon.guard_issue_sla_policy_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.category_version_id IS DISTINCT FROM OLD.category_version_id
     OR NEW.category_record_id IS DISTINCT FROM OLD.category_record_id
     OR NEW.severity IS DISTINCT FROM OLD.severity
     OR NEW.owner_unit_id IS DISTINCT FROM OLD.owner_unit_id
     OR NEW.calendar_code IS DISTINCT FROM OLD.calendar_code
     OR NEW.response_hours IS DISTINCT FROM OLD.response_hours
     OR NEW.resolve_hours IS DISTINCT FROM OLD.resolve_hours
     OR NEW.escalate_l2_pct IS DISTINCT FROM OLD.escalate_l2_pct
     OR NEW.escalate_l3_pct IS DISTINCT FROM OLD.escalate_l3_pct
     OR NEW.require_independent_verifier IS DISTINCT FROM OLD.require_independent_verifier
     OR NEW.require_evidence IS DISTINCT FROM OLD.require_evidence
     OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'an SLA policy version is immutable: publish a new revision instead' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'RETIRED' AND (NEW.status <> 'RETIRED' OR NEW.valid_until IS DISTINCT FROM OLD.valid_until) THEN
    RAISE EXCEPTION 'a retired SLA policy version never changes' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER issue_sla_policy_guard BEFORE UPDATE ON machvon.issue_sla_policy
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_issue_sla_policy_update();
