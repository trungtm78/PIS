-- Authored by hand (not generated): the contract fact (CA-1, plan "nen phan tich hop dong", eng-review R12): ONE row per contract that joins everything the analytics of the portfolio read (the ledger columns of the contract, the base
-- revision, the approved change orders, the guarantees, the retention, the advance, the requests of payment, the acceptances, the measurements, the NCRs, the findings of the audit and the price the package was won at). The view is
-- `security_invoker`, so the row-level security of every table it reads applies to the caller exactly as if the caller had read the tables itself: the view widens nothing and hides nothing the caller could see. The scope of a
-- reader (unit tree, project, contract grant) is the one of the register (`contractScope` over the aliases `c`, `p`, `ou`, `iu`), applied by the query that reads the view.
--
-- Every figure is a scalar subquery (or a column of the aggregate) of the select list on purpose: a query that reads only a few columns of the view (the totals row of the portfolio) does not evaluate the others. The figures
-- that add up other tables per contract come from `contract_aggregate` (R12: kept by triggers in the transaction of the write); a contract that has no aggregate row yet gets the same figures from
-- `contract_aggregate_of`, the one definition both are made from. Money is whole dong (numeric(24,0)).
-- The day the time-dependent columns are judged on (the guarantee in force, the days late of an open contract) is `machvon.contract_fact_as_of()`: today in Vietnam, or the day a builder of a snapshot fixed with
-- `set_config('app.contract_fact_as_of', '<date>', true)` for its own transaction, so the snapshot and the live view are one definition.

