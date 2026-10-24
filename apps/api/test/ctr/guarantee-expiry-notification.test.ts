import { randomBytes, randomUUID } from 'node:crypto';
import { AuditWriter, CtrContractStore, CtrGuaranteeExpiry, CtrGuaranteeStore, EffectiveAccessStore, InMemoryAuthzCache, NotificationStore, WORKER_MEMBERSHIP_ID, contractScope } from '@machvon/db';
import type { OutboxDelivery, TenantTx } from '@machvon/db';
import { signTenantContext } from '@machvon/kernel';
import type { AlertSink, EffectiveAccess, MetricsSink } from '@machvon/kernel';
import { Client } from 'pg';
import { NotificationConsumer } from '../../src/notifications/consumer';
import { PayloadValidator } from '../../src/notifications/payload-validator';
import type { EventTypeCatalog, EventTypeDefinition } from '../../src/notifications/payload-validator';
import { PermissionResourceAccess } from '../../src/notifications/resource-access-port';
import { AuthzHarness, TENANT_A, contextFor, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedCtrWorld } from '../../../../packages/db/test/support/ctr-fixtures';
import type { CtrWorld } from '../../../../packages/db/test/support/ctr-fixtures';

const SIGNING_KEY = randomBytes(32);
const EVENT_TYPE = 'ctr.guarantee.expiring.v1';
const FAMILY = 0x97;
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const OFFICER = 1; // CONTRACT_OFFICER over the department
const ACCOUNTANT = 2; // CHIEF_ACCOUNTANT over the tenant
const CLERK = 3; // CONTRACT_CLERK over the tenant: reached by the resolver, but may not read guarantees
const OUTSIDER = 4; // CONTRACT_OFFICER over another branch: not reached
const REGISTRAR = 5; // registers the guarantee
const JOB = 9;
const ROLES = ['CONTRACT_OFFICER', 'CHIEF_ACCOUNTANT', 'CONTRACT_CLERK'];

class Metrics implements MetricsSink {
  readonly counters = new Map<string, number>();
  increment(name: string, labels?: Record<string, string>): void {
    const key = labels === undefined ? name : `${name}{${Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(',')}}`;
    if (key !== name) this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
    this.counters.set(name, (this.counters.get(name) ?? 0) + 1);
  }
  gauge(): void {
    return undefined;
  }
}

const alerts: AlertSink = { raise: () => undefined };

class StaticCatalog implements EventTypeCatalog {
  constructor(private readonly definition: EventTypeDefinition) {}
  async get(eventType: string, schemaVersion: number): Promise<EventTypeDefinition | undefined> {
    return this.definition.eventType === eventType && this.definition.schemaVersion === schemaVersion ? this.definition : undefined;
  }
}

