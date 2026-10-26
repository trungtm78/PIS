import { randomBytes, randomUUID } from 'node:crypto';
import { OutboxRelay, enqueueOutbox } from '@machvon/db';
import type { OutboxDelivery } from '@machvon/db';
import { Client, Pool } from 'pg';
import { AUD_PAY_RECOVERY_CONSUMER, AUD_RECOVERY_POSTING_METRIC, AUD_REOPENED_ALERT, PAY_RECOVERY_RECORDED_EVENT, PAY_RECOVERY_REVERSED_EVENT, PayRecoveryConsumer } from '../../src/modules/aud/pay-recovery.consumer';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';

const RELAY_KEY = randomBytes(32);
const WORKER = '00000000-0000-4000-8000-000000000000';
const ACCOUNTANT = 1;
const FAMILY = 0x98;
const DECISION = id(FAMILY, 10);

/** The recoveries and the reversals PAY reports against the recommendations of AUD (ST-AUD-004, AUD 3.4, UAT-AC437, UAT-AC444). */
describe('the recoveries of PAY on the ledger of AUD (AC-ST-AUD-004-1, AC-ST-AUD-004-3)', () => {
  const harness = new AuthzHarness();
  let relayPool: Pool;
  let counter = 0;
  const alerts: Array<{ code: string; context: unknown }> = [];
  const increments: Array<{ name: string; labels: Record<string, string> | undefined }> = [];

  const consumer = (): PayRecoveryConsumer =>
    new PayRecoveryConsumer({
      database: harness.tenants,
      security: { signingKey: RELAY_KEY, alerts: { raise: (code: string, context?: unknown) => void alerts.push({ code, context }) } } as never,
      metrics: { increment: (name, labels) => void increments.push({ name, labels }), gauge: () => undefined },
    });

  /** The relay delivers what the outbox holds, to the real consumer. */
  async function relay(): Promise<string[]> {
    const outcomes: string[] = [];
    const real = consumer();
    await new OutboxRelay(relayPool, async (delivery: OutboxDelivery) => void outcomes.push(await real.handle(delivery)), { signingKey: RELAY_KEY }).runOnce();
    return outcomes.filter((outcome) => outcome !== 'ignored');
  }

  const publish = (type: string, payload: Record<string, unknown>, tenantId = TENANT_A, payloadTenant = tenantId, eventKey: string = randomUUID()): Promise<unknown> =>
    harness.tenants.withTenant(contextFor(tenantId, memberId(ACCOUNTANT)), (tx) =>
      enqueueOutbox(tx, {
        aggregateType: 'recovery',
        aggregateId: typeof payload.recovery_id === 'string' ? payload.recovery_id : randomUUID(),
        aggregateVersion: 1,
        type,
        schemaVersion: 1,
        payload: { tenant_id: payloadTenant, ...payload },
        eventKey: `${type}:${eventKey}`,
        correlationId: randomUUID(),
      }),
    );

  const recorded = (recommendationId: string, recoveryId: string, amount: string, kind = 'RECOVERY', extra: Record<string, unknown> = {}) =>
    publish(PAY_RECOVERY_RECORDED_EVENT, { recovery_id: recoveryId, audit_recommendation_id: recommendationId, amount_vnd: amount, kind, recorded_on: '2026-10-20', ...extra });
  const reversed = (recommendationId: string, recoveryId: string, amount: string, kind = 'RECOVERY') =>
    publish(PAY_RECOVERY_REVERSED_EVENT, { recovery_id: recoveryId, audit_recommendation_id: recommendationId, amount_vnd: amount, kind, reversed_on: '2026-10-22' });

  /** A recommendation of 800,000,000 of an engagement that is followed up, with the status asked for. */
  async function seed(status: 'OPEN' | 'CLOSED' = 'OPEN', type = 'FINANCIAL_RECOVERY', amount: string | null = '800000000'): Promise<{ recommendationId: string; engagementId: string }> {
    counter += 1;
    const engagementId = randomUUID();
    const conclusionId = randomUUID();
    const recommendationId = randomUUID();
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.audit_engagement (tenant_id, id, engagement_code, engagement_type, authority_kind, authority_name, decision_document_id, title, period_from, period_to, coordinator_user_id, status, started_on, classification, created_by, updated_by, version)
         values ($1, $2, $3, 'STATE_AUDIT', 'STATE_AUDIT_OFFICE', 'State Audit Office', $4, 'Audit of the bridge', date '2025-01-01', date '2025-12-31', $5, 'FOLLOW_UP', date '2026-10-01', 'CONFIDENTIAL', $5, $5, 3)`,
        [TENANT_A, engagementId, `PR-${counter}`, DECISION, memberId(ACCOUNTANT)],
      ],
      [
        `insert into machvon.audit_conclusion (tenant_id, id, engagement_id, conclusion_kind, conclusion_document_id, revision, issued_on, received_on, summary, total_financial_vnd, status, created_by, updated_by, version)
         values ($1, $2, $3, 'AUDIT_REPORT', $4, 1, date '2026-10-10', date '2026-10-15', 'The audit found payments above the approved volumes.', 2000000000, 'RECEIVED', $5, $5, 1)`,
        [TENANT_A, conclusionId, engagementId, DECISION, memberId(ACCOUNTANT)],
      ],
      [
        `insert into machvon.audit_recommendation (tenant_id, id, conclusion_id, rec_code, rec_type, description, amount_vnd, status, created_by, updated_by, version)
         values ($1, $2, $3, $4, $5, 'Recover what was paid above the volume.', $6::numeric, 'OPEN', $7, $7, 1)`,
        [TENANT_A, recommendationId, conclusionId, `R-${counter}`, type, amount, memberId(ACCOUNTANT)],
      ],
    ]);
    if (status === 'CLOSED') {
      await harness.owner(TENANT_A, [
        ["update machvon.audit_recommendation set status = 'ASSIGNED', owner_unit_id = $2, due_on = date '2026-12-01' where id = $1", [recommendationId, unitId(1)]],
        ["update machvon.audit_recommendation set status = 'IN_PROGRESS' where id = $1", [recommendationId]],
        ["update machvon.audit_recommendation set status = 'PENDING_VERIFICATION', submitted_by = $2 where id = $1", [recommendationId, memberId(ACCOUNTANT)]],
        ["update machvon.audit_recommendation set status = 'CLOSED', verified_by = $2, verified_at = now() where id = $1", [recommendationId, memberId(2)]],
      ]);
    }
    return { recommendationId, engagementId };
  }

  const state = async (recommendationId: string) =>
    (await harness.owner<{ status: string; recovered: string; reopened: boolean }>(TENANT_A, [['select status, recovered_vnd::text as recovered, reopened_at is not null as reopened from machvon.audit_recommendation where id = $1', [recommendationId]]])).at(-1) as {
      status: string;
      recovered: string;
      reopened: boolean;
    };
  const lines = async (recommendationId: string) =>
    harness.owner<{ amount: string; source_kind: string; reversal_of_id: string | null }>(TENANT_A, [['select amount_vnd::text as amount, source_kind, reversal_of_id from machvon.audit_recovery_link where recommendation_id = $1 order by recorded_at, id', [recommendationId]]]);
  const count = async (sql: string, params: unknown[]): Promise<number> => Number((await harness.owner<{ n: string }>(TENANT_A, [[sql, params]])).at(-1)?.n);

  beforeAll(async () => {
    await harness.start();
    relayPool = new Pool({ connectionString: harness.database.urlFor('machvon_outbox_relay'), max: 2 });
    relayPool.on('error', () => undefined);
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
    await harness.seedMembership(TENANT_A, ACCOUNTANT, 1);
    await harness.seedMembership(TENANT_A, 2, 1);
    // The decision document belongs to another module, so the seed runs with foreign keys off.
    const admin = new Client({ connectionString: harness.database.adminUrl });
    await admin.connect();
    try {
      await admin.query('set session_replication_role = replica');
      await admin.query(
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
         values ($1, $2, 'REFERENCE', 'QD', 'Decision to audit the bridge', '12/QD-KTNN', date '2026-01-15', 'EFFECTIVE', 'INTERNAL', $3, $3)`,
        [TENANT_A, DECISION, memberId(ACCOUNTANT)],
      );
    } finally {
      await admin.end();
    }
  }, 240_000);

  afterAll(async () => {
    await relayPool?.end();
    await harness.stop();
  }, 60_000);

  it('serves the events of PAY under its own name', () => {
    expect(consumer().name).toBe(AUD_PAY_RECOVERY_CONSUMER);
    expect(AUD_PAY_RECOVERY_CONSUMER).toBe('aud-pay-recovery');
  });

  it('AC-ST-AUD-004-1 / UAT-AC437: a recovery of 500,000,000 delivered twice is linked once, a deduction of 300,000,000 makes 800,000,000, and the lines carry the events that made them', async () => {
    const { recommendationId } = await seed();
    const first = randomUUID();
    await recorded(recommendationId, first, '500000000');
    // the same recovery reported again under another event
    await recorded(recommendationId, first, '500000000');
    expect(await relay()).toEqual(['processed', 'processed']);
    expect(await lines(recommendationId)).toEqual([{ amount: '500000000', source_kind: 'PAY_RECOVERY', reversal_of_id: null }]);
    await recorded(recommendationId, randomUUID(), '300000000', 'DEDUCTION');
    expect(await relay()).toEqual(['processed']);
    expect(await state(recommendationId)).toMatchObject({ status: 'OPEN', recovered: '800000000', reopened: false });
    expect((await lines(recommendationId)).map((line) => [line.amount, line.source_kind])).toEqual([
      ['500000000', 'PAY_RECOVERY'],
      ['300000000', 'PAY_DEDUCTION'],
    ]);
    expect(await count("select count(*) as n from machvon.audit_recovery_link where recommendation_id = $1 and source_event_id is not null and recorded_by = $2", [recommendationId, WORKER])).toBe(2);
    // the trail and the events: one of each for each line that was linked
    expect(await count("select count(*) as n from machvon.audit_event where action = 'aud.recovery_linked' and actor_id = $1 and safe_diff ->> 'recommendation_id' = $2", [WORKER, recommendationId])).toBe(2);
    expect(await count("select count(*) as n from machvon.outbox_event where type = 'aud.recovery.linked.v1' and payload ->> 'recommendation_id' = $1", [recommendationId])).toBe(2);
    expect(increments.filter((entry) => entry.name === AUD_RECOVERY_POSTING_METRIC).map((entry) => entry.labels?.outcome)).toEqual(expect.arrayContaining(['linked', 'duplicate']));
  });

  it('AC-ST-AUD-004-3 / UAT-AC444: a reversal of PAY delivered twice adds one negative line, recovered falls to 500,000,000, and the closed recommendation goes back to IN_PROGRESS with an alert', async () => {
    const { recommendationId } = await seed('CLOSED');
    const deduction = randomUUID();
    await recorded(recommendationId, randomUUID(), '500000000');
    await recorded(recommendationId, deduction, '300000000', 'DEDUCTION');
    await relay();
    expect(await state(recommendationId)).toMatchObject({ status: 'CLOSED', recovered: '800000000' });
    alerts.length = 0;
    await reversed(recommendationId, deduction, '300000000', 'DEDUCTION');
    await reversed(recommendationId, deduction, '300000000', 'DEDUCTION');
    expect(await relay()).toEqual(['processed', 'processed']);
    expect((await lines(recommendationId)).map((line) => line.amount)).toEqual(['500000000', '300000000', '-300000000']);
    expect(await state(recommendationId)).toEqual({ status: 'IN_PROGRESS', recovered: '500000000', reopened: true });
    expect(alerts).toEqual([{ code: AUD_REOPENED_ALERT, context: expect.objectContaining({ tenantId: TENANT_A, recommendationId }) }]);
    expect(await count("select count(*) as n from machvon.outbox_event where type = 'aud.recommendation.reopened.v1' and aggregate_id = $1", [recommendationId])).toBe(1);
    expect(await count("select count(*) as n from machvon.outbox_event where type = 'aud.recovery.reversed.v1' and payload ->> 'recommendation_id' = $1", [recommendationId])).toBe(1);
    expect(await count("select count(*) as n from machvon.audit_event where action = 'aud.recommendation_reopened' and resource_id = $1", [recommendationId])).toBe(1);
    expect(await count("select count(*) as n from machvon.audit_event where action = 'aud.recovery_reversed' and actor_id = $1 and safe_diff ->> 'recommendation_id' = $2", [WORKER, recommendationId])).toBe(1);
  });

  it('keeps a recovery over the amount, a reversal never linked and a recommendation that takes no money as exceptions, with no line, and tells the trail', async () => {
    const { recommendationId } = await seed('OPEN', 'FINANCIAL_RECOVERY', '400000000');
    await recorded(recommendationId, randomUUID(), '300000000');
    await relay();
    await recorded(recommendationId, randomUUID(), '200000000');
    await reversed(recommendationId, randomUUID(), '100000000');
    const process = await seed('OPEN', 'REFERRAL', null);
    await recorded(process.recommendationId, randomUUID(), '100000000');
    expect(await relay()).toEqual(['processed', 'processed', 'processed']);
    expect(await state(recommendationId)).toMatchObject({ recovered: '300000000' });
    expect((await lines(recommendationId)).length).toBe(1);
    expect((await lines(process.recommendationId)).length).toBe(0);
    expect(await harness.owner(TENANT_A, [['select kind, status from machvon.audit_recovery_exception where recommendation_id = any($1::uuid[]) order by kind', [[recommendationId, process.recommendationId]]]])).toEqual([
      { kind: 'NOT_APPLICABLE', status: 'OPEN' },
      { kind: 'OVER_RECOVERY', status: 'OPEN' },
      { kind: 'UNMATCHED_REVERSAL', status: 'OPEN' },
    ]);
    expect(await count("select count(*) as n from machvon.audit_event where action = 'aud.recovery_exception_kept' and actor_id = $1 and resource_id::text = any($2::text[])", [WORKER, [recommendationId, process.recommendationId]])).toBe(3);
  });

  it('is not the business of an event about a recommendation of another tenant or that is not there, of a payload that names another tenant, of another version or of another type', async () => {
    const { recommendationId } = await seed();
    await recorded(randomUUID(), randomUUID(), '100');
    expect(await relay()).toEqual(['processed']);
    // a payload that names another tenant than the one that signed the delivery is not acted on
    await recorded(recommendationId, randomUUID(), '100', 'RECOVERY', { tenant_id: TENANT_B });
    await publish('pay.payment.settled.v2', { recovery_id: randomUUID(), audit_recommendation_id: recommendationId, amount_vnd: '100' });
    expect(await relay()).toEqual([]);
    expect((await lines(recommendationId)).length).toBe(0);
    // an event of tenant B about a recommendation of tenant A is not found there
    await harness.seedMembership(TENANT_B, ACCOUNTANT, 1);
    await recorded(recommendationId, randomUUID(), '100', 'RECOVERY', {}).then(() => undefined);
    await publish(PAY_RECOVERY_RECORDED_EVENT, { recovery_id: randomUUID(), audit_recommendation_id: recommendationId, amount_vnd: '100', kind: 'RECOVERY', recorded_on: '2026-10-20' }, TENANT_B);
    await relay();
    expect((await lines(recommendationId)).length).toBe(1);
  });

  it('refuses a payload that does not read (422 VALIDATION_FAILED), so the relay keeps it for another try rather than dropping money on the floor', async () => {
    const { recommendationId } = await seed();
    const real = consumer();
    const delivery = (payload: Record<string, unknown>): OutboxDelivery =>
      ({ id: randomUUID(), tenantId: TENANT_A, tenantContext: 'unused', type: PAY_RECOVERY_RECORDED_EVENT, schemaVersion: 1, payload: { tenant_id: TENANT_A, ...payload } }) as unknown as OutboxDelivery;
    for (const bad of [{ recovery_id: 'x', audit_recommendation_id: recommendationId, amount_vnd: '5', kind: 'RECOVERY', recorded_on: '2026-10-20' }, { recovery_id: randomUUID(), audit_recommendation_id: recommendationId, amount_vnd: '5.5', kind: 'RECOVERY', recorded_on: '2026-10-20' }]) {
      await expect(real.handle(delivery(bad))).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    }
    expect((await lines(recommendationId)).length).toBe(0);
  });
});
