-- Authored by hand (not generated): the Word format of the report exports (IAM-2). The packages of the monitoring reports and the formats a form version may name admit DOCX next to XLSX, PDF, XML and CSV. Additive only:
-- no row changes, the two checks only accept one more value. A form version names the formats it can be exported in, so a form that does not list DOCX is still not exported to Word.

ALTER TABLE machvon.mne_export_package DROP CONSTRAINT mne_export_package_format_check;
ALTER TABLE machvon.mne_export_package ADD CONSTRAINT mne_export_package_format_chk CHECK (format IN ('XLSX', 'PDF', 'XML', 'CSV', 'DOCX'));

ALTER TABLE machvon.mne_report_form DROP CONSTRAINT mne_form_shape_chk;
ALTER TABLE machvon.mne_report_form
  ADD CONSTRAINT mne_form_shape_chk CHECK (jsonb_typeof(schema_json) = 'object' AND cardinality(export_formats) > 0 AND export_formats <@ ARRAY['XLSX', 'PDF', 'XML', 'CSV', 'DOCX']);

-- The exports of the BI series and its schedules: the Word document is one more way to take the same table out.
ALTER TABLE machvon.bi_export_job DROP CONSTRAINT bi_export_job_format_check;
ALTER TABLE machvon.bi_export_job ADD CONSTRAINT bi_export_job_format_chk CHECK (format IN ('CSV', 'XLSX', 'PDF', 'DOCX'));
ALTER TABLE machvon.bi_export_schedule DROP CONSTRAINT bi_export_schedule_format_check;
ALTER TABLE machvon.bi_export_schedule ADD CONSTRAINT bi_export_schedule_format_chk CHECK (format IN ('CSV', 'XLSX', 'PDF', 'DOCX', 'LINK_ONLY'));
