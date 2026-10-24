import { randomBytes, randomUUID } from 'node:crypto';
import { EffectiveAccessStore, InMemoryAuthzCache, NotificationPreferenceStore, NotificationStore, WORKER_MEMBERSHIP_ID, enqueueOutbox } from '@machvon/db';
import type { NewNotification, OutboxDelivery, TenantTx } from '@machvon/db';
import { signTenantContext } from '@machvon/kernel';
import type { AlertSink, MetricsSink } from '@machvon/kernel';
import { NotificationConsumer } from '../../src/notifications/consumer';
import { PayloadValidator } from '../../src/notifications/payload-validator';
import type { EventTypeCatalog, EventTypeDefinition } from '../../src/notifications/payload-validator';
import { PermissionResourceAccess } from '../../src/notifications/resource-access-port';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, grantId, memberId, roleId, unitId } from '../../../../packages/db/test/support/authz-fixtures';

const SIGNING_KEY = randomBytes(32);
const EVENT_TYPE = 'project.stage.changed';
const PROJECT = '00000000-0000-4000-8000-0000000000c1';

const READER = 1;
const NO_ACCESS = 2;
const SUSPENDED = 3;
const SUBTREE_WATCHER = 4;
const SIBLING_WATCHER = 5;
const TENANT_B_MEMBER = 9;

const ROLE_READER = 1;
const ROLE_OTHER = 2;
const ROLE_WATCHER = 3;

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
  get(name: string): number {
    return this.counters.get(name) ?? 0;
  }
}

class Alerts implements AlertSink {
  readonly raised: string[] = [];
  raise(code: string): void {
    this.raised.push(code);
  }
}

class StaticCatalog implements EventTypeCatalog {
  constructor(private readonly definitions: EventTypeDefinition[]) {}
  async get(eventType: string, schemaVersion: number): Promise<EventTypeDefinition | undefined> {
    return this.definitions.find((definition) => definition.eventType === eventType && definition.schemaVersion === schemaVersion);
  }
}

const PAYLOAD_SCHEMA = {
  type: 'object',
  required: ['notification'],
  properties: {
    notification: { type: 'object', required: ['resource'], properties: { resource: { type: 'object', required: ['type', 'id'] } } },
  },
};

/** Fails after the first notification insert: a crash between the insert and the commit. */
class CrashingStore extends NotificationStore {
  override async insert(tx: TenantTx, notification: NewNotification): Promise<{ id: string; created: boolean }> {
    await super.insert(tx, notification);
    throw new Error('crash before commit');
  }
}

