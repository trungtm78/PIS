-- Authored by hand (not generated): the Treasury statement import (ST-PAY-006, PAY 3.3 steps 3 and 6, NFR-OPERABILITY-06).
-- V002 gave treasury_import, treasury_import_row, treasury_transaction and reconciliation_item their columns and policies. This slice adds
-- what makes the import provable from the database alone:
--   * what a transaction remembers of where it came from: the Treasury office entry that the crosswalk TREASURY/AGENCY_CODE named, the
--     provider's event id of a callback (one transaction per event) and the evidence document of a manual confirmation;
--   * the shape of each source (a file row belongs to an import, a callback to an event, a manual confirmation to evidence and a request);
--   * a confirmed transaction never changes what it says, and it is never removed: only its match status and links move forward (PAY 3.4:
--     a mistake is corrected by a reversal, not by an update);
--   * two foreign keys that V002 lacks, the open work item that is unique per transaction and kind, and the grants that keep the imports
--     and the work items for good.
-- A treasury_import row has the id of the file_import row (V1002) that claimed the file: the framework owns the file identity, the
-- treasury_import row is the PAY view of the same try.

ALTER TABLE machvon.treasury_transaction ADD COLUMN treasury_office_record_id uuid;
ALTER TABLE machvon.treasury_transaction ADD COLUMN provider_event_id text;
ALTER TABLE machvon.treasury_transaction ADD COLUMN evidence_document_version_id uuid;

ALTER TABLE machvon.treasury_transaction ADD CONSTRAINT treasury_transaction_hash_chk CHECK (source_hash ~ '^[0-9a-f]{64}$' AND (row_hash IS NULL OR row_hash ~ '^[0-9a-f]{64}$'));
ALTER TABLE machvon.treasury_transaction ADD CONSTRAINT treasury_transaction_source_chk CHECK (
  (source_kind = 'FILE_IMPORT') = (import_id IS NOT NULL)
  AND (source_kind = 'CALLBACK_MOCK') = (provider_event_id IS NOT NULL)
  AND (source_kind = 'MANUAL_CONFIRMED') = (evidence_document_version_id IS NOT NULL)
  AND (source_kind <> 'MANUAL_CONFIRMED' OR payment_request_id IS NOT NULL)
);

-- One transaction per provider event: a callback delivered twice is one transaction.
CREATE UNIQUE INDEX treasury_transaction_event_uq ON machvon.treasury_transaction (tenant_id, provider, provider_event_id) WHERE provider_event_id IS NOT NULL;
CREATE INDEX treasury_transaction_treasury_office_record_id_idx ON machvon.treasury_transaction (tenant_id, treasury_office_record_id);
CREATE INDEX treasury_transaction_evidence_document_version_id_idx ON machvon.treasury_transaction (tenant_id, evidence_document_version_id);

ALTER TABLE machvon.treasury_import ADD CONSTRAINT treasury_import_hash_chk CHECK (file_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE machvon.treasury_import ADD CONSTRAINT treasury_import_counts_positive_chk CHECK (row_total >= 0 AND row_new >= 0 AND row_duplicate >= 0 AND row_conflict >= 0 AND row_error >= 0);
ALTER TABLE machvon.treasury_import_row ADD CONSTRAINT treasury_import_row_hash_chk CHECK (row_hash ~ '^[0-9a-f]{64}$' AND char_length(business_key) <= 300);
-- A row that was read (not an error) points at the transaction it created or repeated.
ALTER TABLE machvon.treasury_import_row ADD CONSTRAINT treasury_import_row_transaction_chk CHECK (outcome = 'ERROR' OR treasury_transaction_id IS NOT NULL);

ALTER TABLE machvon.reconciliation_item ADD CONSTRAINT reconciliation_item_amounts_chk CHECK (
  kind NOT IN ('AMOUNT_MISMATCH', 'DUPLICATE_CONFLICT') OR (internal_amount_vnd IS NOT NULL AND confirmed_amount_vnd IS NOT NULL)
);
-- The same difference met again is the same piece of work: one open item per transaction and kind.
CREATE UNIQUE INDEX reconciliation_item_open_uq ON machvon.reconciliation_item (tenant_id, treasury_transaction_id, kind)
  WHERE treasury_transaction_id IS NOT NULL AND status IN ('OPEN', 'EXPLAINED');

-- V002 gave the four tables their foreign keys to each other and to the payment, the contract, the allocation line and the project. This slice
-- adds the two it did not have, and defers the one from a transaction to its import: the file rows are written by the import before its
-- header (the header carries the counts of the whole file), so the key is checked when the transaction ends.
ALTER TABLE machvon.treasury_transaction ADD FOREIGN KEY (tenant_id, treasury_office_record_id) REFERENCES machvon.master_record (tenant_id, id);
ALTER TABLE machvon.treasury_transaction ADD FOREIGN KEY (tenant_id, evidence_document_version_id) REFERENCES machvon.document_version (tenant_id, id);
ALTER TABLE machvon.treasury_transaction ALTER CONSTRAINT treasury_transaction_tenant_id_import_id_fkey DEFERRABLE INITIALLY DEFERRED;

-- A confirmed transaction says the same for good. Its match status moves forward (UNMATCHED or EXCEPTION to MATCHED, UNMATCHED to
-- EXCEPTION) and its links to the payment request, contract and allocation line are set by the match; nothing else is ever updated.
CREATE FUNCTION machvon.treasury_transaction_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.external_id IS DISTINCT FROM OLD.external_id OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.amount_vnd IS DISTINCT FROM OLD.amount_vnd OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
     OR NEW.reversal_of_id IS DISTINCT FROM OLD.reversal_of_id OR NEW.source_hash IS DISTINCT FROM OLD.source_hash
     OR NEW.import_id IS DISTINCT FROM OLD.import_id OR NEW.direction IS DISTINCT FROM OLD.direction
     OR NEW.document_no IS DISTINCT FROM OLD.document_no OR NEW.document_date IS DISTINCT FROM OLD.document_date
     OR NEW.source_kind IS DISTINCT FROM OLD.source_kind OR NEW.row_hash IS DISTINCT FROM OLD.row_hash
     OR NEW.provider_event_id IS DISTINCT FROM OLD.provider_event_id OR NEW.evidence_document_version_id IS DISTINCT FROM OLD.evidence_document_version_id
     OR NEW.treasury_office_record_id IS DISTINCT FROM OLD.treasury_office_record_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'a Treasury transaction keeps what it says; a mistake is corrected by a reversal' USING ERRCODE = '23514';
  END IF;
  IF OLD.match_status = 'MATCHED' THEN
    RAISE EXCEPTION 'a matched Treasury transaction is not changed' USING ERRCODE = '23514';
  END IF;
  IF OLD.match_status = 'EXCEPTION' AND NEW.match_status = 'UNMATCHED' THEN
    RAISE EXCEPTION 'a Treasury transaction in exception does not go back to unmatched' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER treasury_transaction_guard BEFORE UPDATE ON machvon.treasury_transaction
  FOR EACH ROW EXECUTE FUNCTION machvon.treasury_transaction_guard();

-- Retention "kept as an accounting record" (PAY 6): the runtime role cannot remove an import, a row of it, a transaction or a work item,
-- and an import and its rows are written whole, once.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.treasury_import FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.treasury_import_row FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.treasury_transaction FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.reconciliation_item FROM machvon_app;
