-- Authored by hand (not generated): the project register is kept for good (PRJ.md section 6: retention "permanent"; BR-PRJ-01: a code is
-- never reused). A project that could be deleted by the runtime role could be written again under the same code, and the revisions that say
-- what it was and who decided it could be erased. No command deletes either; the database now says so too.
REVOKE DELETE, TRUNCATE ON TABLE machvon.project FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.project_revision FROM machvon_app;
