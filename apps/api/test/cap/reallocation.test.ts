import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, PrjProjectStore, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { capModule } from '../../src/modules/cap';
import { CapitalPlanApprovalController } from '../../src/modules/cap/plan-approval.controller';
import { CapitalPlanController, CapitalPlanLinesController } from '../../src/modules/cap/plan.controller';
import { CapitalPlanRevisionController } from '../../src/modules/cap/plan-revision.controller';
import { ReallocationController } from '../../src/modules/cap/reallocation.controller';
import { CAP_METRICS } from '../../src/modules/cap/tokens';
import { AuthzHarness, TENANT_A, TENANT_B, id as familyId, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(300_000);

const SIGNING_KEY = randomBytes(32);
const PLANNER = 2; // drafts, submits and revises the plan; proposes a reallocation
const APPROVER = 3; // approves the plan
const PUBLISHER = 4; // publishes the plan
const PROPOSER = 5; // capital.reallocation.propose
const DECIDER = 6; // capital.reallocation.approve
const APPLIER = 7; // capital.reallocation.apply
const READER = 8; // capital.read
const BRANCH_READER = 9; // capital.read on another branch
const ALL_REALLOCATION = 10; // propose, approve and apply on the whole tenant: asks, decides and applies
const NOBODY = 11;
const B_PLANNER = 1; // of tenant B
const ROOT = 1;
const BQL1 = 2;
const ELSEWHERE = 3;
const BILLION = 1_000_000_000;
const TODAY = vietnamDateOf(new Date());
const FAMILY = 0xad;
const READS = ['capital.read', 'plan_version.read', 'allocation_line.read'];
const REASON = 'Move capital from the slow bridge to the fast road: the bridge is behind the curve by twenty points';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

interface World {
  planId: string;
  planVersion: number;
  year: number;
  /** Project and line of each of the three: A and B draw on the central appropriation, C on the local one. */
  a: { project: string; line: string };
  b: { project: string; line: string };
  c: { project: string; line: string };
  central: string;
  local: string;
  snapshotId: string;
}

/** The reallocation of capital from slow to fast projects over HTTP (ST-CAP-010, CAP-19, CAP 3.1 F5, BR-CAP-07). */
describe('the reallocation of capital (ST-CAP-010)', () => {
  const harness = new AuthzHarness();
  const projects = new PrjProjectStore();
  let app: RunningApp;
  let counter = 0;
  let yearCounter = 2090;
  const versions: Record<string, string> = {};

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  const money = (billions: number): string => String(billions * BILLION);
  const freshYear = (): number => {
    yearCounter -= 1;
    return yearCounter;
  };

  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string | number }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = `"${options.ifMatch}"`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;
  const versionOf = (reply: Reply): number => reply.json.resource_version as number;
  async function seed(statements: Array<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  async function document(): Promise<string> {
    const documentId = randomUUID();
    await rows(
      `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
       values ($1, $2, 'REFERENCE', 'QD', 'A decision', $3, '2026-01-15', 'EFFECTIVE', 'INTERNAL', $4, $4)`,
      [TENANT_A, documentId, `QD-${documentId.slice(0, 8)}`, memberId(PLANNER)],
    );
    return documentId;
  }

  async function appropriation(year: number, amount: string, source: string, level: 'CENTRAL' | 'LOCAL', origin: string): Promise<string> {
    const appropriationId = randomUUID();
    await rows(
      `insert into machvon.appropriation
         (tenant_id, id, fund_source_version_id, plan_year, origin, budget_level, amount_vnd, allocated_total_vnd, decision_document_id, issuing_authority, source_year, revision, status, approved_by, created_by, updated_by)
       values ($1, $2, $3, $4, $9, $10, $5::numeric, 0, $6, 'Thủ tướng Chính phủ', $4, 1, 'PUBLISHED', $7, $8, $8)`,
      [TENANT_A, appropriationId, source, year, amount, await document(), memberId(APPROVER), memberId(PLANNER), origin, level],
    );
    return appropriationId;
  }

  async function project(): Promise<string> {
    counter += 1;
    const number = counter;
    const code = `RA-${number}-${randomUUID().slice(0, 6)}`;
    const created = await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(PLANNER), scopeVersion: 1 }, (tx) =>
      projects.create(tx, { code, name: `Project ${code}`, ownerUnitId: unitId(BQL1), areaMasterVersionId: versions.area as string, totalInvestmentVnd: '500000000000' }, memberId(PLANNER), TODAY),
    );
    await rows('update machvon.project set status = $2, project_group = $3, national_project_code = $4 where id = $1::uuid', [created.id, 'PIPELINE', 'B', String(7000000 + number)]);
    return created.id;
  }

  async function seedMaster(name: string, masterType: string, attributes: Record<string, unknown>): Promise<string> {
    counter += 1;
    const recordId = randomUUID();
    const versionId = randomUUID();
    const key = `${name}-${counter}`;
    await harness.owner(TENANT_A, [
      [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', $3, $4, 'EFFECTIVE', $5, $5)`, [TENANT_A, recordId, masterType, key, memberId(PLANNER)]],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
         values ($1, $2, $3, $4, 1, $5, $6::jsonb, '2020-01-01', 'EFFECTIVE', $7, now(), $8, $8)`,
        [TENANT_A, versionId, masterType, key, `Label ${key}`, JSON.stringify(attributes), recordId, memberId(PLANNER)],
      ],
    ]);
    return versionId;
  }

  /** A close snapshot of a period, FROZEN or not, with a line for each project (the basis the proposal quotes). */
  async function snapshot(frozen: boolean, projectIds: string[] = []): Promise<string> {
    counter += 1;
    const periodId = familyId(FAMILY, 1000 + counter);
    const snapshotId = randomUUID();
    await seed([
      [
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, $3, 1, $4::date, $4::date + 6, now(), 'DEFAULT', 'WEEK', 2027, 'OPEN', $5, $6, $6)`,
        [TENANT_A, periodId, `RAP-${counter}`, new Date(Date.UTC(2042, 0, 2) + counter * 7 * 86_400_000).toISOString().slice(0, 10), familyId(FAMILY, 40), WORKER_MEMBERSHIP_ID],
      ],
      [
        `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, created_by, updated_by)
         values ($1, $2, $3, 'PERIOD_CLOSE', now(), '2027-10-31', '2027-10-31', 'BUILDING', 'DIS-METRICS-R1-PROPOSED', 'PROPOSED_PENDING_SIGNOFF', $4, $5, $5)`,
        [TENANT_A, snapshotId, periodId, projectIds.length, WORKER_MEMBERSHIP_ID],
      ],
      ...projectIds.map((projectId): [string, unknown[]] => [
        `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, bucket, budget_level, plan_pm_assigned_vnd, plan_total_vnd, disbursed_treasury_vnd, treasury_coverage)
         values ($1, gen_random_uuid(), $2, $3, $4, 'CURRENT_YEAR', 'CENTRAL', 1000, 1000, 120, 'COMPLETE')`,
        [TENANT_A, snapshotId, projectId, unitId(BQL1)],
      ]),
      ...(frozen
        ? ([[`update machvon.period_snapshot set status = 'FROZEN', payload_sha256 = repeat('a', 64), frozen_by = $2, frozen_at = now() where id = $1`, [snapshotId, WORKER_MEMBERSHIP_ID]]] as Array<[string, unknown[]]>)
        : []),
    ]);
    return snapshotId;
  }

  /** Takes a plan to PUBLISHED through the three commands. */
  async function carry(planId: string, version: number, effectiveAt: string): Promise<number> {
    const submitted = await call('POST', `/capital-plans/${planId}/submit`, { member: PLANNER, ifMatch: version, body: {} });
    expect(submitted.status).toBe(200);
    const decided = await call('POST', `/capital-plans/${planId}/decision`, { member: APPROVER, ifMatch: versionOf(submitted), body: { decision: 'approve', reason: 'Reviewed against the decision' } });
    expect(decided.status).toBe(200);
    const published = await call('POST', `/plans/${planId}/publish`, { member: PUBLISHER, ifMatch: versionOf(decided), body: { decision_document_id: await document(), effective_at: effectiveAt } });
    expect(published.status).toBe(200);
    return versionOf(published);
  }

  /** A published plan of three projects: A (5 billion) and B (1 billion) on the central appropriation, C (2 billion) on the local one; and a frozen snapshot of them. */
  async function world(): Promise<World> {
    const year = freshYear();
    const central = await appropriation(year, money(50), versions.nstw as string, 'CENTRAL', 'PM_ASSIGNED');
    const local = await appropriation(year, money(50), versions.nsdp as string, 'LOCAL', 'LOCAL_ADDED');
    const [a, b, c] = [await project(), await project(), await project()];
    counter += 1;
    const created = await call('POST', '/capital-plans', {
      member: PLANNER,
      body: { plan_code: `RA-${counter}-${randomUUID().slice(0, 6)}`, plan_kind: 'ANNUAL', plan_year: year, period_from_year: year, period_to_year: year, scope_unit_id: unitId(ROOT) },
    });
    expect(created.status).toBe(200);
    const planId = idOf(created);
    const line = (project_id: string, appropriation_id: string, billions: number) => ({ project_id, appropriation_id, bucket: 'CURRENT_YEAR', source_year: year, amount_vnd: money(billions) });
    const drafted = await call('POST', `/capital-plans/${planId}/allocations`, { member: PLANNER, ifMatch: versionOf(created), body: { lines: [line(a, central, 5), line(b, central, 1), line(c, local, 2)] } });
    expect(drafted.status).toBe(200);
    const planVersion = await carry(planId, versionOf(drafted), '2030-06-30T00:00:00Z');
    const lines = await rows<{ id: string; project_id: string }>('select al.id, al.project_id from machvon.allocation_line al join machvon.plan_version pv on pv.id = al.plan_version_id where pv.capital_plan_id = $1::uuid', [planId]);
    const lineOf = (projectId: string): string => lines.find((candidate) => candidate.project_id === projectId)?.id as string;
    return {
      planId,
      planVersion,
      year,
      a: { project: a, line: lineOf(a) },
      b: { project: b, line: lineOf(b) },
      c: { project: c, line: lineOf(c) },
      central,
      local,
      snapshotId: await snapshot(true, [a, b, c]),
    };
  }

  let codeCounter = 0;
  const proposalBody = (w: World, lines: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
    code: `RP-${(codeCounter += 1)}-${randomUUID().slice(0, 6)}`,
    plan_year: w.year,
    scope_unit_id: unitId(ROOT),
    basis_snapshot_id: w.snapshotId,
    source_capital_plan_id: w.planId,
    reason: REASON,
    lines,
    ...extra,
  });
  const move = (from: { line: string }, to: { project: string }, billions: number, extra: Record<string, unknown> = {}) => ({ from_allocation_line_id: from.line, to_project_id: to.project, amount_vnd: money(billions), ...extra });
  const draft = (body: Record<string, unknown>, member = PROPOSER): Promise<Reply> => call('POST', '/reallocation-proposals', { member, body });
  const submit = (proposalId: string, version: number, member = PROPOSER): Promise<Reply> => call('POST', `/reallocation-proposals/${proposalId}/submit`, { member, ifMatch: version, body: {} });
  const decide = (proposalId: string, version: number, decision: string, member = DECIDER): Promise<Reply> =>
    call('POST', `/reallocation-proposals/${proposalId}/decision`, { member, ifMatch: version, body: { decision, reason: 'Reviewed against the snapshot' } });
  const apply = async (proposalId: string, version: number, member = APPLIER, documentId?: string): Promise<Reply> =>
    call('POST', `/reallocation-proposals/${proposalId}/apply`, { member, ifMatch: version, body: { decision_document_id: documentId ?? (await document()) } });
  /** A proposal taken to APPROVED: drafted and submitted by the proposer, approved by the decider. */
  async function approved(w: World, lines: Array<Record<string, unknown>>): Promise<{ id: string; version: number }> {
    const made = await draft(proposalBody(w, lines));
    expect(made.status).toBe(200);
    const submitted = await submit(idOf(made), versionOf(made));
    expect(submitted.status).toBe(200);
    const decided = await decide(idOf(made), versionOf(submitted), 'approve');
    expect(decided.status).toBe(200);
    return { id: idOf(made), version: versionOf(decided) };
  }
  const planStatus = async (planId: string): Promise<string> => (await rows<{ status: string }>('select status from machvon.capital_plan where id = $1::uuid', [planId]))[0]?.status as string;
  const allocated = async (lineId: string): Promise<string> => (await rows<{ amount: string }>('select amount_vnd::text as amount from machvon.allocation_line where id = $1::uuid', [lineId]))[0]?.amount as string;
  const balanceOf = async (projectId: string, planId: string): Promise<string> =>
    (await rows<{ allocated: string }>(
      `select b.allocated_vnd::text as allocated from machvon.allocation_balance b join machvon.allocation_line al on al.id = b.allocation_line_id join machvon.plan_version pv on pv.id = al.plan_version_id
        where al.project_id = $1::uuid and pv.capital_plan_id = $2::uuid`,
      [projectId, planId],
    ))[0]?.allocated as string;
  const ceiling = async (appropriationId: string): Promise<string> => (await rows<{ total: string }>('select allocated_total_vnd::text as total from machvon.appropriation where id = $1::uuid', [appropriationId]))[0]?.total as string;

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: BQL1, path: `/${unitId(ROOT)}/${unitId(BQL1)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    for (const n of [PLANNER, APPROVER, PUBLISHER, PROPOSER, DECIDER, APPLIER, READER, BRANCH_READER, ALL_REALLOCATION, NOBODY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_PLANNER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'PLANNER', ['capital.plan.draft', 'capital.plan.submit', ...READS], 40);
    await harness.seedRole(TENANT_A, 2, 'APPROVER', ['capital.plan.approve', ...READS], 50);
    await harness.seedRole(TENANT_A, 3, 'PUBLISHER', ['plan.publish', ...READS], 50);
    await harness.seedRole(TENANT_A, 4, 'PROPOSER', ['capital.reallocation.propose', ...READS], 40);
    await harness.seedRole(TENANT_A, 5, 'DECIDER', ['capital.reallocation.approve', ...READS], 50);
    await harness.seedRole(TENANT_A, 6, 'APPLIER', ['capital.reallocation.apply', ...READS], 50);
    await harness.seedRole(TENANT_A, 7, 'READER', READS, 20);
    await harness.seedRole(TENANT_A, 8, 'ALL_REALLOCATION', ['capital.reallocation.propose', 'capital.reallocation.approve', 'capital.reallocation.apply', ...READS], 60);
    await harness.seedRole(TENANT_B, 1, 'PLANNER', ['capital.plan.draft', 'capital.plan.submit', 'capital.reallocation.propose', ...READS], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: PLANNER, role: 1, kind: 'TENANT' },
      { n: 2, member: APPROVER, role: 2, kind: 'TENANT' },
      { n: 3, member: PUBLISHER, role: 3, kind: 'TENANT' },
      { n: 4, member: PROPOSER, role: 4, kind: 'TENANT' },
      { n: 5, member: DECIDER, role: 5, kind: 'TENANT' },
      { n: 6, member: APPLIER, role: 6, kind: 'TENANT' },
      { n: 7, member: READER, role: 7, kind: 'TENANT' },
      { n: 8, member: BRANCH_READER, role: 7, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 9, member: ALL_REALLOCATION, role: 8, kind: 'TENANT' },
      { n: 10, member: PLANNER, role: 4, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_PLANNER, role: 1, kind: 'TENANT' }]);
    versions.nstw = await seedMaster('NSTW-DTPT', 'FUND_SOURCE', { category: 'NSTW', relation: 'ADDITIVE' });
    versions.nsdp = await seedMaster('NSDP-DTPT', 'FUND_SOURCE', { category: 'NSDP', relation: 'ADDITIVE' });
    versions.area = await seedMaster('AREA', 'AREA', {});
    const tenants = harness.tenants as TenantDatabase;
    const metrics: MetricsSink = { increment: () => undefined, gauge: () => undefined };
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [CapitalPlanController, CapitalPlanApprovalController, CapitalPlanLinesController, CapitalPlanRevisionController, ReallocationController],
      providers: [{ provide: TenantDatabase, useValue: tenants }, { provide: CAP_METRICS, useValue: metrics }, { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module of CAP', () => {
    expect(capModule.controllers).toContain(ReallocationController);
  });

  describe('AC-ST-CAP-010-1 / UAT-AC228: from a frozen snapshot to a new published revision', () => {
    it('AC-ST-CAP-010-1: a transfer of 2 billion from A to B is drafted, submitted, approved by another user and applied: a new PUBLISHED revision, TRANSFER_OUT and TRANSFER_IN with one source, the totals unchanged; a move from NSTW to NSDP is 422 TRANSFER_UNBALANCED', async () => {
      const w = await world();
      const ceilingBefore = [await ceiling(w.central), await ceiling(w.local)];
      const made = await draft(proposalBody(w, [move(w.a, w.b, 2, { rationale: 'Project A is twenty points behind the curve' })]));
      expect(made).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: 1 } });
      const proposalId = idOf(made);
      const submitted = await submit(proposalId, 1);
      expect(submitted).toMatchObject({ status: 200, json: { status: 'SUBMITTED', resource_version: 2 } });
      const decided = await decide(proposalId, 2, 'approve');
      expect(decided).toMatchObject({ status: 200, json: { status: 'APPROVED', resource_version: 3 } });
      expect(await planStatus(w.planId)).toBe('PUBLISHED');

      const applied = await apply(proposalId, 3);
      expect(applied).toMatchObject({ status: 200, json: { status: 'APPLIED', resource_version: 4 } });
      const proposal = (await rows<{ resulting_capital_plan_id: string; decision_document_id: string; applied_by: string; status: string }>('select resulting_capital_plan_id, decision_document_id, applied_by, status from machvon.reallocation_proposal where id = $1::uuid', [proposalId]))[0]!;
      expect(proposal).toMatchObject({ status: 'APPLIED', applied_by: memberId(APPLIER) });
      const resulting = proposal.resulting_capital_plan_id;
      expect(resulting).not.toBe(w.planId);
      expect(await planStatus(resulting)).toBe('PUBLISHED');
      expect(await planStatus(w.planId)).toBe('SUPERSEDED');
      // The plan in force now has the move, the old plan keeps what it said.
      const newLines = await rows<{ project_id: string; amount: string }>('select al.project_id, al.amount_vnd::text as amount from machvon.allocation_line al join machvon.plan_version pv on pv.id = al.plan_version_id where pv.capital_plan_id = $1::uuid', [resulting]);
      expect(Object.fromEntries(newLines.map((line) => [line.project_id, line.amount]))).toEqual({ [w.a.project]: money(3), [w.b.project]: money(3), [w.c.project]: money(2) });
      expect(await allocated(w.a.line)).toBe(money(5));
      expect(await balanceOf(w.a.project, resulting)).toBe(money(3));
      expect(await balanceOf(w.b.project, resulting)).toBe(money(3));
      // The ledger: one pair under the one proposal, and nothing else of this plan changed.
      const entries = await rows<{ entry_type: string; amount_vnd: string; project_id: string; source_ref_kind: string; source_ref_id: string }>(
        `select entry_type, amount_vnd::text as amount_vnd, project_id, source_ref_kind, source_ref_id from machvon.capital_ledger_entry where source_ref_id = $1::uuid order by entry_type`,
        [proposalId],
      );
      expect(entries).toEqual([
        { entry_type: 'TRANSFER_IN', amount_vnd: money(2), project_id: w.b.project, source_ref_kind: 'REALLOCATION', source_ref_id: proposalId },
        { entry_type: 'TRANSFER_OUT', amount_vnd: money(2), project_id: w.a.project, source_ref_kind: 'REALLOCATION', source_ref_id: proposalId },
      ]);
      expect(await rows(`select id from machvon.capital_ledger_entry where source_ref_id = $1::uuid`, [resulting])).toHaveLength(0);
      expect([await ceiling(w.central), await ceiling(w.local)]).toEqual(ceilingBefore);
      // The audit and the events: the application, the publication of the revision, and the two events.
      expect(await rows(`select id from machvon.audit_event where resource_id = $1 and action = 'capital.reallocation_applied'`, [proposalId])).toHaveLength(1);
      expect(await rows(`select id from machvon.audit_event where resource_id = $1 and action = 'capital.plan_published'`, [resulting])).toHaveLength(1);
      const event = await rows<{ payload: Record<string, unknown> }>(`select payload from machvon.outbox_event where type = 'capital.reallocation_applied.v1' and aggregate_id = $1`, [proposalId]);
      expect(event).toHaveLength(1);
      expect(event[0]?.payload).toMatchObject({ proposal_id: proposalId, resulting_capital_plan_id: resulting, source_capital_plan_id: w.planId, total_vnd: money(2), lines: [{ from_project_id: w.a.project, to_project_id: w.b.project, amount_vnd: money(2) }] });
      expect(await rows(`select id from machvon.outbox_event where type = 'capital.plan_published.v1' and aggregate_id = $1`, [resulting])).toHaveLength(1);
      expect(JSON.stringify(await rows('select safe_diff from machvon.audit_event where resource_id = $1', [proposalId]))).not.toContain(REASON);

      // A second proposal on the plan in force that moves central capital to a project that holds none: another appropriation, so it is not balanced.
      const newA = (await rows<{ id: string }>('select al.id from machvon.allocation_line al join machvon.plan_version pv on pv.id = al.plan_version_id where pv.capital_plan_id = $1::uuid and al.project_id = $2::uuid', [resulting, w.a.project]))[0]?.id as string;
      const second = await draft({ ...proposalBody(w, [move({ line: newA }, w.c, 1)]), source_capital_plan_id: resulting });
      expect(second).toMatchObject({ status: 422, json: { code: 'TRANSFER_UNBALANCED', detail: 'lines[0].to_project_id' } });
    });

    it('judges a line that gives and receives in one proposal by the difference: A to B and B to A of the same amount leave both as they were, so the floor of A does not refuse it', async () => {
      const w = await world();
      await rows('update machvon.allocation_balance set committed_vnd = $2::numeric where allocation_line_id = $1::uuid', [w.a.line, String(4.5 * BILLION)]);
      expect(await draft(proposalBody(w, [move(w.a, w.b, 2)]))).toMatchObject({ status: 422, json: { code: 'REVISED_BELOW_COMMITTED' } });
      expect(await draft(proposalBody(w, [move(w.a, w.b, 2), move(w.b, w.a, 2)]))).toMatchObject({ status: 200 });
    });

    it('draws the proposal from a frozen snapshot only (422 SNAPSHOT_NOT_FROZEN), in the year and the unit of the plan in force, from a plan that is published', async () => {
      const w = await world();
      const building = await snapshot(false, [w.a.project]);
      expect(await draft(proposalBody(w, [move(w.a, w.b, 1)], { basis_snapshot_id: building }))).toMatchObject({ status: 422, json: { code: 'SNAPSHOT_NOT_FROZEN', detail: 'basis_snapshot_id' } });
      expect(await draft(proposalBody(w, [move(w.a, w.b, 1)], { basis_snapshot_id: randomUUID() }))).toMatchObject({ status: 422, json: { detail: 'basis_snapshot_id' } });
      expect(await draft(proposalBody(w, [move(w.a, w.b, 1)], { plan_year: w.year + 1 }))).toMatchObject({ status: 422, json: { detail: 'plan_year' } });
      expect(await draft(proposalBody(w, [move(w.a, w.b, 1)], { scope_unit_id: unitId(BQL1) }))).toMatchObject({ status: 422, json: { detail: 'scope_unit_id' } });
      const draftPlan = await call('POST', '/capital-plans', { member: PLANNER, body: { plan_code: `RD-${randomUUID().slice(0, 8)}`, plan_kind: 'ANNUAL', plan_year: w.year, period_from_year: w.year, period_to_year: w.year, scope_unit_id: unitId(ROOT) } });
      expect(await draft(proposalBody(w, [move(w.a, w.b, 1)], { source_capital_plan_id: idOf(draftPlan) }))).toMatchObject({ status: 409, json: { code: 'PLAN_NOT_PUBLISHED' } });
      expect(await rows('select id from machvon.reallocation_proposal where source_capital_plan_id = $1::uuid', [w.planId])).toHaveLength(0);
    });

    it('keeps on a donor line what is reserved, committed and disbursed, with every line listed (422 REVISED_BELOW_COMMITTED), and the move of a line to itself, the same pair twice and an amount that is not whole dong are refused', async () => {
      const w = await world();
      await rows('update machvon.allocation_balance set committed_vnd = $2::numeric, disbursed_vnd = $3::numeric where allocation_line_id = $1::uuid', [w.a.line, money(3), money(1)]);
      const refused = await draft(proposalBody(w, [move(w.a, w.b, 2)]));
      expect(refused).toMatchObject({ status: 422, json: { code: 'REVISED_BELOW_COMMITTED' } });
      expect(JSON.stringify(refused.json)).toContain(money(4));
      expect(await draft(proposalBody(w, [move(w.a, w.b, 1)]))).toMatchObject({ status: 200 });
      expect(await draft(proposalBody(w, [move(w.a, w.b, 1), move(w.a, w.b, 1)]))).toMatchObject({ status: 422, json: { detail: 'lines[1].from_allocation_line_id' } });
      expect(await draft(proposalBody(w, [move(w.a, w.a, 1)]))).toMatchObject({ status: 422, json: { detail: 'lines[0].to_project_id' } });
      expect(await draft(proposalBody(w, [move(w.a, w.b, 1, { amount_vnd: '1.5' })]))).toMatchObject({ status: 422 });
      expect(await draft(proposalBody(w, [move(w.a, w.b, 1, { amount_vnd: '0' })]))).toMatchObject({ status: 422 });
      expect(await draft(proposalBody(w, [move({ line: randomUUID() }, w.b, 1)]))).toMatchObject({ status: 422, json: { detail: 'lines[0].from_allocation_line_id' } });
      expect(await draft(proposalBody(w, [move(w.a, w.b, 9)]))).toMatchObject({ status: 422, json: { code: 'REVISED_BELOW_COMMITTED' } });
    });
  });

  describe('the four-eyes and the states', () => {
    it('is decided by someone who is neither the author nor the submitter, and applied by someone who is neither either (403 SELF_APPROVAL_DENIED, the proposal staying where it was)', async () => {
      const w = await world();
      const made = await draft(proposalBody(w, [move(w.a, w.b, 1)]), ALL_REALLOCATION);
      const proposalId = idOf(made);
      const submitted = await submit(proposalId, 1, ALL_REALLOCATION);
      expect(await decide(proposalId, 2, 'approve', ALL_REALLOCATION)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect(await decide(proposalId, 9, 'approve', ALL_REALLOCATION)).toMatchObject({ status: 403 });
      expect(await rows<{ status: string }>('select status from machvon.reallocation_proposal where id = $1::uuid', [proposalId])).toEqual([{ status: 'SUBMITTED' }]);
      expect(versionOf(submitted)).toBe(2);
      expect(await decide(proposalId, 2, 'approve', DECIDER)).toMatchObject({ status: 200 });
      // The author, who holds the right to apply, is refused by the four-eyes of the plan: no revision is made.
      expect(await apply(proposalId, 3, ALL_REALLOCATION)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect(await rows<{ status: string }>('select status from machvon.reallocation_proposal where id = $1::uuid', [proposalId])).toEqual([{ status: 'APPROVED' }]);
      expect(await planStatus(w.planId)).toBe('PUBLISHED');
      expect(await rows(`select id from machvon.capital_plan where supersedes_id = $1::uuid`, [w.planId])).toHaveLength(0);
      expect((await apply(proposalId, 3, APPLIER)).status).toBe(200);
    });

    it('moves along its states only: a proposal is submitted from a draft, decided once, applied once and only when approved, and a version that moved is 409 VERSION_CONFLICT', async () => {
      const w = await world();
      const made = await draft(proposalBody(w, [move(w.a, w.b, 1)]));
      const proposalId = idOf(made);
      expect(await decide(proposalId, 1, 'approve')).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
      expect(await apply(proposalId, 1)).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
      expect(await submit(proposalId, 5)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect((await submit(proposalId, 1)).status).toBe(200);
      expect(await submit(proposalId, 2)).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
      expect(await decide(proposalId, 9, 'approve')).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect(await decide(proposalId, 2, 'maybe')).toMatchObject({ status: 422 });
      expect((await decide(proposalId, 2, 'approve')).status).toBe(200);
      expect(await decide(proposalId, 3, 'approve')).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
      expect(await apply(proposalId, 3, APPLIER, randomUUID())).toMatchObject({ status: 422, json: { code: 'DECISION_REQUIRED' } });
      expect((await apply(proposalId, 3)).status).toBe(200);
      expect(await apply(proposalId, 4)).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
    });

    it('rejects a proposal for good, and returns one to its author, who submits it again to a decision that can be another person', async () => {
      const w = await world();
      const rejected = idOf(await draft(proposalBody(w, [move(w.a, w.b, 1)])));
      await submit(rejected, 1);
      expect(await decide(rejected, 2, 'reject')).toMatchObject({ status: 200, json: { status: 'REJECTED' } });
      expect(await submit(rejected, 3)).toMatchObject({ status: 409 });
      const sent = idOf(await draft(proposalBody(w, [move(w.a, w.b, 1)])));
      await submit(sent, 1);
      expect(await decide(sent, 2, 'return')).toMatchObject({ status: 200, json: { status: 'DRAFT' } });
      const row = (await rows<{ submitted_by: string | null; decision_reason: string | null }>('select submitted_by, decision_reason from machvon.reallocation_proposal where id = $1::uuid', [sent]))[0];
      expect(row).toEqual({ submitted_by: null, decision_reason: 'Reviewed against the snapshot' });
      expect((await submit(sent, 3)).status).toBe(200);
      expect(await decide(sent, 4, 'approve', ALL_REALLOCATION)).toMatchObject({ status: 200, json: { status: 'APPROVED' } });
    });

    it('refuses what the permission or the unit does not allow: another branch is 403, a stranger without the right is 403, and a duplicate code is 409', async () => {
      const w = await world();
      const body = proposalBody(w, [move(w.a, w.b, 1)]);
      expect(await draft(body, READER)).toMatchObject({ status: 403 });
      expect(await draft(body, NOBODY)).toMatchObject({ status: 403 });
      expect((await draft(body)).status).toBe(200);
      expect(await draft(body)).toMatchObject({ status: 409, json: { code: 'DUPLICATE_KEY', detail: 'code' } });
      expect(await call('POST', '/reallocation-proposals', { member: B_PLANNER, tenantId: TENANT_B, body })).toMatchObject({ status: 404 });
    });
  });

  describe('the database keeps what was approved', () => {
    it('does not let a line of an approved proposal change, leave for a draft, or be removed, and does not let a proposal that is applied change at all', async () => {
      const w = await world();
      const approvedOne = await approved(w, [move(w.a, w.b, 1)]);
      const draftOne = idOf(await draft(proposalBody(w, [move(w.a, w.b, 1)])));
      const lineOf = async (proposalId: string): Promise<string> => (await rows<{ id: string }>('select id from machvon.reallocation_line where proposal_id = $1::uuid', [proposalId]))[0]?.id as string;
      const line = await lineOf(approvedOne.id);
      await expect(rows('update machvon.reallocation_line set amount_vnd = amount_vnd + 1 where id = $1::uuid', [line])).rejects.toMatchObject({ code: '23514' });
      await expect(rows('update machvon.reallocation_line set proposal_id = $2::uuid, amount_vnd = amount_vnd + 1 where id = $1::uuid', [line, draftOne])).rejects.toMatchObject({ code: '23514' });
      await expect(rows('delete from machvon.reallocation_line where id = $1::uuid', [line])).rejects.toMatchObject({ code: '23514' });
      await expect(rows('update machvon.reallocation_line set proposal_id = $2::uuid where id = $1::uuid', [await lineOf(draftOne), approvedOne.id])).rejects.toMatchObject({ code: '23514' });
      expect((await apply(approvedOne.id, approvedOne.version)).status).toBe(200);
      await expect(rows("update machvon.reallocation_proposal set status = 'APPROVED' where id = $1::uuid", [approvedOne.id])).rejects.toMatchObject({ code: '23514' });
      await expect(rows("update machvon.reallocation_proposal set reason = 'A reason that was changed after the proposal was applied' where id = $1::uuid", [approvedOne.id])).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('AC-ST-CAP-010-3 / UAT-PLAN-64: the plan changed since the proposal', () => {
    it('AC-ST-CAP-010-3: the source plan received a new revision after the proposal was drafted: apply is 409 PLAN_CHANGED_SINCE_PROPOSAL and nothing is applied', async () => {
      const w = await world();
      const proposal = await approved(w, [move(w.a, w.b, 1)]);
      // A planner revises the plan and the revision is published before the proposal is applied.
      const revised = await call('POST', `/capital-plans/${w.planId}/revisions`, { member: PLANNER, ifMatch: w.planVersion, body: { reason: 'The ceiling of the project moved after the review of the decision' } });
      expect(revised.status).toBe(200);
      const revisionVersion = await carry(idOf(revised), versionOf(revised), '2031-01-01T00:00:00Z');
      expect(revisionVersion).toBeGreaterThan(0);
      expect(await planStatus(w.planId)).toBe('SUPERSEDED');
      const before = await rows<{ n: string }>(`select count(*)::text as n from machvon.capital_ledger_entry where entry_type in ('TRANSFER_IN', 'TRANSFER_OUT') and project_id = any($1::uuid[])`, [[w.a.project, w.b.project]]);
      expect(await apply(proposal.id, proposal.version)).toMatchObject({ status: 409, json: { code: 'PLAN_CHANGED_SINCE_PROPOSAL' } });
      expect(await rows<{ status: string }>('select status from machvon.reallocation_proposal where id = $1::uuid', [proposal.id])).toEqual([{ status: 'APPROVED' }]);
      expect(await rows<{ n: string }>(`select count(*)::text as n from machvon.capital_ledger_entry where entry_type in ('TRANSFER_IN', 'TRANSFER_OUT') and project_id = any($1::uuid[])`, [[w.a.project, w.b.project]])).toEqual(before);
      expect(await rows(`select id from machvon.capital_plan where supersedes_id = $1::uuid`, [idOf(revised)])).toHaveLength(0);
    });

    it('does not apply over a revision that is in work (409 REVISION_PENDING_EXISTS), and judges the floors again on the day of the application (422 REVISED_BELOW_COMMITTED)', async () => {
      const w = await world();
      const proposal = await approved(w, [move(w.a, w.b, 2)]);
      const pending = await call('POST', `/capital-plans/${w.planId}/revisions`, { member: PLANNER, ifMatch: w.planVersion, body: { reason: 'The ceiling of the project moved after the review of the decision' } });
      expect(pending.status).toBe(200);
      expect(await apply(proposal.id, proposal.version)).toMatchObject({ status: 409, json: { code: 'REVISION_PENDING_EXISTS' } });
      expect((await rows<{ status: string }>('select status from machvon.capital_plan where id = $1::uuid', [idOf(pending)]))[0]?.status).toBe('DRAFT');
      const other = await world();
      const second = await approved(other, [move(other.a, other.b, 2)]);
      await rows('update machvon.allocation_balance set committed_vnd = $2::numeric where allocation_line_id = $1::uuid', [other.a.line, money(4)]);
      expect(await apply(second.id, second.version)).toMatchObject({ status: 422, json: { code: 'REVISED_BELOW_COMMITTED' } });
      expect(await planStatus(other.planId)).toBe('PUBLISHED');
    });
  });

  describe('the list (CAP-19)', () => {
    it('lists the proposals of the units the reader may read, with their lines and what each side holds, newest first, by status and year, a page at a time; judges the query; shows nothing of another tenant', async () => {
      const w = await world();
      const one = idOf(await draft(proposalBody(w, [move(w.a, w.b, 2)])));
      const two = idOf(await draft(proposalBody(w, [move(w.a, w.b, 1)])));
      await submit(two, 1);
      const reply = await call('GET', `/reallocation-proposals?plan_year=${w.year}`, { member: READER });
      const items = reply.json.items as Array<Record<string, unknown>>;
      expect(items.map((item) => item.id)).toEqual([two, one]);
      expect(items[1]).toMatchObject({
        status: 'DRAFT',
        plan_year: w.year,
        version: 1,
        total_vnd: money(2),
        scope_unit: { id: unitId(ROOT) },
        lines: [{ from_project: { id: w.a.project }, to_project: { id: w.b.project }, amount_vnd: money(2), from_allocated_vnd: money(5), to_allocated_vnd: money(1), from_allocation_line_id: w.a.line }],
      });
      expect(Object.keys(items[1]!).sort()).toEqual(['applied_at', 'approved_by', 'basis_snapshot_id', 'code', 'created_at', 'created_by', 'decision_document_id', 'decision_reason', 'id', 'lines', 'plan_year', 'reason', 'resulting_capital_plan_id', 'scope_unit', 'source_capital_plan_id', 'status', 'submitted_by', 'total_vnd', 'version']);
      expect(((await call('GET', `/reallocation-proposals?plan_year=${w.year}&status=SUBMITTED`, { member: READER })).json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([two]);
      const paged = await call('GET', `/reallocation-proposals?plan_year=${w.year}&limit=1`, { member: READER });
      expect((paged.json.items as unknown[]).length).toBe(1);
      const next = await call('GET', `/reallocation-proposals?plan_year=${w.year}&limit=1&cursor=${paged.json.next_cursor as string}`, { member: READER });
      expect((next.json.items as Array<{ id: string }>)[0]?.id).toBe(one);
      expect((await call('GET', `/reallocation-proposals?plan_year=${w.year}`, { member: BRANCH_READER })).json.items).toEqual([]);
      expect(await call('GET', '/reallocation-proposals?status=NOPE', { member: READER })).toMatchObject({ status: 422, json: { detail: 'status' } });
      expect(await call('GET', '/reallocation-proposals?plan_year=abc', { member: READER })).toMatchObject({ status: 422, json: { detail: 'plan_year' } });
      const badCursor = Buffer.from(JSON.stringify(['not a time', randomUUID()])).toString('base64url');
      expect(await call('GET', `/reallocation-proposals?cursor=${badCursor}`, { member: READER })).toMatchObject({ status: 422, json: { detail: 'cursor' } });
      expect((await call('GET', '/reallocation-proposals', { member: NOBODY })).status).toBe(403);
      expect((await call('GET', '/reallocation-proposals', { member: B_PLANNER, tenantId: TENANT_B })).json.items).toEqual([]);
    });
  });
});
