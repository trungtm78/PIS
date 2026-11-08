-- Authored by hand (not generated): FND-1 step 3, phase "expand" (docs/fnd-funding-model.md section 7.2). Every table that holds a funding class says which taxonomy pack its class codes belong to, and a period snapshot says
-- which version of the pack rule it was built with, how it is hashed, and what it restates. A column with a constant default is a catalogue change, not a rewrite of the rows: it fires no trigger, so frozen snapshots and
-- their guards are not touched and the hashes of `hash_schema` 1 (which cover none of these columns) do not move. Every existing row is the public pack, version 1, hash schema 1, which is what it always was. Nothing reads the
-- columns yet; the next migration opens the closed lists of classes. The defaults are dropped in a LATER release (the contract phase), so that every writer states the pack first.

ALTER TABLE machvon.allocation_line ADD COLUMN taxonomy_pack text NOT NULL DEFAULT 'PUBLIC';
ALTER TABLE machvon.appropriation ADD COLUMN taxonomy_pack text NOT NULL DEFAULT 'PUBLIC';
ALTER TABLE machvon.funding_snapshot_line ADD COLUMN taxonomy_pack text NOT NULL DEFAULT 'PUBLIC';
ALTER TABLE machvon.period_snapshot_line ADD COLUMN taxonomy_pack text NOT NULL DEFAULT 'PUBLIC';
ALTER TABLE machvon.disbursement_schedule_line ADD COLUMN taxonomy_pack text NOT NULL DEFAULT 'PUBLIC';
ALTER TABLE machvon.report_revision ADD COLUMN taxonomy_pack text NOT NULL DEFAULT 'PUBLIC';

ALTER TABLE machvon.period_snapshot
  ADD COLUMN taxonomy_pack text NOT NULL DEFAULT 'PUBLIC',
  ADD COLUMN taxonomy_rule_id uuid,
  ADD COLUMN taxonomy_version integer NOT NULL DEFAULT 1,
  ADD COLUMN hash_schema smallint NOT NULL DEFAULT 1,
  ADD COLUMN restates_snapshot_id uuid,
  ADD COLUMN revision integer NOT NULL DEFAULT 1;

-- The pack list is the only closed list left in the database: a new pack is a new migration, on purpose. The classes of a pack are judged by the kernel against the rule version, the database only judges the shape of the pack.
ALTER TABLE machvon.report_revision ADD CONSTRAINT report_revision_pack_chk CHECK (taxonomy_pack IN ('PUBLIC', 'ENTERPRISE'));
ALTER TABLE machvon.period_snapshot
  ADD CONSTRAINT period_snapshot_pack_chk CHECK (taxonomy_pack IN ('PUBLIC', 'ENTERPRISE')),
  ADD CONSTRAINT period_snapshot_taxonomy_version_chk CHECK (taxonomy_version >= 1),
  ADD CONSTRAINT period_snapshot_hash_schema_chk CHECK (hash_schema IN (1, 2)),
  ADD CONSTRAINT period_snapshot_revision_chk CHECK (revision >= 1),
  ADD CONSTRAINT period_snapshot_taxonomy_rule_fk FOREIGN KEY (tenant_id, taxonomy_rule_id) REFERENCES machvon.governance_rule (tenant_id, id),
  ADD CONSTRAINT period_snapshot_restates_fk FOREIGN KEY (tenant_id, restates_snapshot_id) REFERENCES machvon.period_snapshot (tenant_id, id);

CREATE INDEX period_snapshot_taxonomy_rule_idx ON machvon.period_snapshot (tenant_id, taxonomy_rule_id) WHERE taxonomy_rule_id IS NOT NULL;
CREATE INDEX period_snapshot_restates_idx ON machvon.period_snapshot (tenant_id, restates_snapshot_id) WHERE restates_snapshot_id IS NOT NULL;
