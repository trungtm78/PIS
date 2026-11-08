import type { Client } from 'pg';
import { ADVANCE_FIXTURES, CONTRACT_FIXTURES, MEMBERSHIP_FIXTURES, PAYMENT_FIXTURES, PERIOD_SNAPSHOT_FIXTURES, PROJECT_FIXTURES } from '../../suite';
import type { ForeignAttemptSpec } from '../api';
import { EXCEPTION_KINDS, PAYCTL_FIXTURES, RECON_ITEM_KINDS } from './payctl.fixtures';
import type { ExceptionKind } from './payctl.fixtures';
import type { SeedContext } from './support';

const FOREIGN = 'TNT-B';
const FOREIGN_FIXTURE = PAYCTL_FIXTURES[FOREIGN];
const FOREIGN_MEMBER = MEMBERSHIP_FIXTURES[FOREIGN].id;
const FOREIGN_REQUEST = PAYMENT_FIXTURES[FOREIGN].id;
const FOREIGN_SNAPSHOT = PERIOD_SNAPSHOT_FIXTURES[FOREIGN].id;

/** A day some days from now, as `YYYY-MM-DD`: the days a body names are later than today whatever the day the suite runs on. */
function dayFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The foreign-id cases of the payment control: the integrity checks of a payment request, the exceptions to a ceiling of disbursement, the daily reconciliation with the Treasury, the recovery of an advance and
 * the cross-total control of a period snapshot. A TNT-A user names a request, an exception, a pass, an item, an advance, a contract or a snapshot of TNT-B. The owner (TNT-B) finds a real object for each of them:
 * the exceptions and the items of the daily reconciliation are one for each command (see `seedPayctl`), and the bodies are valid, so that the request reaches the lookup. The request for an exception on the payment
 * request of the fixtures is answered 409 for the owner (the request was sent, and only a draft needs a way past a ceiling), which is a rule and not a missing object.
 */
export const PAYCTL_SPECS: readonly ForeignAttemptSpec[] = [
  { operation: 'checkPaymentIntegrity', method: 'POST', id: FOREIGN_REQUEST, body: {} },
  { operation: 'getPaymentIntegrityChecks', method: 'GET', id: FOREIGN_REQUEST },
  {
    operation: 'requestDisbursementException',
    method: 'POST',
    id: FOREIGN_REQUEST,
    body: { ceiling: 'EXCEEDS_PLAN', allowed_amount_vnd: '1000', valid_to: dayFromNow(3), reason: 'Isolation foreign exception request attempt' },
  },
  { operation: 'approveDisbursementException', method: 'POST', id: FOREIGN_FIXTURE.exceptions.approve.id, versioned: true, body: { note: 'Isolation foreign approval attempt' } },
  { operation: 'rejectDisbursementException', method: 'POST', id: FOREIGN_FIXTURE.exceptions.reject.id, versioned: true, body: { reason: 'Isolation foreign refusal attempt' } },
  { operation: 'revokeDisbursementException', method: 'POST', id: FOREIGN_FIXTURE.exceptions.revoke.id, versioned: true, body: { reason: 'Isolation foreign revocation attempt' } },
  { operation: 'getTreasuryDailyReconRun', method: 'GET', id: FOREIGN_FIXTURE.reconRunId },
  { operation: 'getTreasuryDailyReconItem', method: 'GET', id: FOREIGN_FIXTURE.reconItems.read.id },
  {
    operation: 'assignTreasuryDailyReconItem',
    method: 'POST',
    id: FOREIGN_FIXTURE.reconItems.assign.id,
    versioned: true,
    body: { owner_membership_id: FOREIGN_MEMBER, due_on: dayFromNow(10) },
  },
  {
    operation: 'resolveTreasuryDailyReconItem',
    method: 'POST',
    id: FOREIGN_FIXTURE.reconItems.resolve.id,
    versioned: true,
    body: { resolution: 'RESOLVED', note: 'Isolation foreign resolution attempt' },
  },
  { operation: 'getAdvanceRecoveryTable', method: 'GET', id: ADVANCE_FIXTURES[FOREIGN].id },
  { operation: 'getContractAdvancePosition', method: 'GET', id: CONTRACT_FIXTURES[FOREIGN].id },
  { operation: 'getCrossTotalControl', method: 'GET', id: FOREIGN_SNAPSHOT },
  { operation: 'evaluateCrossTotal', method: 'POST', id: FOREIGN_SNAPSHOT, body: {} },
];

