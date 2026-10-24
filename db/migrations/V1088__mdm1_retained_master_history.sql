-- Authored by hand (not generated): the master data that is published is kept for good (MDM.md section 6: retention "permanent").
-- No command deletes an entry, a version of it or a crosswalk (a mistake is answered by a new version, a retirement or a later succession), but
-- the runtime role could, so a statement that went round the commands could erase what a project, a report or an audit row refers to.
-- Found by the cross-cutting review of the MDM-1 slice. Updates stay: the commands move the status and the current version.
REVOKE DELETE, TRUNCATE ON TABLE machvon.master_record FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.master_record_version FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.master_crosswalk FROM machvon_app;
