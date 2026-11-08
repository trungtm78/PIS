-- Authored by hand (not generated): FND-1 step 3, phase "expand" (docs/fnd-funding-model.md sections 7.1, 7.2). The closed lists of funding classes, budget levels and origins are in the database in six places; the enterprise
-- pack needs other codes (EQUITY, LOAN, OTHER; the single tier ALL; the origins GROUP_ASSIGNED and BOARD_APPROVED). For each table, in this one transaction: (1) the pack-aware CHECK is ADDED (and validated, so a row that the
-- old CHECK accepted and the new one does not stops the migration), (2) the old closed CHECKs are DROPPED (found through pg_constraint by what they say, because some of them have generated names), so the table is never without
-- a check. The new CHECK accepts every row the old ones accepted (a public row says `PUBLIC` through the default of V2060), so rolling the code back needs no schema rollback.
-- Not touched on purpose: the semantic CHECKs (`allocation_line_carryover_chk`, `appropriation_carryover_chk`, `funding_line_ctmtqg_bucket_chk`) fire only on public codes and stay as they are; `disbursement_ranking`
-- (`denominator_kind`) is public only (the ranking of an enterprise is out of FND-1); the schedule keeps its granularities WEEK and MONTH (the quarter and year plans and the estimates of the enterprise pack live in
-- `plan_figure_revision`, not in the schedule).

ALTER TABLE machvon.allocation_line ADD CONSTRAINT allocation_line_class_pack_chk CHECK (
  (taxonomy_pack = 'PUBLIC' AND bucket IN ('CURRENT_YEAR', 'CARRYOVER', 'OTHER') AND (budget_level IS NULL OR budget_level IN ('CENTRAL', 'LOCAL'))
     AND (origin IS NULL OR origin IN ('PM_ASSIGNED', 'LOCAL_ADDED', 'CARRYOVER', 'CENTRAL_SUPPORT', 'REVENUE_INCREASE')))
  OR (taxonomy_pack = 'ENTERPRISE' AND bucket IN ('EQUITY', 'LOAN', 'OTHER') AND (budget_level IS NULL OR budget_level = 'ALL')
     AND (origin IS NULL OR origin IN ('GROUP_ASSIGNED', 'BOARD_APPROVED', 'CARRYOVER'))));

ALTER TABLE machvon.appropriation ADD CONSTRAINT appropriation_class_pack_chk CHECK (
  (taxonomy_pack = 'PUBLIC' AND budget_level IN ('CENTRAL', 'LOCAL') AND origin IN ('PM_ASSIGNED', 'LOCAL_ADDED', 'CARRYOVER', 'CENTRAL_SUPPORT', 'REVENUE_INCREASE'))
  OR (taxonomy_pack = 'ENTERPRISE' AND budget_level = 'ALL' AND origin IN ('GROUP_ASSIGNED', 'BOARD_APPROVED', 'CARRYOVER')));

ALTER TABLE machvon.funding_snapshot_line ADD CONSTRAINT funding_line_class_pack_chk CHECK (
  (taxonomy_pack = 'PUBLIC' AND bucket IN ('CURRENT_YEAR', 'CARRYOVER', 'OTHER') AND budget_level IN ('CENTRAL', 'LOCAL'))
  OR (taxonomy_pack = 'ENTERPRISE' AND bucket IN ('EQUITY', 'LOAN', 'OTHER') AND budget_level = 'ALL'));

ALTER TABLE machvon.period_snapshot_line ADD CONSTRAINT snapshot_line_class_pack_chk CHECK (
  (taxonomy_pack = 'PUBLIC' AND bucket IN ('CURRENT_YEAR', 'CARRYOVER', 'OTHER') AND budget_level IN ('CENTRAL', 'LOCAL'))
  OR (taxonomy_pack = 'ENTERPRISE' AND bucket IN ('EQUITY', 'LOAN', 'OTHER') AND budget_level = 'ALL'));

ALTER TABLE machvon.disbursement_schedule_line ADD CONSTRAINT schedule_class_pack_chk CHECK (
  (taxonomy_pack = 'PUBLIC' AND bucket IN ('CURRENT_YEAR', 'CARRYOVER', 'OTHER') AND budget_level IN ('CENTRAL', 'LOCAL'))
  OR (taxonomy_pack = 'ENTERPRISE' AND bucket IN ('EQUITY', 'LOAN', 'OTHER') AND budget_level = 'ALL'));

-- The old closed CHECKs go: a CHECK on these tables that lists the public classes, the public budget levels or the public origins as a closed list, and is not one of the new pack-aware CHECKs.
DO $fnd1$
DECLARE
  old_check record;
BEGIN
  FOR old_check IN
    SELECT c.conrelid::regclass AS relation, c.conname
      FROM pg_constraint c
     WHERE c.contype = 'c'
       AND c.conrelid IN ('machvon.allocation_line'::regclass, 'machvon.appropriation'::regclass, 'machvon.funding_snapshot_line'::regclass, 'machvon.period_snapshot_line'::regclass, 'machvon.disbursement_schedule_line'::regclass)
       AND c.conname NOT LIKE '%\_pack\_chk'
       AND (   (pg_get_constraintdef(c.oid) ~ '\mbucket\M' AND pg_get_constraintdef(c.oid) LIKE '%''CURRENT_YEAR''%')
            OR (pg_get_constraintdef(c.oid) ~ '\mbudget_level\M' AND pg_get_constraintdef(c.oid) LIKE '%''CENTRAL''%')
            OR (pg_get_constraintdef(c.oid) ~ '\morigin\M' AND pg_get_constraintdef(c.oid) LIKE '%''PM_ASSIGNED''%'))
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', old_check.relation, old_check.conname);
  END LOOP;
END
$fnd1$;