/** Every operation of the controllers of the payment integrity, the daily reconciliation, the recovery of an advance and the cross-total control (the ones with an id in the path and the others): the suite principal holds the permission of each. */
export const PAYCTL_OPERATIONS: readonly string[] = [
  'checkPaymentIntegrity',
  'requestDisbursementException',
  'approveDisbursementException',
  'rejectDisbursementException',
  'revokeDisbursementException',
  'getPaymentIntegrityChecks',
  'listPaymentIntegrityFindings',
  'listDisbursementExceptions',
  'runTreasuryDailyRecon',
  'assignTreasuryDailyReconItem',
  'resolveTreasuryDailyReconItem',
  'listTreasuryDailyReconRuns',
  'getTreasuryDailyReconRun',
  'listTreasuryDailyReconItems',
  'getTreasuryDailyReconItem',
  'getAdvanceRecoveryTable',
  'getContractAdvancePosition',
  'listAdvancePolicy',
  'getCrossTotalControl',
  'evaluateCrossTotal',
];

/**
 * The tables the seed fills that have an `id` column, and the one the cross-total control writes (nothing is seeded in it, so that it proves a foreign attempt wrote no check). No read of these operations changes a
 * row of them.
 */
export const PAYCTL_SNAPSHOT_TABLES: readonly string[] = [
  'payment_integrity_run',
  'payment_integrity_finding',
  'disbursement_exception',
  'treasury_daily_recon_run',
  'treasury_daily_recon_line',
  'treasury_daily_recon_item',
  'cross_total_check',
];

/** A draft request for the advance of the contract: it holds no lines and takes nothing from an acceptance, so the sums of a request are met with its amounts alone. */
const INSERT_DRAFT_REQUEST = `insert into machvon.payment_request
  (tenant_id, id, project_id, contract_id, advance_id, currency, gross_vnd, advance_recovery_vnd, retention_vnd, tax_adjustment_vnd, net_vnd, status, version, request_kind, request_no, claims_acceptance, created_by, updated_by)
  select $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'VND', 7, 0, 0, 0, 7, 'DRAFT', 1, 'ADVANCE', $6, false, $7::uuid, $7::uuid
   where not exists (select 1 from machvon.payment_request where id = $2::uuid)`;

/** A check of the request that found a ceiling stood: an invariant that blocks and no exception covers. A run and its findings are kept as they were written. */
const INSERT_INTEGRITY_RUN = `insert into machvon.payment_integrity_run
  (tenant_id, id, payment_request_id, contract_id, project_id, trigger_kind, outcome, rule_version, rule_source, rule_unverified, rule_params, as_of, invariant_count, signal_count, excused_count, unavailable, figures, created_by)
  select $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'PREVIEW', 'BLOCKED', 0, 'DEFAULT', true, '{}'::jsonb, date '2026-02-02', 1, 0, 0, '[]'::jsonb, '{}'::jsonb, $6::uuid
   where not exists (select 1 from machvon.payment_integrity_run where id = $2::uuid)`;

const INSERT_INTEGRITY_FINDING = `insert into machvon.payment_integrity_finding
  (tenant_id, id, run_id, payment_request_id, contract_id, code, kind, severity, excused, subject, params)
  select $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'EXCEEDS_PLAN', 'INVARIANT', 'BLOCK', false, jsonb_build_object('note', $6::text), '{"over_by_vnd":"1000"}'::jsonb
   where not exists (select 1 from machvon.payment_integrity_finding where id = $2::uuid)`;