describe('NotificationConsumer (ST-NOT-001)', () => {
  const harness = new AuthzHarness();
  const store = new NotificationStore();
  let metrics: Metrics;
  let alerts: Alerts;
  let access: EffectiveAccessStore;

  const consumer = (overrides: { store?: NotificationStore; catalog?: EventTypeCatalog; preferences?: NotificationPreferenceStore } = {}): NotificationConsumer =>
    new NotificationConsumer({
      database: harness.tenants,
      store: overrides.store ?? store,
      validator: new PayloadValidator(overrides.catalog ?? new StaticCatalog([{ eventType: EVENT_TYPE, schemaVersion: 1, payloadSchema: PAYLOAD_SCHEMA, allowedPurposes: ['OPERATIONAL', 'REMINDER'], status: 'Active' }])),
      loadAccess: (ctx) => access.load(ctx),
      resourceAccess: new PermissionResourceAccess(),
      security: { signingKey: SIGNING_KEY, alerts },
      metrics,
      ...(overrides.preferences === undefined ? {} : { preferences: overrides.preferences }),
    });

  async function delivery(payload: Record<string, unknown>, options: { tenant?: string; type?: string } = {}): Promise<OutboxDelivery> {
    const tenantId = options.tenant ?? TENANT_A;
    const type = options.type ?? EVENT_TYPE;
    const { id } = await harness.tenants.withTenant(contextFor(tenantId, memberId(READER)), (tx) =>
      enqueueOutbox(tx, { aggregateType: 'project', aggregateId: PROJECT, aggregateVersion: 1, type, schemaVersion: 1, payload, eventKey: `evt-${randomUUID()}`, correlationId: randomUUID() }),
    );
    return {
      id,
      tenantId,
      tenantContext: signTenantContext({ tenantId, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, SIGNING_KEY),
      type,
      schemaVersion: 1,
      aggregateType: 'project',
      aggregateId: PROJECT,
      aggregateVersion: 1,
      payload,
      eventKey: 'unused',
      correlationId: randomUUID(),
      attempts: 0,
    };
  }

  const explicit = (...members: number[]): Record<string, unknown> => ({
    notification: { resource: { type: 'project', id: PROJECT }, deepLink: `/prj/prj-01/${PROJECT}`, recipients: members.map((member) => memberId(member)) },
  });

  const rowsOf = (eventId: string) =>
    harness.owner<{ recipient_id: string; priority: string; ack_required: boolean; workflow_version_id: string; expires_in_minutes: string }>(TENANT_A, [
      [
        `select recipient_id, priority, ack_required, workflow_version_id,
                round(extract(epoch from n.expires_at - e.created_at) / 60)::text as expires_in_minutes
           from machvon.notification_instance n join machvon.outbox_event e on e.id = n.event_id
          where n.event_id = $1 order by recipient_id`,
        [eventId],
      ],
    ]);

  const reset = (): void => {
    metrics = new Metrics();
    alerts = new Alerts();
  };

  beforeAll(async () => {
    await harness.start();
    access = new EffectiveAccessStore(harness.tenants, new InMemoryAuthzCache());
    // Unit tree: 1 root, 2 below it, 3 a sibling path that only looks like a prefix of 2 (/1/2/ versus /1/20/).
    await harness.seedUnits(TENANT_A, [
      { n: 1, path: '/1/' },
      { n: 2, path: '/1/2/', parent: 1 },
      { n: 3, path: '/1/20/', parent: 1 },
    ]);
    await harness.seedUnits(TENANT_B, [{ n: 1, path: '/1/' }]);
    for (const member of [READER, NO_ACCESS, SUBTREE_WATCHER, SIBLING_WATCHER]) await harness.seedMembership(TENANT_A, member, 1);
    await harness.seedMembership(TENANT_A, SUSPENDED, 1, { status: 'Suspended' });
    await harness.seedMembership(TENANT_B, TENANT_B_MEMBER, 1);
    await harness.seedRole(TENANT_A, ROLE_READER, 'PROJECT_READER', ['project.read'], 30);
    await harness.seedRole(TENANT_A, ROLE_OTHER, 'OTHER_ROLE', ['report.read'], 30);
    await harness.seedRole(TENANT_A, ROLE_WATCHER, 'PROJECT_WATCHER', ['project.read'], 30);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: READER, role: ROLE_READER, kind: 'TENANT' },
      { n: 2, member: NO_ACCESS, role: ROLE_OTHER, kind: 'TENANT' },
      { n: 3, member: SUSPENDED, role: ROLE_READER, kind: 'TENANT' },
      { n: 4, member: SUBTREE_WATCHER, role: ROLE_WATCHER, kind: 'UNIT_SUBTREE', refs: [unitId(1)] },
      { n: 5, member: SIBLING_WATCHER, role: ROLE_WATCHER, kind: 'UNIT_ONLY', refs: [unitId(3)] },
    ]);
    const approvals = '00000000-0000-4000-8000-0000000000f0';
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.workflow_version (tenant_id, id, business_type, revision, definition_json, status, kind, event_type, created_by, definition_hash)
         values ($1, $2, 'NOTIFICATION', 1, $3::jsonb, 'Published', 'NOTIFICATION', $4, $5, repeat('a', 64))`,
        [TENANT_A, '00000000-0000-4000-8000-0000000000b1', JSON.stringify({ priority: 'HIGH', ackRequired: true, expiresAfterMinutes: 120 }), EVENT_TYPE, approvals],
      ],
    ]);
  }, 180_000);

  beforeEach(reset);
  afterAll(() => harness.stop(), 60_000);

  it('AC-ST-NOT-001-1: an event delivered three times, with a consumer crash in between, yields one notification and two dedupe hits', async () => {
    const event = await delivery(explicit(READER));
    await expect(consumer({ store: new CrashingStore() }).handle(event)).rejects.toThrow('crash before commit');
    expect(await rowsOf(event.id)).toHaveLength(0);
    const inbox = await harness.owner<{ n: string }>(TENANT_A, [["select count(*)::text as n from machvon.integration_event_inbox where event_key = $1", [event.id]]]);
    expect(inbox[0]?.n).toBe('0');

    expect(await consumer().handle(event)).toBe('processed');
    expect(await consumer().handle(event)).toBe('duplicate');
    expect(await consumer().handle(event)).toBe('duplicate');
    const rows = await rowsOf(event.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recipient_id: memberId(READER), priority: 'HIGH', ack_required: true, expires_in_minutes: '120' });
    expect(metrics.get('notification_dedupe_hits_total')).toBe(2);
    expect(metrics.get('notification_created_total')).toBe(1);
  });

  it('AC-ST-NOT-001-2: a replay after the workflow version changed still yields one notification (the key leaves out workflow and channel)', async () => {
    const event = await delivery(explicit(READER));
    await consumer().handle(event);
    const [first] = await rowsOf(event.id);
    await harness.owner(TENANT_A, [
      ["update machvon.workflow_version set status = 'Superseded' where event_type = $1", [EVENT_TYPE]],
      [
        `insert into machvon.workflow_version (tenant_id, id, business_type, revision, definition_json, status, kind, event_type, created_by, definition_hash)
         values ($1, $2, 'NOTIFICATION', 2, '{"priority":"LOW"}'::jsonb, 'Published', 'NOTIFICATION', $3, $4, repeat('b', 64))`,
        [TENANT_A, randomUUID(), EVENT_TYPE, '00000000-0000-4000-8000-0000000000f0'],
      ],
      ['delete from machvon.integration_event_inbox where event_key = $1', [event.id]],
    ]);
    expect(await consumer().handle(event)).toBe('processed');
    const rows = await rowsOf(event.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.workflow_version_id).toBe(first?.workflow_version_id);
    expect(metrics.get('notification_dedupe_hits_total')).toBe(1);
    await harness.owner(TENANT_A, [
      ["delete from machvon.workflow_version where revision = 2 and event_type = $1", [EVENT_TYPE]],
      ["update machvon.workflow_version set status = 'Published' where revision = 1 and event_type = $1", [EVENT_TYPE]],
    ]);
  });

  it('ST-NOT-003: a recipient who switched the inbox off for the category gets no notification of an ordinary event, and always gets an urgent one', async () => {
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.notification_preference (tenant_id, id, membership_id, event_category, channel, enabled) values ($1, gen_random_uuid(), $2, 'project', 'IN_APP', false)`,
        [TENANT_A, memberId(READER)],
      ],
    ]);
    const preferences = new NotificationPreferenceStore();
    // The workflow is HIGH: the inbox of an urgent message is never dropped.
    const urgent = await delivery(explicit(READER));
    await consumer({ preferences }).handle(urgent);
    expect((await rowsOf(urgent.id)).map((row) => row.recipient_id)).toEqual([memberId(READER)]);
    await harness.owner(TENANT_A, [["update machvon.workflow_version set definition_json = '{\"priority\":\"NORMAL\"}'::jsonb where event_type = $1 and status = 'Published'", [EVENT_TYPE]]]);
    try {
      const ordinary = await delivery(explicit(READER));
      await consumer({ preferences }).handle(ordinary);
      expect(await rowsOf(ordinary.id)).toHaveLength(0);
      expect(metrics.get('notification_suppressed_total{reason=preference}')).toBe(1);
      // The same event without the preference store (a consumer that does not know preferences) still creates it.
      const unaware = await delivery(explicit(READER));
      await consumer().handle(unaware);
      expect(await rowsOf(unaware.id)).toHaveLength(1);
    } finally {
      await harness.owner(TENANT_A, [
        [`update machvon.workflow_version set definition_json = $2::jsonb where event_type = $1 and status = 'Published'`, [EVENT_TYPE, JSON.stringify({ priority: 'HIGH', ackRequired: true, expiresAfterMinutes: 120 })]],
        ['delete from machvon.notification_preference where membership_id = $1', [memberId(READER)]],
      ]);
    }
  });

  it('drops recipients without read access, suspended memberships and memberships of another tenant', async () => {
    const event = await delivery(explicit(READER, NO_ACCESS, SUSPENDED, TENANT_B_MEMBER));
    await consumer().handle(event);
    expect((await rowsOf(event.id)).map((row) => row.recipient_id)).toEqual([memberId(READER)]);
    expect(metrics.get('notification_suppressed_total{reason=no_access}')).toBe(1);
  });

  it('role-in-scope reaches the roles whose grant scope contains the resource owner unit, by whole path segments', async () => {
    await harness.owner(TENANT_A, [
      ["update machvon.workflow_version set definition_json = $2::jsonb where event_type = $1", [EVENT_TYPE, JSON.stringify({ resolver: { kind: 'role-in-scope', roles: ['PROJECT_WATCHER'] }, priority: 'NORMAL' })]],
    ]);
    try {
      const inChild = await delivery({ notification: { resource: { type: 'project', id: PROJECT, ownerUnitId: unitId(2), ownerUnitPath: '/1/2/' } } });
      await consumer().handle(inChild);
      expect((await rowsOf(inChild.id)).map((row) => row.recipient_id)).toEqual([memberId(SUBTREE_WATCHER)]);

      // /1/20/ is not below /1/2/: only the member whose UNIT_ONLY grant is exactly unit 3 is reached, plus the subtree watcher.
      const inSibling = await delivery({ notification: { resource: { type: 'project', id: PROJECT, ownerUnitId: unitId(3), ownerUnitPath: '/1/20/' } } });
      await consumer().handle(inSibling);
      expect((await rowsOf(inSibling.id)).map((row) => row.recipient_id).sort()).toEqual([memberId(SUBTREE_WATCHER), memberId(SIBLING_WATCHER)].sort());

      const noOwner = await delivery({ notification: { resource: { type: 'project', id: PROJECT } } });
      await consumer().handle(noOwner);
      expect(await rowsOf(noOwner.id)).toHaveLength(0);
    } finally {
      await harness.owner(TENANT_A, [
        ["update machvon.workflow_version set definition_json = $2::jsonb where event_type = $1", [EVENT_TYPE, JSON.stringify({ priority: 'HIGH', ackRequired: true, expiresAfterMinutes: 120 })]],
      ]);
    }
  });

  it('refuses a payload that breaks its schema and an unregistered type, writing nothing', async () => {
    const broken = await delivery({ notification: {} });
    await expect(consumer().handle(broken)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    const unknown = await delivery(explicit(READER), { type: 'unregistered.event' });
    await expect(consumer().handle(unknown)).rejects.toMatchObject({ code: 'EVENT_TYPE_UNKNOWN', status: 422 });
    for (const event of [broken, unknown]) expect(await rowsOf(event.id)).toHaveLength(0);
    const inbox = await harness.owner<{ n: string }>(TENANT_A, [['select count(*)::text as n from machvon.integration_event_inbox where event_key = any($1::text[])', [[broken.id, unknown.id]]]]);
    expect(inbox[0]?.n).toBe('0');
  });

  it('refuses a deprecated event type', async () => {
    const catalog = new StaticCatalog([{ eventType: EVENT_TYPE, schemaVersion: 1, payloadSchema: PAYLOAD_SCHEMA, allowedPurposes: ['OPERATIONAL'], status: 'Deprecated' }]);
    await expect(consumer({ catalog }).handle(await delivery(explicit(READER)))).rejects.toMatchObject({ code: 'EVENT_TYPE_UNKNOWN' });
  });

  it('refuses a workflow purpose the event type does not allow', async () => {
    const catalog = new StaticCatalog([{ eventType: EVENT_TYPE, schemaVersion: 1, payloadSchema: PAYLOAD_SCHEMA, allowedPurposes: ['SECURITY'], status: 'Active' }]);
    const event = await delivery(explicit(READER));
    await expect(consumer({ catalog }).handle(event)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await rowsOf(event.id)).toHaveLength(0);
  });

  it('writes nothing, and counts it, when the event type has no Published workflow', async () => {
    const catalog = new StaticCatalog([{ eventType: 'no.workflow.event', schemaVersion: 1, payloadSchema: PAYLOAD_SCHEMA, allowedPurposes: ['OPERATIONAL'], status: 'Active' }]);
    const event = await delivery(explicit(READER), { type: 'no.workflow.event' });
    expect(await consumer({ catalog }).handle(event)).toBe('processed');
    expect(await rowsOf(event.id)).toHaveLength(0);
    expect(metrics.get('notification_no_workflow_total{event_type=no.workflow.event}')).toBe(1);
  });

  it('refuses a delivery whose signed context was altered, with an alert, before touching the database', async () => {
    const event = { ...(await delivery(explicit(READER))), tenantId: TENANT_B };
    await expect(consumer().handle(event)).rejects.toMatchObject({ code: 'TENANT_CONTEXT_INVALID' });
    expect(alerts.raised).toContain('OUTBOX_CONTEXT_TAMPERED');
  });

  it('never creates a notification for a membership of another tenant when the event names it', async () => {
    const event = await delivery(explicit(TENANT_B_MEMBER));
    await consumer().handle(event);
    const inB = await harness.owner<{ n: string }>(TENANT_B, [['select count(*)::text as n from machvon.notification_instance', []]]);
    expect(inB[0]?.n).toBe('0');
    expect(await rowsOf(event.id)).toHaveLength(0);
  });

  it('keeps grant ids and role ids of the fixtures distinct (guard against fixture drift)', () => {
    expect(new Set([grantId(1), roleId(ROLE_READER), unitId(1)]).size).toBe(3);
  });
});