CREATE FUNCTION machvon.contract_fact_as_of() RETURNS date
LANGUAGE sql
STABLE
AS $fn$
  SELECT coalesce(nullif(current_setting('app.contract_fact_as_of', true), '')::date, (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)
$fn$;

CREATE VIEW machvon.contract_fact WITH (security_invoker = true) AS
SELECT
  c.tenant_id,
  c.id,
  c.code,
  c.title,
  c.status AS contract_status,
  c.type AS contract_type,
  c.project_id,
  c.package_id,
  c.contractor_id,
  c.is_joint_venture,
  p.owner_unit_id AS unit_id,
  p.investor_unit_id AS investor_id,
  (SELECT al.fund_source_version_id
     FROM machvon.procurement_package pk
     JOIN machvon.allocation_line al ON al.tenant_id = pk.tenant_id AND al.id = pk.allocation_line_id
    WHERE pk.tenant_id = c.tenant_id AND pk.id = c.package_id) AS fund_source_version_id,
  c.signed_on,
  c.effective_from,
  c.completion_due AS original_due_date,
  c.completed_on AS completed_on,
  c.terminated_on,
  -- the days the approved changes moved the due date by (the due date itself is left as it is), and the milestones of the BOQ in force that are past their day
  CASE WHEN a.contract_id IS NULL THEN (machvon.contract_aggregate_of(c.tenant_id, c.id)).approved_extension_days ELSE a.approved_extension_days END AS approved_extension_days,
  (SELECT count(DISTINCT l.milestone_code) FROM machvon.boq_line l WHERE l.tenant_id = c.tenant_id AND l.contract_revision_id = c.current_revision_id AND l.milestone_code IS NOT NULL)::integer AS milestone_count,
  (SELECT count(DISTINCT l.milestone_code) FROM machvon.boq_line l WHERE l.tenant_id = c.tenant_id AND l.contract_revision_id = c.current_revision_id AND l.milestone_code IS NOT NULL AND l.milestone_due_on < machvon.contract_fact_as_of())::integer AS milestone_past_due_count,
  -- the value now (with the approved changes), the value at signing (the base revision) and what the approved changes added
  c.contract_value_vnd,
  CASE WHEN a.contract_id IS NULL THEN (machvon.contract_aggregate_of(c.tenant_id, c.id)).original_value_vnd ELSE a.original_value_vnd END AS original_value_vnd,
  CASE WHEN a.contract_id IS NULL THEN (machvon.contract_aggregate_of(c.tenant_id, c.id)).approved_change_delta_vnd ELSE a.approved_change_delta_vnd END AS approved_change_delta_vnd,
  CASE WHEN a.contract_id IS NULL THEN (machvon.contract_aggregate_of(c.tenant_id, c.id)).approved_change_count ELSE a.approved_change_count END AS approved_change_count,
  CASE WHEN a.contract_id IS NULL THEN (machvon.contract_aggregate_of(c.tenant_id, c.id)).max_change_tier ELSE a.max_change_tier END AS max_change_tier,
  CASE WHEN a.contract_id IS NULL THEN (machvon.contract_aggregate_of(c.tenant_id, c.id)).max_cumulative_variation_pct ELSE a.max_cumulative_variation_pct END AS max_cumulative_variation_pct,
  -- the price the package was won at, and how many bidders there were (none on record is NULL)
  CASE WHEN a.contract_id IS NULL THEN (machvon.contract_aggregate_of(c.tenant_id, c.id)).winning_bid_vnd ELSE a.winning_bid_vnd END AS winning_bid_vnd,
  CASE WHEN a.contract_id IS NULL THEN (machvon.contract_aggregate_of(c.tenant_id, c.id)).bidder_count ELSE a.bidder_count END AS bidder_count,
  -- the ledger of the contract
  c.requested_total_vnd AS requested_vnd,
  c.accepted_total_vnd AS accepted_vnd,
  c.paid_total_vnd AS paid_vnd,
  c.advance_paid_vnd,
  c.advance_recovered_vnd,
  c.advance_outstanding_vnd,
  c.retention_held_vnd AS retention_withheld_vnd,
  c.retention_released_vnd,
  c.retention_held_vnd - c.retention_released_vnd AS retention_held_vnd,
  -- the guarantees: what the register holds (verified, not released, called or replaced) and what is in force on the as-of day; none on the register is NULL, not zero
  CASE WHEN a.contract_id IS NULL THEN (machvon.contract_aggregate_of(c.tenant_id, c.id)).guarantee_required_vnd ELSE a.guarantee_required_vnd END AS guarantee_required_vnd,
  (SELECT coalesce(sum(g.amount_vnd) FILTER (WHERE g.status = 'ACTIVE' AND (g.valid_from IS NULL OR g.valid_from <= machvon.contract_fact_as_of()) AND (g.expires_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date >= machvon.contract_fact_as_of()), 0)
     FROM machvon.guarantee g WHERE g.tenant_id = c.tenant_id AND g.contract_id = c.id AND g.status IN ('ACTIVE', 'EXPIRED')
    HAVING count(*) > 0) AS guarantee_valid_vnd,
  CASE WHEN a.contract_id IS NULL THEN (machvon.contract_aggregate_of(c.tenant_id, c.id)).guarantee_next_expiry_on ELSE a.guarantee_next_expiry_on END AS guarantee_next_expiry_on,
  -- the work: what the approved measurements are worth at the price of their BOQ line, and the acceptances
  (SELECT round(coalesce(sum(m.quantity_period * l.unit_price), 0))
     FROM machvon.measurement m JOIN machvon.boq_line l ON l.tenant_id = m.tenant_id AND l.id = m.boq_line_id
    WHERE m.tenant_id = c.tenant_id AND m.contract_id = c.id AND m.status = 'APPROVED') AS measured_vnd,
  (SELECT min(pr.treasury_submitted_on) FROM machvon.payment_request pr WHERE pr.tenant_id = c.tenant_id AND pr.contract_id = c.id AND pr.request_kind = 'ADVANCE' AND pr.status IN ('SENT_TREASURY', 'SETTLED')) AS first_advance_on,
  (SELECT max((a2.approved_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) FROM machvon.acceptance a2 WHERE a2.tenant_id = c.tenant_id AND a2.contract_id = c.id AND a2.status = 'APPROVED') AS last_acceptance_on,
  (SELECT max(pr.treasury_submitted_on) FROM machvon.payment_request pr WHERE pr.tenant_id = c.tenant_id AND pr.contract_id = c.id AND pr.status IN ('SENT_TREASURY', 'SETTLED')) AS last_treasury_submission_on,
  -- the clock of a payment: days from the approval of the acceptance to the request, and from the request to the Treasury (the worst request of the contract)
  (SELECT max((pr.submitted_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - (a2.approved_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)
     FROM machvon.payment_request pr JOIN machvon.acceptance a2 ON a2.tenant_id = pr.tenant_id AND a2.id = pr.acceptance_id
    WHERE pr.tenant_id = c.tenant_id AND pr.contract_id = c.id AND pr.request_kind <> 'ADVANCE' AND pr.status IN ('SUBMITTED', 'VERIFIED', 'SENT_TREASURY', 'SETTLED')
      AND a2.approved_at IS NOT NULL AND pr.submitted_at IS NOT NULL)::integer AS acceptance_to_request_days_max,
  (SELECT max(pr.treasury_submitted_on - (pr.submitted_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)
     FROM machvon.payment_request pr
    WHERE pr.tenant_id = c.tenant_id AND pr.contract_id = c.id AND pr.status IN ('SENT_TREASURY', 'SETTLED') AND pr.treasury_submitted_on IS NOT NULL AND pr.submitted_at IS NOT NULL)::integer AS request_to_treasury_days_max,
  (SELECT count(*) FROM machvon.payment_request pr WHERE pr.tenant_id = c.tenant_id AND pr.contract_id = c.id AND pr.status IN ('SENT_TREASURY', 'SETTLED'))::integer AS payments_sent_count,
  -- quality and audit
  (SELECT count(*) FROM machvon.quality_nonconformance n WHERE n.tenant_id = c.tenant_id AND n.contract_id = c.id AND n.status NOT IN ('VERIFIED', 'CLOSED'))::integer AS open_ncr_count,
  (SELECT count(*) FROM machvon.issue i WHERE i.tenant_id = c.tenant_id AND i.project_id = c.project_id AND i.status <> 'CLOSED')::integer AS project_open_issue_count,
  (SELECT count(*) FROM machvon.audit_finding f WHERE f.tenant_id = c.tenant_id AND f.contract_id = c.id)::integer AS audit_finding_count,
  -- days late against the ORIGINAL due date (an extension leaves `completion_due` as it is): to the day it was completed or terminated, or to the as-of day while it is open; none for a contract that was never in force
  CASE
    WHEN c.completion_due IS NULL OR c.status IN ('DRAFT', 'IN_REVIEW', 'CANCELLED') THEN NULL
    ELSE greatest(0, coalesce(c.completed_on, c.terminated_on, machvon.contract_fact_as_of()) - c.completion_due)
  END AS days_late,
  machvon.contract_fact_as_of() AS as_of_date
FROM machvon.contract c
JOIN machvon.project p ON p.tenant_id = c.tenant_id AND p.id = c.project_id
LEFT JOIN machvon.contract_aggregate a ON a.tenant_id = c.tenant_id AND a.contract_id = c.id;

GRANT SELECT ON machvon.contract_fact TO machvon_app;

COMMENT ON VIEW machvon.contract_fact IS 'One row per contract with every figure the contract analytics read (CA-1, R12); security_invoker, so row-level security applies to the caller; the scope of a reader is applied by the query that reads it.';
COMMENT ON FUNCTION machvon.contract_fact_as_of() IS 'The day the time-dependent columns of contract_fact are judged on: app.contract_fact_as_of of the transaction, else today in Vietnam.';
