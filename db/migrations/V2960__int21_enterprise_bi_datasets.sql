-- Authored by hand (not generated): INT-2, the certified BI dataset DS-ENT for the enterprise edition (Power BI and Lakehouse read the FROZEN enterprise period snapshot, eng-review R6 and R13).
-- V2202 made `v_disbursement_lines` and `v_contract_lines` read snapshots of kind PERIOD_CLOSE only, and the enterprise edition freezes its figures as kind ENTERPRISE_CLOSE (V2660, ENT-3a), so a BI login of an
-- enterprise tenant saw nothing. This block opens one more dataset, on the same mechanism and with the same guarantees as the two of V2202 and without changing what they show:
--
--   * `DS-ENT` is switched on per tenant in `int_export_dataset` and needs a CERTIFIED data product that has not run out, exactly like the others (`machvon_bi.dataset_state` is generic over the code). The code is allowed
--     by the CHECK of the table; the public edition of the application never offers it (the kernel lists it for the enterprise edition only), so a public tenant has no way to switch it on and no snapshot of that kind.
--   * The views are `security_invoker`: they run with the rights and the row-level security of the login. They show the FROZEN snapshot of each period only (the official figure; a snapshot that was superseded by a
--     later revision is not shown, so a sum over the view never counts a period twice). The tenant of every row is the one of the binding of the login (`machvon_bi.tenant_of(current_user)`), never `app.tenant_id`.
--   * `bi_reader_boundary` of `machvon.period_snapshot` is written again: the headers of the PERIOD_CLOSE snapshots stay behind DS-DISB or DS-CTR as before, and the headers of the ENTERPRISE_CLOSE snapshots are behind
--     DS-ENT alone. The table of the figures gets its own RESTRICTIVE `bi_reader_boundary` for the group role: tenant of the binding, DS-ENT open, snapshot FROZEN and of kind ENTERPRISE_CLOSE. So a login that sets
--     `app.tenant_id` to another tenant reads nothing, from the views AND from the granted columns of the tables; the figures of a public snapshot (FND-1) are not reachable at all.
--   * `v_dataset_catalogue` is left as it is (it lists the two datasets of V2202 and a test pins it); `v_enterprise_dataset_catalogue` lists the views of DS-ENT with the same state and reason.
--
-- The views (the money columns are whole dong, numeric 24,0; a figure nobody has is NULL with its reason in the long view, never 0; a rate is computed as sum over sum and is NULL when the denominator is not positive):
--   `v_enterprise_figures`        the long format of the snapshot: one row per (project, class, tier, measure, figure kind, grain, ordinal) - the base every other view is made from.
--   `v_enterprise_plan_actual`    one row per (project, class, tier, measure): the plan of the year (original, adjusted, in force), the plan of the period and to date, the estimate, the actual of the period, the
--                                 cumulative of the year and since the start, with the rates against the plan in force and against the plan to date.
--   `v_enterprise_funding_split`  one row per (project, measure): the plan in force and the cumulative of the year by source of funds (EQUITY, LOAN, every other class together) and the share of each.
--   `v_enterprise_by_unit`        one row per (unit, measure) and one row for the whole tenant (`unit_id` NULL, `level` TENANT): the sums of the above over the projects of the unit, with the rates made from the sums.
-- The company of the corporation is the organisation unit that owns the project at the end of the period (`unit_id`); the tenant row is the corporation.

ALTER TABLE machvon.int_export_dataset
  DROP CONSTRAINT int_export_dataset_code_chk,
  ADD CONSTRAINT int_export_dataset_code_chk CHECK (dataset_code IN ('DS-DISB', 'DS-CTR', 'DS-ENT'));

GRANT SELECT (revision) ON machvon.period_snapshot TO machvon_bi_reader;
GRANT SELECT (tenant_id, snapshot_id, project_id, unit_id, bucket, budget_level, measure, figure_kind, grain, plan_year, ordinal, amount_vnd, null_reason, basis) ON machvon.period_snapshot_figure TO machvon_bi_reader;

