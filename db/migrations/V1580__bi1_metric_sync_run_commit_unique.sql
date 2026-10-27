-- Authored by hand (not generated): a bundle is applied once per commit, not once per hash (ST-BI-001, BI 3 F1).
-- The baseline index let a bundle of a given hash be applied once ever. A revert commit brings back the bytes of an older bundle,
-- and that is a deploy like any other: the same hash from another commit is applied again, while the same commit sent twice is not.

DROP INDEX machvon.bi_metric_sync_run_bundle_uq;
CREATE UNIQUE INDEX bi_metric_sync_run_bundle_uq ON machvon.bi_metric_sync_run (tenant_id, source_commit, bundle_sha256) WHERE status = 'APPLIED';
