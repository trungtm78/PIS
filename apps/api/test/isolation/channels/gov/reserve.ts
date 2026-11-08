import { FinAppraisalStore } from '@machvon/db';
import type { ScopeBuilder, TenantTx } from '@machvon/db';
import type { Client } from 'pg';
import {
  DOCUMENT_FIXTURES,
  MASTER_FIXTURES,
  MEMBERSHIP_FIXTURES,
  PROJECT_FIXTURES,
} from '../../suite';
import type { ForeignAttemptSpec } from '../api';
import { APPRAISAL_KINDS, RESERVE_FIXTURES } from './reserve.fixtures';
import type { AppraisalKind } from './reserve.fixtures';
import type { SeedContext } from './support';

const FOREIGN = RESERVE_FIXTURES['TNT-B'];
const FOREIGN_MEMBER = MEMBERSHIP_FIXTURES['TNT-B'].id;

/** The body of the inputs of an appraisal that is valid for the validation of the contract, so that the request reaches the lookup of the appraisal. */
const FOREIGN_INPUTS = {
  title: 'Isolation foreign update of the inputs',
  period_unit: 'YEAR',
  discount_rate_pct: '10',
  convention: 'END',
  lines: [
    { period: 0, capex: '1000000' },
    { period: 1, benefit: '600000' },
  ],
  assumptions: [
    {
      key: 'HORIZON',
      value: '1 year',
      unit: 'year',
      source_kind: 'ESTIMATE',
      source: 'Isolation foreign source',
      owner_id: FOREIGN_MEMBER,
    },
  ],
  scenarios: [],
  scores: [],
};

/**
 * The id-bearing operations of the reserve of a project and of the investment appraisals that no other spec covers. The owner (TNT-B) finds a real object for each of them: the project with its fund, the
 * drawdown that waits for its decision, the risk, and an appraisal in the state each command starts from (see `seedReserve`).
 */
export const RESERVE_SPECS: readonly ForeignAttemptSpec[] = [
  {
    operation: 'getInvestmentAppraisal',
    method: 'GET',
    id: FOREIGN.appraisals.draft.id,
  },
  {
    operation: 'updateInvestmentAppraisalInputs',
    method: 'POST',
    id: FOREIGN.appraisals.draft.id,
    versioned: true,
    body: FOREIGN_INPUTS,
  },
  {
    operation: 'runInvestmentAppraisal',
    method: 'POST',
    id: FOREIGN.appraisals.run.id,
    versioned: true,
    body: {},
  },
  {
    operation: 'exportInvestmentAppraisal',
    method: 'POST',
    id: FOREIGN.appraisals.export.id,
    body: { format: 'CSV' },
  },
  {
    operation: 'submitInvestmentAppraisal',
    method: 'POST',
    id: FOREIGN.appraisals.submit.id,
    versioned: true,
    body: {},
  },
  {
    operation: 'approveInvestmentAppraisal',
    method: 'POST',
    id: FOREIGN.appraisals.approve.id,
    versioned: true,
    body: { reason: 'Isolation foreign approval attempt' },
  },
  {
    operation: 'returnInvestmentAppraisal',
    method: 'POST',
    id: FOREIGN.appraisals.return.id,
    versioned: true,
    body: { reason: 'Isolation foreign return attempt' },
  },
  {
    operation: 'getProjectReserve',
    method: 'GET',
    id: PROJECT_FIXTURES['TNT-B'].id,
  },
  {
    operation: 'fundProjectReserve',
    method: 'POST',
    id: PROJECT_FIXTURES['TNT-B'].id,
    body: {
      kind: 'CONTINGENCY',
      amount_vnd: '1000',
      authority_document_version_id: DOCUMENT_FIXTURES['TNT-B'].versionId,
      reason: 'Isolation foreign funding attempt',
    },
  },
  {
    operation: 'requestReserveDrawdown',
    method: 'POST',
    id: PROJECT_FIXTURES['TNT-B'].id,
    body: {
      kind: 'CONTINGENCY',
      amount_vnd: '1000',
      risk_id: FOREIGN.riskId,
      reason: 'Isolation foreign drawdown request attempt',
    },
  },
  {
    operation: 'decideReserveDrawdown',
    method: 'POST',
    id: FOREIGN.drawdownId,
    versioned: true,
    body: { decision: 'reject', reason: 'Isolation foreign decision attempt' },
  },
  {
    operation: 'setRiskExposure',
    method: 'POST',
    id: FOREIGN.riskId,
    body: { probability_pct: '10', cost_impact_vnd: '1000' },
  },
];