DROP POLICY bi_reader_boundary ON machvon.period_snapshot;
CREATE POLICY bi_reader_boundary ON machvon.period_snapshot AS RESTRICTIVE FOR SELECT TO machvon_bi_reader USING (
  tenant_id = (SELECT machvon_bi.tenant_of(current_user::text))
  AND status = 'FROZEN'
  AND (
    (snapshot_kind = 'PERIOD_CLOSE' AND ((SELECT d.is_open FROM machvon_bi.dataset_state(current_user::text, 'DS-DISB') d) OR (SELECT d.is_open FROM machvon_bi.dataset_state(current_user::text, 'DS-CTR') d)))
    OR (snapshot_kind = 'ENTERPRISE_CLOSE' AND (SELECT d.is_open FROM machvon_bi.dataset_state(current_user::text, 'DS-ENT') d))
  )
);
CREATE POLICY bi_reader_boundary ON machvon.period_snapshot_figure AS RESTRICTIVE FOR SELECT TO machvon_bi_reader USING (
  tenant_id = (SELECT machvon_bi.tenant_of(current_user::text))
  AND (SELECT d.is_open FROM machvon_bi.dataset_state(current_user::text, 'DS-ENT') d)
  AND EXISTS (SELECT 1 FROM machvon.period_snapshot p WHERE p.tenant_id = period_snapshot_figure.tenant_id AND p.id = period_snapshot_figure.snapshot_id AND p.status = 'FROZEN' AND p.snapshot_kind = 'ENTERPRISE_CLOSE')
);

-- DS-ENT, the long format: every figure of a FROZEN enterprise snapshot, as the figure engine froze it (kinds PLAN_YEAR, PLAN_ADJUSTED, PLAN_IN_FORCE, PLAN_MONTH or PLAN_QUARTER, PLAN_TO_DATE, ESTIMATE,
-- ESTIMATE_AS_REPORTED, ACTUAL, CUMULATIVE_YTD, CUMULATIVE_SINCE_START, ESTIMATE_YEAR, and TMDT_IN_FORCE of class TOTAL, the total investment of a project). The key of a row is (snapshot_id, project_id, class_code, tier_code,
-- measure, figure_kind, grain, plan_year, ordinal).
CREATE VIEW machvon_bi.v_enterprise_figures WITH (security_invoker = true) AS
SELECT
  g.tenant_id,
  s.id AS snapshot_id,
  s.period_id,
  s.revision,
  s.as_of_date,
  f.project_id,
  f.unit_id,
  f.bucket AS class_code,
  f.budget_level AS tier_code,
  f.measure,
  f.figure_kind,
  f.grain,
  f.plan_year,
  f.ordinal,
  f.amount_vnd,
  f.null_reason,
  f.basis,
  g.certified_until AS certification_expires_on
FROM machvon_bi.dataset_state(current_user::text, 'DS-ENT') g
JOIN machvon.period_snapshot s ON g.is_open AND s.tenant_id = g.tenant_id AND s.status = 'FROZEN' AND s.snapshot_kind = 'ENTERPRISE_CLOSE'
JOIN machvon.period_snapshot_figure f ON f.tenant_id = s.tenant_id AND f.snapshot_id = s.id;

