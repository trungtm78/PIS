-- Authored by hand (not generated): a monitoring report is kept for good (MNE.md section 6: retention "permanent"). The filing calendar
-- writes the shells of a year and the report commands update them; nothing deletes one. The runtime role no longer can.
REVOKE DELETE, TRUNCATE ON TABLE machvon.mne_report FROM machvon_app;
