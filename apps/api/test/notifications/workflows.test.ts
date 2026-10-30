import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, NotificationStore, TenantDatabase, WORKER_MEMBERSHIP_ID, enqueueOutbox } from '@machvon/db';
import type { OutboxDelivery } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import type { AlertSink, MetricsSink } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { NotificationConsumer } from '../../src/notifications/consumer';
import { PayloadValidator } from '../../src/notifications/payload-validator';
import type { EventTypeCatalog, EventTypeDefinition } from '../../src/notifications/payload-validator';
import { PermissionResourceAccess } from '../../src/notifications/resource-access-port';
import { NotificationWorkflowsController } from '../../src/notifications/workflows/workflows.controller';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const AUTHOR = 1; // notification.publish on the whole tenant
const PUBLISHER = 2; // the same, another person
const SUBTREE = 3; // the same, on one unit only
const NOBODY = 4; // no right
const RECIPIENT = 5; // reads projects
const OTHER_TENANT_ADMIN = 1; // of tenant B
const EVENT = 'project.stage.changed.v1';
const NARROW_EVENT = 'project.narrow.v1';
const OLD_EVENT = 'project.retired.v1';
const OLD_EVENT_LEGACY = 'project.legacy.v1';
const PROJECT = '00000000-0000-4000-8000-0000000000c1';
const REASON = 'Reviewed with the owner of the process.';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

class StaticCatalog implements EventTypeCatalog {
  constructor(private readonly definitions: EventTypeDefinition[]) {}
  async get(eventType: string, schemaVersion: number): Promise<EventTypeDefinition | undefined> {
    return this.definitions.find((definition) => definition.eventType === eventType && definition.schemaVersion === schemaVersion);
  }
}

const noMetrics: MetricsSink = { increment: () => undefined, gauge: () => undefined };
const noAlerts: AlertSink = { raise: () => undefined };