-- DS-ENT, plan against actual by project: the figures of one (project, class, tier, measure) side by side. Each kind is one row of the long format, so `max` only picks it (it never adds). The grain, the plan year
-- and the ordinal are those of the period the snapshot closes (read from its ACTUAL row). The class TOTAL (the total investment of the project) is not a class of funds and is left to the long view.
CREATE VIEW machvon_bi.v_enterprise_plan_actual WITH (security_invoker = true) AS
SELECT
  g.tenant_id,
  s.id AS snapshot_id,
  s.period_id,
  s.revision,
  s.as_of_date,
  c.period_grain,
  c.plan_year,
  c.period_ordinal,
  c.project_id,
  c.unit_id,
  c.class_code,
  c.tier_code,
  c.measure,
  c.plan_year_vnd,
  c.plan_adjusted_vnd,
  c.plan_in_force_vnd,
  -- The plan of the period: the plan of the month or of the quarter; for a year the plan of the period is the plan of the year in force (the figure engine writes no separate row for it).
  CASE WHEN c.period_grain = 'YEAR' THEN c.plan_in_force_vnd ELSE c.plan_month_quarter_vnd END AS plan_period_vnd,
  c.plan_to_date_vnd,
  c.estimate_vnd,
  c.estimate_as_reported_vnd,
  c.actual_vnd,
  c.cumulative_ytd_vnd,
  c.cumulative_since_start_vnd,
  c.estimate_year_vnd,
  CASE WHEN c.plan_in_force_vnd > 0 THEN round(c.cumulative_ytd_vnd * 100 / c.plan_in_force_vnd, 4) END AS rate_in_force_pct,
  CASE WHEN c.plan_to_date_vnd > 0 THEN round(c.cumulative_ytd_vnd * 100 / c.plan_to_date_vnd, 4) END AS rate_to_date_pct,
  g.certified_until AS certification_expires_on
FROM machvon_bi.dataset_state(current_user::text, 'DS-ENT') g
JOIN machvon.period_snapshot s ON g.is_open AND s.tenant_id = g.tenant_id AND s.status = 'FROZEN' AND s.snapshot_kind = 'ENTERPRISE_CLOSE'
CROSS JOIN LATERAL (
  SELECT
    f.project_id,
    f.unit_id,
    f.bucket AS class_code,
    f.budget_level AS tier_code,
    f.measure,
    max(f.grain) FILTER (WHERE f.figure_kind = 'ACTUAL') AS period_grain,
    max(f.plan_year) FILTER (WHERE f.figure_kind = 'ACTUAL') AS plan_year,
    max(f.ordinal) FILTER (WHERE f.figure_kind = 'ACTUAL') AS period_ordinal,
    max(f.amount_vnd) FILTER (WHERE f.figure_kind = 'PLAN_YEAR') AS plan_year_vnd,
    max(f.amount_vnd) FILTER (WHERE f.figure_kind = 'PLAN_ADJUSTED') AS plan_adjusted_vnd,
    max(f.amount_vnd) FILTER (WHERE f.figure_kind = 'PLAN_IN_FORCE') AS plan_in_force_vnd,
    max(f.amount_vnd) FILTER (WHERE f.figure_kind IN ('PLAN_MONTH', 'PLAN_QUARTER')) AS plan_month_quarter_vnd,
    max(f.amount_vnd) FILTER (WHERE f.figure_kind = 'PLAN_TO_DATE') AS plan_to_date_vnd,
    max(f.amount_vnd) FILTER (WHERE f.figure_kind = 'ESTIMATE') AS estimate_vnd,
    max(f.amount_vnd) FILTER (WHERE f.figure_kind = 'ESTIMATE_AS_REPORTED') AS estimate_as_reported_vnd,
    max(f.amount_vnd) FILTER (WHERE f.figure_kind = 'ACTUAL') AS actual_vnd,
    max(f.amount_vnd) FILTER (WHERE f.figure_kind = 'CUMULATIVE_YTD') AS cumulative_ytd_vnd,
    max(f.amount_vnd) FILTER (WHERE f.figure_kind = 'CUMULATIVE_SINCE_START') AS cumulative_since_start_vnd,
    max(f.amount_vnd) FILTER (WHERE f.figure_kind = 'ESTIMATE_YEAR') AS estimate_year_vnd
  FROM machvon.period_snapshot_figure f
  WHERE f.tenant_id = s.tenant_id AND f.snapshot_id = s.id AND f.bucket <> 'TOTAL'
  GROUP BY f.project_id, f.unit_id, f.bucket, f.budget_level, f.measure
) c;

