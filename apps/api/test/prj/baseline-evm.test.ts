import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { DisSnapshotStore, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { payModule } from '../../src/modules/pay';
import { DisbursementCheckController } from '../../src/modules/pay/disbursement-check.controller';
import { prjModule } from '../../src/modules/prj';
import { ProjectBaselineController, ProjectBaselineReadsController } from '../../src/modules/prj/baseline.controller';
import { ProjectEvmController, ProjectEvmReadsController } from '../../src/modules/prj/evm.controller';
import { ProjectRevisionController, ProjectRevisionReadsController } from '../../src/modules/prj/revision.controller';
import { ProjectWbsController, ProjectWbsReadsController } from '../../src/modules/prj/wbs.controller';
import { CapWorld, money } from '../../../../packages/db/test/support/cap-fixtures';
import { TENANT_A, id, memberId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAs, seedContractor } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const FAMILY = 0xb1;
const ROOT = 1;
const TODAY = vietnamDateOf(new Date());
const PM = 11; // updates the project, takes the baseline, links contracts, proposes revisions, and may decide and acknowledge (to prove it may not decide or acknowledge its own effects)
const APPROVER = 12; // approves a revision
const DECIDER = 13; // decides a request to appraise again
const AUDITOR = 14; // reads and acknowledges the alerts to the auditors
const READER = 15; // reads the figures only
const NOBODY = 16;
const MEMBERS = [PM, APPROVER, DECIDER, AUDITOR, READER, NOBODY];
const REASON = 'The site was handed over late by the district.';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the baseline, the earned value and the precondition of a disbursement over HTTP (governance deepening, lane B1: G1-2, G1-3, G1-4, G1-5)', () => {
  const world = new CapWorld();
  const harness = world.harness;
  let app: RunningApp;
  let counter = 0;
  let contractor = '';
  let version = '';

  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; body?: unknown; ifMatch?: string | number; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = typeof options.ifMatch === 'number' ? `"${options.ifMatch}"` : options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => world.owner<R>(sql, params);
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, unknown>; actor_id: string; reason: string | null }>('select safe_diff, actor_id, reason from machvon.audit_event where resource_id = $1 and action = $2 and outcome = $3 order by occurred_at', [resourceId, action, 'SUCCESS']);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2', [aggregateId, type]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;
  const versionOf = (reply: Reply): number => reply.json.resource_version as number;

  interface Ready {
    projectId: string;
    lineId: string;
    c1: string;
    c2: string;
    m1: string;
    m2: string;
  }

  /** A project in IMPLEMENTATION with an approved amount in the capital plan, two first-level packages (6 and 4 billion) and a milestone for each (finishing on 2026-03-31 and 2026-06-30). */
  async function ready(options: { milestones?: boolean; endYear?: number | null } = {}): Promise<Ready> {
    const line = await world.publishedLine({ allocated: money(60), appropriationAmount: money(80) });
    await world.owner('update machvon.project set status = $2, start_year = 2026, end_year = $3 where id = $1::uuid', [line.projectId, 'IMPLEMENTATION', options.endYear === undefined ? 2028 : options.endYear]);
    counter += 1;
    const c1 = await call('POST', `/projects/${line.projectId}/components`, { member: PM, body: { code: `P1-${counter}`, name: 'Gói xây lắp chính', planned_value_vnd: '6000000000', valid_from: '2026-01-01' } });
    const c2 = await call('POST', `/projects/${line.projectId}/components`, { member: PM, body: { code: `P2-${counter}`, name: 'Gói thiết bị', planned_value_vnd: '4000000000', valid_from: '2026-01-01' } });
    expect([c1.status, c2.status]).toEqual([200, 200]);
    let m1 = '';
    let m2 = '';
    if (options.milestones !== false) {
      const a = await call('POST', `/projects/${line.projectId}/milestones`, { member: PM, body: { code: `M1-${counter}`, name: 'Hoàn thành phần thô', component_id: idOf(c1), baseline_date: '2026-03-31', planned_date: '2026-03-31' } });
      const b = await call('POST', `/projects/${line.projectId}/milestones`, { member: PM, body: { code: `M2-${counter}`, name: 'Lắp đặt thiết bị', component_id: idOf(c2), baseline_date: '2026-06-30', planned_date: '2026-06-30' } });
      expect([a.status, b.status]).toEqual([200, 200]);
      m1 = idOf(a);
      m2 = idOf(b);
    }
    return { projectId: line.projectId, lineId: line.lineId, c1: idOf(c1), c2: idOf(c2), m1, m2 };
  }

  const capture = (of: { projectId: string }, member = PM, key?: string) => call('POST', `/projects/${of.projectId}/baseline`, { member, body: {}, ...(key === undefined ? {} : { key }) });
  const baseline = (of: { projectId: string }, member = READER) => call('GET', `/projects/${of.projectId}/baseline`, { member });
  const delay = (milestoneId: string, plannedDate: string, milestoneVersion: number, member = PM) =>
    call('POST', `/project-milestones/${milestoneId}/progress`, { member, ifMatch: milestoneVersion, body: { status: 'DELAYED', planned_date: plannedDate, reason: REASON } });

  async function document(): Promise<string> {
    const documentId = randomUUID();
    await rows(
      `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
       values ($1, $2, 'REFERENCE', 'QD', 'Decision on the adjustment', $3, '2026-01-15', 'EFFECTIVE', 'INTERNAL', $4, $4)`,
      [TENANT_A, documentId, `QD-${documentId.slice(0, 8)}/2026`, memberId(PM)],
    );
    return documentId;
  }

  async function projectVersion(projectId: string): Promise<number> {
    return Number((await rows<{ version: string }>('select version::text as version from machvon.project where id = $1::uuid', [projectId]))[0]?.version);
  }

  async function revise(of: { projectId: string }, body: Record<string, unknown>): Promise<Reply> {
    const proposed = await call('POST', `/projects/${of.projectId}/revisions`, { member: PM, ifMatch: await projectVersion(of.projectId), body: { reason: 'The cost of the site clearance went up', ...body } });
    expect(proposed.status).toBe(200);
    return call('POST', `/project-revisions/${idOf(proposed)}/decision`, {
      member: APPROVER,
      ifMatch: 1,
      body: { decision: 'approve', reason: 'Approved by the people committee', effective_from: TODAY, decision_document_id: await document() },
    });
  }

  async function contract(projectId: string, lineId: string, value: string): Promise<string> {
    counter += 1;
    const contractId = randomUUID();
    const packageId = randomUUID();
    const code = `HD-B1-${String(counter).padStart(4, '0')}`;
    await seedAs(harness, [
      [
        `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, allocation_line_id) values ($1, $2, $3, $4, 100000000000, 'OPEN', 1, 'AWARDED', $5)`,
        [TENANT_A, packageId, projectId, `PKG-${code}`, lineId],
      ],
      [
        `insert into machvon.contract
           (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd, created_by, updated_by, signed_on, effective_from)
         values ($1, $2, $3, $4, $5, $6, 'LUMP_SUM', 'VND', 'ACTIVE', 1, 'Contract', 'CONSTRUCTION', false, true, $7, $8, $8, date '2026-01-01', date '2026-01-02')`,
        [TENANT_A, contractId, projectId, packageId, contractor, code, value, memberId(PM)],
      ],
    ]);
    return contractId;
  }

  async function accept(contractId: string, amount: string, approvedAt: string): Promise<void> {
    counter += 1;
    await seedAs(harness, [
      [
        `insert into machvon.acceptance (tenant_id, id, contract_id, measurement_ids, document_version_id, signer_refs, status, version, acceptance_no, accepted_amount_vnd, approved_at, decided_by, decision_reason, submitted_by, submitted_at, created_by, updated_by)
         values ($1, $2, $3, jsonb_build_array($4::text), $5, '[]'::jsonb, 'APPROVED', 3, $6, $7::numeric, $8::timestamptz, $9, 'Checked.', $10, $8::timestamptz, $10, $10)`,
        [TENANT_A, randomUUID(), contractId, randomUUID(), version, `NT-B1-${counter}`, amount, approvedAt, memberId(APPROVER), memberId(PM)],
      ],
    ]);
  }

  async function pay(projectId: string, contractId: string, gross: string, verifiedAt: string, status = 'VERIFIED'): Promise<void> {
    counter += 1;
    await seedAs(harness, [
      [
        `insert into machvon.payment_request (tenant_id, id, project_id, contract_id, acceptance_id, currency, gross_vnd, advance_recovery_vnd, retention_vnd, tax_adjustment_vnd, net_vnd, status, version, request_kind, request_no, claims_acceptance, submitted_by, submitted_at, verified_by, verified_at, created_by, updated_by)
         values ($1, $2, $3, $4, $11, 'VND', $5::numeric, 0, 0, 0, $5::numeric, $6, 1, 'INTERIM', $7, $6 in ('SUBMITTED', 'VERIFIED', 'SENT_TREASURY', 'SETTLED'), $8, $9::timestamptz, $10, $9::timestamptz, $8, $8)`,
        [TENANT_A, randomUUID(), projectId, contractId, gross, status, `DNTT-B1-${counter}`, memberId(PM), verifiedAt, memberId(APPROVER), randomUUID()],
      ],
    ]);
  }

  beforeAll(async () => {
    await world.start();
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    const roles: Array<[number, string, readonly string[], number]> = [
      [1, 'B1_PM', ['project.read', 'project.update', 'project.baseline.capture', 'project.baseline.read', 'project.baseline.decide', 'project.evm.link', 'project.evm.read', 'project.revision.propose', 'project.governance.alert.read', 'project.governance.alert.acknowledge', 'payment_request.read'], 30],
      [2, 'B1_APPROVER', ['project.read', 'project.revision.approve', 'project.baseline.read'], 50],
      [3, 'B1_DECIDER', ['project.read', 'project.baseline.decide', 'project.baseline.read'], 50],
      [4, 'B1_AUDITOR', ['project.read', 'project.baseline.read', 'project.governance.alert.read', 'project.governance.alert.acknowledge'], 40],
      [5, 'B1_READER', ['project.read', 'project.baseline.read', 'project.evm.read', 'payment_request.read'], 10],
    ];
    for (const [n, code, permissions, rank] of roles) await harness.seedRole(TENANT_A, 80 + n, code, permissions, rank);
    const grant = (n: number, member: number, role: number) => ({ n: 80 + n, member, role: 80 + role, kind: 'TENANT' as const });
    await harness.seedGrants(TENANT_A, [grant(1, PM, 1), grant(2, APPROVER, 2), grant(3, DECIDER, 3), grant(4, AUDITOR, 4), grant(5, READER, 5)]);
    contractor = await seedContractor(harness);
    version = id(FAMILY, 10);
    await seedAs(harness, [
      [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Decision', 'INTERNAL', $3, $3)`, [TENANT_A, id(FAMILY, 11), memberId(READER)]],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/prj/decision.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, version, id(FAMILY, 11)],
      ],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [ProjectWbsController, ProjectWbsReadsController, ProjectRevisionController, ProjectRevisionReadsController, ProjectBaselineController, ProjectBaselineReadsController, ProjectEvmController, ProjectEvmReadsController, DisbursementCheckController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 480_000);

  afterAll(async () => {
    if (app) await app.close();
    await world.stop();
  }, 60_000);

  it('is registered in the modules of PRJ and PAY', () => {
    expect(prjModule.controllers).toEqual(expect.arrayContaining([ProjectBaselineController, ProjectBaselineReadsController, ProjectEvmController, ProjectEvmReadsController]));
    expect(payModule.controllers).toEqual(expect.arrayContaining([DisbursementCheckController]));
  });

  describe('version 0 of the baseline (G1-3)', () => {
    it('refuses to take a baseline from nothing (BASELINE_NO_WBS) and from a plan with a package that has no finish day (BASELINE_INCOMPLETE, naming the package)', async () => {
      const line = await world.publishedLine();
      await world.owner('update machvon.project set status = $2 where id = $1::uuid', [line.projectId, 'IMPLEMENTATION']);
      const none = await capture({ projectId: line.projectId });
      expect([none.status, none.json.code]).toEqual([422, 'BASELINE_NO_WBS']);
      const open = await ready({ milestones: false, endYear: null });
      const incomplete = await capture(open);
      expect([incomplete.status, incomplete.json.code]).toEqual([422, 'BASELINE_INCOMPLETE']);
      expect(JSON.stringify(incomplete.json)).toContain('NO_FINISH_DATE');
      expect(await rows('select 1 from machvon.project_baseline where project_id = $1::uuid', [open.projectId])).toHaveLength(0);
    });

    it('takes version 0 once, from the components and the baseline days of the milestones, audits it, replays the same key and refuses a second one and whoever lacks the right', async () => {
      const of = await ready();
      const key = `baseline-${randomUUID()}`;
      const taken = await capture(of, PM, key);
      expect(taken).toMatchObject({ status: 200, json: { status: 'TAKEN', baseline_version: 0, bac_vnd: '10000000000', line_count: 2 } });
      expect(await capture(of, PM, key)).toMatchObject({ status: 200, json: { resource_id: idOf(taken) } });
      const second = await capture(of);
      expect([second.status, second.json.code]).toEqual([409, 'BASELINE_ALREADY_TAKEN']);
      expect((await capture(of, READER)).status).toBe(403);
      expect((await audits(idOf(taken), 'project.baseline_captured'))[0]).toMatchObject({ actor_id: memberId(PM), safe_diff: { project_id: of.projectId, version: 0, bac_vnd: '10000000000', planned_start: '2026-01-01', planned_finish: '2026-06-30', lines: 2 } });
      expect((await events(idOf(taken), 'project.baseline_captured.v1'))[0]?.payload).toMatchObject({ project_id: of.projectId, baseline_version: 0, bac_vnd: '10000000000' });
      const read = await baseline(of);
      expect(read.status).toBe(200);
      expect(read.json).toMatchObject({
        has_baseline: true,
        deviation: { cost_vnd: '0', cost_pct: '0.0000', finish_slip_days: 0 },
        reasons: [],
        reschedule: { count: 0 },
        policy: { source: 'BUILT_IN', version: 'built-in:1', cost_pct: 10, slip_days: 90, reschedule_alert_count: 3 },
        actions: { capture: false },
      });
      const versions = read.json.versions as Array<{ version: number; kind: string; lines: Array<{ code: string; bac_vnd: string; planned_finish: string }> }>;
      expect(versions).toHaveLength(1);
      expect(versions[0]?.lines.map((entry) => [entry.bac_vnd, entry.planned_finish])).toEqual([['6000000000', '2026-03-31'], ['4000000000', '2026-06-30']]);
      expect((await baseline(of, NOBODY)).status).toBe(403);
    });

    it('keeps version 0 for good: not even the owner of the database changes or removes it', async () => {
      const of = await ready();
      const taken = await capture(of);
      await expect(world.owner('update machvon.project_baseline set bac_vnd = 1 where id = $1::uuid', [idOf(taken)])).rejects.toThrow(/append-only/);
      await expect(world.owner('delete from machvon.project_baseline_line where baseline_id = $1::uuid', [idOf(taken)])).rejects.toThrow(/append-only/);
      expect((await rows<{ bac_vnd: string }>('select bac_vnd::text as bac_vnd from machvon.project_baseline where id = $1::uuid', [idOf(taken)]))[0]?.bac_vnd).toBe('10000000000');
    });
  });

  describe('the moves of a date, the alert to the auditors and the request to appraise again (G1-3)', () => {
    it('counts every later day of a milestone, raises one alert to AUD at the third move with the version of the rule, and lets an auditor other than the maker acknowledge it once', async () => {
      const of = await ready();
      await capture(of);
      const first = await delay(of.m1, '2026-04-30', 1);
      expect(first.status).toBe(200);
      const second = await delay(of.m1, '2026-05-30', versionOf(first));
      expect(second.status).toBe(200);
      expect(await rows('select 1 from machvon.project_governance_alert where project_id = $1::uuid', [of.projectId])).toHaveLength(0);
      const third = await delay(of.m1, '2026-06-29', versionOf(second));
      expect(third.status).toBe(200);
      const alerts = await rows<{ id: string; move_count: number; threshold: number; rule_version: string; audience: string; status: string; raised_by: string; subject_kind: string; subject_id: string; version: string }>(
        'select id, move_count, threshold, rule_version, audience, status, raised_by, subject_kind, subject_id, version::text as version from machvon.project_governance_alert where project_id = $1::uuid',
        [of.projectId],
      );
      expect(alerts).toEqual([{ id: expect.any(String), move_count: 3, threshold: 3, rule_version: 'built-in:1', audience: 'AUD', status: 'OPEN', raised_by: memberId(PM), subject_kind: 'MILESTONE', subject_id: of.m1, version: '1' }]);
      const alert = alerts[0]!;
      expect((await audits(alert.id, 'project.governance_alert_raised'))[0]).toMatchObject({ actor_id: memberId(PM), safe_diff: { project_id: of.projectId, audience: 'AUD', move_count: 3, threshold: 3, rule_version: 'built-in:1', subject_id: of.m1 } });
      expect((await events(alert.id, 'project.governance_alert_raised.v1'))[0]?.payload).toMatchObject({ project_id: of.projectId, audience: 'AUD', move_count: 3 });
      expect(await rows('select 1 from machvon.project_reschedule_event where project_id = $1::uuid', [of.projectId])).toHaveLength(3);
      const read = await baseline(of);
      expect(read.json).toMatchObject({ reschedule: { count: 3, project_moves: 0, per_milestone: [{ milestone_id: of.m1, moves: 3 }] } });
      // A fourth move only brings the count of the open alert up to date: there is still one alert.
      expect((await delay(of.m1, '2026-06-30', versionOf(third))).status).toBe(200);
      expect(await rows<{ move_count: number }>("select move_count from machvon.project_governance_alert where project_id = $1::uuid and status = 'OPEN'", [of.projectId])).toEqual([{ move_count: 4 }]);

      const own = await call('POST', `/project-governance-alerts/${alert.id}/acknowledgement`, { member: PM, ifMatch: 2, body: { note: 'I looked at my own delay.' } });
      expect([own.status, own.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect((await call('POST', `/project-governance-alerts/${alert.id}/acknowledgement`, { member: READER, ifMatch: 2, body: { note: 'No right.' } })).status).toBe(403);
      const stale = await call('POST', `/project-governance-alerts/${alert.id}/acknowledgement`, { member: AUDITOR, ifMatch: 1, body: { note: 'Stale.' } });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const acknowledged = await call('POST', `/project-governance-alerts/${alert.id}/acknowledgement`, { member: AUDITOR, ifMatch: 2, body: { note: 'Asked the project board for the cause.' } });
      expect(acknowledged).toMatchObject({ status: 200, json: { status: 'ACKNOWLEDGED', project_id: of.projectId } });
      expect((await audits(alert.id, 'project.governance_alert_acknowledged'))[0]).toMatchObject({ actor_id: memberId(AUDITOR), reason: 'Asked the project board for the cause.' });
      const again = await call('POST', `/project-governance-alerts/${alert.id}/acknowledgement`, { member: AUDITOR, ifMatch: versionOf(acknowledged), body: { note: 'Twice.' } });
      expect([again.status, again.json.code]).toEqual([409, 'GOVERNANCE_ALERT_STATE_INVALID']);
      const listed = await call('GET', `/project-governance-alerts?status=ACKNOWLEDGED&project_id=${of.projectId}`, { member: AUDITOR });
      expect(listed.status).toBe(200);
      expect((listed.json.items as Array<{ id: string; status: string }>).map((item) => [item.id, item.status])).toEqual([[alert.id, 'ACKNOWLEDGED']]);
      expect((await call('GET', '/project-governance-alerts', { member: READER })).status).toBe(403);
      expect((await call('GET', '/project-governance-alerts?status=DONE', { member: AUDITOR })).json.code).toBe('VALIDATION_FAILED');
    });

    it('asks to appraise again when the finish slips past the threshold, once, decided by someone other than the maker, and asks again only when the deviation grew', async () => {
      const of = await ready();
      await capture(of);
      const slipped = await delay(of.m2, '2026-10-30', 1);
      expect(slipped.status).toBe(200);
      const open = await rows<{ id: string; status: string; reasons: string[]; finish_slip_days: number; threshold_slip_days: number; rule_version: string; requested_by: string; version: string }>(
        "select id, status, reasons, finish_slip_days, threshold_slip_days, rule_version, requested_by, version::text as version from machvon.project_reappraisal_request where project_id = $1::uuid",
        [of.projectId],
      );
      expect(open).toEqual([{ id: expect.any(String), status: 'OPEN', reasons: ['SLIP'], finish_slip_days: 122, threshold_slip_days: 90, rule_version: 'built-in:1', requested_by: memberId(PM), version: '1' }]);
      const request = open[0]!;
      expect((await audits(request.id, 'project.reappraisal_requested'))[0]).toMatchObject({ safe_diff: { project_id: of.projectId, reasons: ['SLIP'], finish_slip_days: 122 } });
      expect((await events(request.id, 'project.reappraisal_requested.v1'))[0]?.payload).toMatchObject({ project_id: of.projectId, reasons: ['SLIP'] });
      expect((await baseline(of)).json).toMatchObject({ reasons: ['SLIP'], deviation: { finish_slip_days: 122, forecast_finish: '2026-10-30' }, actions: { decide_reappraisal: false } });
      expect((await baseline(of, PM)).json).toMatchObject({ actions: { decide_reappraisal: true } });

      const own = await call('POST', `/project-reappraisals/${request.id}/decision`, { member: PM, ifMatch: 1, body: { decision: 'WAIVE', reason: 'It is fine.' } });
      expect([own.status, own.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect((await call('POST', `/project-reappraisals/${request.id}/decision`, { member: READER, ifMatch: 1, body: { decision: 'WAIVE', reason: 'No right.' } })).status).toBe(403);
      expect((await call('POST', `/project-reappraisals/${request.id}/decision`, { member: DECIDER, ifMatch: 1, body: { decision: 'MAYBE', reason: 'x' } })).json.code).toBe('VALIDATION_FAILED');
      const waived = await call('POST', `/project-reappraisals/${request.id}/decision`, { member: DECIDER, ifMatch: 1, body: { decision: 'WAIVE', reason: 'The handover delay is the district, not the project.' } });
      expect(waived).toMatchObject({ status: 200, json: { status: 'WAIVED', project_id: of.projectId } });
      expect((await audits(request.id, 'project.reappraisal_waived'))[0]).toMatchObject({ actor_id: memberId(DECIDER), reason: 'The handover delay is the district, not the project.' });
      const again = await call('POST', `/project-reappraisals/${request.id}/decision`, { member: DECIDER, ifMatch: versionOf(waived), body: { decision: 'START', reason: 'Changed my mind.' } });
      expect([again.status, again.json.code]).toEqual([409, 'REAPPRAISAL_STATE_INVALID']);
      await expect(world.owner("update machvon.project_reappraisal_request set decision_reason = 'Edited later.' where id = $1::uuid", [request.id])).rejects.toThrow(/never changed/);

      // A move that leaves the deviation where it was does not ask again; one that makes it worse does.
      expect((await delay(of.m1, '2026-04-15', 1)).status).toBe(200);
      expect(await rows('select 1 from machvon.project_reappraisal_request where project_id = $1::uuid', [of.projectId])).toHaveLength(1);
      expect((await delay(of.m2, '2026-11-10', versionOf(slipped))).status).toBe(200);
      expect(await rows<{ status: string }>('select status from machvon.project_reappraisal_request where project_id = $1::uuid order by requested_at', [of.projectId])).toEqual([{ status: 'WAIVED' }, { status: 'OPEN' }]);
    });

    it('adds the next version of the baseline when a revision of the total is approved, measures the cost from version 0 and asks to appraise again over ten percent', async () => {
      const of = await ready();
      const taken = await capture(of);
      const approved = await revise(of, { change_kind: 'ADJUST_INVESTMENT', after: {}, total_investment_vnd: '575000000000' });
      expect(approved.status).toBe(200);
      const read = await baseline(of, PM);
      expect(read.json).toMatchObject({
        deviation: { cost_vnd: '75000000000', cost_pct: '15.0000' },
        reasons: ['COST'],
        current: { total_investment_vnd: '575000000000', bac_vnd: '10000000000' },
        actions: { decide_reappraisal: true },
      });
      const versions = read.json.versions as Array<{ id: string; version: number; kind: string; basis: string; total_investment_vnd: string; source_revision_id: string | null }>;
      expect(versions.map((entry) => [entry.version, entry.kind, entry.basis, entry.total_investment_vnd])).toEqual([[0, 'V0', 'BASELINE', '500000000000'], [1, 'REVISION', 'PLANNED', '575000000000']]);
      expect(versions[0]?.id).toBe(idOf(taken));
      expect(versions[1]?.source_revision_id).toBe(idOf(approved));
      expect((await audits(versions[1]!.id, 'project.baseline_version_added'))[0]).toMatchObject({ safe_diff: { project_id: of.projectId, version: 1 } });
      expect((await events(versions[1]!.id, 'project.baseline_version_added.v1'))[0]?.payload).toMatchObject({ baseline_version: 1 });
      const request = (read.json.reappraisals as Array<{ id: string; status: string; reasons: string[]; cost_pct: string; requested_by: string }>)[0]!;
      expect(request).toMatchObject({ status: 'OPEN', reasons: ['COST'], cost_pct: '15.0000', requested_by: memberId(APPROVER) });
      const started = await call('POST', `/project-reappraisals/${request.id}/decision`, { member: DECIDER, ifMatch: 1, body: { decision: 'START', reason: 'The investor takes the project back to appraisal.' } });
      expect(started).toMatchObject({ status: 200, json: { status: 'STARTED' } });
      // Version 0 never moved.
      expect((await rows<{ total_investment_vnd: string }>('select total_investment_vnd::text as total_investment_vnd from machvon.project_baseline where id = $1::uuid', [idOf(taken)]))[0]?.total_investment_vnd).toBe('500000000000');
    });

    it('counts an end year pushed back by an approved revision of the schedule as a move of the date of the project, and adds a version', async () => {
      const of = await ready();
      await capture(of);
      const approved = await revise(of, { change_kind: 'ADJUST_SCHEDULE', after: { end_year: 2029 }, total_investment_vnd: undefined });
      expect(approved.status).toBe(200);
      const read = await baseline(of);
      expect(read.json).toMatchObject({ reschedule: { project_moves: 1, count: 1, events: [{ source: 'REVISION', from_date: '2028-12-31', to_date: '2029-12-31', revision_id: idOf(approved) }] } });
      expect((read.json.versions as unknown[]).length).toBe(2);
      expect(await rows('select 1 from machvon.project_governance_alert where project_id = $1::uuid', [of.projectId])).toHaveLength(0);
    });
  });

  describe('the earned value of a project, a package and a contract (G1-4)', () => {
    it('measures planned value from the baseline, earned value from accepted quantities and cost from certified payments, and says what it cannot know instead of writing zero', async () => {
      const of = await ready();
      const k1 = await contract(of.projectId, of.lineId, '6000000000');
      const k2 = await contract(of.projectId, of.lineId, '4000000000');
      const asOf = '2026-02-14';
      // Nothing was taken yet: the answer is "not enough data" with the reason, never zero.
      const noBaseline = await call('GET', `/projects/${of.projectId}/evm?as_of=${asOf}`, { member: READER });
      expect(noBaseline).toMatchObject({ status: 200, json: { figures: { status: 'INSUFFICIENT', missing: ['NO_BASELINE'], cpi: null, ev_vnd: null }, rows: [] } });
      await capture(of);
      // A package with money planned and no contract carrying it has no earned value.
      const unlinked = await call('GET', `/projects/${of.projectId}/evm?as_of=${asOf}`, { member: READER });
      expect(unlinked.json).toMatchObject({ source: 'LIVE', baseline: { version: 0 }, figures: { status: 'INSUFFICIENT', missing: ['NO_CONTRACT_LINK'], ev_vnd: null, ac_vnd: null, cpi: null, eac_vnd: null } });

      // Linking: a contract of another project, a package of another project, no right, a repeated link.
      const foreign = await ready();
      const otherContract = await contract(foreign.projectId, foreign.lineId, '1000000000');
      expect((await call('POST', `/projects/${of.projectId}/component-contracts`, { member: PM, body: { contract_id: otherContract, component_id: of.c1 } })).json.code).toBe('VALIDATION_FAILED');
      expect((await call('POST', `/projects/${of.projectId}/component-contracts`, { member: PM, body: { contract_id: k1, component_id: foreign.c1 } })).json.code).toBe('VALIDATION_FAILED');
      expect((await call('POST', `/projects/${of.projectId}/component-contracts`, { member: READER, body: { contract_id: k1, component_id: of.c1 } })).status).toBe(403);
      const linked = await call('POST', `/projects/${of.projectId}/component-contracts`, { member: PM, body: { contract_id: k1, component_id: of.c1 } });
      expect(linked).toMatchObject({ status: 200, json: { status: 'LINKED', project_id: of.projectId } });
      expect((await audits(idOf(linked), 'project.component_contract_linked'))[0]).toMatchObject({ actor_id: memberId(PM), safe_diff: { contract_id: k1, component_id: of.c1 } });
      const repeated = await call('POST', `/projects/${of.projectId}/component-contracts`, { member: PM, body: { contract_id: k1, component_id: of.c1 } });
      expect([repeated.status, repeated.json.code]).toEqual([409, 'COMPONENT_CONTRACT_UNCHANGED']);
      expect((await call('POST', `/projects/${of.projectId}/component-contracts`, { member: PM, body: { contract_id: k2, component_id: of.c2 } })).status).toBe(200);

      // C1: 1.5 of 6 billion accepted by the day (a later acceptance does not count); 1.2 billion paid (a later payment does not count).
      await accept(k1, '1500000000', '2026-02-01T05:00:00Z');
      await accept(k1, '1000000000', '2026-03-01T05:00:00Z');
      await pay(of.projectId, k1, '1200000000', '2026-02-05T05:00:00Z');
      await pay(of.projectId, k1, '300000000', '2026-02-20T05:00:00Z');
      // C2: 1 of 4 billion accepted, 0.9 billion paid.
      await accept(k2, '1000000000', '2026-01-31T05:00:00Z');
      await pay(of.projectId, k2, '900000000', '2026-02-10T05:00:00Z');
      // A payment that was only submitted is not certified: it does not count.
      await pay(of.projectId, k2, '700000000', '2026-02-11T05:00:00Z', 'SUBMITTED');

      const figures = await call('GET', `/projects/${of.projectId}/evm?as_of=${asOf}`, { member: READER });
      const pv = 3000000000n + (4000000000n * 45n) / 181n;
      expect(figures.status).toBe(200);
      expect(figures.json).toMatchObject({
        scope: 'PROJECT',
        source: 'LIVE',
        as_of: asOf,
        figures: { status: 'OK', bac_vnd: '10000000000', pv_vnd: pv.toString(), ev_vnd: '2500000000', ac_vnd: '2100000000', cpi: '1.1905', spi: (Number(2500000000n) / Number(pv)).toFixed(4), eac_vnd: '8400000000', etc_vnd: '6300000000', vac_vnd: '1600000000', eac_method: 'CPI_CUMULATIVE', rag_cpi: 'GREEN', rag_spi: 'RED' },
        policy: { source: 'BUILT_IN', version: 'built-in:1', eac_method: 'CPI_CUMULATIVE', amber_below: 0.95, red_below: 0.85 },
        eac_against_total: { over_vnd: '-491600000000' },
      });
      expect((figures.json.rows as Array<{ code: string; ev_vnd: string; ac_vnd: string; contracts: Array<{ contract_id: string }> }>).map((row) => [row.ev_vnd, row.ac_vnd, row.contracts[0]?.contract_id])).toEqual([['1500000000', '1200000000', k1], ['1000000000', '900000000', k2]]);

      const component = await call('GET', `/projects/${of.projectId}/evm?as_of=${asOf}&scope=COMPONENT&ref=${of.c1}`, { member: READER });
      expect(component.json).toMatchObject({ scope: 'COMPONENT', ref: of.c1, figures: { pv_vnd: '3000000000', ev_vnd: '1500000000', ac_vnd: '1200000000', cpi: '1.2500', spi: '0.5000', eac_vnd: '4800000000' } });
      const byContract = await call('GET', `/projects/${of.projectId}/evm?as_of=${asOf}&scope=CONTRACT&ref=${k2}`, { member: READER });
      expect(byContract.json).toMatchObject({ scope: 'CONTRACT', figures: { bac_vnd: '4000000000', ev_vnd: '1000000000', ac_vnd: '900000000', cpi: '1.1111' } });
      const unknownContract = await call('GET', `/projects/${of.projectId}/evm?as_of=${asOf}&scope=CONTRACT&ref=${randomUUID()}`, { member: READER });
      expect(unknownContract.json).toMatchObject({ figures: { status: 'INSUFFICIENT', missing: ['NO_CONTRACT_LINK'] } });

      // The link is ended, not deleted: the package has no contract again.
      expect((await call('POST', `/projects/${of.projectId}/component-contracts`, { member: PM, body: { contract_id: k2, component_id: null } })).json.status).toBe('ENDED');
      expect(await rows('select 1 from machvon.project_component_contract where contract_id = $1::uuid', [k2])).toHaveLength(1);
      expect((await call('GET', `/projects/${of.projectId}/evm?as_of=${asOf}`, { member: READER })).json).toMatchObject({ figures: { status: 'INSUFFICIENT', missing: ['NO_CONTRACT_LINK'] } });
      const links = await call('GET', `/projects/${of.projectId}/component-contracts`, { member: READER });
      expect((links.json.items as Array<{ contract_id: string }>).map((item) => item.contract_id)).toEqual([k1]);
      await expect(world.owner('delete from machvon.project_component_contract where contract_id = $1::uuid', [k2])).rejects.toThrow();
    });

    it('freezes the earned value of every project of the snapshot of a closed period with the snapshot, and reads it from there afterwards, never recomputed from data that moved later', async () => {
      const of = await ready();
      const k1 = await contract(of.projectId, of.lineId, '6000000000');
      await capture(of);
      await call('POST', `/projects/${of.projectId}/component-contracts`, { member: PM, body: { contract_id: k1, component_id: of.c1 } });
      await accept(k1, '1500000000', '2026-02-01T05:00:00Z');
      await pay(of.projectId, k1, '1200000000', '2026-02-05T05:00:00Z');
      // A project of the snapshot that has no baseline is frozen too, as "not enough data" with the reason.
      const bare = await world.publishedLine();
      const snapshotId = randomUUID();
      await seedAs(harness, [
        [
          `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, created_by, updated_by, version)
           values ($1, $2, $3, 'PERIOD_CLOSE', '2026-02-14T10:00:00Z', date '2026-02-14', date '2026-02-14', 'BUILDING', 'DIS-METRICS-R1-PROPOSED', 'PROPOSED_PENDING_SIGNOFF', 2, $4, $4, 1)`,
          [TENANT_A, snapshotId, randomUUID(), memberId(PM)],
        ],
        ...[of.projectId, bare.projectId].map((projectId): [string, unknown[]] => [
          `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, bucket, budget_level, rate_null_reason, treasury_coverage) values ($1, $2, $3, $4, $5, 'CURRENT_YEAR', 'CENTRAL', 'NO_DATA', 'NONE')`,
          [TENANT_A, randomUUID(), snapshotId, projectId, id(0x60, 1)],
        ]),
      ]);
      await world.as((tx) => new DisSnapshotStore().freeze(tx, snapshotId, 1, memberId(APPROVER), new Date()), PM);
      const frozen = await rows<{ project_id: string; status: string; baseline_version: number | null; eac_method: string; policy_version: string; payload_sha256: string; figures: { missing: string[]; evVnd?: string; ev_vnd?: string } }>(
        'select project_id, status, baseline_version, eac_method, policy_version, payload_sha256, figures from machvon.evm_frozen_result where snapshot_id = $1::uuid order by status',
        [snapshotId],
      );
      expect(frozen.map((row) => [row.project_id, row.status, row.baseline_version, row.eac_method, row.policy_version]).sort()).toEqual(
        [
          [of.projectId, 'INSUFFICIENT', 0, 'CPI_CUMULATIVE', 'built-in:1'],
          [bare.projectId, 'INSUFFICIENT', null, 'CPI_CUMULATIVE', 'built-in:1'],
        ].sort(),
      );
      expect(frozen.every((row) => /^[0-9a-f]{64}$/.test(row.payload_sha256))).toBe(true);
      expect(frozen.find((row) => row.project_id === bare.projectId)?.figures.missing).toEqual(['NO_BASELINE']);
      // The second package has money planned and no contract, so the project is "not enough data" with the reason, in the frozen result as it is live.
      expect(frozen.find((row) => row.project_id === of.projectId)?.figures.missing).toEqual(['NO_CONTRACT_LINK']);

      // The closed period answers from the frozen result even when the data moved after it.
      await accept(k1, '2000000000', '2026-02-10T05:00:00Z');
      const read = await call('GET', `/projects/${of.projectId}/evm?as_of=2026-02-14`, { member: READER });
      expect(read.json).toMatchObject({ source: 'FROZEN', snapshot_id: snapshotId, payload_sha256: frozen.find((row) => row.project_id === of.projectId)?.payload_sha256, as_of: '2026-02-14', figures: { status: 'INSUFFICIENT', missing: ['NO_CONTRACT_LINK'] } });
      const named = await call('GET', `/projects/${of.projectId}/evm?snapshot_id=${snapshotId}`, { member: READER });
      expect(named.json).toMatchObject({ source: 'FROZEN', snapshot_id: snapshotId });
      // The live view of the same day is another thing: version 0 is read live, with the accepted quantity that came after.
      const live = await call('GET', `/projects/${of.projectId}/evm?as_of=2026-02-14&scope=COMPONENT&ref=${of.c1}`, { member: READER });
      expect(live.json).toMatchObject({ source: 'LIVE', figures: { ev_vnd: '3500000000' } });
      await expect(world.owner("update machvon.evm_frozen_result set status = 'OK' where snapshot_id = $1::uuid", [snapshotId])).rejects.toThrow(/append-only/);
      await expect(world.owner('delete from machvon.evm_frozen_result where snapshot_id = $1::uuid', [snapshotId])).rejects.toThrow(/append-only/);
    });

    it('refuses a day after today, a scope without its thing and a thing without its scope, and keeps the projects of the caller out of sight of others', async () => {
      const of = await ready();
      await capture(of);
      expect((await call('GET', `/projects/${of.projectId}/evm?as_of=2999-01-01`, { member: READER })).json.code).toBe('VALIDATION_FAILED');
      expect((await call('GET', `/projects/${of.projectId}/evm?scope=COMPONENT`, { member: READER })).json.code).toBe('VALIDATION_FAILED');
      expect((await call('GET', `/projects/${of.projectId}/evm?ref=${of.c1}`, { member: READER })).json.code).toBe('VALIDATION_FAILED');
      expect((await call('GET', `/projects/${of.projectId}/evm?baseline=V9`, { member: READER })).json.code).toBe('VALIDATION_FAILED');
      expect((await call('GET', `/projects/${of.projectId}/evm?snapshot_id=${randomUUID()}`, { member: READER })).status).toBe(404);
      expect((await call('GET', `/projects/${of.projectId}/evm`, { member: NOBODY })).status).toBe(403);
      expect((await call('GET', `/projects/${randomUUID()}/evm`, { member: READER })).status).toBe(404);
    });
  });

  describe('the S-curve and its Excel file (G1-5)', () => {
    it('draws the plan by version 0 and by the current baseline and the earned value and cost up to the day of the view, and exports the same figures', async () => {
      const of = await ready();
      const k1 = await contract(of.projectId, of.lineId, '6000000000');
      await capture(of);
      expect((await call('GET', `/projects/${of.projectId}/s-curve`, { member: READER })).status).toBe(200);
      await call('POST', `/projects/${of.projectId}/component-contracts`, { member: PM, body: { contract_id: k1, component_id: of.c1 } });
      await accept(k1, '3000000000', '2026-02-01T05:00:00Z');
      await pay(of.projectId, k1, '2000000000', '2026-02-05T05:00:00Z');
      const curve = await call('GET', `/projects/${of.projectId}/s-curve?as_of=2026-02-14&scope=COMPONENT&ref=${of.c1}`, { member: READER });
      expect(curve.status).toBe(200);
      const points = curve.json.points as Array<{ day: string; pv_v0_vnd: string; pv_current_vnd: string; ev_vnd: string | null; ac_vnd: string | null }>;
      expect(points[0]).toEqual({ day: '2026-01-01', pv_v0_vnd: '66666666', pv_current_vnd: '66666666', ev_vnd: '0', ac_vnd: '0' });
      expect(points.map((point) => point.day)).toEqual([...points.map((point) => point.day)].sort());
      const last = points[points.length - 1]!;
      expect(last).toMatchObject({ day: '2026-03-31', pv_v0_vnd: '6000000000', ev_vnd: null, ac_vnd: null });
      const onTheDay = points.find((point) => point.day === '2026-02-14')!;
      expect(onTheDay).toMatchObject({ pv_v0_vnd: '3000000000', ev_vnd: '3000000000', ac_vnd: '2000000000' });
      expect(curve.json).toMatchObject({ as_of: '2026-02-14', baseline: { version: 0 }, figures: { status: 'OK', cpi: '1.5000', spi: '1.0000' }, missing: [] });

      const exported = await call('GET', `/projects/${of.projectId}/s-curve/export?as_of=2026-02-14&scope=COMPONENT&ref=${of.c1}`, { member: READER });
      expect(exported.status).toBe(200);
      const bytes = Buffer.from(exported.json.content_base64 as string, 'base64');
      expect(bytes.subarray(0, 2).toString()).toBe('PK');
      expect(exported.json).toMatchObject({ content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), as_of: '2026-02-14' });
      expect(exported.json.file_name).toMatch(/\.xlsx$/);
      expect((await call('GET', `/projects/${of.projectId}/s-curve/export`, { member: NOBODY })).status).toBe(403);

      const none = await ready();
      const refused = await call('GET', `/projects/${none.projectId}/s-curve`, { member: READER });
      expect([refused.status, refused.json.code]).toEqual([422, 'BASELINE_MISSING']);
    });
  });

  describe('the precondition of a disbursement (G1-2)', () => {
    it('answers whether a project may be paid, naming the cause and the way to fix it, and takes the stage and the plan from the system', async () => {
      const listed = await world.publishedLine({ allocated: money(5), appropriationAmount: money(8) });
      await world.owner('update machvon.project set status = $2 where id = $1::uuid', [listed.projectId, 'IMPLEMENTATION']);
      const allowed = await call('GET', `/projects/${listed.projectId}/disbursement-check`, { member: READER });
      expect(allowed).toMatchObject({ status: 200, json: { allowed: true, refusal: null, fix: null, warnings: [], policy_version: 'built-in:1' } });

      await world.owner('update machvon.project set status = $2 where id = $1::uuid', [listed.projectId, 'CONCEPT']);
      const unlisted = await call('GET', `/projects/${listed.projectId}/disbursement-check`, { member: READER });
      expect(unlisted).toMatchObject({ status: 200, json: { allowed: false, refusal: 'DISBURSEMENT_PROJECT_NOT_LISTED', fix: 'COMPLETE_STAGE_TRANSITION', cause: { project_status: 'CONCEPT' } } });

      const planless = await world.project();
      await world.owner('update machvon.project set status = $2 where id = $1::uuid', [planless, 'IMPLEMENTATION']);
      const noPlan = await call('GET', `/projects/${planless}/disbursement-check`, { member: READER });
      expect(noPlan).toMatchObject({ status: 200, json: { allowed: false, refusal: 'DISBURSEMENT_NO_APPROVED_PLAN', fix: 'ENTER_APPROVED_PLAN', cause: { project_status: 'IMPLEMENTATION', allocated_vnd: '0' } } });

      // An open request to appraise the project again is a warning on the verdict, never a block.
      const of = await ready();
      await capture(of);
      await delay(of.m2, '2026-10-30', 1);
      expect((await call('GET', `/projects/${of.projectId}/disbursement-check`, { member: READER })).json).toMatchObject({ allowed: true, warnings: ['REAPPRAISAL_OPEN'] });
      expect((await call('GET', `/projects/${of.projectId}/disbursement-check`, { member: NOBODY })).status).toBe(403);
    });
  });

  describe('the thresholds come from the governance rules, not from the code (G0-1)', () => {
    it('reads BASELINE_DEVIATION through the governance port: an approved rule moves the thresholds and its version is kept on what it decided', async () => {
      // A rule approved by someone who is neither its maker nor its submitter, in force from the start of the year: the alert comes at the second move and 400 days of slip are tolerated.
      await world.owner(
        `insert into machvon.governance_rule (tenant_id, id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
         values ($1, $2, 'BASELINE_DEVIATION', 'DEFAULT', 1, 'APPROVED', '{"cost_pct": 50, "slip_days": 400, "reschedule_alert_count": 2}'::jsonb, '2026-01-01', 'The board confirmed the thresholds', $3, $4, now(), $5, now())`,
        [TENANT_A, randomUUID(), memberId(PM), memberId(APPROVER), memberId(DECIDER)],
      );
      const of = await ready();
      await capture(of);
      const first = await delay(of.m2, '2026-10-30', 1);
      expect(await rows('select 1 from machvon.project_governance_alert where project_id = $1::uuid', [of.projectId])).toHaveLength(0);
      expect(await rows('select 1 from machvon.project_reappraisal_request where project_id = $1::uuid', [of.projectId])).toHaveLength(0);
      expect((await delay(of.m2, '2026-11-15', versionOf(first))).status).toBe(200);
      expect(await rows<{ threshold: number; rule_version: string; move_count: number }>('select threshold, rule_version, move_count from machvon.project_governance_alert where project_id = $1::uuid', [of.projectId])).toEqual([{ threshold: 2, rule_version: '1', move_count: 2 }]);
      expect((await baseline(of)).json).toMatchObject({ reasons: [], policy: { source: 'RULE', version: '1', cost_pct: 50, slip_days: 400, reschedule_alert_count: 2 } });
    });
  });
});
