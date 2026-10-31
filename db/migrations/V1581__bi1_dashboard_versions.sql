-- Authored by hand (not generated): dashboards and their immutable versions (ST-BI-005, BI.md F5 and the forbidden list of section 4).
-- V002 gave the tables; what a published layout stands on is put into the database here, whatever the application checked first:
--   * a version of a dashboard (V002 ties it to a dashboard of the tenant) has a revision (1, 2, 3 ... one after the other, once each), and names the policy for the versions of the datasets it reads: the latest frozen one, or a list of pinned
--     ones (a pinned policy names at least one, the latest-frozen policy names none);
--   * a saved version never changes: its layout, metrics, filter mappings, breakpoints and dataset policy are fixed when it is written (409 VERSION_IMMUTABLE at the application, 42501 here); only its state moves, DRAFT to
--     PUBLISHED (with who and when) to SUPERSEDED, and nothing is deleted;
--   * the code and the owner of a dashboard are fixed when it is made, and the version it points to is one of its own.

ALTER TABLE machvon.dashboard_version
  ALTER COLUMN breakpoints SET NOT NULL,
  ALTER COLUMN dataset_version_policy SET NOT NULL,
  ALTER COLUMN created_by SET NOT NULL;

ALTER TABLE machvon.dashboard_version
  ADD CONSTRAINT dashboard_version_status_chk CHECK (status IN ('DRAFT', 'PUBLISHED', 'SUPERSEDED')),
  ADD CONSTRAINT dashboard_version_revision_chk CHECK (revision >= 1),
  ADD CONSTRAINT dashboard_version_published_chk CHECK (
    (status = 'DRAFT' AND published_at IS NULL AND published_by IS NULL) OR (status <> 'DRAFT' AND published_at IS NOT NULL AND published_by IS NOT NULL)),
  ADD CONSTRAINT dashboard_version_metrics_chk CHECK (jsonb_typeof(metric_versions) = 'array'),
  ADD CONSTRAINT dashboard_version_pinned_chk CHECK (
    (dataset_version_policy = 'PINNED' AND coalesce(jsonb_typeof(pinned_dataset_version_ids) = 'array' AND jsonb_array_length(pinned_dataset_version_ids) > 0, false))
    OR (dataset_version_policy = 'LATEST_FROZEN' AND (pinned_dataset_version_ids IS NULL OR jsonb_array_length(pinned_dataset_version_ids) = 0)));

ALTER TABLE machvon.dashboard
  ADD CONSTRAINT dashboard_code_chk CHECK (code = btrim(code) AND char_length(code) BETWEEN 2 AND 80);

CREATE INDEX dashboard_owner_idx ON machvon.dashboard (tenant_id, owner_user_id);

CREATE FUNCTION machvon.guard_dashboard_version() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'dashboard versions are never deleted (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;
  IF (NEW.dashboard_id, NEW.revision, NEW.layout_json, NEW.metric_versions, NEW.filter_mappings, NEW.breakpoints, NEW.dataset_version_policy, NEW.pinned_dataset_version_ids, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.dashboard_id, OLD.revision, OLD.layout_json, OLD.metric_versions, OLD.filter_mappings, OLD.breakpoints, OLD.dataset_version_policy, OLD.pinned_dataset_version_ids, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'a saved version of a dashboard never changes (UPDATE on %.% by %)', TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501', DETAIL = 'VERSION_IMMUTABLE';
  END IF;
  IF NOT (OLD.status = NEW.status OR (OLD.status = 'DRAFT' AND NEW.status = 'PUBLISHED') OR (OLD.status = 'PUBLISHED' AND NEW.status = 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'a dashboard version cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'DRAFT' AND (NEW.published_by, NEW.published_at) IS DISTINCT FROM (OLD.published_by, OLD.published_at) THEN
    RAISE EXCEPTION 'who published a dashboard version, and when, is written once' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER dashboard_version_guard BEFORE UPDATE OR DELETE ON machvon.dashboard_version
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_dashboard_version();
CREATE TRIGGER dashboard_version_no_truncate BEFORE TRUNCATE ON machvon.dashboard_version
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_dashboard_version();

CREATE FUNCTION machvon.guard_dashboard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'dashboards are never deleted (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;
  IF (NEW.code, NEW.owner_user_id, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.code, OLD.owner_user_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'the code and the owner of a dashboard are fixed when it is made' USING ERRCODE = '42501';
  END IF;
  IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id AND NOT EXISTS (
       SELECT 1 FROM machvon.dashboard_version v WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.current_version_id AND v.dashboard_id = NEW.id) THEN
    RAISE EXCEPTION 'the version of a dashboard is one of its own' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER dashboard_guard BEFORE UPDATE OR DELETE ON machvon.dashboard
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_dashboard();
CREATE TRIGGER dashboard_no_truncate BEFORE TRUNCATE ON machvon.dashboard
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_dashboard();

REVOKE DELETE, TRUNCATE ON TABLE machvon.dashboard_version FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.dashboard FROM machvon_app;
