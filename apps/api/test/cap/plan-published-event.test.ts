import { randomBytes, randomUUID } from 'node:crypto';
import { CapPlanStore, OutboxRelay, PrjProjectStore, enqueueOutbox, projectScope } from '@machvon/db';
import type { OutboxDelivery } from '@machvon/db';
import { vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { Pool } from 'pg';
import { PlanPublishedConsumer } from '../../src/modules/prj/plan-published.consumer';
import { InMemoryPipelineCache } from '../../src/modules/prj/pipeline-cache';
import { planPublishedEvent } from '../../src/modules/cap/plan-events';
import { AuthzHarness, TENANT_A, contextFor, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';

const RELAY_KEY = randomBytes(32);
const PLANNER = 1;
const APPROVER = 2;
const ROOT = 1;
const TODAY = vietnamDateOf(new Date());
const BILLION = 1_000_000_000;
const WORKER = '00000000-0000-4000-8000-000000000000';

/** The event that ST-CAP-002 produces for the publication of a plan (CAP 3.1 section 9), read by the consumer of the project register (PRJ 3.1 F3). */
describe('capital.plan_published.v1: the producer and the consumer of the project register agree (AC-ST-PRJ-002-3)', () => {
  const harness = new AuthzHarness();
  const store = new CapPlanStore();
  const projects = new PrjProjectStore();
  const cache = new InMemoryPipelineCache();
  let relayPool: Pool;
  let areaVersion = '';
  let fundVersion = '';
  let counter = 0;
  let yearCounter = 2100;

  const everyone: EffectiveAccess = {
    membershipId: memberId(PLANNER),
    scopeVersion: 1,
    membershipActive: true,
    grants: [{ roleCode: 'TEST', rank: 10, permissions: ['capital.plan.draft'], scope: { kind: 'TENANT' }, status: 'Active', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveUntil: null }],
  };
  const write = projectScope(everyone, 'capital.plan.draft', new Date());
  const as = <T>(work: Parameters<typeof harness.tenants.withTenant<T>>[1], member = PLANNER): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);

  async function master(name: string, masterType: string, attributes: Record<string, unknown>): Promise<string> {
    const recordId = randomUUID();
    const versionId = randomUUID();
    await harness.owner(TENANT_A, [
      [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', $3, $4, 'EFFECTIVE', $5, $5)`, [TENANT_A, recordId, masterType, name, memberId(PLANNER)]],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
         values ($1, $2, $3, $4, 1, $4, $5::jsonb, '2020-01-01', 'EFFECTIVE', $6, now(), $7, $7)`,
        [TENANT_A, versionId, masterType, name, JSON.stringify(attributes), recordId, memberId(PLANNER)],
      ],
    ]);
    return versionId;
  }

  async function document(): Promise<string> {
    const id = randomUUID();
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
         values ($1, $2, 'REFERENCE', 'QD', 'A decision', $3, '2026-01-15', 'EFFECTIVE', 'INTERNAL', $4, $4)`,
        [TENANT_A, id, `QD-${id.slice(0, 8)}`, memberId(PLANNER)],
      ],
    ]);
    return id;
  }

  async function pipelineProject(): Promise<string> {
    counter += 1;
    const number = counter;
    const created = await as((tx) => projects.create(tx, { code: `EV-${number}`, name: `Project ${number}`, ownerUnitId: unitId(ROOT), areaMasterVersionId: areaVersion, totalInvestmentVnd: '500000000000' }, memberId(PLANNER), TODAY));
    await harness.owner(TENANT_A, [['update machvon.project set status = $2, project_group = $3, national_project_code = $4 where id = $1::uuid', [created.id, 'PIPELINE', 'B', String(9100000 + number)]]]);
    return created.id;
  }

  async function appropriation(year: number): Promise<string> {
    const id = randomUUID();
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.appropriation
           (tenant_id, id, fund_source_version_id, plan_year, origin, budget_level, amount_vnd, allocated_total_vnd, decision_document_id, issuing_authority, source_year, revision, status, approved_by, created_by, updated_by)
         values ($1, $2, $3, $4, 'PM_ASSIGNED', 'CENTRAL', $5::numeric, 0, $6, 'Thủ tướng Chính phủ', $4, 1, 'PUBLISHED', $7, $8, $8)`,
        [TENANT_A, id, fundVersion, year, String(10 * BILLION), await document(), memberId(APPROVER), memberId(PLANNER)],
      ],
    ]);
    return id;
  }

  /** A plan with a line for each of the funded projects, drafted by the command, then published the way the publication command leaves it. */
  async function plan(funded: string[], publish = true): Promise<{ planId: string; documentId: string; version: number }> {
    yearCounter -= 1;
    const year = yearCounter;
    const source = await appropriation(year);
    const created = await as((tx) => store.createPlan(tx, { planCode: `EV-${randomUUID().slice(0, 8)}`, planKind: 'ANNUAL', planYear: year, periodFromYear: year, periodToYear: year, scopeUnitId: unitId(ROOT) }, memberId(PLANNER), () => undefined));
    const drafted = await as((tx) =>
      store.draft(tx, created.id, 1, { lines: funded.map((projectId) => ({ projectId, appropriationId: source, bucket: 'CURRENT_YEAR', sourceYear: year, amountVnd: String(BILLION) })) }, memberId(PLANNER), {
        write,
        read: { lines: write, drafts: true },
      }),
    );
    const documentId = await document();
    if (publish) {
      await harness.owner(TENANT_A, [
        ["update machvon.capital_plan set status = 'IN_REVIEW', submitted_by = $2::uuid where id = $1::uuid", [created.id, memberId(PLANNER)]],
        ["update machvon.capital_plan set status = 'APPROVED', approved_by = $2::uuid where id = $1::uuid", [created.id, memberId(APPROVER)]],
        ["update machvon.capital_plan set status = 'PUBLISHED', decision_document_id = $2::uuid, effective_at = now(), published_at = now(), version = version + 1 where id = $1::uuid", [created.id, documentId]],
      ]);
    }
    return { planId: created.id, documentId, version: drafted.version + (publish ? 1 : 0) };
  }

  /** The command of a later story, as far as this one needs it: the event is built from the facts of the plan and written to the outbox in the transaction. */
  async function emit(planId: string, version: number): Promise<void> {
    await as(async (tx) => {
      const facts = await store.publicationFacts(tx, planId);
      if (facts === undefined) return;
      await enqueueOutbox(tx, { ...planPublishedEvent(TENANT_A, memberId(APPROVER), facts, version, new Date()), correlationId: randomUUID() });
    }, APPROVER);
  }

  /** The relay delivers what the outbox holds, to the real consumer. */
  async function relay(): Promise<string[]> {
    const outcomes: string[] = [];
    const consumer = new PlanPublishedConsumer({ database: harness.tenants, security: { signingKey: RELAY_KEY }, cache });
    await new OutboxRelay(relayPool, async (delivery: OutboxDelivery) => void outcomes.push(await consumer.handle(delivery)), { signingKey: RELAY_KEY }).runOnce();
    return outcomes;
  }

  const statusOf = async (projectId: string): Promise<{ status: string; version: string; updated_by: string }> =>
    (await harness.owner<{ status: string; version: string; updated_by: string }>(TENANT_A, [['select status, version::text as version, updated_by from machvon.project where id = $1::uuid', [projectId]]]))[0] as {
      status: string;
      version: string;
      updated_by: string;
    };

  beforeAll(async () => {
    await harness.start();
    relayPool = new Pool({ connectionString: harness.database.urlFor('machvon_outbox_relay'), max: 2 });
    relayPool.on('error', () => undefined);
    await harness.seedUnits(TENANT_A, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    for (const member of [PLANNER, APPROVER]) await harness.seedMembership(TENANT_A, member, ROOT);
    areaVersion = await master('AREA-EV', 'AREA', {});
    fundVersion = await master('NSTW-EV', 'FUND_SOURCE', { category: 'NSTW', relation: 'ADDITIVE' });
  }, 240_000);

  afterAll(async () => {
    await relayPool?.end();
    await harness.stop();
  }, 60_000);

  it('moves the projects that have a funded line in the published plan to BUDGETED once, in the name of the system, and leaves the others (AC-ST-CAP-002-3 chain, TX01)', async () => {
    const funded = [await pipelineProject(), await pipelineProject()];
    const unfunded = await pipelineProject();
    const published = await plan(funded);
    await emit(published.planId, published.version);
    const event = (await harness.owner<{ type: string; payload: Record<string, unknown>; aggregate_type: string; event_key: string }>(TENANT_A, [['select type, payload, aggregate_type, event_key from machvon.outbox_event where aggregate_id = $1::uuid', [published.planId]]]))[0];
    expect(event).toMatchObject({
      type: 'capital.plan_published.v1',
      aggregate_type: 'capital_plan',
      event_key: `capital_plan:${published.planId}:published`,
      payload: {
        tenant_id: TENANT_A,
        capital_plan_id: published.planId,
        revision: 1,
        decision_document_id: published.documentId,
        project_ids: [...funded].sort(),
        actor_id: memberId(APPROVER),
      },
    });
    expect(event?.payload.plan_year).toEqual(expect.any(Number));
    expect(event?.payload.effective_at).toEqual(expect.stringMatching(/Z$/));
    expect(await relay()).toEqual(['processed']);
    for (const projectId of funded) expect(await statusOf(projectId)).toMatchObject({ status: 'BUDGETED', version: '2', updated_by: WORKER });
    expect(await statusOf(unfunded)).toMatchObject({ status: 'PIPELINE', version: '1' });
    const history = await harness.owner<{ operation: string; actor_kind: string; decision_document_id: string }>(TENANT_A, [
      ['select operation, actor_kind, decision_document_id from machvon.project_stage_change where project_id = any($1::uuid[]) order by project_id', [funded]],
    ]);
    expect(history).toEqual(funded.map(() => ({ operation: 'capital.plan_published.v1', actor_kind: 'SYSTEM', decision_document_id: published.documentId })));
    // The same event delivered again changes nothing: the outbox row is published and the consumer's inbox holds its id.
    expect((await relay()).filter((outcome) => outcome !== 'ignored')).toEqual([]);
  });

  it('delivers the same event again to the consumer without moving a project twice (at-least-once delivery)', async () => {
    const waiting = await pipelineProject();
    const published = await plan([waiting]);
    await emit(published.planId, published.version);
    const seen: OutboxDelivery[] = [];
    await new OutboxRelay(relayPool, async (delivery: OutboxDelivery) => void seen.push(delivery), { signingKey: RELAY_KEY }).runOnce();
    const delivery = seen.find((candidate) => candidate.aggregateId === published.planId) as OutboxDelivery;
    const consumer = new PlanPublishedConsumer({ database: harness.tenants, security: { signingKey: RELAY_KEY }, cache });
    expect(await consumer.handle(delivery)).toBe('processed');
    expect(await consumer.handle(delivery)).toBe('duplicate');
    expect(await statusOf(waiting)).toMatchObject({ status: 'BUDGETED', version: '2' });
  });

  it('gives no facts, so no event, for a plan that is not published', async () => {
    const waiting = await pipelineProject();
    const draft = await plan([waiting], false);
    await emit(draft.planId, draft.version);
    expect(await harness.owner(TENANT_A, [['select 1 from machvon.outbox_event where aggregate_id = $1::uuid', [draft.planId]]])).toEqual([]);
    expect(await as((tx) => store.publicationFacts(tx, draft.planId))).toBeUndefined();
    expect(await statusOf(waiting)).toMatchObject({ status: 'PIPELINE' });
  });
});
