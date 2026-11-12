import { randomBytes, randomUUID } from 'node:crypto';
import { AuditWriter, CtrGuaranteeExpiry, CtrGuaranteeStore, INTAKE_CATEGORY_KEYS, WORKER_MEMBERSHIP_ID, contractScope } from '@machvon/db';
import type { OutboxDelivery } from '@machvon/db';
import { signTenantContext } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink } from '@machvon/kernel';
import { IssIntakeConsumer } from '../../src/modules/iss/intake.consumer';
import { CONTRACT, DOCUMENT_CLEAN, IssWorld, PEOPLE, PROJECT, TENANT_A, memberId } from '../../../../packages/db/test/support/iss-fixtures';
import { expectCheckFails } from '../uat/uat-kit';

/**
 * UAT-AC59 (docs/uat/ctr/uat.json, CTR-05): an advance guarantee about to lapse is reminded three times, never extended by itself, and when it lapses with an advance still owed it opens one issue of ISS.
 * The job guarantee-expiry runs on the dates of the case (its own `now` parameter is the clock of the product); the issue is opened by the real intake consumer of ISS from the event the job left in
 * the outbox, not from a payload typed by the test. The refusal of a new advance on the lapsed guarantee is proven in packages/db/test/uat-case-ac59-advance-after-expiry.test.ts.
 */
const SIGNING_KEY = randomBytes(32);
const REGISTRAR = PEOPLE.REPORTER;
const VERIFIER = PEOPLE.ASSIGNER;
const JOB = PEOPLE.SYSTEM;
const metrics: MetricsSink = { increment: () => undefined, gauge: () => undefined };

const grant = (permission: string, member: number): EffectiveAccess => ({
  membershipId: memberId(member),
  scopeVersion: 1,
  membershipActive: true,
  grants: [{ roleCode: 'TEST', rank: 10, permissions: [permission], scope: { kind: 'TENANT' }, status: 'Active', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveUntil: null }],
});
const scopes = (permission: string, member: number) => ({ update: contractScope(grant(permission, member), permission, new Date()), read: contractScope(grant('guarantee.read', member), 'guarantee.read', new Date()) });
// 06:00 in Vietnam on the day of the case: the hour at which the job runs.
const at = (day: string): Date => new Date(`${day}T06:00:00+07:00`);

