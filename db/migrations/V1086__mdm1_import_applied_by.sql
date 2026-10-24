-- Authored by hand (not generated): the person who applied an import batch (Codex review of ST-MDM-006, finding 4).
-- Four-eyes on a batch is judged on the person who applied it, because the change requests it creates carry that person as their author;
-- this one may differ from the person who staged the file (created_by). The batch keeps the applier so that the screen and the API can say
-- who may not decide or publish it. Tenant row level security is unchanged.

ALTER TABLE machvon.master_import_batch ADD COLUMN applied_by uuid;

-- A batch that was applied before this column existed: its applier is the author of its change requests, or, for a batch that was applied
-- with no change request at all, the person who last touched it.
UPDATE machvon.master_import_batch AS batch
   SET applied_by = COALESCE(
     (SELECT change.created_by FROM machvon.master_change_request AS change
        WHERE change.tenant_id = batch.tenant_id AND change.import_batch_id = batch.id ORDER BY change.created_at, change.id LIMIT 1),
     batch.updated_by)
 WHERE batch.status IN ('IN_REVIEW', 'APPLIED', 'CANCELLED');
