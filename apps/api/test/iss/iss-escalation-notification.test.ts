import { randomBytes, randomUUID } from 'node:crypto';
import { AuditWriter, EffectiveAccessStore, InMemoryAuthzCache, IssSlaJob, NotificationStore, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import type { OutboxDelivery } from '@machvon/db';
import { signTenantContext } from '@machvon/kernel';
import type { AlertSink, MetricsSink } from '@machvon/kernel';
import { NotificationConsumer } from '../../src/notifications/consumer';
import { PayloadValidator } from '../../src/notifications/payload-validator';
import type { EventTypeCatalog, EventTypeDefinition } from '../../src/notifications/payload-validator';
import { PermissionResourceAccess } from '../../src/notifications/resource-access-port';
import { Client } from 'pg';
import { FAMILY, IssWorld, PEOPLE, PROJECT, TENANT_A, UNIT_1, id, memberId } from '../../../../packages/db/test/support/iss-fixtures';

const SIGNING_KEY = randomBytes(32);
const EVENT_TYPE = 'iss.issue.escalated.v1';
const TASK_FORCE = id(FAMILY, 50);
const AT_L3 = new Date('2026-08-12T07:00:00Z');

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

describe('the escalation of an issue reaches the people who answer for it (ST-ISS-004, docs/notification-event-types.md)', () => {
  const world = new IssWorld();
  const metrics = new Metrics();
  let definition: EventTypeDefinition;
  let access: EffectiveAccessStore;
  let issueId = '';

  const consumer = (): NotificationConsumer =>
    new NotificationConsumer({
      database: world.harness.tenants,
      store: new NotificationStore(),
      validator: new PayloadValidator(new StaticCatalog(definition)),
      loadAccess: (ctx) => access.load(ctx),
      resourceAccess: new PermissionResourceAccess(),
      security: { signingKey: SIGNING_KEY, alerts },
      metrics,
    });

  async function deliveries(): Promise<OutboxDelivery[]> {
    const rows = await world.owner<{ id: string; type: string; payload: Record<string, unknown>; aggregate_version: string; event_key: string }>(
      'select id, type, payload, aggregate_version::text as aggregate_version, event_key from machvon.outbox_event where aggregate_id = $1::uuid and type = $2 order by (payload ->> $3)::int',
      [issueId, EVENT_TYPE, 'level'],
    );
    return rows.map((row) => ({
      id: row.id,
      tenantId: TENANT_A,
      tenantContext: signTenantContext({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, SIGNING_KEY),
      type: row.type,
      schemaVersion: 1,
      aggregateType: 'issue',
      aggregateId: issueId,
      aggregateVersion: Number(row.aggregate_version),
      payload: row.payload,
      eventKey: row.event_key,
      correlationId: randomUUID(),
      attempts: 0,
    }));
  }
  const recipients = async (eventId: string): Promise<string[]> =>
    (await world.owner<{ recipient_id: string }>('select recipient_id from machvon.notification_instance where event_id = $1 order by recipient_id', [eventId])).map((row) => row.recipient_id);

  beforeAll(async () => {
    await world.start();
    access = new EffectiveAccessStore(world.harness.tenants, new InMemoryAuthzCache());
    // The people who answer for the project and the task force; each reads issues over what their role reaches.
    await world.harness.seedRole(TENANT_A, 10, 'ISSUE_READER_UNIT', ['issue.read'], 20);
    await world.harness.seedGrants(TENANT_A, [
      { n: 20, member: PEOPLE.UNIT_HEAD, role: 10, kind: 'UNIT_SUBTREE', refs: [UNIT_1] },
      { n: 21, member: PEOPLE.TF_LEAD, role: 10, kind: 'TENANT' },
    ]);
    const admin = new Client({ connectionString: world.harness.database.adminUrl });
    await admin.connect();
    try {
      await admin.query('set session_replication_role = replica');
      await admin.query(
        `insert into machvon.task_force (tenant_id, id, code, name, purpose, lead_membership_id, scope_unit_id, valid_from, status, created_by, updated_by)
         values ($1, $2, 'TF-N-01', 'Task force', 'Clear the plots', $3, $4, date '2026-01-01', 'ACTIVE', $3, $3)`,
        [TENANT_A, TASK_FORCE, memberId(PEOPLE.TF_LEAD), UNIT_1],
      );
      await admin.query(
        `insert into machvon.task_force_member (tenant_id, id, task_force_id, membership_id, member_role, valid_from, created_by, updated_by)
         values ($1, $2, $3, $4, 'MEMBER', date '2026-01-01', $4, $4)`,
        [TENANT_A, id(FAMILY, 51), TASK_FORCE, memberId(PEOPLE.TF_MEMBER)],
      );
      await admin.query(
        `insert into machvon.project_accountability (tenant_id, id, project_id, leader_membership_id, accountability_role, valid_from, status, created_by, updated_by)
         values ($1, $2, $3, $4, 'LEADER_IN_CHARGE', date '2026-01-01', 'ACTIVE', $4, $4)`,
        [TENANT_A, id(FAMILY, 52), PROJECT, memberId(PEOPLE.UNIT_HEAD)],
      );
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
    await world.owner(
      `insert into machvon.workflow_version (tenant_id, id, business_type, revision, definition_json, status, kind, event_type, created_by, definition_hash)
       values ($1, $2, 'NOTIFICATION', 1, $3::jsonb, 'Published', 'NOTIFICATION', $4, $5, repeat('a', 64))`,
      [TENANT_A, randomUUID(), JSON.stringify({ resolver: { kind: 'explicit' }, priority: 'HIGH', purpose: 'OPERATIONAL' }), EVENT_TYPE, memberId(PEOPLE.REPORTER)],
    );
    const created = await world.open();
    issueId = created.id;
    await world.inProgress(created);
    await world.as((tx) => new IssSlaJob(new AuditWriter(world.harness.tenants), { deadlines: world.deadlines }).run(tx, memberId(PEOPLE.SYSTEM), AT_L3));
  }, 240_000);

  afterAll(() => world.stop(), 60_000);

  it('AC-ST-ISS-004-1: tells the people who answer for the project at level 2 and the task force at level 3, and no one who may not read the issue', async () => {
    const events = await deliveries();
    expect(events.map((event) => event.payload.level)).toEqual([2, 3]);
    for (const event of events) expect(await consumer().handle(event)).toBe('processed');
    // The leader of the project reads issues over unit 1. Of the task force, the lead reads issues and the member does not: the member is dropped, not told.
    expect(await recipients(events[0]?.id ?? '')).toEqual([memberId(PEOPLE.UNIT_HEAD)]);
    expect(await recipients(events[1]?.id ?? '')).toEqual([memberId(PEOPLE.TF_LEAD)]);
    expect(metrics.counters.get('notification_suppressed_total{reason=no_access}')).toBe(1);
    const stored = await world.owner<{ priority: string; purpose: string; source_event_type: string }>('select distinct priority, purpose, source_event_type from machvon.notification_instance');
    expect(stored).toEqual([{ priority: 'HIGH', purpose: 'OPERATIONAL', source_event_type: EVENT_TYPE }]);
  });

  it('makes no second notification when an event is delivered again', async () => {
    const [first] = await deliveries();
    if (first === undefined) throw new Error('an event was expected');
    expect(await consumer().handle(first)).toBe('duplicate');
    expect(await recipients(first.id)).toHaveLength(1);
  });

  it('opens the issue through a link and keeps the title and the description out of the payload', async () => {
    const [first] = await deliveries();
    expect(first?.payload).toMatchObject({ issue_id: issueId, level: 2, trigger: 'SLA_AUTO', notification: { deepLink: `/iss/iss-03?id=${issueId}`, resource: { type: 'issue', id: issueId } } });
    expect(JSON.stringify(first?.payload)).not.toMatch(/handover|compensation/);
  });

  it('refuses a payload that breaks the registered schema, writing nothing', async () => {
    const [first] = await deliveries();
    if (first === undefined) throw new Error('an event was expected');
    const broken: OutboxDelivery = { ...first, payload: { ...first.payload, level: 9 } };
    await expect(consumer().handle(broken)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
  });
});
