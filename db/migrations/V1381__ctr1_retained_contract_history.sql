-- Authored by hand (not generated): a contract and its revisions follow the retention of the project dossier and a legal hold blocks their
-- removal (CTR.md section 6). A draft that was a mistake is cancelled, never deleted (V1380), and the revisions are the paper trail of what
-- was agreed. No command deletes either; the runtime role no longer can, so nothing short of the retention job can end them.
REVOKE DELETE, TRUNCATE ON TABLE machvon.contract FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.contract_revision FROM machvon_app;
