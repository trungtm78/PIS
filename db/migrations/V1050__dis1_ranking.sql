-- ST-DIS-013: the ranking of the units of a comparison group on a frozen snapshot, one table for each denominator, with the units that are left out and why (DIS 3 F8, BR-DIS-10).
--
-- V002 gave `disbursement_ranking` its columns, the unit once in a table and the position that is there if and only if the unit is not left out. This migration makes the database say the rest of what the job relies on:
--   * a position is positive and held by one unit of a table; a unit that is left out says why, from the reasons there are, and has no rate;
--   * a ranking is computed once for a frozen snapshot and is never changed or deleted: a correction of the figures is a newer snapshot with a ranking of its own.

ALTER TABLE machvon.disbursement_ranking
  ADD CONSTRAINT disbursement_ranking_rank_positive_chk CHECK (rank IS NULL OR rank > 0),
  ADD CONSTRAINT disbursement_ranking_reason_chk CHECK (excluded_reason IS NULL OR excluded_reason IN ('PLAN_BELOW_MINIMUM', 'ZERO_DENOMINATOR', 'NO_DATA')),
  ADD CONSTRAINT disbursement_ranking_rate_chk CHECK ((excluded_reason IS NULL) = (rate_pct IS NOT NULL) AND (rate_pct IS NULL OR rate_pct >= 0)),
  ADD CONSTRAINT disbursement_ranking_plan_chk CHECK (plan_vnd >= 0),
  ADD CONSTRAINT disbursement_ranking_disbursed_chk CHECK (excluded_reason IS NOT NULL OR disbursed_vnd IS NOT NULL);

CREATE UNIQUE INDEX disbursement_ranking_rank_uq ON machvon.disbursement_ranking (tenant_id, snapshot_id, comparison_group, denominator_kind, rank) WHERE rank IS NOT NULL;
CREATE INDEX disbursement_ranking_read_idx ON machvon.disbursement_ranking (tenant_id, snapshot_id, comparison_group, denominator_kind, rank);

CREATE FUNCTION machvon.disbursement_ranking_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'a ranking is computed once for a frozen snapshot and is kept: a correction is a newer snapshot' USING ERRCODE = '23514', CONSTRAINT = 'disbursement_ranking_guard';
END
$fn$;

CREATE TRIGGER disbursement_ranking_guard BEFORE UPDATE OR DELETE ON machvon.disbursement_ranking FOR EACH ROW EXECUTE FUNCTION machvon.disbursement_ranking_guard();