describe('the event catalogue and the notification workflows (ST-NOT-004, NOT-05, NOT-06)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let access: EffectiveAccessStore;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  const rows = <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

  async function call(method: 'GET' | 'POST', url: string, options: { member?: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member ?? AUTHOR, options.tenantId), 'content-type': 'application/json' };
    if (method === 'POST') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, ...(method === 'POST' ? { body: JSON.stringify(options.body ?? {}) } : {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const definition = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    priority: 'HIGH',
    purpose: 'OPERATIONAL',
    ackRequired: true,
    expiresAfterMinutes: 120,
    channels: [{ channel: 'IN_APP' }],
    resolver: { kind: 'explicit' },
    ...overrides,
  });
  const draft = (body: Record<string, unknown>, member = AUTHOR, tenantId = TENANT_A) => call('POST', '/notification-workflows', { member, tenantId, body });
  const draftOf = (overrides: Record<string, unknown> = {}, eventType = EVENT) => draft({ event_type: eventType, definition: definition(overrides) });
  const publish = (id: string, version: number, member = PUBLISHER, tenantId = TENANT_A) =>
    call('POST', `/notification-workflows/${id}/publish`, { member, tenantId, ifMatch: `"${version}"`, body: { decision: 'approve', reason: REASON, evidence_ids: [] } });
  const workflows = async (query = ''): Promise<Array<Record<string, unknown>>> => (await call('GET', `/notification-workflows${query}`)).json.items as Array<Record<string, unknown>>;

  /** Drafts and publishes a revision made by the author and published by the other administrator. */
  async function inForce(overrides: Record<string, unknown> = {}, eventType = EVENT): Promise<string> {
    const made = await draftOf(overrides, eventType);
    expect(made.status).toBe(201);
    const done = await publish(made.json.resource_id as string, made.json.resource_version as number);
    expect(done.status).toBe(200);
    return made.json.resource_id as string;
  }

  beforeAll(async () => {
    await harness.start();
    access = new EffectiveAccessStore(harness.tenants, new InMemoryAuthzCache());
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }, { n: 2, path: `/${unitId(1)}/${unitId(2)}/`, parent: 1 }]);
    for (const [member, unit] of [[AUTHOR, 1], [PUBLISHER, 1], [SUBTREE, 2], [NOBODY, 1], [RECIPIENT, 1]] as const) await harness.seedMembership(TENANT_A, member, unit, { validFrom: '2026-01-01T00:00:00Z' });
    await harness.seedMembership(TENANT_B, OTHER_TENANT_ADMIN, 1, { validFrom: '2026-01-01T00:00:00Z' });
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedRole(tenant, 1, 'NOTIFICATION_ADMIN', ['notification.publish'], 50);
      await harness.seedRole(tenant, 2, 'PROJECT_READER', ['project.read'], 30);
    }
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: AUTHOR, role: 1, kind: 'TENANT' },
      { n: 2, member: PUBLISHER, role: 1, kind: 'TENANT' },
      { n: 3, member: SUBTREE, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 4, member: RECIPIENT, role: 2, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT_ADMIN, role: 1, kind: 'TENANT' }]);
    // The catalogue is the platform's: three entries of this test, among the ones the modules registered.
    await rows(
      `insert into machvon.notification_event_type (id, event_type, owning_module, schema_version, payload_schema, allowed_purposes, data_classification, status)
       values (gen_random_uuid(), $1, 'PRJ', 1, '{"type":"object"}'::jsonb, '{OPERATIONAL,REMINDER}', 'INTERNAL', 'Active'),
              (gen_random_uuid(), $2, 'PRJ', 1, '{"type":"object"}'::jsonb, '{OPERATIONAL}', 'CONFIDENTIAL', 'Active'),
              (gen_random_uuid(), $3, 'PRJ', 1, '{"type":"object"}'::jsonb, '{OPERATIONAL}', 'INTERNAL', 'Deprecated'),
              (gen_random_uuid(), $4, 'PRJ', 1, '{"type":"object"}'::jsonb, '{OPERATIONAL}', 'INTERNAL', 'Active')`,
      [EVENT, NARROW_EVENT, OLD_EVENT, OLD_EVENT_LEGACY],
    );
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access })],
      controllers: [NotificationWorkflowsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await harness.stop();
  }, 60_000);

  describe('the catalogue (NOT-05)', () => {
    it('lists the event types with the module, the purposes, the classification and the state, and never the schema of the payload', async () => {
      const reply = await call('GET', '/notification-event-types');
      expect(reply.status).toBe(200);
      const items = reply.json.items as Array<Record<string, unknown>>;
      expect(items.find((item) => item.event_type === EVENT)).toEqual({ event_type: EVENT, owning_module: 'PRJ', schema_version: 1, allowed_purposes: ['OPERATIONAL', 'REMINDER'], data_classification: 'INTERNAL', status: 'Active' });
      expect(items.find((item) => item.event_type === NARROW_EVENT)).toMatchObject({ data_classification: 'CONFIDENTIAL' });
      expect(items.find((item) => item.event_type === OLD_EVENT)).toMatchObject({ status: 'Deprecated' });
      expect(JSON.stringify(reply.json)).not.toContain('payload_schema');
    });

    it('is a read for who may publish workflows: somebody without the right, or with it on one unit only, is refused the workflows too', async () => {
      expect((await call('GET', '/notification-event-types', { member: NOBODY })).status).toBe(403);
      expect((await call('GET', '/notification-workflows', { member: NOBODY })).status).toBe(403);
      // A grant on one unit does not read what is the whole tenant's: the workflows, who wrote them, and the catalogue they are written from.
      expect((await call('GET', '/notification-workflows', { member: SUBTREE })).status).toBe(403);
      expect((await call('GET', '/notification-event-types', { member: SUBTREE })).status).toBe(403);
    });
  });

  describe('writing a draft (NOT-06)', () => {
    it('AC-ST-NOT-004-1 UAT-AC194: an event type that is not registered, or no longer accepted, is refused with 422 EVENT_TYPE_UNKNOWN and nothing is written', async () => {
      const before = (await workflows()).length;
      for (const eventType of ['not.registered.v1', OLD_EVENT]) {
        const refused = await draftOf({}, eventType);
        expect(refused.status).toBe(422);
        expect(refused.json.code).toBe('EVENT_TYPE_UNKNOWN');
      }
      expect(await workflows()).toHaveLength(before);
    });

    it('writes a draft of the event type: Draft, revision 1 then 2, the definition as given, the author kept, an audit row with no definition in it', async () => {
      const first = await draftOf({ priority: 'NORMAL' }, NARROW_EVENT);
      expect(first.status).toBe(201);
      expect(first.json).toMatchObject({ status: 'DRAFT', resource_version: 1 });
      const second = await draftOf({ priority: 'LOW' }, NARROW_EVENT);
      const listed = (await workflows(`?event_type=${NARROW_EVENT}`)).map((row) => ({ revision: row.revision, status: row.status, event_type: row.event_type, created_by: row.created_by }));
      expect(listed).toEqual([
        { revision: 2, status: 'Draft', event_type: NARROW_EVENT, created_by: memberId(AUTHOR) },
        { revision: 1, status: 'Draft', event_type: NARROW_EVENT, created_by: memberId(AUTHOR) },
      ]);
      const [kept] = await rows<{ business_type: string; kind: string; definition_json: { priority: string } }>('select business_type, kind, definition_json from machvon.workflow_version where id = $1', [second.json.resource_id]);
      expect(kept).toMatchObject({ business_type: NARROW_EVENT, kind: 'NOTIFICATION', definition_json: { priority: 'LOW' } });
      const audits = await rows<{ action: string; safe_diff: unknown }>("select action, safe_diff from machvon.audit_event where resource_id = $1 and action = 'notification.workflow_created'", [second.json.resource_id]);
      expect(audits).toHaveLength(1);
      expect(audits[0]?.safe_diff).toEqual({ event_type: NARROW_EVENT, revision: 2 });
    });

    it('refuses a definition that is wrong and names the field: a key nobody reads, a purpose the event type does not allow, a bad channel, priority or expiry', async () => {
      const wrong: Array<[Record<string, unknown>, string]> = [
        [{ colour: 'red' }, 'definition.colour'],
        [{ purpose: 'ANNOUNCEMENT' }, 'definition.purpose'],
        [{ priority: 'URGENT' }, 'definition.priority'],
        [{ channels: [{ channel: 'TELEGRAM' }] }, 'definition.channels.channel'],
        [{ channels: [{ channel: 'EMAIL' }] }, 'definition.channels.templateCode'],
        [{ expiresAfterMinutes: 0 }, 'definition.expiresAfterMinutes'],
        [{ resolver: { kind: 'role-in-scope', roles: [] } }, 'definition.resolver.roles'],
      ];
      for (const [overrides, field] of wrong) {
        const refused = await draftOf(overrides, NARROW_EVENT);
        expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'WORKFLOW_DEFINITION_INVALID', field]);
      }
      expect((await draft({ event_type: EVENT, definition: 'text' })).status).toBe(400);
    });

    it('lets the quiet hours be overridden only for a CRITICAL message with a reason, and takes a reason for nothing else', async () => {
      const cases: Array<[Record<string, unknown>, number]> = [
        [{ priority: 'HIGH', quietHoursOverride: true, quietHoursOverrideReason: 'The incident desk must be reached at night.' }, 422],
        [{ priority: 'CRITICAL', quietHoursOverride: true }, 422],
        [{ priority: 'CRITICAL', quietHoursOverride: true, quietHoursOverrideReason: 'short' }, 422],
        [{ priority: 'CRITICAL', quietHoursOverride: false, quietHoursOverrideReason: 'The incident desk must be reached at night.' }, 422],
        [{ priority: 'CRITICAL', quietHoursOverride: true, quietHoursOverrideReason: 'The incident desk must be reached at night.' }, 201],
      ];
      for (const [overrides, status] of cases) {
        const reply = await draftOf(overrides, NARROW_EVENT);
        expect([reply.status, status === 201 ? 201 : reply.json.code]).toEqual([status, status === 201 ? 201 : 'WORKFLOW_DEFINITION_INVALID']);
      }
    });

    it('says the business type once: it is the event type, and a different one is refused', async () => {
      const refused = await draft({ event_type: EVENT, business_type: 'something.else', definition: definition() });
      expect([refused.status, refused.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect((await draft({ event_type: NARROW_EVENT, business_type: NARROW_EVENT, definition: definition() })).status).toBe(201);
    });

    it('is the right of who holds the permission on the whole tenant: a person with it on one unit, or none, is refused with 403 and nothing is written', async () => {
      const before = (await workflows()).length;
      expect((await draft({ event_type: EVENT, definition: definition() }, SUBTREE)).status).toBe(403);
      expect((await draft({ event_type: EVENT, definition: definition() }, NOBODY)).status).toBe(403);
      expect(await workflows()).toHaveLength(before);
    });
  });

  describe('publishing (NOT-06)', () => {
    it('is not done by the person who wrote the draft: 403 SELF_APPROVAL_DENIED, and the draft stays a draft', async () => {
      const made = await draftOf();
      const refused = await publish(made.json.resource_id as string, made.json.resource_version as number, AUTHOR);
      expect([refused.status, refused.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect((await workflows()).find((row) => row.id === made.json.resource_id)).toMatchObject({ status: 'Draft', published_by: null });
    });

    it('needs the version the person saw, a go-ahead and the whole tenant', async () => {
      const made = await draftOf();
      const id = made.json.resource_id as string;
      expect((await publish(id, 99)).status).toBe(409);
      expect((await call('POST', `/notification-workflows/${id}/publish`, { member: PUBLISHER, body: { decision: 'approve', reason: REASON, evidence_ids: [] } })).status).toBe(428);
      const returned = await call('POST', `/notification-workflows/${id}/publish`, { member: PUBLISHER, ifMatch: '"1"', body: { decision: 'reject', reason: REASON, evidence_ids: [] } });
      expect([returned.status, returned.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect((await publish(id, 1, SUBTREE)).status).toBe(403);
      expect((await publish(id, 1, NOBODY)).status).toBe(403);
      expect((await publish(randomUUID(), 1)).status).toBe(404);
      expect((await workflows()).find((row) => row.id === id)).toMatchObject({ status: 'Draft' });
    });

    it('publishes a draft by another person, supersedes the one in force, tells the world once, and refuses to publish it again', async () => {
      const first = await inForce({ priority: 'LOW' }, NARROW_EVENT);
      const made = await draftOf({ priority: 'NORMAL' }, NARROW_EVENT);
      const id = made.json.resource_id as string;
      const done = await publish(id, made.json.resource_version as number);
      expect(done.json).toMatchObject({ status: 'PUBLISHED', resource_id: id });
      const byId = new Map((await workflows(`?event_type=${NARROW_EVENT}`)).map((row) => [row.id as string, row]));
      expect(byId.get(id)).toMatchObject({ status: 'Published', published_by: memberId(PUBLISHER), supersedes_id: first });
      expect(byId.get(first)).toMatchObject({ status: 'Superseded' });
      expect([...byId.values()].filter((row) => row.status === 'Published')).toHaveLength(1);
      const audits = await rows<{ reason: string }>("select reason from machvon.audit_event where resource_id = $1 and action = 'notification.workflow_published'", [id]);
      expect(audits).toEqual([{ reason: REASON }]);
      const events = await rows<{ type: string }>("select type from machvon.outbox_event where aggregate_id = $1 and type = 'not.workflow.published.v1'", [id]);
      expect(events).toHaveLength(1);
      const again = await publish(id, (done.json.resource_version as number) ?? 2);
      expect([again.status, again.json.code]).toEqual([409, 'WORKFLOW_NOT_DRAFT']);
    });

    it('supersedes the workflow of an event type that was written before, whatever its business type, and numbers the new revision after it', async () => {
      const legacy = randomUUID();
      await rows(
        `insert into machvon.workflow_version (tenant_id, id, business_type, revision, definition_json, status, kind, event_type, created_by, definition_hash)
         values ($1, $2, 'NOTIFICATION', 7, '{"priority":"LOW"}'::jsonb, 'Published', 'NOTIFICATION', $3, $4, repeat('a', 64))`,
        [TENANT_A, legacy, OLD_EVENT_LEGACY, memberId(AUTHOR)],
      );
      const made = await draftOf({}, OLD_EVENT_LEGACY);
      expect(made.status).toBe(201);
      expect((await workflows(`?event_type=${OLD_EVENT_LEGACY}`)).find((row) => row.id === made.json.resource_id)).toMatchObject({ revision: 8 });
      expect((await publish(made.json.resource_id as string, 1)).status).toBe(200);
      const byId = new Map((await workflows(`?event_type=${OLD_EVENT_LEGACY}`)).map((row) => [row.id as string, row]));
      expect(byId.get(legacy)).toMatchObject({ status: 'Superseded' });
      expect(byId.get(made.json.resource_id as string)).toMatchObject({ status: 'Published', supersedes_id: legacy });
      expect([...byId.values()].filter((row) => row.status === 'Published')).toHaveLength(1);
    });

    it('filters the list by status and pages it newest first', async () => {
      await inForce({}, NARROW_EVENT);
      const published = await workflows('?status=Published');
      expect(published.length).toBeGreaterThan(0);
      expect(published.every((row) => row.status === 'Published')).toBe(true);
      expect((await call('GET', '/notification-workflows?status=Bogus')).status).toBe(422);
      const all = await workflows('?limit=200');
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: Reply = await call('GET', `/notification-workflows?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`);
        seen.push(...(page.json.items as Array<{ id: string }>).map((row) => row.id));
        cursor = page.json.next_cursor as string | null;
      } while (cursor !== null);
      expect(seen).toEqual(all.map((row) => row.id));
    });

    it('keeps the workflows of one tenant from another: nothing of tenant A is listed, read or published by tenant B', async () => {
      const made = await draftOf({}, NARROW_EVENT);
      expect(await workflows('?limit=200').then((items) => items.length)).toBeGreaterThan(0);
      const listedByB = await call('GET', '/notification-workflows?limit=200', { member: OTHER_TENANT_ADMIN, tenantId: TENANT_B });
      expect(listedByB.json.items).toEqual([]);
      const refused = await publish(made.json.resource_id as string, 1, OTHER_TENANT_ADMIN, TENANT_B);
      expect(refused.status).toBe(404);
      expect((await workflows()).find((row) => row.id === made.json.resource_id)).toMatchObject({ status: 'Draft' });
    });
  });

  describe('the notifications follow the workflow in force (AC-ST-NOT-004-2, UAT-AC26)', () => {
    const consumer = (): NotificationConsumer =>
      new NotificationConsumer({
        database: harness.tenants,
        store: new NotificationStore(),
        validator: new PayloadValidator(
          new StaticCatalog([
            { eventType: EVENT, schemaVersion: 1, payloadSchema: { type: 'object', required: ['notification'] }, allowedPurposes: ['OPERATIONAL', 'REMINDER'], status: 'Active' },
          ]),
        ),
        loadAccess: (ctx) => access.load(ctx),
        resourceAccess: new PermissionResourceAccess(),
        security: { signingKey: SIGNING_KEY, alerts: noAlerts },
        metrics: noMetrics,
      });

    async function event(): Promise<OutboxDelivery> {
      const payload = { notification: { resource: { type: 'project', id: PROJECT }, deepLink: `/prj/prj-01/${PROJECT}`, recipients: [memberId(RECIPIENT)] } };
      const { id } = await harness.tenants.withTenant(contextFor(TENANT_A, memberId(AUTHOR)), (tx) =>
        enqueueOutbox(tx, { aggregateType: 'project', aggregateId: PROJECT, aggregateVersion: 1, type: EVENT, schemaVersion: 1, payload, eventKey: `evt-${randomUUID()}`, correlationId: randomUUID() }),
      );
      return {
        id,
        tenantId: TENANT_A,
        tenantContext: signTenantContext({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, SIGNING_KEY),
        type: EVENT,
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

    const madeFrom = (eventId: string) =>
      rows<{ workflow_version_id: string; priority: string }>('select workflow_version_id, priority from machvon.notification_instance where event_id = $1 order by recipient_id', [eventId]);

    it('writes new notifications from the revision published last, keeps the older ones on theirs, and still blocks a duplicate', async () => {
      // Revisions 1 and 2 are published and superseded on the way; revision 3 is the one in force when the first event arrives.
      await inForce({ priority: 'LOW' });
      await inForce({ priority: 'NORMAL' });
      const v3 = await inForce({ priority: 'HIGH' });
      const first = await event();
      expect(await consumer().handle(first)).toBe('processed');
      expect(await madeFrom(first.id)).toEqual([{ workflow_version_id: v3, priority: 'HIGH' }]);

      const v4 = await inForce({ priority: 'CRITICAL' });
      const second = await event();
      expect(await consumer().handle(second)).toBe('processed');
      expect(await madeFrom(second.id)).toEqual([{ workflow_version_id: v4, priority: 'CRITICAL' }]);
      // The notification made before is as it was, on revision 3.
      expect(await madeFrom(first.id)).toEqual([{ workflow_version_id: v3, priority: 'HIGH' }]);

      // The same event delivered again is a duplicate; and when the inbox forgot it, the key of the notification still blocks a second one, which stays on revision 3.
      expect(await consumer().handle(first)).toBe('duplicate');
      await rows('delete from machvon.integration_event_inbox where event_key = $1', [first.id]);
      expect(await consumer().handle(first)).toBe('processed');
      expect(await madeFrom(first.id)).toEqual([{ workflow_version_id: v3, priority: 'HIGH' }]);
    });
  });
});