/** An exception that is asked for and waits for its decision: it lapses thirty days from now (Vietnamese time), so the window of the command and of the table is met. */
const INSERT_EXCEPTION_REQUESTED = `insert into machvon.disbursement_exception
  (tenant_id, id, payment_request_id, contract_id, project_id, ceiling, allowed_amount_vnd, valid_to, reason, status, requested_by)
  select $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, 5000000, (now() at time zone 'Asia/Ho_Chi_Minh')::date + 30, $7, 'REQUESTED', $8::uuid
   where not exists (select 1 from machvon.disbursement_exception where id = $2::uuid)`;

/** An exception that was approved by another member than the one who asked for it, and not used. */
const INSERT_EXCEPTION_APPROVED = `insert into machvon.disbursement_exception
  (tenant_id, id, payment_request_id, contract_id, project_id, ceiling, allowed_amount_vnd, valid_to, reason, status, requested_by, decided_by, decided_at)
  select $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, 5000000, (now() at time zone 'Asia/Ho_Chi_Minh')::date + 30, $7, 'APPROVED', $8::uuid, $9::uuid, now()
   where not exists (select 1 from machvon.disbursement_exception where id = $2::uuid)`;

/** The pass of a day that found a difference on each fund of the project: the thresholds are the default ones, and the author is the suite principal (the pass has no foreign key on it). */
const INSERT_RECON_RUN = `insert into machvon.treasury_daily_recon_run
  (tenant_id, id, recon_date, run_no, status, statement_imports, transaction_count, line_count, difference_line_count, opened_items, cleared_items, books_total_vnd, treasury_total_vnd, rule_version, rule_source, rule_unverified,
   threshold_vnd, due_days, partial_after_days, calendar_basis, result_sha256, origin, created_by)
  select $1::uuid, $2::uuid, date '2026-02-02', 1, 'COMPLETE', 1, 3, 3, 3, 3, 0, 3000000, 4500000, 0, 'DEFAULT', true, 1000000, 5, 2, 'WEEKDAYS_ASSUMED', repeat('c', 64), 'MANUAL', $3::uuid
   where not exists (select 1 from machvon.treasury_daily_recon_run where id = $2::uuid)`;

/** A line of the pass: the books hold less than the Treasury, so the line has a kind and opens an item. */
const INSERT_RECON_LINE = `insert into machvon.treasury_daily_recon_line
  (tenant_id, id, run_id, project_id, project_code, fund_key, fund_label, books_vnd, treasury_vnd, books_count, treasury_count, kind, opens_item)
  select $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, 1000000, 1500000, 1, 2, 'UNMATCHED', true
   where not exists (select 1 from machvon.treasury_daily_recon_line where id = $2::uuid)`;

/** The item the line opened: open, owned by the other member (the suite principal gives it away and resolves it), due on a day in the past. */
const INSERT_RECON_ITEM = `insert into machvon.treasury_daily_recon_item
  (tenant_id, id, project_id, fund_key, fund_label, recon_date, kind, books_vnd, treasury_vnd, latest_difference_vnd, owner_membership_id, due_on, status, opened_run_id, last_run_id, created_by, updated_by)
  select $1::uuid, $2::uuid, $3::uuid, $4, $5, date '2026-02-02', 'UNMATCHED', 1000000, 1500000, 500000, $6::uuid, date '2026-02-10', 'OPEN', $7::uuid, $7::uuid, $6::uuid, $6::uuid
   where not exists (select 1 from machvon.treasury_daily_recon_item where id = $2::uuid)`;

/** The cap of an advance as the tenant published it (the table of tiers is an assumption that waits for confirmation, like the baseline), in force for good from the start of the year. */
const INSERT_CAP_RECORD = `insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by)
  select $1::uuid, $2::uuid, 'TENANT', 'PAY_ADVANCE_CAP', $3, 'EFFECTIVE', $4::uuid, $4::uuid
   where not exists (select 1 from machvon.master_record where id = $2::uuid)`;

const INSERT_CAP_VERSION = `insert into machvon.master_record_version
  (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, legal_basis, published_at, created_by, updated_by)
  select $1::uuid, $2::uuid, $3::uuid, 'PAY_ADVANCE_CAP', $4, 1, $4,
         '{"owner_module":"PAY","awaiting_confirmation":true,"cxn":"CXN-02","tiers":[{"min_value_vnd":"0","cap_pct":"30"}],"recovery_threshold_pct":"80"}'::jsonb,
         date '2026-01-01', 'EFFECTIVE', 'TENANT', $5, timestamptz '2026-01-01T00:00:00Z', $6::uuid, $6::uuid
   where not exists (select 1 from machvon.master_record_version where id = $2::uuid)`;

