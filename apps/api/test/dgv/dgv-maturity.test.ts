import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { AuditWriter, DgvMaturityJob, EffectiveAccessStore, InMemoryAuthzCache, NotificationStore, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import type { OutboxDelivery } from '@machvon/db';
import { MATURITY_PILLARS, loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { NotificationConsumer } from '../../src/notifications/consumer';
import { PayloadValidator } from '../../src/notifications/payload-validator';
import type { EventTypeCatalog, EventTypeDefinition } from '../../src/notifications/payload-validator';
import { PermissionResourceAccess } from '../../src/notifications/resource-access-port';
import { CommandModule } from '../../src/command.module';
import { dgvModule } from '../../src/modules/dgv';
import { DgvMaturityCommandsController, DgvMaturityReadsController } from '../../src/modules/dgv/dgv-maturity.controller';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';
import { asList, asNumber, asObject, asObjects, asString } from '../support/json';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const MANAGER = 1; // drafts rubrics, starts assessments, plans the roadmap (data.maturity.manage)
const PUBLISHER = 2; // publishes rubrics and assessments (data.maturity.publish)
const ASSESSOR = 3; // records the criteria (data.maturity.assess)
const REVIEWER = 4; // reviews what was recorded (data.maturity.review)
const READER = 5; // reads (data.maturity.read and the resources)
const NOBODY = 6; // no right over the maturity
const DUAL = 7; // may manage, publish, assess and review: the separation of duties holds for them
const UNIT_MANAGER = 8; // manages on one unit subtree only
const B_MANAGER = 9; // of tenant B
const OWNER = 10; // owns the milestones
const AUDITOR = 11; // reads the evidence of every assessment (audit.read)

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const CODES: Record<string, string> = { GOVERNANCE: 'GOV', METADATA: 'META', QUALITY: 'QUAL', INTEGRATION: 'INTEG', SECURITY: 'SEC', LINEAGE_BI: 'LIN', AI_READINESS: 'AI', VALUE_COST: 'VAL' };
const LEVELS = { 1: 'ad hoc', 2: 'repeatable', 3: 'defined', 4: 'managed', 5: 'optimised' };
const pillars = (weights: number[] = MATURITY_PILLARS.map(() => 12.5)) =>
  MATURITY_PILLARS.map((pillar, index) => ({
    code: pillar,
    name: `Pillar ${pillar}`,
    weight: weights[index],
    criteria: [1, 2, 3].map((n) => ({ code: `${CODES[pillar]}-${n}`, name: `Criterion ${CODES[pillar]}-${n}`, weight: 10, levels: LEVELS, refs: [] })),
  }));
const ALL = MATURITY_PILLARS.flatMap((pillar) => [1, 2, 3].map((n) => ({ pillar, criterion: `${CODES[pillar]}-${n}` })));
const TEST_EVIDENCE = [{ kind: 'TEST', ref: 'run-2026-10-30', note: 'the run that was read' }];

class Counters implements MetricsSink {
  readonly counters = new Map<string, number>();
  increment(name: string, labels?: Record<string, string>): void {
    const key =
      labels === undefined
        ? name
        : `${name}{${Object.entries(labels)
            .map(([k, v]) => `${k}=${v}`)
            .join(',')}}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }
  gauge(): void {
    return undefined;
  }
}

describe('the maturity of data governance: rubric, assessment, evidence, score, roadmap (ST-DGV-008, DGV 3.1 F8, DGV-16, DGV-17, DGV-21, UAT-AC53, UAT-AC492 to UAT-AC494)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let sequence = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const asApp = (member: number, sql: string, params: unknown[] = []): Promise<unknown> =>
    harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, (tx) => tx.query(sql, params));
  const events = (type: string, aggregateId?: string) =>
    rows<{
      payload: Record<string, unknown>;
      aggregate_id: string;
    }>('select payload, aggregate_id from machvon.outbox_event where type = $1 and ($2::uuid is null or aggregate_id = $2::uuid) order by created_at', [type, aggregateId ?? null]);
  const audits = (action: string) =>
    rows<{ resource_id: string; safe_diff: Record<string, unknown> }>('select resource_id, safe_diff from machvon.audit_event where action = $1 order by occurred_at', [action]);

  const rubricBody = (code: string, over: Record<string, unknown> = {}) => ({
    rubric_code: code,
    framework_refs: { DCAM: ['1.1', '2.3'], DMM: ['DM-4'] },
    pillars_json: { pillars: pillars() },
    min_coverage_pct: '70',
    evidence_ttl_days: 365,
    ...over,
  });
  const draftRubric = (member: number, code: string, over: Record<string, unknown> = {}): Promise<Reply> => call('POST', '/dgv/maturity-rubrics', { member, body: rubricBody(code, over) });
  const publishRubric = (member: number, id: string, version = 1): Promise<Reply> => call('POST', `/dgv/maturity-rubrics/${id}/publish`, { member, body: {}, ifMatch: `"${version}"` });
  const startAssessment = (member: number, rubricId: string, period: string, over: Record<string, unknown> = {}): Promise<Reply> =>
    call('POST', '/dgv/maturity-assessments', {
      member,
      body: { period_code: period, rubric_version_id: rubricId, scope_kind: 'TENANT', assessor_user_id: memberId(ASSESSOR), reviewer_id: memberId(REVIEWER), ...over },
    });
  const evidenceOf = async (assessmentId: string): Promise<Array<{ id: string; pillar_code: string; criterion_code: string; version: number; assessment_state: string; review_status: string }>> =>
    (await call('GET', `/resources/maturity_evidence?assessment_id=${assessmentId}&limit=200`, { member: READER })).json.items as Array<{ id: string; pillar_code: string; criterion_code: string; version: number; assessment_state: string; review_status: string }>;
  const record = (member: number, assessmentId: string, row: { version: number }, body: Record<string, unknown>): Promise<Reply> =>
    call('POST', `/dgv/maturity-assessments/${assessmentId}/evidence`, { member, body, ifMatch: `"${row.version}"` });
  const review = (member: number, evidenceId: string, version: number, decision = 'ACCEPTED', note = 'Read the evidence and agreed.'): Promise<Reply> =>
    call('POST', `/dgv/maturity-evidence/${evidenceId}/review`, { member, body: { decision, note }, ifMatch: `"${version}"` });
  const decide = (member: number, assessmentId: string, version: number, decision = 'approve'): Promise<Reply> =>
    call('POST', `/maturity-assessments/${assessmentId}/publish`, { member, body: { decision, reason: 'The assessment was read and agreed.', evidence_ids: [] }, ifMatch: `"${version}"` });
  const score = (assessmentId: string, member = READER): Promise<Reply> => call('GET', `/dgv/maturity-assessments/${assessmentId}/score`, { member });
  const assessmentOf = async (assessmentId: string) => (await call('GET', `/resources/maturity_assessment/${assessmentId}`, { member: READER })).json;

  const milestone = (member: number, rubric: string, over: Record<string, unknown> = {}): Promise<Reply> =>
    call('POST', '/dgv/maturity-milestones', {
      member,
      body: {
        rubric_version_id: rubric,
        pillar_code: 'QUALITY',
        target_level: 3,
        due_on: '2030-12-31',
        owner_user_id: memberId(OWNER),
        exit_criteria: 'The quality score of the tenant is published',
        evidence_required: ['a published scorecard'],
        ...over,
      },
    });
  async function publishedRubric(code = `RB-${(sequence += 1)}`): Promise<string> {
    const drafted = await draftRubric(MANAGER, code);
    expect(drafted.status).toBe(200);
    const published = await publishRubric(PUBLISHER, asString(drafted.json.resource_id));
    expect([published.status, published.json.status]).toEqual([200, 'PUBLISHED']);
    return asString(drafted.json.resource_id);
  }

  /** Records a criterion by the assessor and has it accepted by the reviewer. */
  async function assess(assessmentId: string, row: { id: string; version: number; pillar_code: string; criterion_code: string }, level: number, expiresOn?: string): Promise<void> {
    const recorded = await record(ASSESSOR, assessmentId, row, {
      pillar_code: row.pillar_code,
      criterion_code: row.criterion_code,
      assessment_state: 'ASSESSED',
      level,
      evidence_refs: TEST_EVIDENCE,
      ...(expiresOn === undefined ? {} : { evidence_expires_on: expiresOn }),
    });
    expect(recorded.status).toBe(200);
    expect((await review(REVIEWER, row.id, asNumber(recorded.json.resource_version))).status).toBe(200);
  }

  async function markNotApplicable(assessmentId: string, row: { id: string; version: number; pillar_code: string; criterion_code: string }): Promise<void> {
    const recorded = await record(ASSESSOR, assessmentId, row, {
      pillar_code: row.pillar_code,
      criterion_code: row.criterion_code,
      assessment_state: 'NOT_APPLICABLE',
      na_reason: 'The platform keeps no such data for this scope.',
      evidence_refs: [],
    });
    expect(recorded.status).toBe(200);
    expect((await review(REVIEWER, row.id, asNumber(recorded.json.resource_version))).status).toBe(200);
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
    for (const n of [MANAGER, PUBLISHER, ASSESSOR, REVIEWER, READER, NOBODY, DUAL, UNIT_MANAGER, OWNER, AUDITOR]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, B_MANAGER, 1);
    const read = ['data.maturity.read', 'maturity_assessment.read', 'maturity_evidence.read'];
    await harness.seedRole(TENANT_A, 1, 'MATURITY_MANAGER', ['data.maturity.manage', ...read], 30);
    await harness.seedRole(TENANT_A, 2, 'MATURITY_PUBLISHER', ['data.maturity.publish', ...read], 40);
    await harness.seedRole(TENANT_A, 3, 'MATURITY_ASSESSOR', ['data.maturity.assess', ...read], 20);
    await harness.seedRole(TENANT_A, 4, 'MATURITY_REVIEWER', ['data.maturity.review', ...read], 20);
    await harness.seedRole(TENANT_A, 5, 'MATURITY_READER', read, 10);
    await harness.seedRole(TENANT_A, 6, 'MATURITY_DUAL', ['data.maturity.manage', 'data.maturity.publish', 'data.maturity.assess', 'data.maturity.review', ...read], 40);
    await harness.seedRole(TENANT_A, 7, 'AUDITOR', ['audit.read', 'maturity_evidence.read'], 25);
    await harness.seedRole(TENANT_B, 1, 'MATURITY_MANAGER', ['data.maturity.manage', ...read], 30);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MANAGER, role: 1, kind: 'TENANT' },
      { n: 2, member: PUBLISHER, role: 2, kind: 'TENANT' },
      { n: 3, member: ASSESSOR, role: 3, kind: 'TENANT' },
      { n: 4, member: REVIEWER, role: 4, kind: 'TENANT' },
      { n: 5, member: READER, role: 5, kind: 'TENANT' },
      { n: 6, member: DUAL, role: 6, kind: 'TENANT' },
      { n: 7, member: UNIT_MANAGER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(1)] },
      { n: 11, member: AUDITOR, role: 7, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_MANAGER, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [DgvMaturityCommandsController, DgvMaturityReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module of DGV', () => {
    for (const controller of [DgvMaturityCommandsController, DgvMaturityReadsController]) expect(dgvModule.controllers).toContain(controller);
  });

  describe('the rubric (UAT-AC493)', () => {
    it('refuses weights of the pillars that add up to 90 (422 RUBRIC_WEIGHTS_INVALID), then is drafted, published by somebody else, and supersedes the version before it', async () => {
      const bad = await draftRubric(MANAGER, 'RB-W', { pillars_json: { pillars: pillars([12.5, 12.5, 12.5, 12.5, 12.5, 12.5, 12.5, 2.5]) } });
      expect([bad.status, bad.json.code, bad.json.detail]).toEqual([422, 'RUBRIC_WEIGHTS_INVALID', 'pillars_json.pillars']);
      const first = await draftRubric(MANAGER, 'RB-W');
      expect([first.status, first.json.status, first.json.resource_version]).toEqual([200, 'DRAFT', 1]);
      // Not by the person who drafted it, whatever else they may do.
      expect(await publishRubric(DUAL, asString((await draftRubric(DUAL, 'RB-W-DUAL')).json.resource_id))).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect((await publishRubric(PUBLISHER, asString(first.json.resource_id), 7)).json.code).toBe('VERSION_CONFLICT');
      const published = await publishRubric(PUBLISHER, asString(first.json.resource_id));
      expect([published.status, published.json.status, published.json.resource_version]).toEqual([200, 'PUBLISHED', 2]);
      expect((await publishRubric(PUBLISHER, asString(first.json.resource_id), 2)).json.code).toBe('STAGE_TRANSITION_DENIED');
      const stored = await call('GET', `/dgv/maturity-rubrics?rubric_code=RB-W`, { member: READER });
      const revision1 = asObject(asObjects(stored.json.items).find((item) => item.id === first.json.resource_id));
      expect(revision1).toMatchObject({
        rubric_code: 'RB-W',
        revision: 1,
        status: 'PUBLISHED',
        min_coverage_pct: '70.00',
        evidence_ttl_days: 365,
        framework_refs: { DCAM: ['1.1', '2.3'], DMM: ['DM-4'] },
      });
      expect(asList(revision1.pillars)).toHaveLength(8);
      expect(asObjects(revision1.pillars)[0]).toMatchObject({
        code: 'GOVERNANCE',
        weight: '12.50',
        criteria: [{ code: 'GOV-1', weight: '10.00', levels: { 1: 'ad hoc', 5: 'optimised' } }, expect.anything(), expect.anything()],
      });
      expect(asObject(revision1.approved_by).membership_id).toBe(memberId(PUBLISHER));
      // The next revision of the rubric supersedes it once it is published.
      const second = await draftRubric(MANAGER, 'RB-W', { min_coverage_pct: '80.5' });
      expect(second.json.resource_id).not.toBe(first.json.resource_id);
      expect((await publishRubric(PUBLISHER, asString(second.json.resource_id))).status).toBe(200);
      const both = (await call('GET', '/dgv/maturity-rubrics?rubric_code=RB-W', { member: READER })).json.items as Array<{ revision: number; status: string; min_coverage_pct: string }>;
      expect(both.map((item) => [item.revision, item.status, item.min_coverage_pct])).toEqual([
        [2, 'PUBLISHED', '80.50'],
        [1, 'SUPERSEDED', '70.00'],
      ]);
      expect((await events('dgv.rubric.drafted.v1', asString(first.json.resource_id)))[0]?.payload).toMatchObject({ rubric_code: 'RB-W', revision: 1 });
      expect((await events('dgv.rubric.published.v1', asString(second.json.resource_id)))[0]?.payload).toMatchObject({ revision: 2, superseded_id: first.json.resource_id });
      expect((await audits('dgv.maturity_rubric_published')).some((entry) => entry.resource_id === second.json.resource_id && entry.safe_diff.superseded_id === first.json.resource_id)).toBe(true);
    });

    it.each([
      ['a code with a bad shape', { rubric_code: 'bad code' }, 'VALIDATION_FAILED', 'rubric_code'],
      ['seven pillars', { pillars_json: { pillars: pillars().slice(1) } }, 'VALIDATION_FAILED', 'pillars_json.pillars'],
      ['a share of coverage that is none', { min_coverage_pct: '0' }, 'VALIDATION_FAILED', 'min_coverage_pct'],
      ['days of evidence that are none', { evidence_ttl_days: 0 }, 'VALIDATION_FAILED', 'evidence_ttl_days'],
      [
        'a pillar with two criteria',
        { pillars_json: { pillars: pillars().map((pillar, index) => (index === 0 ? { ...pillar, criteria: pillar.criteria.slice(1) } : pillar)) } },
        'VALIDATION_FAILED',
        'pillars_json.pillars[0].criteria',
      ],
    ])('refuses a draft with %s', async (_name, over, code, detail) => {
      const reply = await draftRubric(MANAGER, 'RB-BAD', over);
      expect([reply.status, reply.json.code, reply.json.detail]).toEqual([422, code, detail]);
    });

    it('is drafted and published only by those who may, over the whole tenant', async () => {
      expect((await draftRubric(NOBODY, 'RB-NO')).status).toBe(403);
      expect((await draftRubric(READER, 'RB-NO')).status).toBe(403);
      expect((await draftRubric(UNIT_MANAGER, 'RB-NO')).status).toBe(403);
      const drafted = await draftRubric(MANAGER, 'RB-WHO');
      expect((await publishRubric(MANAGER, asString(drafted.json.resource_id))).status).toBe(403);
      expect((await publishRubric(UNIT_MANAGER, asString(drafted.json.resource_id))).status).toBe(403);
      expect((await call('GET', '/dgv/maturity-rubrics', { member: NOBODY })).status).toBe(403);
      expect((await call('GET', '/dgv/maturity-rubrics', { member: UNIT_MANAGER })).status).toBe(403);
    });

    it('publishes two drafts of one rubric one after the other: the second waits for the first and replaces it', async () => {
      const code = `RB-RACE-${(sequence += 1)}`;
      const first = (await draftRubric(MANAGER, code)).json.resource_id as string;
      const second = (await draftRubric(MANAGER, code)).json.resource_id as string;
      let release!: () => void;
      let locked!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      // Another command holds the lock of the rubric and has not committed yet.
      const holding = harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(MANAGER), scopeVersion: 1 }, async (tx) => {
        await tx.query("select pg_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id', true) || ':maturity-rubric:' || $1, 0))", [code]);
        locked();
        await held;
      });
      await isLocked;
      let answered = false;
      const publishing = Promise.all([publishRubric(PUBLISHER, first), publishRubric(PUBLISHER, second)]).then((replies) => {
        answered = true;
        return replies;
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(answered).toBe(false);
      release();
      await holding;
      const replies = await publishing;
      expect(replies.map((reply) => reply.status)).toEqual([200, 200]);
      const stored = (await call('GET', `/dgv/maturity-rubrics?rubric_code=${code}`, { member: READER })).json.items as Array<{ status: string }>;
      expect(stored.map((item) => item.status).sort()).toEqual(['PUBLISHED', 'SUPERSEDED']);
    });

    it('is never changed or deleted once written, and the database refuses the same of anything else', async () => {
      const id = await publishedRubric();
      await expect(asApp(MANAGER, 'update machvon.maturity_rubric_version set pillars_json = \'{"pillars":[]}\'::jsonb where id = $1', [id])).rejects.toMatchObject({ code: '42501' });
      await expect(asApp(MANAGER, 'update machvon.maturity_rubric_version set min_coverage_pct = 10 where id = $1', [id])).rejects.toMatchObject({ code: '42501' });
      await expect(asApp(MANAGER, "update machvon.maturity_rubric_version set status = 'DRAFT' where id = $1", [id])).rejects.toMatchObject({ code: '42501' });
      await expect(asApp(MANAGER, 'delete from machvon.maturity_rubric_version where id = $1', [id])).rejects.toMatchObject({ code: '42501' });
      await expect(asApp(MANAGER, 'truncate machvon.maturity_rubric_version')).rejects.toMatchObject({ code: '42501' });
      const draft = (await draftRubric(MANAGER, 'RB-SOD')).json.resource_id;
      await expect(asApp(MANAGER, "update machvon.maturity_rubric_version set status = 'PUBLISHED', approved_by = created_by where id = $1", [draft])).rejects.toMatchObject({ code: '42501' });
    });

    it('lists the rubrics newest first, by code and by state, a page at a time', async () => {
      const code = `RB-PAGE-${(sequence += 1)}`;
      const ids: string[] = [];
      for (let n = 0; n < 3; n += 1) ids.push(asString((await draftRubric(MANAGER, code)).json.resource_id));
      const seen: string[] = [];
      let cursor = '';
      for (let page = 0; page < 5; page += 1) {
        const reply = await call('GET', `/dgv/maturity-rubrics?rubric_code=${code}&limit=1${cursor}`, { member: READER });
        seen.push(...asObjects(reply.json.items).map((item) => asString(item.id)));
        if (reply.json.next_cursor === null) break;
        cursor = `&cursor=${reply.json.next_cursor as string}`;
      }
      expect(seen).toEqual([...ids].reverse());
      expect((await call('GET', `/dgv/maturity-rubrics?rubric_code=${code}&status=PUBLISHED`, { member: READER })).json.items).toEqual([]);
      for (const query of ['?status=NEARLY', '?limit=0', '?limit=201', '?cursor=bad']) expect((await call('GET', `/dgv/maturity-rubrics${query}`, { member: READER })).status).toBe(422);
    });
  });

  describe('the assessment (UAT-AC53, UAT-AC492)', () => {
    it('starts with every criterion NOT_ASSESSED, for a rubric that is published, with an assessor and a reviewer who are two people', async () => {
      const draftOnly = (await draftRubric(MANAGER, `RB-DRAFT-${(sequence += 1)}`)).json.resource_id;
      expect(await startAssessment(MANAGER, asString(draftOnly), '2026-H2')).toMatchObject({ status: 422, json: { code: 'RUBRIC_NOT_PUBLISHED' } });
      const rubric = await publishedRubric();
      expect(await startAssessment(MANAGER, rubric, '2026-H2', { reviewer_id: memberId(ASSESSOR) })).toMatchObject({ status: 422, json: { code: 'ASSESSOR_IS_REVIEWER' } });
      const made = await startAssessment(MANAGER, rubric, '2026-H2');
      expect([made.status, made.json.status, made.json.resource_version]).toEqual([200, 'DRAFT', 1]);
      const assessment = await assessmentOf(asString(made.json.resource_id));
      expect(assessment).toMatchObject({
        period_code: '2026-H2',
        scope_kind: 'TENANT',
        scope_ref: null,
        status: 'DRAFT',
        coverage_percent: '0.00',
        overall_state: null,
        overall_level: null,
        assessor: { membership_id: memberId(ASSESSOR) },
        reviewer: { membership_id: memberId(REVIEWER) },
        rubric_version_id: rubric,
      });
      const items = await evidenceOf(asString(made.json.resource_id));
      expect(items).toHaveLength(24);
      expect(items.every((item) => item.assessment_state === 'NOT_ASSESSED' && item.review_status === 'PENDING')).toBe(true);
      expect((await events('dgv.assessment.created.v1', asString(made.json.resource_id)))[0]?.payload).toMatchObject({ period_code: '2026-H2', scope_kind: 'TENANT' });
      // One assessment for a rubric version, a scope and a period.
      expect(await startAssessment(MANAGER, rubric, '2026-H2')).toMatchObject({ status: 409, json: { code: 'DUPLICATE_KEY', detail: 'period_code' } });
    });

    it.each([
      ['a rubric that is none', { rubric_version_id: randomUUID() }, 'rubric_version_id'],
      ['a period that is too short', { period_code: 'H2' }, 'period_code'],
      ['a scope that is none', { scope_kind: 'GALAXY' }, 'scope_kind'],
      ['a scope of the tenant that names a reference', { scope_ref: 'X' }, 'scope_ref'],
      ['a domain with no reference', { scope_kind: 'DOMAIN' }, 'scope_ref'],
      ['a domain that no dataset has', { scope_kind: 'DOMAIN', scope_ref: 'NO-SUCH-DOMAIN' }, 'scope_ref'],
      ['a product that is none', { scope_kind: 'DATA_PRODUCT', scope_ref: 'NO-SUCH-PRODUCT' }, 'scope_ref'],
      ['an assessor who is no member', { assessor_user_id: randomUUID() }, 'assessor_user_id'],
      ['a reviewer who is no member', { reviewer_id: randomUUID() }, 'reviewer_id'],
    ])('refuses an assessment with %s', async (_name, over, detail) => {
      const rubric = await publishedRubric();
      const refused = await startAssessment(MANAGER, rubric, `PER-${(sequence += 1)}`, over);
      expect([refused.status, refused.json.detail]).toEqual([422, detail]);
    });

    it('is another tenant’s: its rubric and its people are unknown', async () => {
      const rubric = await publishedRubric();
      const reply = await call('POST', '/dgv/maturity-assessments', {
        member: B_MANAGER,
        tenantId: TENANT_B,
        body: { period_code: 'B-2026', rubric_version_id: rubric, scope_kind: 'TENANT', assessor_user_id: memberId(ASSESSOR), reviewer_id: memberId(REVIEWER) },
      });
      expect([reply.status, reply.json.detail]).toEqual([422, 'rubric_version_id']);
    });

    it('refuses the evidence that is missing or has run out, with the criterion NOT_ASSESSED still (UAT-AC492)', async () => {
      const rubric = await publishedRubric();
      const made = (await startAssessment(MANAGER, rubric, '2026-A1')).json.resource_id as string;
      const qual2 = (await evidenceOf(made)).find((item) => item.criterion_code === 'QUAL-2') as { id: string; version: number; pillar_code: string };
      const body = { pillar_code: 'QUALITY', criterion_code: 'QUAL-2', assessment_state: 'ASSESSED', level: 4 };
      expect(await record(ASSESSOR, made, qual2, { ...body, evidence_refs: [] })).toMatchObject({ status: 422, json: { code: 'EVIDENCE_REQUIRED' } });
      expect(await record(ASSESSOR, made, qual2, { ...body, evidence_refs: TEST_EVIDENCE, evidence_expires_on: '2026-06-30' })).toMatchObject({ status: 422, json: { code: 'EVIDENCE_EXPIRED' } });
      expect(await record(ASSESSOR, made, qual2, { ...body, level: 6, evidence_refs: TEST_EVIDENCE })).toMatchObject({ status: 422, json: { code: 'LEVEL_OUT_OF_RANGE' } });
      expect(await record(ASSESSOR, made, qual2, { pillar_code: 'QUALITY', criterion_code: 'QUAL-2', assessment_state: 'NOT_ASSESSED', level: 1, evidence_refs: [] })).toMatchObject({
        status: 422,
        json: { detail: 'level' },
      });
      expect((await evidenceOf(made)).find((item) => item.criterion_code === 'QUAL-2')).toMatchObject({ assessment_state: 'NOT_ASSESSED', version: qual2.version });
      expect((await assessmentOf(made)).status).toBe('DRAFT');
    });

    it('is recorded by its assessor only, against the version of the row that was read, and put in review by the first record', async () => {
      const rubric = await publishedRubric();
      const made = (await startAssessment(MANAGER, rubric, '2026-A2')).json.resource_id as string;
      const gov1 = (await evidenceOf(made)).find((item) => item.criterion_code === 'GOV-1') as { id: string; version: number; pillar_code: string };
      const body = { pillar_code: 'GOVERNANCE', criterion_code: 'GOV-1', assessment_state: 'ASSESSED', level: 3, evidence_refs: TEST_EVIDENCE, sample_size: 30, confidence: 'HIGH' };
      expect((await record(REVIEWER, made, gov1, body)).status).toBe(403);
      expect((await record(NOBODY, made, gov1, body)).status).toBe(403);
      expect((await record(DUAL, made, gov1, body)).json.code).toBe('SCOPE_DENIED');
      expect((await record(ASSESSOR, made, { version: 9 }, body)).json.code).toBe('VERSION_CONFLICT');
      expect(await record(ASSESSOR, made, gov1, { ...body, criterion_code: 'NOPE-1' })).toMatchObject({ status: 422, json: { detail: 'criterion_code' } });
      const done = await record(ASSESSOR, made, gov1, body);
      expect(done.json).toMatchObject({ status: 'ASSESSED', assessment_status: 'IN_REVIEW', resource_version: gov1.version + 1 });
      const row = (await call('GET', `/resources/maturity_evidence/${gov1.id}`, { member: ASSESSOR })).json;
      expect(row).toMatchObject({
        assessment_state: 'ASSESSED',
        level: 3,
        review_status: 'PENDING',
        sample_size: 30,
        confidence: 'HIGH',
        assessed_by: { membership_id: memberId(ASSESSOR) },
        evidence_refs: TEST_EVIDENCE,
        reviewer: null,
      });
      expect(row.evidence_expires_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect((await events('dgv.evidence.recorded.v1', gov1.id))[0]?.payload).toMatchObject({ criterion_code: 'GOV-1', assessment_state: 'ASSESSED', level: 3 });
      expect((await audits('dgv.maturity_evidence_recorded')).some((entry) => entry.resource_id === gov1.id && entry.safe_diff.evidence_count === 1 && entry.safe_diff.from === 'NOT_ASSESSED')).toBe(
        true,
      );
      // Recording again starts the review over; the assessor may say a criterion is NOT_ASSESSED again.
      const again = await record(ASSESSOR, made, { version: asNumber(done.json.resource_version) }, { pillar_code: 'GOVERNANCE', criterion_code: 'GOV-1', assessment_state: 'NOT_ASSESSED', evidence_refs: [] });
      expect([again.status, again.json.status]).toEqual([200, 'NOT_ASSESSED']);
    });

    it('is reviewed by the reviewer of the assessment and nobody else, never by who recorded it, and never when the evidence has run out (UAT-AC492)', async () => {
      const rubric = await publishedRubric();
      const made = (await startAssessment(MANAGER, rubric, '2026-A3')).json.resource_id as string;
      const row = (await evidenceOf(made)).find((item) => item.criterion_code === 'QUAL-2') as { id: string; version: number; pillar_code: string };
      expect((await review(REVIEWER, row.id, row.version)).json.code).toBe('STAGE_TRANSITION_DENIED');
      const recorded = await record(ASSESSOR, made, row, { pillar_code: 'QUALITY', criterion_code: 'QUAL-2', assessment_state: 'ASSESSED', level: 4, evidence_refs: TEST_EVIDENCE });
      const version = recorded.json.resource_version as number;
      // The assessor may not review their own record, and the reviewer of another assessment is not the reviewer of this one.
      expect((await review(ASSESSOR, row.id, version)).status).toBe(403);
      expect(await review(DUAL, row.id, version)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect((await review(NOBODY, row.id, version)).status).toBe(403);
      expect((await review(REVIEWER, row.id, version + 5)).json.code).toBe('VERSION_CONFLICT');
      expect((await review(REVIEWER, row.id, version, 'ACCEPTED', 'short')).json.detail).toBe('note');
      expect((await review(REVIEWER, row.id, version, 'MAYBE')).json.detail).toBe('decision');
      // The evidence runs out before the review.
      await rows("update machvon.maturity_evidence set evidence_expires_on = date '2020-01-01' where id = $1", [row.id]);
      expect(await review(REVIEWER, row.id, version)).toMatchObject({ status: 422, json: { code: 'EVIDENCE_EXPIRED' } });
      await rows('update machvon.maturity_evidence set evidence_expires_on = current_date + 30 where id = $1', [row.id]);
      const accepted = await review(REVIEWER, row.id, version, 'ACCEPTED', 'The run was read and the level agreed.');
      expect([accepted.status, accepted.json.status, accepted.json.resource_version]).toEqual([200, 'ACCEPTED', version + 1]);
      const reviewed = (await call('GET', `/resources/maturity_evidence/${row.id}`, { member: REVIEWER })).json;
      expect(reviewed).toMatchObject({ review_status: 'ACCEPTED', reviewer: { membership_id: memberId(REVIEWER) }, review_note: 'The run was read and the level agreed.' });
      expect((await events('dgv.evidence.reviewed.v1', row.id))[0]?.payload).toMatchObject({ decision: 'ACCEPTED', assessment_state: 'ASSESSED' });
      // A decision is on a record that waits: it is not on one that was decided.
      expect((await review(REVIEWER, row.id, version + 1)).json.code).toBe('STAGE_TRANSITION_DENIED');
    });

    it('is not reviewed or published by who assessed it, even by somebody who may do both (UAT-AC492)', async () => {
      const rubric = await publishedRubric();
      const made = (await startAssessment(MANAGER, rubric, '2026-SoD', { assessor_user_id: memberId(DUAL), reviewer_id: memberId(REVIEWER) })).json.resource_id as string;
      const row = (await evidenceOf(made)).find((item) => item.criterion_code === 'QUAL-2') as { id: string; version: number; pillar_code: string };
      const recorded = await record(DUAL, made, row, { pillar_code: 'QUALITY', criterion_code: 'QUAL-2', assessment_state: 'ASSESSED', level: 4, evidence_refs: TEST_EVIDENCE });
      expect(recorded.status).toBe(200);
      expect(await review(DUAL, row.id, asNumber(recorded.json.resource_version))).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect((await review(REVIEWER, row.id, asNumber(recorded.json.resource_version))).status).toBe(200);
      expect(await decide(DUAL, made, asNumber((await assessmentOf(made)).version))).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect((await assessmentOf(made)).status).toBe('IN_REVIEW');
      await expect(asApp(MANAGER, 'update machvon.maturity_evidence set reviewer_user_id = assessed_by where id = $1', [row.id])).rejects.toMatchObject({ code: '23514' });
    });

    it('shows what the evidence says to the assessor, the reviewer and the auditors only: to anybody else who may read the rows there is the criterion, its state and how many pieces of evidence there are', async () => {
      const rubric = await publishedRubric();
      const made = (await startAssessment(MANAGER, rubric, '2026-REDACT')).json.resource_id as string;
      const items = await evidenceOf(made);
      const na = items[1] as { id: string; version: number; pillar_code: string; criterion_code: string };
      await markNotApplicable(made, na);
      const row = items[0] as { id: string; version: number; pillar_code: string; criterion_code: string };
      await assess(made, row, 4);
      const seen = async (member: number) => (await call('GET', `/resources/maturity_evidence/${row.id}`, { member })).json;
      for (const member of [ASSESSOR, REVIEWER, AUDITOR]) {
        expect(await seen(member)).toMatchObject({ evidence_refs: TEST_EVIDENCE, evidence_count: 1, evidence_redacted: false, review_note: 'Read the evidence and agreed.' });
      }
      for (const member of [READER, DUAL, PUBLISHER]) {
        const redacted = await seen(member);
        expect(redacted).toMatchObject({ evidence_refs: [], evidence_count: 1, evidence_redacted: true, review_note: null, assessment_state: 'ASSESSED', level: 4, review_status: 'ACCEPTED' });
        expect(JSON.stringify(redacted)).not.toContain('run-2026-10-30');
      }
      // The list is redacted the same way, and so is the reason a criterion does not apply.
      const listed = async (member: number) => (await call('GET', `/resources/maturity_evidence?assessment_id=${made}&limit=200`, { member })).json.items as Array<Record<string, unknown>>;
      const open = (await listed(READER)).find((item) => item.id === na.id) as Record<string, unknown>;
      expect(open).toMatchObject({ na_reason: null, evidence_redacted: true });
      expect((await listed(READER)).every((item) => asList(item.evidence_refs).length === 0 && item.review_note === null && item.na_reason === null)).toBe(true);
      expect((await listed(AUDITOR)).find((item) => item.id === na.id)).toMatchObject({ na_reason: 'The platform keeps no such data for this scope.', evidence_redacted: false });
      expect((await listed(REVIEWER)).find((item) => item.id === row.id)?.evidence_refs).toEqual(TEST_EVIDENCE);
    });

    it('turns a rejected record back to NOT_ASSESSED, with no level', async () => {
      const rubric = await publishedRubric();
      const made = (await startAssessment(MANAGER, rubric, '2026-A4')).json.resource_id as string;
      const row = (await evidenceOf(made)).find((item) => item.criterion_code === 'SEC-1') as { id: string; version: number; pillar_code: string };
      const recorded = await record(ASSESSOR, made, row, { pillar_code: 'SECURITY', criterion_code: 'SEC-1', assessment_state: 'ASSESSED', level: 5, evidence_refs: TEST_EVIDENCE });
      const rejected = await review(REVIEWER, row.id, asNumber(recorded.json.resource_version), 'REJECTED', 'The run does not show what is claimed.');
      expect([rejected.status, rejected.json.status]).toEqual([200, 'REJECTED']);
      expect((await call('GET', `/resources/maturity_evidence/${row.id}`, { member: READER })).json).toMatchObject({ assessment_state: 'NOT_ASSESSED', level: null, review_status: 'REJECTED' });
      expect(asObjects((await score(made)).json.criteria).find((criterion) => criterion.criterion_code === 'SEC-1')).toMatchObject({ state: 'NOT_ASSESSED', level: null });
    });

    it('scores 14 of 22 criteria as no total, and 17 of 22 as a total over the criteria that are assessed (UAT-AC53)', async () => {
      const rubric = await publishedRubric();
      const made = (await startAssessment(MANAGER, rubric, '2026-H2')).json.resource_id as string;
      const byKey = new Map((await evidenceOf(made)).map((item) => [item.criterion_code, item]));
      const row = (index: number) => byKey.get((ALL[index] as { criterion: string }).criterion) as { id: string; version: number; pillar_code: string; criterion_code: string };
      const levelOf = (index: number) => 2 + (index % 3);
      for (let index = 0; index < 14; index += 1) await assess(made, row(index), levelOf(index));
      await markNotApplicable(made, row(22));
      await markNotApplicable(made, row(23));
      const before = await score(made);
      expect(before.status).toBe(200);
      expect(before.json).toMatchObject({
        assessment_id: made,
        status: 'IN_REVIEW',
        coverage_percent: '63.64',
        min_coverage_pct: '70.00',
        overall_state: 'NOT_COMPUTED',
        assessed_count: 14,
        not_assessed_count: 8,
        not_applicable_count: 2,
      });
      expect('overall_level' in before.json).toBe(false);
      // The pillars with nothing assessed are NOT_ASSESSED, not a 0 and not a 1.
      const empty = asObjects(before.json.pillars).filter((pillar) => pillar.state === 'NOT_ASSESSED');
      expect(empty.length).toBeGreaterThan(0);
      expect(empty.every((pillar) => pillar.level === null && pillar.assessed_count === 0)).toBe(true);
      // Three more are accepted.
      for (let index = 14; index < 17; index += 1) await assess(made, row(index), levelOf(index));
      const after = await score(made);
      expect(after.json).toMatchObject({ coverage_percent: '77.27', overall_state: 'COMPUTED', assessed_count: 17, not_assessed_count: 5, not_applicable_count: 2 });
      // The total is the average of the pillars over their assessed criteria: pillar weights are equal, so it is the mean of the pillar levels.
      const levels = asObjects(after.json.pillars).filter((pillar) => pillar.level !== null).map((pillar) => Number(pillar.level));
      const mean = levels.reduce((sum: number, level: number) => sum + level, 0) / levels.length;
      expect(Math.abs(Number(after.json.overall_level) - mean)).toBeLessThan(0.006);
      expect(after.json.criteria).toHaveLength(24);
      expect(asObjects(after.json.criteria).filter((criterion) => criterion.state === 'ASSESSED')).toHaveLength(17);
    });

    it('is published by somebody other than its assessor with the score it has, and then never changes (UAT-AC492)', async () => {
      const rubric = await publishedRubric();
      const made = (await startAssessment(MANAGER, rubric, '2026-H3')).json.resource_id as string;
      const items = await evidenceOf(made);
      const first = items[0] as { id: string; version: number; pillar_code: string; criterion_code: string };
      // Nothing recorded: nothing to publish.
      expect((await decide(PUBLISHER, made, 1)).json.code).toBe('STAGE_TRANSITION_DENIED');
      await assess(made, first, 4);
      const version = (await assessmentOf(made)).version as number;
      expect(await decide(ASSESSOR, made, version)).toMatchObject({ status: 403 });
      expect((await decide(NOBODY, made, version)).status).toBe(403);
      expect((await decide(PUBLISHER, made, version + 5)).json.code).toBe('VERSION_CONFLICT');
      const bad = await call('POST', `/maturity-assessments/${made}/publish`, { member: PUBLISHER, body: { decision: 'maybe', reason: 'x', evidence_ids: [] }, ifMatch: `"${version}"` });
      expect(bad.json.detail).toBe('decision');
      const empty = await call('POST', `/maturity-assessments/${made}/publish`, { member: PUBLISHER, body: { decision: 'approve', reason: '  ', evidence_ids: [] }, ifMatch: `"${version}"` });
      expect(empty.json.detail).toBe('reason');
      const done = await decide(PUBLISHER, made, version);
      expect(done.json).toMatchObject({ status: 'PUBLISHED', coverage_percent: '4.17', overall_state: 'NOT_COMPUTED' });
      expect(done.json.overall_level).toBeUndefined();
      expect(await assessmentOf(made)).toMatchObject({
        status: 'PUBLISHED',
        coverage_percent: '4.17',
        overall_state: 'NOT_COMPUTED',
        overall_level: null,
        published_by: { membership_id: memberId(PUBLISHER) },
      });
      expect((await events('dgv.assessment.published.v1', made))[0]?.payload).toMatchObject({ coverage_percent: '4.17', overall_state: 'NOT_COMPUTED' });
      expect((await audits('dgv.maturity_assessment_published')).some((entry) => entry.resource_id === made)).toBe(true);
      // Nothing under a published assessment changes: not through the API, not in the database.
      const second = items[1] as { id: string; version: number; pillar_code: string; criterion_code: string };
      expect((await record(ASSESSOR, made, second, { pillar_code: second.pillar_code, criterion_code: second.criterion_code, assessment_state: 'NOT_ASSESSED', evidence_refs: [] })).json.code).toBe(
        'STAGE_TRANSITION_DENIED',
      );
      expect((await decide(PUBLISHER, made, asNumber(done.json.resource_version))).json.code).toBe('STAGE_TRANSITION_DENIED');
      await expect(asApp(MANAGER, 'update machvon.maturity_assessment set overall_level = 5 where id = $1', [made])).rejects.toMatchObject({ code: '42501' });
      await expect(asApp(MANAGER, 'update machvon.maturity_evidence set level = 5 where id = $1', [first.id])).rejects.toMatchObject({ code: '42501' });
      await expect(asApp(MANAGER, 'delete from machvon.maturity_evidence where id = $1', [first.id])).rejects.toMatchObject({ code: '42501' });
      // The score it was published with does not move when the evidence runs out afterwards: it was published three days ago and the evidence ran out two days ago.
      const published = await score(made);
      expect(published.json).toMatchObject({ status: 'PUBLISHED', assessed_count: 1 });
      await rows("update machvon.maturity_assessment set published_at = now() - interval '3 days' where id = $1", [made]);
      await rows('update machvon.maturity_evidence set evidence_expires_on = current_date - 2 where id = $1', [first.id]);
      const later = await score(made);
      expect(later.json).toMatchObject({ status: 'PUBLISHED', assessed_count: 1, coverage_percent: '4.17' });
      expect(asObjects(later.json.criteria).find((criterion) => criterion.criterion_code === first.criterion_code)).toMatchObject({ state: 'ASSESSED', level: 4 });
    });

    it('refuses a decision made on the score as it was once the evidence under it has changed, so that nobody publishes a score they did not read', async () => {
      const rubric = await publishedRubric();
      const made = (await startAssessment(MANAGER, rubric, '2026-STALE')).json.resource_id as string;
      const items = await evidenceOf(made);
      await assess(made, items[0] as never, 4);
      const read = (await assessmentOf(made)).version as number;
      // The assessor records another criterion after the publisher read the assessment ...
      const second = items[1] as { id: string; version: number; pillar_code: string; criterion_code: string };
      const recorded = await record(ASSESSOR, made, second, {
        pillar_code: second.pillar_code,
        criterion_code: second.criterion_code,
        assessment_state: 'ASSESSED',
        level: 2,
        evidence_refs: TEST_EVIDENCE,
      });
      expect(recorded.json.assessment_version).toBeGreaterThan(read);
      expect(await decide(PUBLISHER, made, read)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      // ... and a review changes what the score stands on as well.
      const afterRecord = (await assessmentOf(made)).version as number;
      expect((await review(REVIEWER, second.id, asNumber(recorded.json.resource_version))).status).toBe(200);
      expect((await assessmentOf(made)).version).toBeGreaterThan(afterRecord);
      expect((await decide(PUBLISHER, made, afterRecord)).json.code).toBe('VERSION_CONFLICT');
      expect((await decide(PUBLISHER, made, asNumber((await assessmentOf(made)).version))).status).toBe(200);
    });

    it('is returned to the assessor or rejected, by somebody other than the assessor', async () => {
      const rubric = await publishedRubric();
      const made = (await startAssessment(MANAGER, rubric, '2026-H4')).json.resource_id as string;
      const first = (await evidenceOf(made))[0] as { id: string; version: number; pillar_code: string; criterion_code: string };
      await assess(made, first, 3);
      const version = (await assessmentOf(made)).version as number;
      const returned = await decide(PUBLISHER, made, version, 'return');
      expect([returned.status, returned.json.status]).toEqual([200, 'DRAFT']);
      expect((await audits('dgv.maturity_assessment_returned')).some((entry) => entry.resource_id === made)).toBe(true);
      // Recorded again, it is in review again; the reviewer rejects the whole assessment.
      const row = (await evidenceOf(made))[1] as { id: string; version: number; pillar_code: string; criterion_code: string };
      await assess(made, row, 2);
      const rejected = await decide(PUBLISHER, made, asNumber((await assessmentOf(made)).version), 'reject');
      expect([rejected.status, rejected.json.status]).toEqual([200, 'REJECTED']);
      expect((await events('dgv.assessment.published.v1', made)).length).toBe(0);
      // A rejected assessment frees its period for another.
      expect((await startAssessment(MANAGER, rubric, '2026-H4')).status).toBe(200);
    });

    it('lists the assessments and their evidence by state and by assessment, a page at a time, to those who may read', async () => {
      const rubric = await publishedRubric();
      const made = (await startAssessment(MANAGER, rubric, `LIST-${(sequence += 1)}`)).json.resource_id as string;
      expect(asObjects((await call('GET', `/resources/maturity_assessment?rubric_version_id=${rubric}&status=DRAFT`, { member: READER })).json.items).map((item) => item.id)).toEqual([made]);
      expect((await call('GET', `/resources/maturity_assessment?rubric_version_id=${rubric}&status=PUBLISHED`, { member: READER })).json.items).toEqual([]);
      const seen: string[] = [];
      let cursor = '';
      for (let page = 0; page < 30; page += 1) {
        const reply = await call('GET', `/resources/maturity_evidence?assessment_id=${made}&limit=5${cursor}`, { member: READER });
        seen.push(...asObjects(reply.json.items).map((item) => asString(item.id)));
        if (reply.json.next_cursor === null) break;
        cursor = `&cursor=${reply.json.next_cursor as string}`;
      }
      expect(new Set(seen).size).toBe(24);
      for (const query of ['?status=NEARLY', '?rubric_version_id=x', '?limit=0', '?cursor=bad'])
        expect((await call('GET', `/resources/maturity_assessment${query}`, { member: READER })).status).toBe(422);
      expect((await call('GET', `/resources/maturity_evidence?assessment_id=x`, { member: READER })).status).toBe(422);
      for (const member of [NOBODY, UNIT_MANAGER]) {
        expect((await call('GET', '/resources/maturity_assessment', { member })).status).toBe(403);
        expect((await call('GET', '/resources/maturity_evidence', { member })).status).toBe(403);
        expect((await score(made, member)).status).toBe(403);
      }
      expect((await score(randomUUID())).status).toBe(404);
      expect((await call('GET', `/resources/maturity_assessment/${randomUUID()}`, { member: READER })).status).toBe(404);
      expect((await call('GET', `/resources/maturity_evidence/${randomUUID()}`, { member: READER })).status).toBe(404);
      // Another tenant sees none of it.
      expect((await call('GET', `/resources/maturity_assessment/${made}`, { member: B_MANAGER, tenantId: TENANT_B })).status).toBe(404);
      expect((await call('GET', `/dgv/maturity-assessments/${made}/score`, { member: B_MANAGER, tenantId: TENANT_B })).status).toBe(404);
    });
  });

  describe('the evidence that runs out (UAT-AC492)', () => {
    it('becomes NOT_ASSESSED on an assessment still being worked on, once, and its assessor is told which criteria need new evidence', async () => {
      const rubric = await publishedRubric();
      const made = (await startAssessment(MANAGER, rubric, '2026-E1')).json.resource_id as string;
      const items = await evidenceOf(made);
      await assess(made, items[0] as never, 4);
      await assess(made, items[1] as never, 3);
      await assess(made, items[2] as never, 2);
      await rows("update machvon.maturity_evidence set evidence_expires_on = date '2020-01-01' where id = any($1::uuid[])", [[(items[0] as { id: string }).id, (items[1] as { id: string }).id]]);
      const run = () =>
        harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, (tx) =>
          new DgvMaturityJob(new AuditWriter(harness.tenants as TenantDatabase)).run(tx, WORKER_MEMBERSHIP_ID, new Date()),
        );
      // The score does not wait for the job: what has run out does not count.
      expect((await score(made)).json).toMatchObject({ assessed_count: 1 });
      const summary = await run();
      expect(summary.evidenceExpired).toBeGreaterThanOrEqual(2);
      const after = await evidenceOf(made);
      expect(after.filter((item) => item.review_status === 'EXPIRED' && item.assessment_state === 'NOT_ASSESSED')).toHaveLength(2);
      expect(after.find((item) => item.id === (items[2] as { id: string }).id)).toMatchObject({ assessment_state: 'ASSESSED', review_status: 'ACCEPTED' });
      const told = (await events('dgv.evidence.expired.v1', made))[0]?.payload;
      expect(told).toMatchObject({
        period_code: '2026-E1',
        criteria: [(items[0] as { criterion_code: string }).criterion_code, (items[1] as { criterion_code: string }).criterion_code].sort(),
        notification: { recipients: [memberId(ASSESSOR)] },
      });
      expect((await audits('dgv.maturity_evidence_expired')).some((entry) => entry.resource_id === made && entry.safe_diff.expired === 2)).toBe(true);
      // Once: the pass again announces nothing for it.
      await run();
      expect((await events('dgv.evidence.expired.v1', made)).length).toBe(1);
      // The version of the assessment moves with the evidence, so that a decision on the score as it was is refused.
      expect((await assessmentOf(made)).version).toBeGreaterThan(2);
      // A published assessment keeps what it was published with.
      const published = (await startAssessment(MANAGER, rubric, '2026-E2')).json.resource_id as string;
      const row = (await evidenceOf(published))[0] as { id: string; version: number; pillar_code: string; criterion_code: string };
      await assess(published, row, 5);
      expect((await decide(PUBLISHER, published, asNumber((await assessmentOf(published)).version))).status).toBe(200);
      await rows("update machvon.maturity_evidence set evidence_expires_on = date '2020-01-01' where id = $1", [row.id]);
      await run();
      expect((await evidenceOf(published)).find((item) => item.id === row.id)).toMatchObject({ assessment_state: 'ASSESSED', review_status: 'ACCEPTED' });
    });
  });

  describe('the notifications of the sweep', () => {
    it('reach the assessor whose evidence ran out and the owner of a milestone that was missed through the notification service, and nobody who may not read what they are about', async () => {
      const tenants = harness.tenants as TenantDatabase;
      const types = ['dgv.evidence.expired.v1', 'dgv.maturity.milestone_missed.v1'];
      const definitions = new Map<string, EventTypeDefinition>();
      for (const type of types) {
        const row = (
          await rows<{ payload_schema: unknown; allowed_purposes: string[]; status: 'Active' | 'Deprecated' }>(
            'select payload_schema, allowed_purposes, status from machvon.notification_event_type where event_type = $1 and schema_version = 1',
            [type],
          )
        )[0];
        if (row === undefined) throw new Error(`${type} is not registered by a migration`);
        definitions.set(type, { eventType: type, schemaVersion: 1, payloadSchema: row.payload_schema, allowedPurposes: row.allowed_purposes, status: row.status });
        await rows(
          `insert into machvon.workflow_version (tenant_id, id, business_type, revision, definition_json, status, kind, event_type, created_by, definition_hash)
           values ($1, $2, $6, 1, $3::jsonb, 'Published', 'NOTIFICATION', $4, $5, repeat('a', 64))`,
          [TENANT_A, randomUUID(), JSON.stringify({ resolver: { kind: 'explicit' }, priority: 'HIGH', purpose: 'OPERATIONAL' }), type, memberId(MANAGER), `NOTIFICATION_${types.indexOf(type) + 1}`],
        );
      }
      const catalog: EventTypeCatalog = { get: async (eventType, schemaVersion) => (schemaVersion === 1 ? definitions.get(eventType) : undefined) };
      const metrics = new Counters();
      const consumer = new NotificationConsumer({
        database: tenants,
        store: new NotificationStore(),
        validator: new PayloadValidator(catalog),
        loadAccess: (ctx) => new EffectiveAccessStore(tenants, new InMemoryAuthzCache()).load(ctx),
        resourceAccess: new PermissionResourceAccess(),
        security: { signingKey: SIGNING_KEY, alerts: { raise: () => undefined } },
        metrics,
      });
      const deliver = async (type: string, aggregateType: string, aggregateId: string): Promise<{ result: unknown; recipients: string[] }> => {
        const event = (
          await rows<{ id: string; payload: Record<string, unknown>; aggregate_version: string; event_key: string }>(
            'select id, payload, aggregate_version::text as aggregate_version, event_key from machvon.outbox_event where type = $1 and aggregate_id = $2::uuid',
            [type, aggregateId],
          )
        )[0];
        if (event === undefined) throw new Error('an event was expected');
        const delivery: OutboxDelivery = {
          id: event.id,
          tenantId: TENANT_A,
          tenantContext: signTenantContext({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, SIGNING_KEY),
          type,
          schemaVersion: 1,
          aggregateType,
          aggregateId,
          aggregateVersion: Number(event.aggregate_version),
          payload: event.payload,
          eventKey: event.event_key,
          correlationId: randomUUID(),
          attempts: 0,
        };
        const result = await consumer.handle(delivery);
        const found = await rows<{ recipient_id: string }>('select recipient_id from machvon.notification_instance where event_id = $1', [event.id]);
        return { result, recipients: found.map((item) => item.recipient_id) };
      };
      // The evidence of an assessment still being worked on runs out; two milestones pass their day, one owned by a reader of the maturity and one by nobody who may read it.
      const rubric = await publishedRubric();
      const made = (await startAssessment(MANAGER, rubric, '2026-NOTIFY')).json.resource_id as string;
      const first = (await evidenceOf(made))[0] as { id: string; version: number; pillar_code: string; criterion_code: string };
      await assess(made, first, 3);
      await rows("update machvon.maturity_evidence set evidence_expires_on = date '2020-01-01' where id = $1", [first.id]);
      const told = (await milestone(MANAGER, rubric, { owner_user_id: memberId(READER) })).json.resource_id as string;
      const unread = (await milestone(MANAGER, rubric, { owner_user_id: memberId(NOBODY) })).json.resource_id as string;
      await rows("update machvon.maturity_milestone set due_on = date '2020-01-01' where id = any($1::uuid[])", [[told, unread]]);
      await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, (tx) =>
        new DgvMaturityJob(new AuditWriter(tenants)).run(tx, WORKER_MEMBERSHIP_ID, new Date()),
      );
      expect(await deliver('dgv.evidence.expired.v1', 'maturity_assessment', made)).toEqual({ result: 'processed', recipients: [memberId(ASSESSOR)] });
      expect(await deliver('dgv.maturity.milestone_missed.v1', 'maturity_milestone', told)).toEqual({ result: 'processed', recipients: [memberId(READER)] });
      expect((await deliver('dgv.maturity.milestone_missed.v1', 'maturity_milestone', unread)).recipients).toEqual([]);
      expect(metrics.counters.get('notification_suppressed_total{reason=no_access}')).toBe(1);
    });
  });

  describe('the sweep and a decision that overlap', () => {
    it('leaves alone an assessment that is closed while the sweep waits for it', async () => {
      const rubric = await publishedRubric();
      const made = (await startAssessment(MANAGER, rubric, '2026-RACE')).json.resource_id as string;
      const first = (await evidenceOf(made))[0] as { id: string; version: number; pillar_code: string; criterion_code: string };
      await assess(made, first, 4);
      await rows("update machvon.maturity_evidence set evidence_expires_on = date '2020-01-01' where id = $1", [first.id]);
      let release!: () => void;
      let locked!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      // A decision holds the assessment and has not committed yet.
      const deciding = harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(PUBLISHER), scopeVersion: 1 }, async (tx) => {
        await tx.query('select 1 from machvon.maturity_assessment where id = $1::uuid for update', [made]);
        locked();
        await held;
        await tx.query("update machvon.maturity_assessment set status = 'REJECTED', version = version + 1 where id = $1::uuid", [made]);
      });
      await isLocked;
      const sweeping = harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, (tx) =>
        new DgvMaturityJob(new AuditWriter(harness.tenants as TenantDatabase)).run(tx, WORKER_MEMBERSHIP_ID, new Date()),
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      release();
      await deciding;
      await sweeping;
      expect((await evidenceOf(made)).find((item) => item.id === first.id)).toMatchObject({ assessment_state: 'ASSESSED', review_status: 'ACCEPTED' });
      expect((await events('dgv.evidence.expired.v1', made)).length).toBe(0);
    });
  });

  describe('the roadmap (UAT-AC494)', () => {
    const milestones = async (rubric: string) => (await call('GET', `/dgv/maturity-milestones?rubric_version_id=${rubric}`, { member: READER })).json.items as Array<Record<string, unknown>>;

    it('plans a milestone of a pillar of a published rubric, with a level to reach, an owner and the evidence it needs', async () => {
      const rubric = await publishedRubric();
      const made = await milestone(MANAGER, rubric);
      expect([made.status, made.json.status, made.json.resource_version]).toEqual([200, 'PLANNED', 1]);
      expect((await milestones(rubric))[0]).toMatchObject({
        id: made.json.resource_id,
        pillar_code: 'QUALITY',
        target_level: 3,
        due_on: '2030-12-31',
        status: 'PLANNED',
        owner: { membership_id: memberId(OWNER) },
        exit_criteria: 'The quality score of the tenant is published',
        evidence_required: ['a published scorecard'],
        achieved_assessment_id: null,
      });
      expect((await events('dgv.milestone.created.v1', asString(made.json.resource_id)))[0]?.payload).toMatchObject({ pillar_code: 'QUALITY', target_level: 3 });
      expect((await milestone(READER, rubric)).status).toBe(403);
      expect((await milestone(UNIT_MANAGER, rubric)).status).toBe(403);
      expect((await call('GET', '/dgv/maturity-milestones', { member: NOBODY })).status).toBe(403);
      const draftOnly = (await draftRubric(MANAGER, `RB-MS-${(sequence += 1)}`)).json.resource_id;
      expect((await milestone(MANAGER, asString(draftOnly))).json.code).toBe('RUBRIC_NOT_PUBLISHED');
    });

    it.each([
      ['a pillar that is none', { pillar_code: 'MONEY' }, 'pillar_code'],
      ['a level of 0', { target_level: 0 }, 'target_level'],
      ['a level of 6', { target_level: 6 }, 'target_level'],
      ['a last day in the past', { due_on: '2020-01-01' }, 'due_on'],
      ['criteria that are too short', { exit_criteria: 'done' }, 'exit_criteria'],
      ['an owner who is no member', { owner_user_id: randomUUID() }, 'owner_user_id'],
      ['a rubric that is none', { rubric_version_id: randomUUID() }, 'rubric_version_id'],
    ])('refuses a milestone with %s', async (_name, over, detail) => {
      const rubric = await publishedRubric();
      const reply = await milestone(MANAGER, rubric, over);
      expect([reply.status, reply.json.detail]).toEqual([422, detail]);
    });

    it('is achieved only by a published assessment of the whole tenant that reaches the level, never by a mark, and is MISSED when its day passes without one', async () => {
      const code = `RB-RM-${(sequence += 1)}`;
      const rubric = await publishedRubric(code);
      const reached = (await milestone(MANAGER, rubric, { pillar_code: 'QUALITY', target_level: 3 })).json.resource_id as string;
      const higher = (await milestone(MANAGER, rubric, { pillar_code: 'QUALITY', target_level: 5 })).json.resource_id as string;
      const other = (await milestone(MANAGER, rubric, { pillar_code: 'SECURITY', target_level: 2 })).json.resource_id as string;
      // A mark of the database is not enough: the milestone must name an assessment that is published.
      await expect(asApp(MANAGER, "update machvon.maturity_milestone set status = 'ACHIEVED' where id = $1", [reached])).rejects.toMatchObject({ code: expect.stringMatching(/^(23514|42501)$/) });
      // An assessment of a domain does not prove the roadmap of the tenant.
      await rows(
        "insert into machvon.dataset (tenant_id, id, dataset_code, title, domain, grain, producer_module, owner_user_id, steward_user_id, classification, is_critical, freshness_slo_seconds, status, created_by, updated_by) values ($1, $2, 'DS-MS', 'DS-MS', 'TREASURY', 'g', 'DIS', $3, $4, 'INTERNAL', false, 86400, 'DRAFT', $4, $4)",
        [TENANT_A, randomUUID(), memberId(OWNER), memberId(MANAGER)],
      );
      const domain = (await startAssessment(MANAGER, rubric, '2026-D1', { scope_kind: 'DOMAIN', scope_ref: 'TREASURY' })).json.resource_id as string;
      const domainRows = await evidenceOf(domain);
      for (const row of domainRows.filter((item) => item.pillar_code === 'QUALITY')) await assess(domain, row as never, 5);
      expect((await decide(PUBLISHER, domain, asNumber((await assessmentOf(domain)).version))).json.achieved_milestone_ids).toEqual([]);
      expect((await milestones(rubric)).every((item) => item.status === 'PLANNED')).toBe(true);
      // The assessment of the tenant reaches 3.00 in QUALITY (levels 3, 3, 3) and 2.00 in SECURITY (2, 2, 2).
      const tenant = (await startAssessment(MANAGER, rubric, '2026-T1')).json.resource_id as string;
      const tenantRows = await evidenceOf(tenant);
      for (const row of tenantRows.filter((item) => item.pillar_code === 'QUALITY')) await assess(tenant, row as never, 3);
      for (const row of tenantRows.filter((item) => item.pillar_code === 'SECURITY')) await assess(tenant, row as never, 2);
      const published = await decide(PUBLISHER, tenant, asNumber((await assessmentOf(tenant)).version));
      expect(asList(published.json.achieved_milestone_ids).sort()).toEqual([reached, other].sort());
      const after = await milestones(rubric);
      expect(after.find((item) => item.id === reached)).toMatchObject({ status: 'ACHIEVED', achieved_assessment_id: tenant });
      expect(after.find((item) => item.id === other)).toMatchObject({ status: 'ACHIEVED', achieved_assessment_id: tenant });
      expect(after.find((item) => item.id === higher)).toMatchObject({ status: 'PLANNED', achieved_assessment_id: null });
      // A level that the pillar has reached is not a target.
      expect(await milestone(MANAGER, rubric, { pillar_code: 'QUALITY', target_level: 3 })).toMatchObject({ status: 422, json: { code: 'TARGET_BELOW_CURRENT', detail: 'target_level' } });
      expect((await milestone(MANAGER, rubric, { pillar_code: 'QUALITY', target_level: 4 })).status).toBe(200);
      // The day goes by: the milestone that was not proved is MISSED, its owner is told, once; the one that was achieved stays so.
      await rows("update machvon.maturity_milestone set due_on = date '2020-01-01' where id = any($1::uuid[])", [[higher, reached]]);
      const run = () =>
        harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, (tx) =>
          new DgvMaturityJob(new AuditWriter(harness.tenants as TenantDatabase)).run(tx, WORKER_MEMBERSHIP_ID, new Date()),
        );
      const summary = await run();
      expect(summary.milestonesMissed).toBeGreaterThanOrEqual(1);
      const final = await milestones(rubric);
      expect(final.find((item) => item.id === higher)).toMatchObject({ status: 'MISSED' });
      expect(final.find((item) => item.id === reached)).toMatchObject({ status: 'ACHIEVED' });
      const told = (await events('dgv.maturity.milestone_missed.v1', higher))[0]?.payload;
      expect(told).toMatchObject({ pillar_code: 'QUALITY', target_level: 5, notification: { recipients: [memberId(OWNER)] } });
      await run();
      expect((await events('dgv.maturity.milestone_missed.v1', higher)).length).toBe(1);
      expect((await audits('dgv.maturity_milestone_missed')).some((entry) => entry.resource_id === higher)).toBe(true);
      // A final state is final.
      await expect(asApp(MANAGER, "update machvon.maturity_milestone set status = 'PLANNED' where id = $1", [higher])).rejects.toMatchObject({ code: '42501' });
      await expect(asApp(MANAGER, 'update machvon.maturity_milestone set target_level = 1 where id = $1', [reached])).rejects.toMatchObject({ code: '42501' });
      await expect(asApp(MANAGER, 'delete from machvon.maturity_milestone where id = $1', [reached])).rejects.toMatchObject({ code: '42501' });
    });

    it('does not achieve a milestone whose day is past when the assessment is published before the job has marked it, so that the deadline does not wait for the job', async () => {
      const rubric = await publishedRubric(`RB-LATE-${(sequence += 1)}`);
      const late = (await milestone(MANAGER, rubric, { pillar_code: 'QUALITY', target_level: 3 })).json.resource_id as string;
      const today = (await milestone(MANAGER, rubric, { pillar_code: 'QUALITY', target_level: 2 })).json.resource_id as string;
      await rows('update machvon.maturity_milestone set due_on = current_date - 1 where id = $1', [late]);
      await rows("update machvon.maturity_milestone set due_on = (now() at time zone 'Asia/Ho_Chi_Minh')::date where id = $1", [today]);
      const made = (await startAssessment(MANAGER, rubric, `LATE-${sequence}`)).json.resource_id as string;
      for (const row of (await evidenceOf(made)).filter((item) => item.pillar_code === 'QUALITY')) await assess(made, row as never, 4);
      const published = await decide(PUBLISHER, made, asNumber((await assessmentOf(made)).version));
      // The milestone due today is proved on its last day; the one past its day is not, and stays for the job to mark.
      expect(published.json.achieved_milestone_ids).toEqual([today]);
      const after = await milestones(rubric);
      expect(after.find((item) => item.id === late)).toMatchObject({ status: 'PLANNED', achieved_assessment_id: null });
      expect(after.find((item) => item.id === today)).toMatchObject({ status: 'ACHIEVED' });
    });

    it('waits for a publication that is deciding the milestones of its rubric, and a publication waits for a milestone that is being planned', async () => {
      const code = `RB-LOCK-${(sequence += 1)}`;
      const rubric = await publishedRubric(code);
      const holder = async (work: () => Promise<unknown>): Promise<{ answered: () => boolean; finish: () => Promise<void> }> => {
        let release!: () => void;
        let locked!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        const isLocked = new Promise<void>((resolve) => (locked = resolve));
        // Another command holds the lock of the roadmap of the rubric and has not committed yet.
        const holding = harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(PUBLISHER), scopeVersion: 1 }, async (tx) => {
          await tx.query("select pg_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id', true) || ':maturity-roadmap:' || $1, 0))", [code]);
          locked();
          await held;
        });
        await isLocked;
        let done = false;
        const waiting = work().then(() => (done = true));
        await new Promise((resolve) => setTimeout(resolve, 400));
        return {
          answered: () => done,
          finish: async () => {
            release();
            await holding;
            await waiting;
          },
        };
      };
      const planning = await holder(() => milestone(MANAGER, rubric));
      expect(planning.answered()).toBe(false);
      await planning.finish();
      const made = (await startAssessment(MANAGER, rubric, `LOCK-${sequence}`)).json.resource_id as string;
      await assess(made, (await evidenceOf(made))[0] as never, 4);
      const version = (await assessmentOf(made)).version as number;
      const publishing = await holder(() => decide(PUBLISHER, made, version));
      expect(publishing.answered()).toBe(false);
      await publishing.finish();
      expect((await assessmentOf(made)).status).toBe('PUBLISHED');
    });

    it('lists the milestones by state and pillar, a page at a time', async () => {
      const rubric = await publishedRubric();
      for (const level of [2, 3, 4]) expect((await milestone(MANAGER, rubric, { target_level: level })).status).toBe(200);
      expect((await milestone(MANAGER, rubric, { pillar_code: 'SECURITY' })).status).toBe(200);
      expect(await milestones(rubric)).toHaveLength(4);
      expect((await call('GET', `/dgv/maturity-milestones?rubric_version_id=${rubric}&pillar_code=SECURITY`, { member: READER })).json.items).toHaveLength(1);
      expect((await call('GET', `/dgv/maturity-milestones?rubric_version_id=${rubric}&status=ACHIEVED`, { member: READER })).json.items).toEqual([]);
      const first = await call('GET', `/dgv/maturity-milestones?rubric_version_id=${rubric}&limit=3`, { member: READER });
      expect(first.json.items).toHaveLength(3);
      const rest = await call('GET', `/dgv/maturity-milestones?rubric_version_id=${rubric}&limit=3&cursor=${first.json.next_cursor}`, { member: READER });
      expect(rest.json.items).toHaveLength(1);
      expect(rest.json.next_cursor).toBeNull();
      for (const query of ['?status=NEARLY', '?rubric_version_id=x', '?limit=0', '?cursor=bad', '?pillar_code='])
        expect((await call('GET', `/dgv/maturity-milestones${query}`, { member: READER })).status).toBe(422);
    });
  });

  describe('the database', () => {
    it('keeps what an assessment is about, and who assesses and reviews it, and refuses an assessor who is the reviewer', async () => {
      const rubric = await publishedRubric();
      const made = (await startAssessment(MANAGER, rubric, '2026-DB')).json.resource_id as string;
      await expect(asApp(MANAGER, "update machvon.maturity_assessment set period_code = 'OTHER-1' where id = $1", [made])).rejects.toMatchObject({ code: '42501' });
      await expect(asApp(MANAGER, 'update machvon.maturity_assessment set reviewer_id = assessor_user_id where id = $1', [made])).rejects.toMatchObject({ code: '42501' });
      await expect(asApp(MANAGER, "update machvon.maturity_assessment set status = 'PUBLISHED' where id = $1", [made])).rejects.toMatchObject({ code: '42501' });
      await expect(asApp(MANAGER, 'update machvon.maturity_assessment set overall_level = 3 where id = $1', [made])).rejects.toMatchObject({ code: '42501' });
      await expect(asApp(MANAGER, 'delete from machvon.maturity_assessment where id = $1', [made])).rejects.toMatchObject({ code: '42501' });
      await expect(asApp(MANAGER, 'update machvon.maturity_evidence set criterion_code = $2 where assessment_id = $1', [made, 'OTHER-1'])).rejects.toMatchObject({ code: '42501' });
      const row = (await evidenceOf(made))[0] as { id: string };
      await expect(
        asApp(
          MANAGER,
          "update machvon.maturity_evidence set assessment_state = 'ASSESSED', level = 3, evidence_refs = '[]'::jsonb, assessed_by = $2, evidence_expires_on = current_date + 1 where id = $1",
          [row.id, memberId(ASSESSOR)],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(asApp(MANAGER, "update machvon.maturity_evidence set assessment_state = 'NOT_ASSESSED', level = 2 where id = $1", [row.id])).rejects.toMatchObject({ code: '23514' });
      await expect(asApp(MANAGER, "update machvon.maturity_evidence set assessment_state = 'NOT_APPLICABLE', na_reason = null where id = $1", [row.id])).rejects.toMatchObject({ code: '23514' });
      await expect(asApp(MANAGER, "update machvon.maturity_evidence set review_status = 'ACCEPTED' where id = $1", [row.id])).rejects.toMatchObject({ code: '23514' });
    });
  });
});