describe('UAT-AC59: the guarantee that is about to lapse is reminded, not extended, and its lapse with an advance owed opens one issue', () => {
  const world = new IssWorld();
  const guarantees = new CtrGuaranteeStore();
  const consumer = (): IssIntakeConsumer => new IssIntakeConsumer({ database: world.harness.tenants, security: { signingKey: SIGNING_KEY }, metrics });
  const job = (): CtrGuaranteeExpiry => new CtrGuaranteeExpiry(new AuditWriter(world.harness.tenants));
  const run = (day: string) => world.as((tx) => job().run(tx, memberId(JOB), at(day)), TENANT_A, JOB);
  const guaranteeRow = async (id: string) =>
    (await world.owner<{ status: string; last_alert_days: number | null; expires_at: string; verification_status: string }>('select status, last_alert_days, expires_at::text as expires_at, verification_status from machvon.guarantee where id = $1::uuid', [id]))[0];
  const eventsOf = (id: string, type: string) =>
    world.owner<{ id: string; payload: Record<string, unknown>; aggregate_version: string; event_key: string }>(
      'select id, payload, aggregate_version::text as aggregate_version, event_key from machvon.outbox_event where aggregate_id = $1::uuid and type = $2 order by created_at, id',
      [id, type],
    );
  const issuesOf = (source: string) => world.owner<{ id: string; title: string; status: string; source_module: string; project_id: string }>('select id, title, status, source_module, project_id from machvon.issue where source_ref_id = $1::uuid', [source]);

  let guaranteeId = '';

  beforeAll(async () => {
    await world.start();
    // The category of the issues of CTR and its policy: the tenant defines them, the intake only opens an issue under them.
    const category = await world.seedCategory(TENANT_A, 'ISSUE_CATEGORY', INTAKE_CATEGORY_KEYS.CTR);
    await world.as((tx) =>
      world.policies.publish(tx, { code: 'SLA-CTR-HIGH', categoryVersionId: category, severity: 'HIGH', calendarCode: 'WORKDAY_VN', responseHours: 4, resolveHours: 16, validFrom: '2026-08-05' }, memberId(PEOPLE.SYSTEM)),
    );
    // BL-A-001: advance guarantee ACTIVE, expires 2026-12-01 23:59 Vietnam; ADV-A-001 of 2,000,000,000 with 750,000,000 recovered leaves 1,250,000,000 outstanding.
    await world.owner('update machvon.contract set contract_value_vnd = 10000000000, advance_paid_vnd = 2000000000, advance_recovered_vnd = 750000000 where id = $1::uuid', [CONTRACT]);
    const registered = await world.as(
      (tx) =>
        guarantees.register(
          tx,
          CONTRACT,
          { kind: 'ADVANCE', issuer: 'Bank of the Province', guaranteeNo: 'BL-A-001', amountVnd: '2000000000', validFrom: '2026-03-01', expiresAt: '2026-12-01T16:59:00Z', documentVersionId: DOCUMENT_CLEAN },
          memberId(REGISTRAR),
          scopes('guarantee.manage', REGISTRAR),
          new Date('2026-10-24T03:00:00Z'),
        ),
      TENANT_A,
      REGISTRAR,
    );
    await world.as(
      (tx) =>
        guarantees.verify(tx, registered.id, 1, { outcome: 'VERIFIED', method: 'Confirmation letter', evidenceDocumentVersionId: DOCUMENT_CLEAN }, memberId(VERIFIER), scopes('guarantee.verify', VERIFIER), new Date('2026-10-24T03:00:00Z')),
      TENANT_A,
      VERIFIER,
    );
    guaranteeId = registered.id;
  }, 300_000);

  afterAll(() => world.stop(), 60_000);

  it('UAT-AC59: reminds at 30, 15 and 7 days once each, keeps ACTIVE and the expiry until the day is over, then EXPIRED opens exactly one issue, and nothing extends it by itself', async () => {
    const expiresBefore = (await guaranteeRow(guaranteeId))?.expires_at;
    expect(await guaranteeRow(guaranteeId)).toMatchObject({ status: 'ACTIVE', verification_status: 'VERIFIED', last_alert_days: null });

    // Step 1: 2026-11-01, 30 days left.
    expect(await run('2026-11-01')).toMatchObject({ alerted: 1, expired: 0 });
    expect((await guaranteeRow(guaranteeId))?.last_alert_days).toBe(30);
    // Step 2: 2026-11-16 (15) and 2026-11-24 (7).
    expect(await run('2026-11-16')).toMatchObject({ alerted: 1 });
    expect((await guaranteeRow(guaranteeId))?.last_alert_days).toBe(15);
    expect(await run('2026-11-24')).toMatchObject({ alerted: 1 });
    expect((await guaranteeRow(guaranteeId))?.last_alert_days).toBe(7);
    // Step 3: the same day again makes no second notification.
    expect(await run('2026-11-24')).toMatchObject({ alerted: 0, expired: 0 });
    const reminders = await eventsOf(guaranteeId, 'ctr.guarantee.expiring.v1');
    expect(reminders.map((event) => event.payload.threshold_days)).toEqual([30, 15, 7]);
    expect(reminders.map((event) => event.payload.days_left)).toEqual([30, 15, 7]);
    // The status stays ACTIVE, the expiry is never moved, and no replacement was made.
    expect(await guaranteeRow(guaranteeId)).toMatchObject({ status: 'ACTIVE' });
    expect((await guaranteeRow(guaranteeId))?.expires_at).toEqual(expiresBefore);

    // Step 4: 2026-12-02, the day after the expiry.
    expect(await run('2026-12-01')).toMatchObject({ expired: 0 });
    expect(await run('2026-12-02')).toMatchObject({ expired: 1 });
    expect(await guaranteeRow(guaranteeId)).toMatchObject({ status: 'EXPIRED' });
    expect((await guaranteeRow(guaranteeId))?.expires_at).toEqual(expiresBefore);
    expect(await run('2026-12-02')).toMatchObject({ expired: 0 });
    expect(await world.owner('select 1 from machvon.guarantee where contract_id = $1::uuid', [CONTRACT])).toHaveLength(1);

    // The event the job left asks ISS for an issue: the advance is still owed.
    const lapsed = await eventsOf(guaranteeId, 'ctr.guarantee.expired.v1');
    expect(lapsed).toHaveLength(1);
    const [event] = lapsed;
    expect(event?.payload).toMatchObject({ guarantee_id: guaranteeId, contract_id: CONTRACT, project_id: PROJECT, kind: 'ADVANCE', advance_outstanding_vnd: '1250000000', issue_required: true, source_module: 'CTR', source_reference: guaranteeId });
    const delivery: OutboxDelivery = {
      id: event?.id as string,
      tenantId: TENANT_A,
      tenantContext: signTenantContext({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, SIGNING_KEY),
      type: 'ctr.guarantee.expired.v1',
      schemaVersion: 1,
      aggregateType: 'guarantee',
      aggregateId: guaranteeId,
      aggregateVersion: Number(event?.aggregate_version),
      payload: event?.payload as Record<string, unknown>,
      eventKey: event?.event_key as string,
      correlationId: randomUUID(),
      attempts: 0,
    };
    expect(await consumer().handle(delivery)).toBe('processed');
    const issues = await issuesOf(guaranteeId);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ title: 'Advance guarantee expired: ADVANCE-2026-12-01', status: 'OPEN', source_module: 'CTR', project_id: PROJECT });
    // The same event delivered again opens nothing more.
    expect(await consumer().handle(delivery)).toBe('duplicate');
    expect(await issuesOf(guaranteeId)).toHaveLength(1);
  });

  it('negative control: the checks of this suite go red on an answer that is wrong on purpose', () => {
    expectCheckFails(() => expect([30, 15, 7]).toEqual([30, 15, 7, 7]));
    expectCheckFails(() => expect('ACTIVE').toBe('EXPIRED'));
  });
});