/** Every operation of the controllers of the reserve and of the investment appraisal (the ones with an id in the path and the others): the suite principal holds the permission of each. */
export const RESERVE_OPERATIONS: readonly string[] = [
  'getProjectReserve',
  'fundProjectReserve',
  'requestReserveDrawdown',
  'decideReserveDrawdown',
  'setRiskExposure',
  'createInvestmentAppraisal',
  'updateInvestmentAppraisalInputs',
  'runInvestmentAppraisal',
  'submitInvestmentAppraisal',
  'approveInvestmentAppraisal',
  'returnInvestmentAppraisal',
  'exportInvestmentAppraisal',
  'listInvestmentAppraisals',
  'getInvestmentAppraisal',
];

/**
 * The tables the seed fills that have an `id` column and that no read of these operations changes (the child tables of an appraisal and the exposure of a risk have none). `project_risk` is the table of
 * the risk of the reserve; the risk of the fixtures of the project is in it too.
 */
export const RESERVE_SNAPSHOT_TABLES: readonly string[] = [
  'project_risk',
  'reserve_fund',
  'reserve_drawdown',
  'reserve_ledger_entry',
  'investment_appraisal',
];

const INSERT_RISK = `insert into machvon.project_risk
  (tenant_id, id, project_id, code, category_master_version_id, title, description, likelihood, impact, owner_membership_id, mitigation, due_date, status, created_by, updated_by)
  select $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6, 'Isolation fixture: a risk that the reserve of one tenant is drawn for', 4, 5, $7::uuid, 'Isolation fixture mitigation', current_date + 30, 'OPEN', $7::uuid, $7::uuid
   where not exists (select 1 from machvon.project_risk where id = $2::uuid)`;

const INSERT_FUND = `insert into machvon.reserve_fund (tenant_id, id, project_id, kind, created_by)
  select $1::uuid, $2::uuid, $3::uuid, 'CONTINGENCY', $4::uuid
   where not exists (select 1 from machvon.reserve_fund where id = $2::uuid)`;

/** The balance of the fund is the database's: the entry moves it. */
const INSERT_LEDGER_ENTRY = `insert into machvon.reserve_ledger_entry
  (tenant_id, id, fund_id, project_id, entry_kind, amount_vnd, authority_document_version_id, reason, requested_by)
  select $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'FUND', 5000000, $5::uuid, $6, $7::uuid
   where not exists (select 1 from machvon.reserve_ledger_entry where id = $2::uuid)`;

const INSERT_DRAWDOWN = `insert into machvon.reserve_drawdown
  (tenant_id, id, fund_id, project_id, amount_vnd, risk_id, reason, requested_by)
  select $1::uuid, $2::uuid, $3::uuid, $4::uuid, 100000, $5::uuid, $6, $7::uuid
   where not exists (select 1 from machvon.reserve_drawdown where id = $2::uuid)`;

/** A draft that starts at the given version; the commands send `If-Match: '1'`. */
const INSERT_APPRAISAL = `insert into machvon.investment_appraisal
  (tenant_id, id, code, title, kind, owner_unit_id, project_id, period_unit, discount_rate_pct, convention, version, created_by, updated_by)
  select $1::uuid, $2::uuid, $3, $4, 'FINANCIAL', $5::uuid, $6::uuid, 'YEAR', 10, 'END', $7::bigint, $8::uuid, $8::uuid
   where not exists (select 1 from machvon.investment_appraisal where id = $2::uuid)`;

/** The cash flow: the cost in the first period and the benefit in the three that follow it. */
const INSERT_CASH_LINES = `insert into machvon.appraisal_cash_line (tenant_id, appraisal_id, period, benefit_vnd, capex_vnd)
  values ($1::uuid, $2::uuid, 0, 0, 1000000), ($1::uuid, $2::uuid, 1, 600000, 0), ($1::uuid, $2::uuid, 2, 600000, 0), ($1::uuid, $2::uuid, 3, 600000, 0)`;

/** The inputs that a cash flow with a cost and a benefit has to be answered for: the horizon, the rate, the benefit and the cost, each with its source and owner. */
const INSERT_ASSUMPTIONS = `insert into machvon.appraisal_assumption (tenant_id, appraisal_id, input_key, value_text, unit, source_kind, source_text, owner_id)
  values ($1::uuid, $2::uuid, 'HORIZON', '3 years', 'year', 'ESTIMATE', $3, $4::uuid),
         ($1::uuid, $2::uuid, 'DISCOUNT_RATE', '10 percent a year', 'percent', 'ESTIMATE', $3, $4::uuid),
         ($1::uuid, $2::uuid, 'BENEFIT', 'The yearly toll', 'VND', 'ESTIMATE', $3, $4::uuid),
         ($1::uuid, $2::uuid, 'CAPEX', 'The cost of the bridge', 'VND', 'ESTIMATE', $3, $4::uuid)`;

