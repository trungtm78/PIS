-- Authored by hand (not generated): the data contracts of DGV (ST-DGV-005, DGV.md F2, BR-DGV-07).
-- V002 gave the tables; what a contract stands on is put into the database here, whatever the application checked first:
--   * a revision of a contract (a row of dataset_contract with an ODCS document) never changes what it says: the document, its version, its compatibility, the day it takes effect, who drafted it; it moves forward only:
--     IN_REVIEW, then PUBLISHED, REJECTED or RETURNED; PUBLISHED goes to SUPERSEDED when the next revision is published; nothing is deleted; one revision is open (IN_REVIEW) for a dataset at a time;
--   * a published version (data_contract_version) is written once and never changed: it has the hash of its document, who published it and when, and a breaking one has the window in which the revision before it still serves;
--   * a consumer approval is decided once, by the owner of the consumer, and never deleted.
-- The contracts that earlier fixtures and the quality rules lean on (no ODCS document) are not touched by the guards of the revisions.

ALTER TABLE machvon.dataset_contract
  ADD CONSTRAINT dataset_contract_status_chk CHECK (status IN ('DRAFT', 'IN_REVIEW', 'PUBLISHED', 'SUPERSEDED', 'REJECTED', 'RETURNED')) NOT VALID,
  ADD CONSTRAINT dataset_contract_revision_chk CHECK (revision > 0) NOT VALID,
  ADD CONSTRAINT dataset_contract_odcs_chk CHECK (odcs_json IS NULL OR (jsonb_typeof(odcs_json) = 'object' AND odcs_version IS NOT NULL AND compatibility IS NOT NULL AND dataset_id IS NOT NULL AND effective_from IS NOT NULL AND created_by IS NOT NULL)) NOT VALID,
  ADD CONSTRAINT dataset_contract_published_chk CHECK (odcs_json IS NULL OR status NOT IN ('PUBLISHED', 'SUPERSEDED') OR approved_by IS NOT NULL) NOT VALID;

CREATE UNIQUE INDEX dataset_contract_open_uq ON machvon.dataset_contract (tenant_id, dataset_id) WHERE status = 'IN_REVIEW' AND odcs_json IS NOT NULL;
CREATE INDEX dataset_contract_dataset_idx ON machvon.dataset_contract (tenant_id, dataset_id, revision DESC) WHERE dataset_id IS NOT NULL;

ALTER TABLE machvon.data_contract_version
  ADD CONSTRAINT data_contract_version_status_chk CHECK (status = 'PUBLISHED') NOT VALID,
  ADD CONSTRAINT data_contract_version_revision_chk CHECK (revision > 0) NOT VALID,
  ADD CONSTRAINT data_contract_version_published_chk CHECK (contract_id IS NULL OR (odcs_sha256 IS NOT NULL AND compatibility IS NOT NULL AND published_by IS NOT NULL AND published_at IS NOT NULL)) NOT VALID,
  ADD CONSTRAINT data_contract_version_window_chk CHECK (compatibility IS DISTINCT FROM 'BREAKING' OR migration_window_until IS NOT NULL) NOT VALID;

ALTER TABLE machvon.contract_consumer_approval
  ADD CONSTRAINT contract_consumer_approval_owner_chk CHECK (decision = 'PENDING' OR decided_by = consumer_owner_user_id) NOT VALID,
  ADD CONSTRAINT contract_consumer_approval_ref_chk CHECK (char_length(btrim(consumer_ref)) BETWEEN 1 AND 200) NOT VALID;

CREATE INDEX contract_consumer_approval_owner_idx ON machvon.contract_consumer_approval (tenant_id, consumer_owner_user_id, decision, created_at DESC);

CREATE FUNCTION machvon.guard_dataset_contract() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  -- A contract that has no ODCS document is the working copy that the quality rules lean on: it is not a revision, and these guards leave it alone.
  IF OLD.odcs_json IS NULL THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a revision of a data contract is never deleted (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;
  IF (NEW.dataset_code, NEW.revision, NEW.dataset_id, NEW.odcs_version, NEW.odcs_json, NEW.producer_module, NEW.compatibility, NEW.effective_from, NEW.created_by, NEW.created_at, NEW.owner_id, NEW.schema_json, NEW.quality_json, NEW.freshness_seconds, NEW.classification)
     IS DISTINCT FROM (OLD.dataset_code, OLD.revision, OLD.dataset_id, OLD.odcs_version, OLD.odcs_json, OLD.producer_module, OLD.compatibility, OLD.effective_from, OLD.created_by, OLD.created_at, OLD.owner_id, OLD.schema_json, OLD.quality_json, OLD.freshness_seconds, OLD.classification) THEN
    RAISE EXCEPTION 'what a revision of a data contract says never changes' USING ERRCODE = '42501';
  END IF;
  IF NOT (OLD.status = NEW.status
          OR (OLD.status = 'IN_REVIEW' AND NEW.status IN ('PUBLISHED', 'REJECTED', 'RETURNED'))
          OR (OLD.status = 'PUBLISHED' AND NEW.status = 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'a revision of a data contract cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  IF OLD.approved_by IS NOT NULL AND NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
    RAISE EXCEPTION 'who published a revision never changes' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER dataset_contract_guard BEFORE UPDATE OR DELETE ON machvon.dataset_contract
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_dataset_contract();

CREATE FUNCTION machvon.guard_data_contract_version() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a published version of a data contract is never changed (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
END;
$fn$;

CREATE TRIGGER data_contract_version_guard BEFORE UPDATE OR DELETE ON machvon.data_contract_version
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_data_contract_version();
CREATE TRIGGER data_contract_version_no_truncate BEFORE TRUNCATE ON machvon.data_contract_version
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_data_contract_version();

CREATE FUNCTION machvon.guard_contract_consumer_approval() RETURNS trigger
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
    RAISE EXCEPTION 'consumer approvals are never deleted (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;
  IF (NEW.contract_id, NEW.consumer_kind, NEW.consumer_ref, NEW.consumer_owner_user_id, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.contract_id, OLD.consumer_kind, OLD.consumer_ref, OLD.consumer_owner_user_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'what a consumer is asked, and who answers for it, never changes' USING ERRCODE = '42501';
  END IF;
  IF OLD.decision <> 'PENDING' AND (NEW.decision, NEW.decided_by, NEW.decided_at, NEW.comment) IS DISTINCT FROM (OLD.decision, OLD.decided_by, OLD.decided_at, OLD.comment) THEN
    RAISE EXCEPTION 'a consumer decision is written once' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER contract_consumer_approval_guard BEFORE UPDATE OR DELETE ON machvon.contract_consumer_approval
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_contract_consumer_approval();
CREATE TRIGGER contract_consumer_approval_no_truncate BEFORE TRUNCATE ON machvon.contract_consumer_approval
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_contract_consumer_approval();

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.data_contract_version FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.contract_consumer_approval FROM machvon_app;
REVOKE TRUNCATE ON TABLE machvon.dataset_contract FROM machvon_app;
