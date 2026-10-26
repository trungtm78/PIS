import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { audModule } from '../../src/modules/aud';
import { AuditConclusionController, AuditConclusionReadsController } from '../../src/modules/aud/conclusion.controller';
import { AuditEngagementController, AuditEngagementReadsController } from '../../src/modules/aud/engagement.controller';
import { AuditRecommendationController, AuditRecommendationReadsController } from '../../src/modules/aud/recommendation.controller';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const MANAGER = 1; // aud.engagement.manage, aud.conclusion.record and aud.read over the whole tenant
const DEPARTMENT_RECORDER = 2; // aud.conclusion.record and aud.read over the subtree of unit 2 (the owner of the project)
const OUTSIDER = 3; // the same over another branch, where the engagement is not
const READER = 4; // aud.read over the whole tenant, nothing more
const NOBODY = 5;
const ENGAGEMENT_ONLY = 6; // aud.engagement.manage and aud.read, but not aud.conclusion.record
const B_MANAGER = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const FAMILY = 0x94;
const PROJECT = id(FAMILY, 1);
const PROJECT_ELSEWHERE = id(FAMILY, 2);
const CONTRACT = id(FAMILY, 3);
const DECISION = id(FAMILY, 10);
const CONCLUSION_DOCUMENT = id(FAMILY, 11);
const PENDING_DOCUMENT = id(FAMILY, 12);
const PERIOD = { period_from: '2025-01-01', period_to: '2025-12-31' };
const TOTAL = '1250000000';
const SUMMARY = 'The audit found payments above the approved volumes.';
const DESCRIPTION = 'Payment above the volume accepted on site.';
const SECRET_WORDS = [SUMMARY, DESCRIPTION, 'Recover the amount paid above the volume accepted.', 'Article 12 of the law on public investment'];

interface Reply {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
}

interface CallOptions {
  member: number;
  tenantId?: string;
  body?: unknown;
  ifMatch?: string;
  key?: string;
}