describe('the reminder of a guarantee reaches the people who hold the contract (ST-CTR-003, docs/notification-event-types.md)', () => {
  const harness = new AuthzHarness();
  const metrics = new Metrics();
  let world: CtrWorld;
  let definition: EventTypeDefinition;
  let access: EffectiveAccessStore;
  let contractId = '';
  let guaranteeId = '';

  const consumer = (): NotificationConsumer =>
    new NotificationConsumer({
      database: harness.tenants,
      store: new NotificationStore(),
      validator: new PayloadValidator(new StaticCatalog(definition)),
      loadAccess: (ctx) => access.load(ctx),
      resourceAccess: new PermissionResourceAccess(),
      security: { signingKey: SIGNING_KEY, alerts },
      metrics,
    });
  const grant = (permission: string): EffectiveAccess => ({
    membershipId: memberId(REGISTRAR),
    scopeVersion: 1,
    membershipActive: true,
    grants: [{ roleCode: 'TEST', rank: 10, permissions: [permission], scope: { kind: 'TENANT' }, status: 'Active', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveUntil: null }],
  });
  const scopes = (permission: string) => ({ update: contractScope(grant(permission), permission, new Date()), read: contractScope(grant('guarantee.read'), 'guarantee.read', new Date()) });
  const as = <T>(member: number, work: (tx: TenantTx) => Promise<T>): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);

  /** The events a day's pass left in the outbox for the guarantee, as the relay would deliver them. */
  async function deliveries(): Promise<OutboxDelivery[]> {
    const rows = await harness.owner<{ id: string; type: string; payload: Record<string, unknown>; aggregate_version: string; event_key: string }>(TENANT_A, [
      ['select id, type, payload, aggregate_version::text as aggregate_version, event_key from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at, id', [guaranteeId, EVENT_TYPE]],
    ]);
    return rows.map((row) => ({
      id: row.id,
      tenantId: TENANT_A,
      tenantContext: signTenantContext({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, SIGNING_KEY),
      type: row.type,
      schemaVersion: 1,
      aggregateType: 'guarantee',
      aggregateId: guaranteeId,
      aggregateVersion: Number(row.aggregate_version),
      payload: row.payload,
      eventKey: row.event_key,
      correlationId: randomUUID(),
      attempts: 0,
    }));
  }
  const recipients = async (eventId: string): Promise<string[]> =>
    (await harness.owner<{ recipient_id: string }>(TENANT_A, [['select recipient_id from machvon.notification_instance where event_id = $1 order by recipient_id', [eventId]]])).map((row) => row.recipient_id);

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: ROOT, path: '/u1/' },
      { n: DEPARTMENT, path: '/u1/u2/', parent: ROOT },
      { n: ELSEWHERE, path: '/u3/' },
    ]);
    for (const n of [OFFICER, ACCOUNTANT, CLERK, OUTSIDER, REGISTRAR, JOB]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 1, 'CONTRACT_OFFICER', ['guarantee.read'], 30);
    await harness.seedRole(TENANT_A, 2, 'CHIEF_ACCOUNTANT', ['guarantee.read', 'guarantee.verify'], 40);
    await harness.seedRole(TENANT_A, 3, 'CONTRACT_CLERK', ['contract.read'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: OFFICER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 2, member: ACCOUNTANT, role: 2, kind: 'TENANT' },
      { n: 3, member: CLERK, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 4, member: OUTSIDER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
    ]);
    world = await seedCtrWorld(harness.database.adminUrl, TENANT_A, FAMILY, REGISTRAR, DEPARTMENT, ROOT);
    access = new EffectiveAccessStore(harness.tenants, new InMemoryAuthzCache());

    // The event type is registered by the migration of the module: the schema the consumer judges the payload by is the one it wrote.
    const admin = new Client({ connectionString: harness.database.adminUrl });
    await admin.connect();
    try {
      const { rows } = await admin.query<{ payload_schema: unknown; allowed_purposes: string[]; status: 'Active' | 'Deprecated' }>(
        'select payload_schema, allowed_purposes, status from machvon.notification_event_type where event_type = $1 and schema_version = 1',
        [EVENT_TYPE],
      );
      const row = rows[0];
      if (row === undefined) throw new Error(`${EVENT_TYPE} is not registered by a migration`);
      definition = { eventType: EVENT_TYPE, schemaVersion: 1, payloadSchema: row.payload_schema, allowedPurposes: row.allowed_purposes, status: row.status };
    } finally {
      await admin.end();
    }
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.workflow_version (tenant_id, id, business_type, revision, definition_json, status, kind, event_type, created_by, definition_hash)
         values ($1, $2, 'NOTIFICATION', 1, $3::jsonb, 'Published', 'NOTIFICATION', $4, $5, repeat('a', 64))`,
        [TENANT_A, randomUUID(), JSON.stringify({ resolver: { kind: 'role-in-scope', roles: ROLES }, priority: 'HIGH', purpose: 'REMINDER' }), EVENT_TYPE, memberId(REGISTRAR)],
      ],
    ]);

    const contracts = new CtrContractStore();
    const guarantees = new CtrGuaranteeStore();
    const everything = { update: contractScope(grant('guarantee.manage'), 'guarantee.manage', new Date()), read: contractScope(grant('guarantee.read'), 'guarantee.read', new Date()) };
    const created = await as(REGISTRAR, (tx) =>
      contracts.create(tx, { projectId: world.project, packageId: world.packageId, contractorId: world.lead, code: 'HD-N-001', title: 'Bridge', type: 'UNIT_PRICE', advanceCategory: 'CONSTRUCTION', contractValueVnd: '10000000000', documentVersionId: world.document }, memberId(REGISTRAR), '2026-10-24'),
    );
    contractId = created.id;
    const registered = await as(REGISTRAR, (tx) =>
      guarantees.register(
        tx,
        contractId,
        { kind: 'ADVANCE', issuer: 'Bank of the Province', guaranteeNo: 'BL-N-001', amountVnd: '2000000000', validFrom: '2026-03-01', expiresAt: '2026-12-01T16:59:00Z', documentVersionId: world.document },
        memberId(REGISTRAR),
        everything,
        new Date('2026-10-24T03:00:00Z'),
      ),
    );
    guaranteeId = registered.id;
    await as(ACCOUNTANT, (tx) =>
      guarantees.verify(tx, guaranteeId, 1, { outcome: 'VERIFIED', method: 'Confirmation letter', evidenceDocumentVersionId: world.evidence }, memberId(ACCOUNTANT), scopes('guarantee.verify'), new Date('2026-10-24T03:00:00Z')),
    );
  }, 240_000);

  afterAll(() => harness.stop(), 60_000);

  it('turns the 30, 15 and 7 day reminders of a pass into one notification each for the people who read guarantees in the scope, and for no one else (AC-ST-CTR-003-2)', async () => {
    const job = new CtrGuaranteeExpiry(new AuditWriter(harness.tenants));
    for (const day of ['2026-11-01', '2026-11-16', '2026-11-24', '2026-11-24']) await as(JOB, (tx) => job.run(tx, memberId(JOB), new Date(`${day}T06:00:00+07:00`)));
    const events = await deliveries();
    expect(events.map((event) => event.payload.threshold_days)).toEqual([30, 15, 7]);
    for (const event of events) {
      expect(await consumer().handle(event)).toBe('processed');
      // The officer of the department and the chief accountant read guarantees there; the clerk is reached by the role but may not read, the outsider is not in the scope.
      expect(await recipients(event.id)).toEqual([memberId(OFFICER), memberId(ACCOUNTANT)].sort());
    }
    expect(metrics.counters.get('notification_created_total')).toBe(6);
    expect(metrics.counters.get('notification_suppressed_total{reason=no_access}')).toBe(3);
    const priorities = await harness.owner<{ priority: string; purpose: string; source_event_type: string }>(TENANT_A, [['select distinct priority, purpose, source_event_type from machvon.notification_instance', []]]);
    expect(priorities).toEqual([{ priority: 'HIGH', purpose: 'REMINDER', source_event_type: EVENT_TYPE }]);
  });

  it('makes no second notification when an event is delivered again', async () => {
    const [first] = await deliveries();
    if (first === undefined) throw new Error('an event was expected');
    expect(await consumer().handle(first)).toBe('duplicate');
    expect(await recipients(first.id)).toHaveLength(2);
  });

  it('shows the reader the guarantee through a link that opens it again under their own access, and keeps the number and the issuer out of the payload', async () => {
    const [first] = await deliveries();
    expect(first?.payload).toMatchObject({
      guarantee_id: guaranteeId,
      contract_id: contractId,
      kind: 'ADVANCE',
      expires_on: '2026-12-01',
      days_left: 30,
      threshold_days: 30,
      notification: { deepLink: `/ctr/ctr-05?id=${guaranteeId}`, resource: { type: 'guarantee', id: guaranteeId, contractId } },
    });
    expect(JSON.stringify(first?.payload)).not.toMatch(/BL-N-001|Bank of the Province/);
  });

  it('refuses a payload that breaks the registered schema, writing nothing', async () => {
    const [first] = await deliveries();
    if (first === undefined) throw new Error('an event was expected');
    const broken: OutboxDelivery = { ...first, payload: { ...first.payload, threshold_days: 10 } };
    await expect(consumer().handle(broken)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
  });
});
