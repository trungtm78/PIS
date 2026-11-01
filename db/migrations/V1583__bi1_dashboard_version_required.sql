-- contract: the breakpoints, the policy for the versions of the datasets and the author of a dashboard version are required; dashboard versions came with ST-BI-005 and no release wrote one without them; release M3
-- Authored by hand (not generated): the contract step of V1581, in its own migration as the policy of expand then contract asks (ST-KERNEL-014).

ALTER TABLE machvon.dashboard_version
  ALTER COLUMN breakpoints SET NOT NULL,
  ALTER COLUMN dataset_version_policy SET NOT NULL,
  ALTER COLUMN created_by SET NOT NULL;