-- DS-ENT, the funding split by project: the sources of funds side by side (EQUITY, LOAN, and every other class together as `other`). A source nobody planned or reported is NULL; a share is NULL when the total of
-- the project is not positive.
CREATE VIEW machvon_bi.v_enterprise_funding_split WITH (security_invoker = true) AS
SELECT
  a.tenant_id,
  a.snapshot_id,
  a.period_id,
  a.revision,
  a.as_of_date,
  a.period_grain,
  a.plan_year,
  a.period_ordinal,
  a.project_id,
  a.unit_id,
  a.measure,
  sum(a.plan_in_force_vnd) FILTER (WHERE a.class_code = 'EQUITY') AS plan_in_force_equity_vnd,
  sum(a.plan_in_force_vnd) FILTER (WHERE a.class_code = 'LOAN') AS plan_in_force_loan_vnd,
  sum(a.plan_in_force_vnd) FILTER (WHERE a.class_code NOT IN ('EQUITY', 'LOAN')) AS plan_in_force_other_vnd,
  sum(a.plan_in_force_vnd) AS plan_in_force_total_vnd,
  sum(a.cumulative_ytd_vnd) FILTER (WHERE a.class_code = 'EQUITY') AS cumulative_ytd_equity_vnd,
  sum(a.cumulative_ytd_vnd) FILTER (WHERE a.class_code = 'LOAN') AS cumulative_ytd_loan_vnd,
  sum(a.cumulative_ytd_vnd) FILTER (WHERE a.class_code NOT IN ('EQUITY', 'LOAN')) AS cumulative_ytd_other_vnd,
  sum(a.cumulative_ytd_vnd) AS cumulative_ytd_total_vnd,
  CASE WHEN sum(a.cumulative_ytd_vnd) > 0 THEN round(coalesce(sum(a.cumulative_ytd_vnd) FILTER (WHERE a.class_code = 'EQUITY'), 0) * 100 / sum(a.cumulative_ytd_vnd), 4) END AS equity_share_pct,
  CASE WHEN sum(a.cumulative_ytd_vnd) > 0 THEN round(coalesce(sum(a.cumulative_ytd_vnd) FILTER (WHERE a.class_code = 'LOAN'), 0) * 100 / sum(a.cumulative_ytd_vnd), 4) END AS loan_share_pct,
  min(a.certification_expires_on) AS certification_expires_on
FROM machvon_bi.v_enterprise_plan_actual a
GROUP BY a.tenant_id, a.snapshot_id, a.period_id, a.revision, a.as_of_date, a.period_grain, a.plan_year, a.period_ordinal, a.project_id, a.unit_id, a.measure;

-- DS-ENT, by unit and for the corporation: the sums over the projects (and over the classes) of each unit, then the whole tenant (`unit_id` NULL, `level` TENANT). The rates are made from the sums, never averaged.
CREATE VIEW machvon_bi.v_enterprise_by_unit WITH (security_invoker = true) AS
SELECT
  a.tenant_id,
  a.snapshot_id,
  a.period_id,
  a.revision,
  a.as_of_date,
  a.period_grain,
  a.plan_year,
  a.period_ordinal,
  CASE WHEN GROUPING(a.unit_id) = 1 THEN 'TENANT' ELSE 'UNIT' END AS level,
  a.unit_id,
  a.measure,
  count(DISTINCT a.project_id) AS project_count,
  sum(a.plan_in_force_vnd) AS plan_in_force_vnd,
  sum(a.plan_to_date_vnd) AS plan_to_date_vnd,
  sum(a.actual_vnd) AS actual_vnd,
  sum(a.cumulative_ytd_vnd) AS cumulative_ytd_vnd,
  CASE WHEN sum(a.plan_in_force_vnd) > 0 THEN round(sum(a.cumulative_ytd_vnd) * 100 / sum(a.plan_in_force_vnd), 4) END AS rate_in_force_pct,
  CASE WHEN sum(a.plan_to_date_vnd) > 0 THEN round(sum(a.cumulative_ytd_vnd) * 100 / sum(a.plan_to_date_vnd), 4) END AS rate_to_date_pct,
  sum(a.cumulative_ytd_vnd) FILTER (WHERE a.class_code = 'EQUITY') AS cumulative_ytd_equity_vnd,
  sum(a.cumulative_ytd_vnd) FILTER (WHERE a.class_code = 'LOAN') AS cumulative_ytd_loan_vnd,
  sum(a.cumulative_ytd_vnd) FILTER (WHERE a.class_code NOT IN ('EQUITY', 'LOAN')) AS cumulative_ytd_other_vnd,
  CASE WHEN sum(a.cumulative_ytd_vnd) > 0 THEN round(coalesce(sum(a.cumulative_ytd_vnd) FILTER (WHERE a.class_code = 'EQUITY'), 0) * 100 / sum(a.cumulative_ytd_vnd), 4) END AS equity_share_pct,
  CASE WHEN sum(a.cumulative_ytd_vnd) > 0 THEN round(coalesce(sum(a.cumulative_ytd_vnd) FILTER (WHERE a.class_code = 'LOAN'), 0) * 100 / sum(a.cumulative_ytd_vnd), 4) END AS loan_share_pct,
  min(a.certification_expires_on) AS certification_expires_on
