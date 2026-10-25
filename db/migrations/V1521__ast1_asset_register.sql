-- Authored by hand (not generated): the assets a work produces, registered after the handover was accepted and transferred to the unit that operates them (ST-AST-002, AST 3.2, BR-AST-02, UAT-AC389).
-- The table asset_record, its non-negative value, the day of the transfer and the code that is unique in a project are in V002. This adds who transferred the asset, that a registered
-- asset names the contract it comes from, the day it was registered and its name, the guard of the edges of its status, that what an asset is does not change and the transfer of it
-- does not change once written, the words of the code, the name and the external code, and that an asset is never deleted.

ALTER TABLE machvon.asset_record
  ADD COLUMN transferred_by uuid;

ALTER TABLE machvon.asset_record
  ADD CONSTRAINT asset_record_text_chk CHECK (
    asset_code = btrim(asset_code) AND asset_code <> '' AND char_length(asset_code) <= 2000
    AND (name IS NULL OR (name = btrim(name) AND name <> '' AND char_length(name) <= 2000))
    AND (funding_origin IS NULL OR (funding_origin = btrim(funding_origin) AND funding_origin <> '' AND char_length(funding_origin) <= 2000))
    AND (external_asset_id IS NULL OR (external_asset_id = btrim(external_asset_id) AND external_asset_id <> '' AND char_length(external_asset_id) <= 2000))
  ),
  -- An asset that was registered names the contract it comes from, its name and the day; one that was transferred names who transferred it and the dossier of the commissioning.
  ADD CONSTRAINT asset_record_registered_chk CHECK (status = 'DRAFT' OR (source_contract_id IS NOT NULL AND name IS NOT NULL AND registered_on IS NOT NULL)),
  ADD CONSTRAINT asset_record_transferred_chk CHECK (status NOT IN ('TRANSFERRED', 'IN_OPERATION') OR (transferred_by IS NOT NULL AND commissioning_document_version_id IS NOT NULL)),
  ADD CONSTRAINT asset_record_transfer_day_chk CHECK (transferred_on IS NULL OR registered_on IS NULL OR transferred_on >= registered_on),
  ADD CONSTRAINT asset_record_transferred_by_fk FOREIGN KEY (tenant_id, transferred_by) REFERENCES machvon.membership (tenant_id, id);

REVOKE DELETE, TRUNCATE ON TABLE machvon.asset_record FROM machvon_app;

CREATE FUNCTION machvon.guard_asset_record() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'REGISTERED' THEN
      RAISE EXCEPTION 'ASSET_STATE_INVALID: an asset is registered first' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.project_id, NEW.handover_id, NEW.asset_code, NEW.source_contract_id, NEW.registered_on, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.project_id, OLD.handover_id, OLD.asset_code, OLD.source_contract_id, OLD.registered_on, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what an asset is never changes' USING ERRCODE = '23514';
  END IF;
  -- The transfer of an asset is kept as it was written.
  IF OLD.transferred_on IS NOT NULL AND (NEW.transferred_on, NEW.transferred_by, NEW.commissioning_document_version_id) IS DISTINCT FROM (OLD.transferred_on, OLD.transferred_by, OLD.commissioning_document_version_id) THEN
    RAISE EXCEPTION 'the transfer of an asset does not change' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
      FROM (VALUES ('REGISTERED', 'TRANSFERRED'), ('REGISTERED', 'DISPOSED'), ('TRANSFERRED', 'IN_OPERATION'), ('TRANSFERRED', 'DISPOSED'), ('IN_OPERATION', 'DISPOSED')) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'ASSET_STATE_INVALID: this move of the status is not allowed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER asset_record_guard BEFORE INSERT OR UPDATE ON machvon.asset_record
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_asset_record();
