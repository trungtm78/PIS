-- ST-MNE-007: the correction of an issued or filed monitoring report is a new revision that supersedes it (MNE 3.1 F3, BR-MNE-06).
--
-- V002 gave `mne_report` its revision, the link to the revision it supersedes and the check that a revision after the first has its reason. A report is superseded by at most one revision: a second
-- correction of the same report is refused by the table, whoever asks and whenever, and the chain of revisions is a line.

-- The day (Vietnam time) the obligation was first filed: on the report that was filed and on the revisions it corrected. It is written once, so that a later filing of a correction never changes how late the obligation was.
ALTER TABLE machvon.mne_report ADD COLUMN filed_on date;

-- A report that was filed before the day was kept has it from the receipt that was recorded first (the day the person says the file was filed, in Vietnam time): the runtime judges the first filing, and so does this.
UPDATE machvon.mne_report r SET filed_on = k.day
  FROM (SELECT DISTINCT ON (tenant_id, mne_report_id) tenant_id, mne_report_id, (submitted_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS day
          FROM machvon.mne_export_package WHERE status = 'SUBMISSION_CONFIRMED' AND submitted_at IS NOT NULL ORDER BY tenant_id, mne_report_id, receipt_recorded_at, id) k
 WHERE k.tenant_id = r.tenant_id AND k.mne_report_id = r.id AND r.filed_on IS NULL;

CREATE UNIQUE INDEX mne_report_supersedes_uq ON machvon.mne_report (tenant_id, supersedes_id) WHERE supersedes_id IS NOT NULL;
