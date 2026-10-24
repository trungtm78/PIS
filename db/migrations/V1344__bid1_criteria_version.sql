-- Authored by hand (not generated): the evaluation criteria of a package (ST-BID-003, BID 3 F4).
-- V002 gave `criteria_version` (package, revision, criteria, approver, effective time) and extended it (status, legal basis, weights sum, maker,
-- version) with the row-level security of the tenant, the separation of maker and approver, `weights_sum = 100` and one revision number per
-- package. The table was shaped for a version that is born approved; a draft has no approver yet. This migration puts into the database what
-- the commands rely on:
--   * a draft has neither approver nor effective time; an approved version has both; the approver is never the maker;
--   * a version keeps its package, revision, criteria, legal basis, weights and maker for good: the only way to change criteria is a new
--     revision, and an approved version is superseded, never edited (the analysis runs of the package point at the version they used);
--   * a version is born a draft whose weights add up to 100 (or that has no weighted criterion), and moves DRAFT to APPROVED or SUPERSEDED,
--     APPROVED to SUPERSEDED, nothing else; SUPERSEDED is final; a version is never deleted;
--   * a package has one draft and one approved version at most, so a revision never races another.

-- What the table held before this story was approved by definition.
UPDATE machvon.criteria_version SET status = 'APPROVED' WHERE status = 'DRAFT';

ALTER TABLE machvon.criteria_version
  ALTER COLUMN approved_by DROP NOT NULL,
  ALTER COLUMN effective_at DROP NOT NULL;

ALTER TABLE machvon.criteria_version
  ADD CONSTRAINT criteria_version_text_chk CHECK (legal_basis IS NULL OR (legal_basis = btrim(legal_basis) AND char_length(legal_basis) BETWEEN 3 AND 2000)),
  ADD CONSTRAINT criteria_version_approval_chk CHECK (
    (status = 'DRAFT' AND approved_by IS NULL AND effective_at IS NULL)
    OR (status = 'APPROVED' AND approved_by IS NOT NULL AND effective_at IS NOT NULL)
    OR status = 'SUPERSEDED'
  ),
  ADD CONSTRAINT criteria_version_revision_chk CHECK (revision >= 1),
  ADD CONSTRAINT criteria_version_package_fk FOREIGN KEY (tenant_id, package_id) REFERENCES machvon.procurement_package (tenant_id, id);

CREATE UNIQUE INDEX criteria_version_one_draft_uq ON machvon.criteria_version (tenant_id, package_id) WHERE status = 'DRAFT';
CREATE UNIQUE INDEX criteria_version_one_approved_uq ON machvon.criteria_version (tenant_id, package_id) WHERE status = 'APPROVED';
CREATE INDEX criteria_version_listing_idx ON machvon.criteria_version (tenant_id, created_at DESC, id DESC);

CREATE FUNCTION machvon.guard_criteria_version() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  listed jsonb;
  scored integer;
  total integer;
  expected integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a criteria version is never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'a criteria version starts as a draft' USING ERRCODE = '23514';
    END IF;
    IF NEW.created_by IS NULL OR NEW.legal_basis IS NULL THEN
      RAISE EXCEPTION 'a criteria version names its maker and its legal basis' USING ERRCODE = '23514';
    END IF;
    listed := NEW.criteria_json -> 'criteria';
    IF jsonb_typeof(NEW.criteria_json) <> 'object' OR jsonb_typeof(listed) IS DISTINCT FROM 'array' OR jsonb_array_length(listed) NOT BETWEEN 1 AND 50 THEN
      RAISE EXCEPTION 'the criteria are a list of one to fifty' USING ERRCODE = '23514';
    END IF;
    SELECT count(*), coalesce(sum((c ->> 'weight')::integer), 0) INTO scored, total FROM jsonb_array_elements(listed) AS c WHERE c ->> 'kind' = 'SCORED';
    IF scored > 0 AND total <> 100 THEN
      RAISE EXCEPTION 'the weights of the criteria add up to 100' USING ERRCODE = '23514';
    END IF;
    expected := CASE WHEN scored > 0 THEN total END;
    IF NEW.weights_sum IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'the sum of the weights is the sum of the weights of the criteria' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.package_id, NEW.revision, NEW.criteria_json, NEW.legal_basis, NEW.weights_sum, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.package_id, OLD.revision, OLD.criteria_json, OLD.legal_basis, OLD.weights_sum, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'a criteria version keeps its criteria for good; a change is a new revision' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'SUPERSEDED' THEN
    RAISE EXCEPTION 'a superseded criteria version never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status, NEW.status) NOT IN (('DRAFT', 'APPROVED'), ('DRAFT', 'SUPERSEDED'), ('APPROVED', 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'the state transition of the criteria version is not allowed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'APPROVED' AND (NEW.approved_by, NEW.effective_at) IS DISTINCT FROM (OLD.approved_by, OLD.effective_at) THEN
    RAISE EXCEPTION 'the approval of a criteria version is not rewritten' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER criteria_version_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.criteria_version
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_criteria_version();

-- The criteria an analysis was run with are kept with the package for the life of the project: no command deletes them.
REVOKE DELETE, TRUNCATE ON TABLE machvon.criteria_version FROM machvon_app;