describe('conclusions, findings and recommendations over HTTP (ST-AUD-002, AUD-04, AUD-05)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST', url: string, options: CallOptions): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;

  async function seedAs(statements: Array<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      // The projects, contracts and documents belong to other modules: the superuser seeds them with the foreign keys switched off.
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  /** An engagement that is ONGOING (registered and started by the manager) and its version. */
  async function ongoing(extra: Record<string, unknown> = {}): Promise<string> {
    counter += 1;
    const made = await call('POST', '/audit-engagements', {
      member: MANAGER,
      body: {
        engagement_code: `KL-2026-${String(counter).padStart(3, '0')}`,
        engagement_type: 'STATE_AUDIT',
        authority_kind: 'STATE_AUDIT_OFFICE',
        authority_name: 'State Audit Office',
        decision_document_id: DECISION,
        title: 'Audit of the investment in the bridge',
        ...PERIOD,
        coordinator_user_id: memberId(MANAGER),
        scope: [
          { kind: 'PROJECT', id: PROJECT },
          { kind: 'CONTRACT', id: CONTRACT },
        ],
        ...extra,
      },
    });
    expect(made.status).toBe(200);
    const engagementId = idOf(made);
    const started = await call('POST', `/audit-engagements/${engagementId}/start`, { member: MANAGER, ifMatch: '"1"', body: { started_on: '2026-10-20', place_legal_hold: false } });
    expect(started.status).toBe(200);
    return engagementId;
  }

  const conclusionBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    conclusion_kind: 'AUDIT_REPORT',
    conclusion_document_id: CONCLUSION_DOCUMENT,
    issued_on: '2026-10-10',
    received_on: '2026-10-15',
    implementation_due_on: '2026-12-31',
    report_due_on: '2027-01-15',
    summary: SUMMARY,
    total_financial_vnd: TOTAL,
    ...extra,
  });
  const record = (member: number, engagementId: string, version: number | string, extra: Record<string, unknown> = {}, key?: string): Promise<Reply> =>
    call('POST', `/audit-engagements/${engagementId}/conclusions`, { member, ifMatch: `"${version}"`, body: conclusionBody(extra), ...(key === undefined ? {} : { key }) });
  /** An engagement with its conclusion recorded, and the id of the conclusion. */
  async function followed(extra: Record<string, unknown> = {}): Promise<{ engagementId: string; conclusionId: string }> {
    const engagementId = await ongoing();
    const recorded = await record(MANAGER, engagementId, 2, extra);
    expect(recorded.status).toBe(200);
    return { engagementId, conclusionId: idOf(recorded) };
  }

  const findingBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => {
    counter += 1;
    return {
      finding_code: `F-${counter}`,
      category: 'FINANCIAL',
      project_id: PROJECT,
      description: DESCRIPTION,
      legal_basis_cited: 'Article 12 of the law on public investment',
      amount_vnd: '300000000',
      severity: 'HIGH',
      ...extra,
    };
  };
  const addFinding = (member: number, conclusionId: string, extra: Record<string, unknown> = {}, options: Partial<CallOptions> = {}): Promise<Reply> =>
    call('POST', `/audit-conclusions/${conclusionId}/findings`, { member, body: findingBody(extra), ...options });
  const recommendationBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => {
    counter += 1;
    return { rec_code: `R-${counter}`, rec_type: 'FINANCIAL_RECOVERY', description: 'Recover the amount paid above the volume accepted.', amount_vnd: '100000000', ...extra };
  };
  const addRecommendation = (member: number, conclusionId: string, extra: Record<string, unknown> = {}, options: Partial<CallOptions> = {}): Promise<Reply> =>
    call('POST', `/audit-conclusions/${conclusionId}/recommendations`, { member, body: recommendationBody(extra), ...options });
  const conclusionsOf = (member: number, engagementId: string, tenantId = TENANT_A): Promise<Reply> => call('GET', `/audit-engagements/${engagementId}/conclusions`, { member, tenantId });
  const audits = (resourceId: string): Promise<Array<{ action: string; classification: string; safe_diff: Record<string, unknown> }>> =>
    rows('select action, classification, safe_diff from machvon.audit_event where resource_id = $1 order by occurred_at, id', [resourceId]);
  const events = (aggregateId: string): Promise<Array<{ type: string; payload: Record<string, unknown> }>> =>
    rows('select type, payload from machvon.outbox_event where aggregate_id = $1 order by created_at, id', [aggregateId]);

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    for (const n of [MANAGER, DEPARTMENT_RECORDER, OUTSIDER, READER, NOBODY, ENGAGEMENT_ONLY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_MANAGER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'AUD_MANAGER', ['aud.engagement.manage', 'aud.conclusion.record', 'aud.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'AUD_READER', ['aud.read'], 20);
    await harness.seedRole(TENANT_A, 3, 'AUD_RECORDER', ['aud.conclusion.record', 'aud.read'], 30);
    await harness.seedRole(TENANT_A, 4, 'AUD_ENGAGEMENT', ['aud.engagement.manage', 'aud.read'], 30);
    await harness.seedRole(TENANT_B, 1, 'AUD_MANAGER', ['aud.engagement.manage', 'aud.conclusion.record', 'aud.read'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MANAGER, role: 1, kind: 'TENANT' },
      { n: 2, member: DEPARTMENT_RECORDER, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 3, member: OUTSIDER, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 4, member: READER, role: 2, kind: 'TENANT' },
      { n: 5, member: ENGAGEMENT_ONLY, role: 4, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_MANAGER, role: 1, kind: 'TENANT' }]);
    await seedAs([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, 'P-A-001', 'Bridge', $4, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B'), ($1, $3, 'P-A-002', 'Road', $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, PROJECT, PROJECT_ELSEWHERE, unitId(DEPARTMENT), unitId(ELSEWHERE), id(FAMILY, 30)],
      ],
      [
        `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version)
         values ($1, $2, $3, $4, $4, 'C-01', 'LUMP_SUM', 'VND', 'DRAFT', 1)`,
        [TENANT_A, CONTRACT, PROJECT, id(FAMILY, 31)],
      ],
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, document_number, number_year, created_by, updated_by)
         values ($1, $2, 'REFERENCE', 'QD', 'Decision to audit the bridge', '12/QD-KTNN', '2026-01-15', 'EFFECTIVE', 'INTERNAL', null, null, $5, $5),
                ($1, $3, 'INCOMING', 'KL', 'Audit report on the bridge', '88/BC-KTNN', '2026-10-10', 'EFFECTIVE', 'INTERNAL', 88, 2026, $5, $5),
                ($1, $4, 'INCOMING', 'KL', 'A report not yet in force', null, null, 'PENDING', 'INTERNAL', null, null, $5, $5)`,
        [TENANT_A, DECISION, CONCLUSION_DOCUMENT, PENDING_DOCUMENT, memberId(MANAGER)],
      ],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [AuditEngagementController, AuditEngagementReadsController, AuditConclusionController, AuditConclusionReadsController, AuditRecommendationController, AuditRecommendationReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('serves the conclusion controllers in the module of AUD', () => {
    expect(audModule.controllers.slice(0, 4)).toEqual([AuditEngagementController, AuditEngagementReadsController, AuditConclusionController, AuditConclusionReadsController]);
  });

  describe('recordAuditConclusion', () => {
    it('AC-ST-AUD-002-2 / UAT-AC434: records the conclusion of an ONGOING engagement with an effective document, moves it to FOLLOW_UP and emits aud.conclusion.recorded.v1', async () => {
      const engagementId = await ongoing();
      const reply = await record(MANAGER, engagementId, 2);
      expect(reply).toMatchObject({ status: 200, json: { status: 'RECEIVED', resource_version: 1 } });
      const conclusionId = idOf(reply);
      const engagement = await call('GET', `/audit-engagements/${engagementId}`, { member: MANAGER });
      expect(engagement.json).toMatchObject({ status: 'FOLLOW_UP', version: 3 });
      const [event] = await events(conclusionId);
      expect(event).toMatchObject({
        type: 'aud.conclusion.recorded.v1',
        payload: {
          conclusion_id: conclusionId,
          engagement_id: engagementId,
          conclusion_kind: 'AUDIT_REPORT',
          conclusion_document_id: CONCLUSION_DOCUMENT,
          issued_on: '2026-10-10',
          received_on: '2026-10-15',
          implementation_due_on: '2026-12-31',
          report_due_on: '2027-01-15',
          total_financial_vnd: TOTAL,
          is_public: false,
          revision: 1,
          actor_id: memberId(MANAGER),
        },
      });
      const [trail] = await audits(conclusionId);
      expect(trail).toMatchObject({ action: 'aud.conclusion_recorded', classification: 'CONFIDENTIAL', safe_diff: { engagement_from_status: 'ONGOING', engagement_to_status: 'FOLLOW_UP', total_financial_vnd: TOTAL } });
      const listed = await conclusionsOf(MANAGER, engagementId);
      expect(listed.json.items).toEqual([
        expect.objectContaining({
          id: conclusionId,
          document: { id: CONCLUSION_DOCUMENT, title: 'Audit report on the bridge', symbol: '88/BC-KTNN' },
          revision: 1,
          total_financial_vnd: TOTAL,
          recommended_vnd: '0',
          shortfall_vnd: TOTAL,
          status: 'RECEIVED',
          finding_count: 0,
          recommendation_count: 0,
        }),
      ]);
    });

    it('also records it once the fieldwork has ended', async () => {
      const engagementId = await ongoing();
      expect((await call('POST', `/audit-engagements/${engagementId}/fieldwork-end`, { member: MANAGER, ifMatch: '"2"', body: { on_date: '2026-10-22' } })).status).toBe(200);
      expect(await record(MANAGER, engagementId, 3)).toMatchObject({ status: 200, json: { status: 'RECEIVED' } });
    });

    it('answers a replay with the first body, refuses the same key with another body, and a second conclusion is a conflict of state', async () => {
      const engagementId = await ongoing();
      const first = await record(MANAGER, engagementId, 2, {}, 'conclusion-replay-key');
      const again = await record(MANAGER, engagementId, 2, {}, 'conclusion-replay-key');
      expect(again.headers.get('idempotency-replayed')).toBe('true');
      expect(again.json).toEqual(first.json);
      const other = await record(MANAGER, engagementId, 2, { summary: 'A different summary of the same audit.' }, 'conclusion-replay-key');
      expect([other.status, other.json.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
      expect(await record(MANAGER, engagementId, 3)).toMatchObject({ status: 409, json: { code: 'ENGAGEMENT_STATE_INVALID' } });
      expect((await rows<{ n: string }>('select count(*) as n from machvon.audit_conclusion where engagement_id = $1', [engagementId]))[0]?.n).toBe('1');
    });

    it('refuses a stale version (409 VERSION_CONFLICT), an engagement that is PLANNED (409 ENGAGEMENT_STATE_INVALID) and a document that is not in force (422), writing nothing', async () => {
      const engagementId = await ongoing();
      expect(await record(MANAGER, engagementId, 1)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect(await record(MANAGER, engagementId, 2, { conclusion_document_id: PENDING_DOCUMENT })).toMatchObject({ status: 422, json: { code: 'DECISION_DOCUMENT_NOT_EFFECTIVE' } });
      expect(await record(MANAGER, engagementId, 2, { conclusion_document_id: randomUUID() })).toMatchObject({ status: 422, json: { code: 'DECISION_DOCUMENT_NOT_EFFECTIVE' } });
      const planned = idOf(await call('POST', '/audit-engagements', { member: MANAGER, body: { engagement_code: 'KL-PLANNED', engagement_type: 'STATE_AUDIT', authority_kind: 'STATE_AUDIT_OFFICE', authority_name: 'State Audit Office', decision_document_id: DECISION, title: 'Planned audit of the bridge', ...PERIOD, coordinator_user_id: memberId(MANAGER), scope: [{ kind: 'PROJECT', id: PROJECT }] } }));
      expect(await record(MANAGER, planned, 1)).toMatchObject({ status: 409, json: { code: 'ENGAGEMENT_STATE_INVALID' } });
      expect((await rows<{ n: string }>('select count(*) as n from machvon.audit_conclusion where engagement_id = any($1::uuid[])', [[engagementId, planned]]))[0]?.n).toBe('0');
    });

    it('refuses fields out of order or of the wrong shape: a received day before the issue, a total that is not whole dong, a short summary, a field that is not in the contract', async () => {
      const engagementId = await ongoing();
      for (const extra of [{ received_on: '2026-10-09' }, { received_on: '2999-01-01' }, { summary: 'short' }, { total_financial_vnd: '12.5' }, { total_financial_vnd: '-1' }, { implementation_due_on: '2026-10-01' }]) {
        const reply = await record(MANAGER, engagementId, 2, extra);
        expect([reply.status, 400 === reply.status || 422 === reply.status]).toEqual([reply.status, true]);
      }
      expect((await record(MANAGER, engagementId, 2, { status: 'CLOSED' })).status).toBe(400);
      expect(await record(MANAGER, engagementId, 2, { supersedes_id: randomUUID() })).toMatchObject({ status: 409, json: { code: 'CONCLUSION_REVISION_INVALID' } });
      expect((await call('GET', `/audit-engagements/${engagementId}`, { member: MANAGER })).json).toMatchObject({ status: 'ONGOING' });
    });

    it('keeps what the authority wrote out of the trail and the events: they hold codes, ids and amounts only', async () => {
      const done = await followed();
      await addFinding(MANAGER, done.conclusionId, { finding_code: 'F-PRIVACY' });
      await addRecommendation(MANAGER, done.conclusionId, { rec_code: 'R-PRIVACY' });
      const trail = await rows<{ safe_diff: unknown; classification: string }>(
        "select safe_diff, classification from machvon.audit_event where action in ('aud.conclusion_recorded', 'aud.finding_recorded', 'aud.recommendation_created') and (resource_id::text = $1 or safe_diff ->> 'conclusion_id' = $1)",
        [done.conclusionId],
      );
      expect(trail.length).toBe(3);
      expect(trail.every((entry) => entry.classification === 'CONFIDENTIAL')).toBe(true);
      const emitted = await rows<{ payload: unknown }>("select payload from machvon.outbox_event where type like 'aud.%' and (aggregate_id::text = $1 or payload ->> 'conclusion_id' = $1)", [done.conclusionId]);
      expect(emitted.length).toBe(3);
      for (const text of [JSON.stringify(trail), JSON.stringify(emitted)]) for (const words of SECRET_WORDS) expect(text).not.toContain(words);
    });
  });

  describe('recordAuditFinding', () => {
    it('records a finding about the project of the engagement and lists it with the code and the name of the project, once per code', async () => {
      const done = await followed();
      const made = await addFinding(MANAGER, done.conclusionId, { finding_code: 'F-ONE', contract_id: CONTRACT, organization_unit_id: unitId(DEPARTMENT) });
      expect(made).toMatchObject({ status: 200, json: { status: 'RECORDED', resource_version: 1 } });
      const listed = await call('GET', `/audit-conclusions/${done.conclusionId}/findings`, { member: MANAGER });
      expect(listed.json).toMatchObject({ next_cursor: null });
      expect(listed.json.items).toEqual([
        expect.objectContaining({
          id: idOf(made),
          conclusion_id: done.conclusionId,
          finding_code: 'F-ONE',
          category: 'FINANCIAL',
          project: { id: PROJECT, code: 'P-A-001', name: 'Bridge' },
          contract: { id: CONTRACT, code: 'C-01' },
          organization_unit: expect.objectContaining({ id: unitId(DEPARTMENT) }),
          amount_vnd: '300000000',
          severity: 'HIGH',
        }),
      ]);
      expect(await addFinding(MANAGER, done.conclusionId, { finding_code: 'F-ONE' })).toMatchObject({ status: 409, json: { code: 'FINDING_CODE_DUPLICATE' } });
      const [event] = await events(idOf(made));
      expect(event).toMatchObject({ type: 'aud.finding.recorded.v1', payload: { finding_code: 'F-ONE', category: 'FINANCIAL', severity: 'HIGH', project_id: PROJECT, amount_vnd: '300000000' } });
    });

    it('refuses a place of the tenant that is not in the engagement (422 TARGET_OUT_OF_ENGAGEMENT) and does not find one of another tenant or one that does not exist (404)', async () => {
      const done = await followed();
      expect(await addFinding(MANAGER, done.conclusionId, { project_id: PROJECT_ELSEWHERE })).toMatchObject({ status: 422, json: { code: 'TARGET_OUT_OF_ENGAGEMENT' } });
      expect(await addFinding(MANAGER, done.conclusionId, { project_id: randomUUID() })).toMatchObject({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
      expect((await call('GET', `/audit-conclusions/${done.conclusionId}/findings`, { member: MANAGER })).json.items).toEqual([]);
    });

    it('lists the findings by code, page by page', async () => {
      const done = await followed();
      for (const code of ['F-C', 'F-A', 'F-B']) await addFinding(MANAGER, done.conclusionId, { finding_code: code, amount_vnd: undefined });
      const first = await call('GET', `/audit-conclusions/${done.conclusionId}/findings?limit=2`, { member: MANAGER });
      expect((first.json.items as Array<{ finding_code: string }>).map((item) => item.finding_code)).toEqual(['F-A', 'F-B']);
      const second = await call('GET', `/audit-conclusions/${done.conclusionId}/findings?limit=2&cursor=${first.json.next_cursor as string}`, { member: MANAGER });
      expect((second.json.items as Array<{ finding_code: string }>).map((item) => item.finding_code)).toEqual(['F-C']);
      expect(second.json.next_cursor).toBeNull();
      expect((await call('GET', `/audit-conclusions/${done.conclusionId}/findings?limit=0`, { member: MANAGER })).status).toBe(422);
    });
  });

  describe('createAuditRecommendation (AC-ST-AUD-002-1)', () => {
    it('AC-ST-AUD-002-1 / UAT-AC434: 800,000,000 and 400,000,000 on a total of 1,250,000,000; a further 100,000,000 is 422 FINANCIAL_TOTAL_MISMATCH with the figures and a financial recommendation without an amount is 422 AMOUNT_REQUIRED', async () => {
      const done = await followed();
      expect(await addRecommendation(MANAGER, done.conclusionId, { amount_vnd: '800000000' })).toMatchObject({ status: 200, json: { status: 'OPEN', resource_version: 1 } });
      expect(await addRecommendation(MANAGER, done.conclusionId, { rec_type: 'FINANCIAL_ADJUSTMENT', amount_vnd: '400000000' })).toMatchObject({ status: 200 });
      const before = (await conclusionsOf(MANAGER, done.engagementId)).json.items as Array<Record<string, unknown>>;
      expect(before[0]).toMatchObject({ total_financial_vnd: TOTAL, recommended_vnd: '1200000000', shortfall_vnd: '50000000', recommendation_count: 2 });
      const over = await addRecommendation(MANAGER, done.conclusionId, { amount_vnd: '100000000' });
      expect(over).toMatchObject({
        status: 422,
        json: { code: 'FINANCIAL_TOTAL_MISMATCH', total_financial_vnd: TOTAL, recommended_vnd: '1200000000', amount_vnd: '100000000', remaining_vnd: '50000000', excess_vnd: '50000000' },
      });
      expect(await addRecommendation(MANAGER, done.conclusionId, { amount_vnd: undefined })).toMatchObject({ status: 422, json: { code: 'AMOUNT_REQUIRED' } });
      expect(await addRecommendation(MANAGER, done.conclusionId, { amount_vnd: '50000000' })).toMatchObject({ status: 200 });
      const after = (await conclusionsOf(MANAGER, done.engagementId)).json.items as Array<Record<string, unknown>>;
      expect(after[0]).toMatchObject({ recommended_vnd: TOTAL, shortfall_vnd: '0', recommendation_count: 3 });
    });

    it('stores a recommendation OPEN with its finding and project, emits aud.recommendation.created.v1 and lists it with the filters of the screens', async () => {
      const done = await followed();
      const finding = idOf(await addFinding(MANAGER, done.conclusionId));
      const made = await addRecommendation(MANAGER, done.conclusionId, { rec_code: 'R-LISTED', finding_id: finding, project_id: PROJECT });
      expect(made.status).toBe(200);
      const [event] = await events(idOf(made));
      expect(event).toMatchObject({ type: 'aud.recommendation.created.v1', payload: { rec_code: 'R-LISTED', rec_type: 'FINANCIAL_RECOVERY', amount_vnd: '100000000', finding_id: finding, recommended_vnd: '100000000', shortfall_vnd: '1150000000' } });
      await addRecommendation(MANAGER, done.conclusionId, { rec_code: 'R-REFERRAL', rec_type: 'REFERRAL', amount_vnd: undefined });
      const listed = await call('GET', `/audit-recommendations?conclusion_id=${done.conclusionId}`, { member: MANAGER });
      expect((listed.json.items as Array<Record<string, unknown>>).map((item) => item.rec_code)).toEqual(['R-LISTED', 'R-REFERRAL']);
      expect(listed.json.items).toEqual([
        expect.objectContaining({ id: idOf(made), conclusion_id: done.conclusionId, finding_id: finding, rec_type: 'FINANCIAL_RECOVERY', amount_vnd: '100000000', recovered_vnd: '0', status: 'OPEN', is_overdue: false, owner_unit_id: null, due_on: null }),
        expect.objectContaining({ rec_code: 'R-REFERRAL', amount_vnd: null }),
      ]);
      const byType = await call('GET', `/audit-recommendations?engagement_id=${done.engagementId}&rec_type=REFERRAL&overdue=false`, { member: MANAGER });
      expect((byType.json.items as Array<Record<string, unknown>>).map((item) => item.rec_code)).toEqual(['R-REFERRAL']);
      expect((await call('GET', `/audit-recommendations?conclusion_id=${done.conclusionId}&limit=1`, { member: MANAGER })).json.next_cursor).not.toBeNull();
      expect((await call('GET', '/audit-recommendations?overdue=maybe', { member: MANAGER })).status).toBe(422);
      expect((await call('GET', '/audit-recommendations?conclusion_id=not-a-uuid', { member: MANAGER })).status).toBe(422);
    });

    it('refuses a duplicate code (409), an amount on a recommendation that is not financial (422) and a finding of another conclusion (422)', async () => {
      const done = await followed();
      const other = await followed();
      const theirs = idOf(await addFinding(MANAGER, other.conclusionId));
      expect(await addRecommendation(MANAGER, done.conclusionId, { rec_code: 'R-DUP' })).toMatchObject({ status: 200 });
      expect(await addRecommendation(MANAGER, done.conclusionId, { rec_code: 'R-DUP' })).toMatchObject({ status: 409, json: { code: 'REC_CODE_DUPLICATE' } });
      expect(await addRecommendation(MANAGER, done.conclusionId, { rec_type: 'PROCESS_CORRECTION', amount_vnd: '5' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await addRecommendation(MANAGER, done.conclusionId, { finding_id: theirs })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await addRecommendation(MANAGER, done.conclusionId, { project_id: PROJECT_ELSEWHERE })).toMatchObject({ status: 422, json: { code: 'TARGET_OUT_OF_ENGAGEMENT' } });
    });

    it('serialises two recommendations sent at the same time: one fits and the other is 422 FINANCIAL_TOTAL_MISMATCH', async () => {
      const done = await followed({ total_financial_vnd: '1000' });
      const replies = await Promise.all([addRecommendation(MANAGER, done.conclusionId, { amount_vnd: '700' }), addRecommendation(MANAGER, done.conclusionId, { amount_vnd: '700' })]);
      expect(replies.map((reply) => reply.status).sort()).toEqual([200, 422]);
      expect(replies.find((reply) => reply.status === 422)?.json.code).toBe('FINANCIAL_TOTAL_MISMATCH');
    });

    it('takes nothing more once the engagement is closed (409 ENGAGEMENT_STATE_INVALID)', async () => {
      const done = await followed();
      await rows("update machvon.audit_engagement set status = 'CLOSED', closed_on = '2026-10-26' where id = $1", [done.engagementId]);
      expect(await addRecommendation(MANAGER, done.conclusionId)).toMatchObject({ status: 409, json: { code: 'ENGAGEMENT_STATE_INVALID' } });
      expect(await addFinding(MANAGER, done.conclusionId)).toMatchObject({ status: 409, json: { code: 'ENGAGEMENT_STATE_INVALID' } });
    });
  });

  describe('who may record, and who finds what (AUD 2, BR-IAM-01)', () => {
    it('lets a recorder of the unit that owns the project record in the engagement, and refuses a reader or a manager of engagements who may not record (403)', async () => {
      const engagementId = await ongoing();
      const refused = [READER, ENGAGEMENT_ONLY, NOBODY];
      for (const member of refused) expect((await record(member, engagementId, 2)).status).toBe(403);
      expect(await record(DEPARTMENT_RECORDER, engagementId, 2)).toMatchObject({ status: 200 });
      const conclusion = (await conclusionsOf(DEPARTMENT_RECORDER, engagementId)).json.items as Array<{ id: string }>;
      const conclusionId = (conclusion[0] as { id: string }).id;
      for (const member of refused) {
        expect((await addFinding(member, conclusionId)).status).toBe(403);
        expect((await addRecommendation(member, conclusionId)).status).toBe(403);
      }
      expect((await addFinding(DEPARTMENT_RECORDER, conclusionId)).status).toBe(200);
      expect((await addRecommendation(DEPARTMENT_RECORDER, conclusionId)).status).toBe(200);
    });

    it('AC-ST-AUD-001-2 / UAT-AC442: answers 404 to a recorder of another branch and to a coordinator of another tenant, for the commands and for the reads, and reveals nothing', async () => {
      const done = await followed();
      const engagementId = await ongoing();
      for (const [member, tenantId] of [[OUTSIDER, TENANT_A], [B_MANAGER, TENANT_B]] as const) {
        expect((await call('POST', `/audit-engagements/${engagementId}/conclusions`, { member, tenantId, ifMatch: '"2"', body: conclusionBody() })).status).toBe(404);
        expect((await call('POST', `/audit-conclusions/${done.conclusionId}/findings`, { member, tenantId, body: findingBody() })).status).toBe(404);
        expect((await call('POST', `/audit-conclusions/${done.conclusionId}/recommendations`, { member, tenantId, body: recommendationBody() })).status).toBe(404);
        expect((await conclusionsOf(member, done.engagementId, tenantId)).status).toBe(404);
        expect((await call('GET', `/audit-conclusions/${done.conclusionId}/findings`, { member, tenantId })).status).toBe(404);
        expect((await call('GET', `/audit-recommendations?conclusion_id=${done.conclusionId}`, { member, tenantId })).json.items).toEqual([]);
      }
    });

    it('lets a reader see the conclusions, findings and recommendations of the engagement and refuses a user without the permission to read (403)', async () => {
      const done = await followed();
      await addFinding(MANAGER, done.conclusionId, { finding_code: 'F-SEEN' });
      await addRecommendation(MANAGER, done.conclusionId, { rec_code: 'R-SEEN' });
      expect((await conclusionsOf(READER, done.engagementId)).status).toBe(200);
      expect(((await call('GET', `/audit-conclusions/${done.conclusionId}/findings`, { member: READER })).json.items as unknown[]).length).toBe(1);
      expect(((await call('GET', `/audit-recommendations?conclusion_id=${done.conclusionId}`, { member: READER })).json.items as unknown[]).length).toBe(1);
      expect((await conclusionsOf(NOBODY, done.engagementId)).status).toBe(403);
      expect((await call('GET', `/audit-conclusions/${done.conclusionId}/findings`, { member: NOBODY })).status).toBe(403);
      expect((await call('GET', '/audit-recommendations', { member: NOBODY })).status).toBe(403);
    });
  });
});
