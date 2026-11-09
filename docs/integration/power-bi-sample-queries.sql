-- Sample queries over the read-only BI views of MACHVON (INT-1, DOC-3).
--
-- Connect with the database login that INT-04 hands out (name machvon_bi_<12 hex>), schema machvon_bi.
-- Nothing in this file is a secret; the password is entered in the credential dialog of the tool.
-- A closed dataset (not switched on, not certified, expired) returns no rows and no error: run query 1 first.
--
-- Figures of DS-DISB are CUMULATIVE per reporting period: take one period at a time, never add periods together.
-- A percentage is never summed: divide the summed amounts.

-- 1. What can this login read now, and why not
SELECT dataset_code, view_name, grain, is_open, reason, certified_until
FROM machvon_bi.v_dataset_catalogue
ORDER BY dataset_code;

-- 2. The reporting periods that have a frozen close snapshot
SELECT period_id, snapshot_id, as_of_date, count(*) AS line_count
FROM machvon_bi.v_disbursement_lines
GROUP BY period_id, snapshot_id, as_of_date
ORDER BY as_of_date DESC;

-- 3. Source for the table FactDisbursement of the semantic model (Import mode)
SELECT snapshot_id, period_id, as_of_date, line_id, project_id, unit_id, fund_source_version_id,
       bucket, budget_level, plan_total_vnd, disbursed_treasury_vnd, disbursed_reported_vnd,
       period_delta_vnd, rate_total_pct, rate_null_reason, treasury_coverage
FROM machvon_bi.v_disbursement_lines;

-- 4. Disbursement rate of the latest period by project (rate = summed amounts, not the average of line rates)
WITH latest AS (
  SELECT period_id FROM machvon_bi.v_disbursement_lines ORDER BY as_of_date DESC LIMIT 1
)
SELECT d.project_id,
       sum(d.plan_total_vnd)                                          AS plan_vnd,
       sum(d.disbursed_treasury_vnd)                                  AS disbursed_treasury_vnd,
       round(100.0 * sum(d.disbursed_treasury_vnd) / NULLIF(sum(d.plan_total_vnd), 0), 2) AS rate_pct
FROM machvon_bi.v_disbursement_lines d
JOIN latest l ON l.period_id = d.period_id
GROUP BY d.project_id
ORDER BY rate_pct DESC NULLS LAST;

-- 5. The same by bucket and budget level (current-year plan, carry-over, central or local)
WITH latest AS (
  SELECT period_id FROM machvon_bi.v_disbursement_lines ORDER BY as_of_date DESC LIMIT 1
)
SELECT d.bucket, d.budget_level,
       sum(d.plan_total_vnd)         AS plan_vnd,
       sum(d.disbursed_treasury_vnd) AS disbursed_treasury_vnd,
       round(100.0 * sum(d.disbursed_treasury_vnd) / NULLIF(sum(d.plan_total_vnd), 0), 2) AS rate_pct
FROM machvon_bi.v_disbursement_lines d
JOIN latest l ON l.period_id = d.period_id
GROUP BY d.bucket, d.budget_level
ORDER BY d.bucket, d.budget_level;

-- 6. Trend of the whole organization: one point per period (cumulative figures, so no sum across periods)
SELECT period_id, as_of_date,
       sum(plan_total_vnd)         AS plan_vnd,
       sum(disbursed_treasury_vnd) AS disbursed_treasury_vnd,
       sum(period_delta_vnd)       AS period_delta_vnd,
       round(100.0 * sum(disbursed_treasury_vnd) / NULLIF(sum(plan_total_vnd), 0), 2) AS rate_pct
FROM machvon_bi.v_disbursement_lines
GROUP BY period_id, as_of_date
ORDER BY as_of_date, period_id;

-- 7. How trustworthy a period is: lines the Treasury does not cover and why a rate is missing
SELECT period_id, as_of_date, treasury_coverage, rate_null_reason, count(*) AS line_count
FROM machvon_bi.v_disbursement_lines
GROUP BY period_id, as_of_date, treasury_coverage, rate_null_reason
ORDER BY as_of_date DESC, period_id, treasury_coverage, rate_null_reason;

-- 8. Reconciliation of a Lakehouse copy: one row per period to compare with the copy
SELECT period_id, as_of_date, count(*) AS line_count,
       sum(plan_total_vnd)         AS plan_vnd,
       sum(disbursed_treasury_vnd) AS disbursed_treasury_vnd
FROM machvon_bi.v_disbursement_lines
GROUP BY period_id, as_of_date
ORDER BY as_of_date;

-- 9. Source for the table FactContract: the newest revision of each period
--    (the money of a contract is spread over its active parties by share_pct to the last dong,
--    so the lines of one contract add up to its value and nothing is counted twice)
SELECT c.snapshot_id, c.period_id, c.revision, c.cutoff_date, c.contract_id, c.contractor_id,
       c.is_lead, c.share_pct, c.project_id, c.unit_id, c.contract_status, c.contract_type,
       c.contract_value_vnd, c.active_value_vnd, c.paid_vnd
FROM machvon_bi.v_contract_lines c
WHERE c.revision = (
  SELECT max(x.revision) FROM machvon_bi.v_contract_lines x WHERE x.period_id = c.period_id
);

-- 10. Contract value and payments by project and status for the newest revision of the latest period
WITH latest AS (
  SELECT period_id, max(revision) AS revision
  FROM machvon_bi.v_contract_lines
  WHERE period_id = (SELECT period_id FROM machvon_bi.v_contract_lines ORDER BY cutoff_date DESC LIMIT 1)
  GROUP BY period_id
)
SELECT c.project_id, c.contract_status,
       count(DISTINCT c.contract_id)   AS contract_count,
       sum(c.active_value_vnd)         AS active_value_vnd,
       sum(c.paid_vnd)                 AS paid_vnd,
       round(100.0 * sum(c.paid_vnd) / NULLIF(sum(c.active_value_vnd), 0), 2) AS paid_pct
FROM machvon_bi.v_contract_lines c
JOIN latest l ON l.period_id = c.period_id AND l.revision = c.revision
GROUP BY c.project_id, c.contract_status
ORDER BY c.project_id, c.contract_status;

-- 11. What changed between consecutive revisions of the same period (a correction): contracts whose value moved
WITH r AS (
  SELECT period_id, contract_id, revision, sum(active_value_vnd) AS active_value_vnd, sum(paid_vnd) AS paid_vnd,
         lag(revision)          OVER w AS from_revision,
         lag(sum(active_value_vnd)) OVER w AS from_active_value_vnd,
         lag(sum(paid_vnd))     OVER w AS from_paid_vnd
  FROM machvon_bi.v_contract_lines
  GROUP BY period_id, contract_id, revision
  WINDOW w AS (PARTITION BY period_id, contract_id ORDER BY revision)
)
SELECT period_id, contract_id, from_revision, revision AS to_revision,
       active_value_vnd - from_active_value_vnd AS value_change_vnd,
       paid_vnd - from_paid_vnd                 AS paid_change_vnd
FROM r
WHERE from_revision IS NOT NULL
  AND (active_value_vnd <> from_active_value_vnd OR paid_vnd <> from_paid_vnd)
ORDER BY period_id, contract_id;