const BACK_TO_VERSION =
  'update machvon.investment_appraisal set version = $2::bigint where id = $1::uuid';

/** The handle the stores take inside a transaction, over the connection of the seed. */
function txOf(client: Client): TenantTx {
  return {
    async query<R>(sql: string, params?: unknown[]): Promise<R[]> {
      const result = await client.query(sql, params);
      return result.rows as R[];
    },
  };
}

/** The scope of the seed reaches every appraisal: the rows are made for the suite, not asked for by a person. */
const EVERYTHING: ScopeBuilder = () => ({ sql: 'true', params: [] });

/** How far an appraisal of each kind is taken beyond its insert: the commands give it the state the command of the spec starts from. */
const PROGRESS: Readonly<
  Record<AppraisalKind, 'DRAFT' | 'COMPUTED' | 'SUBMITTED'>
> = {
  draft: 'DRAFT',
  run: 'DRAFT',
  export: 'COMPUTED',
  submit: 'COMPUTED',
  approve: 'SUBMITTED',
  return: 'SUBMITTED',
};

/**
 * Seeds the contingency of the project of the tenant (the risk, the fund, the entry that fills it and a drawdown that waits for its decision, asked for by the other member so that the suite principal may
 * decide it) and one investment appraisal for each command that moves one. The appraisals are made by the other member, so that the suite principal may approve. Where a command needs a computed result or a
 * submission, the store that the API uses takes the appraisal there (the hashes of a result belong to the formula, never to the seed), and the version goes back to the one the commands of the suite send.
 */
export async function seedReserve(
  client: Client,
  context: SeedContext,
): Promise<void> {
  const fixture = RESERVE_FIXTURES[context.tenant];
  const project = PROJECT_FIXTURES[context.tenant];
  const member = MEMBERSHIP_FIXTURES[context.tenant].id;
  await client.query(INSERT_RISK, [
    context.tenantId,
    fixture.riskId,
    project.id,
    fixture.riskCode,
    MASTER_FIXTURES[context.tenant].versionId,
    fixture.riskTitle,
    context.membershipId,
  ]);
  await client.query(INSERT_FUND, [
    context.tenantId,
    fixture.fundId,
    project.id,
    context.membershipId,
  ]);
  await client.query(INSERT_LEDGER_ENTRY, [
    context.tenantId,
    fixture.ledgerEntryId,
    fixture.fundId,
    project.id,
    DOCUMENT_FIXTURES[context.tenant].versionId,
    fixture.ledgerReason,
    context.membershipId,
  ]);
  await client.query(INSERT_DRAWDOWN, [
    context.tenantId,
    fixture.drawdownId,
    fixture.fundId,
    project.id,
    fixture.riskId,
    fixture.drawdownReason,
    member,
  ]);

  const store = new FinAppraisalStore();
  const tx = txOf(client);
  for (const kind of APPRAISAL_KINDS) {
    const appraisal = fixture.appraisals[kind];
    const progress = PROGRESS[kind];
    // A result is computed by the command, which adds one to the version: the row starts below the version it has to end at.
    const startVersion = progress === 'DRAFT' ? 1 : 0;
    const inserted = await client.query(INSERT_APPRAISAL, [
      context.tenantId,
      appraisal.id,
      appraisal.code,
      appraisal.title,
      context.home,
      project.id,
      startVersion,
      member,
    ]);
    // A seed that runs again leaves the appraisal as it is: the steps below are taken once, with the row.
    if (inserted.rowCount !== 1) continue;
    await client.query(INSERT_CASH_LINES, [context.tenantId, appraisal.id]);
    await client.query(INSERT_ASSUMPTIONS, [
      context.tenantId,
      appraisal.id,
      fixture.assumptionSource,
      member,
    ]);
    if (progress === 'DRAFT') continue;
    await store.run(tx, appraisal.id, 0, member, EVERYTHING, new Date());
    if (progress === 'COMPUTED') continue;
    await client.query(BACK_TO_VERSION, [appraisal.id, 0]);
    await store.submit(tx, appraisal.id, 0, member, EVERYTHING, new Date());
  }
}