FROM machvon_bi.v_enterprise_plan_actual a
GROUP BY GROUPING SETS (
  (a.tenant_id, a.snapshot_id, a.period_id, a.revision, a.as_of_date, a.period_grain, a.plan_year, a.period_ordinal, a.unit_id, a.measure),
  (a.tenant_id, a.snapshot_id, a.period_id, a.revision, a.as_of_date, a.period_grain, a.plan_year, a.period_ordinal, a.measure)
);

-- What the login may read of DS-ENT, and why it is closed when it is: the first thing a person opens when the tenant is an enterprise.
CREATE VIEW machvon_bi.v_enterprise_dataset_catalogue WITH (security_invoker = true) AS
SELECT d.dataset_code, d.view_name, d.grain, s.is_open, s.reason, s.certified_until
FROM (VALUES
  ('DS-ENT', 'v_enterprise_figures', 'one row per figure (project, class, tier, measure, figure kind, grain, ordinal) of a frozen enterprise period snapshot'),
  ('DS-ENT', 'v_enterprise_plan_actual', 'one row per project, class, tier and measure of a frozen enterprise period snapshot: plan, actual, cumulative and rates'),
  ('DS-ENT', 'v_enterprise_funding_split', 'one row per project and measure of a frozen enterprise period snapshot: equity, loan and other funds'),
  ('DS-ENT', 'v_enterprise_by_unit', 'one row per unit and measure, and one for the whole tenant, of a frozen enterprise period snapshot')
) AS d(dataset_code, view_name, grain)
CROSS JOIN LATERAL machvon_bi.dataset_state(current_user::text, d.dataset_code) s;

GRANT SELECT ON machvon_bi.v_enterprise_figures, machvon_bi.v_enterprise_plan_actual, machvon_bi.v_enterprise_funding_split, machvon_bi.v_enterprise_by_unit, machvon_bi.v_enterprise_dataset_catalogue TO machvon_bi_reader;

COMMENT ON VIEW machvon_bi.v_enterprise_figures IS 'INT-2: DS-ENT long format for external readers; the FROZEN enterprise snapshot only; security_invoker; the tenant is resolved from current_user through machvon_bi.reader_binding, never from app.tenant_id.';
COMMENT ON VIEW machvon_bi.v_enterprise_plan_actual IS 'INT-2: DS-ENT plan against actual by project, class, tier and measure; rates are sum over sum and NULL when the denominator is not positive.';
COMMENT ON VIEW machvon_bi.v_enterprise_funding_split IS 'INT-2: DS-ENT funding split (equity, loan, other) by project and measure.';
COMMENT ON VIEW machvon_bi.v_enterprise_by_unit IS 'INT-2: DS-ENT sums by unit and for the whole tenant, rates made from the sums.';
COMMENT ON VIEW machvon_bi.v_enterprise_dataset_catalogue IS 'INT-2: the views of DS-ENT and whether the dataset is open (switched on and certified) now.';
