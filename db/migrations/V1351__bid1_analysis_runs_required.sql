-- contract: the columns of a run that the design names as part of every run, and the kind of confidence of a finding, are required; analysis runs came with ST-BID-009 and no release wrote one without them; release M3
-- Authored by hand (not generated): the contract step of V1350, in its own migration as the policy of expand then contract asks (ST-KERNEL-014).

ALTER TABLE machvon.analysis_run
  ALTER COLUMN package_id SET NOT NULL,
  ALTER COLUMN data_classification SET NOT NULL,
  ALTER COLUMN prompt_version_id SET NOT NULL,
  ALTER COLUMN document_version_set_sha256 SET NOT NULL,
  ALTER COLUMN requested_by SET NOT NULL,
  ALTER COLUMN started_at SET NOT NULL;

ALTER TABLE machvon.analysis_finding
  ALTER COLUMN confidence_type SET NOT NULL;