const SET_CAP_CURRENT = 'update machvon.master_record set current_version_id = $2::uuid where id = $1::uuid';

/** For each exception: the request it is on, the ceiling it is for, and whether it was approved. A request and a ceiling have one live exception, so the refusal is on the draft request. */
const EXCEPTION_PLAN: Readonly<Record<ExceptionKind, { onDraft: boolean; ceiling: 'EXCEEDS_PLAN' | 'EXCEEDS_CONTRACT'; approved: boolean }>> = {
  approve: { onDraft: false, ceiling: 'EXCEEDS_PLAN', approved: false },
  reject: { onDraft: true, ceiling: 'EXCEEDS_PLAN', approved: false },
  revoke: { onDraft: false, ceiling: 'EXCEEDS_CONTRACT', approved: true },
};

/**
 * Seeds, for the tenant of the context: a check of its payment request with the finding it made; three exceptions to a ceiling of disbursement, asked for by the other member so that the suite principal may decide
 * them (one waits for its approval, one for its refusal and one is approved, so that it can be taken back); one pass of the daily reconciliation with three items of difference, one for each case (read, given an
 * owner, resolved); and the cap of an advance, which `listAdvancePolicy` reads. The payment request of the fixtures was sent, so the refusal sits on a draft request for the advance that is added here.
 */
export async function seedPayctl(client: Client, context: SeedContext): Promise<void> {
  const fixture = PAYCTL_FIXTURES[context.tenant];
  const tenantId = context.tenantId;
  const project = PROJECT_FIXTURES[context.tenant].id;
  const contract = CONTRACT_FIXTURES[context.tenant].id;
  const request = PAYMENT_FIXTURES[context.tenant].id;
  const maker = MEMBERSHIP_FIXTURES[context.tenant].id;
  const decider = context.membershipId;

  await client.query(INSERT_DRAFT_REQUEST, [tenantId, fixture.draftRequestId, project, contract, ADVANCE_FIXTURES[context.tenant].id, fixture.draftRequestNo, context.actorId]);

  await client.query(INSERT_INTEGRITY_RUN, [tenantId, fixture.integrityRunId, request, contract, project, decider]);
  await client.query(INSERT_INTEGRITY_FINDING, [tenantId, fixture.findingId, fixture.integrityRunId, request, contract, fixture.findingNote]);

  for (const kind of EXCEPTION_KINDS) {
    const plan = EXCEPTION_PLAN[kind];
    const exception = fixture.exceptions[kind];
    const onRequest = plan.onDraft ? fixture.draftRequestId : request;
    const common = [tenantId, exception.id, onRequest, contract, project, plan.ceiling, exception.reason, maker];
    if (plan.approved) await client.query(INSERT_EXCEPTION_APPROVED, [...common, decider]);
    else await client.query(INSERT_EXCEPTION_REQUESTED, common);
  }

  await client.query(INSERT_RECON_RUN, [tenantId, fixture.reconRunId, decider]);
  for (const kind of RECON_ITEM_KINDS) {
    const item = fixture.reconItems[kind];
    await client.query(INSERT_RECON_LINE, [tenantId, item.lineId, fixture.reconRunId, project, PROJECT_FIXTURES[context.tenant].code, item.fundKey, item.fundLabel]);
    await client.query(INSERT_RECON_ITEM, [tenantId, item.id, project, item.fundKey, item.fundLabel, maker, fixture.reconRunId]);
  }

  await client.query(INSERT_CAP_RECORD, [tenantId, fixture.capRecordId, fixture.capCategory, context.actorId]);
  await client.query(INSERT_CAP_VERSION, [tenantId, fixture.capVersionId, fixture.capRecordId, fixture.capCategory, fixture.capBasis, context.actorId]);
  await client.query(SET_CAP_CURRENT, [fixture.capRecordId, fixture.capVersionId]);
}
