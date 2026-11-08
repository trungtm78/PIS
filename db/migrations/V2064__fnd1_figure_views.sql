-- Authored by hand (not generated): FND-1 step 3 (docs/fnd-funding-model.md section 7.4). One reading shape of the figures of a snapshot for everyone who reads them (RPT-1 form packs, IND-1 indicators, the BI datasets,
-- HOME): `v_snapshot_figure` unions the long-format figures with the public lines, mapped column by column. The public line table stays the source of truth of the public edition; the view only gives it the shape of the
-- others. The mapping: the plan of the Prime Minister and the plan added by the province are the plan in force with their origin group; the Treasury figure is the cumulative year to date on the basis TREASURY, the report's
-- cumulative on the basis REPORTED, the change of the period the actual, the registration of the next month the plan of that month, the forecast the estimate of the year. A figure a line does not have is not a row.
-- No backfill is needed: the defaults of V2060 already say public, version 1, hash schema 1 for every row that exists. The view reads with the rights of the caller, so row-level security applies.

CREATE VIEW machvon.v_snapshot_figure WITH (security_invoker = true) AS
SELECT f.tenant_id, f.snapshot_id, f.project_id, f.unit_id, f.bucket AS class_code, f.budget_level AS tier_code, f.measure, f.figure_kind, f.grain, f.plan_year, f.ordinal, f.amount_vnd, f.null_reason, f.basis,
       NULL::text AS origin_group, s.taxonomy_pack
  FROM machvon.period_snapshot_figure f
  JOIN machvon.period_snapshot s ON s.tenant_id = f.tenant_id AND s.id = f.snapshot_id
UNION ALL
SELECT l.tenant_id, l.snapshot_id, l.project_id, l.unit_id, l.bucket, l.budget_level, 'DISBURSED', m.figure_kind, m.grain, m.plan_year, m.ordinal, m.amount_vnd,
       CASE WHEN m.amount_vnd IS NULL THEN 'NO_DATA' END, m.basis, m.origin_group, l.taxonomy_pack
  FROM machvon.period_snapshot_line l
  JOIN machvon.period_snapshot s ON s.tenant_id = l.tenant_id AND s.id = l.snapshot_id
  JOIN machvon.reporting_period p ON p.tenant_id = s.tenant_id AND p.id = s.period_id
  CROSS JOIN LATERAL (
    SELECT p.fiscal_year AS plan_year,
           CASE WHEN p.period_type IN ('MONTH', 'QUARTER', 'YEAR') THEN p.period_type ELSE 'MONTH' END AS grain,
           CASE WHEN p.period_type = 'MONTH' THEN extract(month FROM p.end_date)::smallint WHEN p.period_type = 'QUARTER' THEN extract(quarter FROM p.end_date)::smallint ELSE 0::smallint END AS ordinal
  ) at_period
  CROSS JOIN LATERAL (VALUES
    ('PLAN_IN_FORCE', at_period.grain, at_period.plan_year, at_period.ordinal, l.plan_pm_assigned_vnd, NULL::text, 'PRIMARY'),
    ('PLAN_IN_FORCE', at_period.grain, at_period.plan_year, at_period.ordinal, l.plan_local_added_vnd, NULL::text, 'ADDED'),
    ('CUMULATIVE_YTD', at_period.grain, at_period.plan_year, at_period.ordinal, l.disbursed_treasury_vnd, 'TREASURY', NULL::text),
    ('CUMULATIVE_YTD', at_period.grain, at_period.plan_year, at_period.ordinal, l.disbursed_reported_vnd, 'REPORTED', NULL::text),
    ('ACTUAL', at_period.grain, at_period.plan_year, at_period.ordinal, l.period_delta_vnd, 'REPORTED', NULL::text),
    ('PLAN_MONTH', 'MONTH', at_period.plan_year, (at_period.ordinal + 1)::smallint, l.registered_month_vnd, 'REPORTED', NULL::text),
    ('ESTIMATE_YEAR', 'YEAR', at_period.plan_year, 0::smallint, l.forecast_eac_vnd, 'REPORTED', NULL::text)
  ) AS m(figure_kind, grain, plan_year, ordinal, amount_vnd, basis, origin_group)
 WHERE m.amount_vnd IS NOT NULL OR m.origin_group IS NOT NULL;

COMMENT ON VIEW machvon.v_snapshot_figure IS 'FND-1: the figures of a snapshot in one shape: the long-format figures and the public lines mapped column by column.';
