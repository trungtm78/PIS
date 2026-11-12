import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, NotificationStore, TenantDatabase, enqueueOutbox } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { Client } from 'pg';
import { CommandModule } from '../../src/command.module';
import { NotificationInstancesController, NotificationsController } from '../../src/notifications/notifications.controller';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, grantId, memberId, roleId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const PROJECT = '00000000-0000-4000-8000-0000000000c1';
const WORKFLOW = '00000000-0000-4000-8000-0000000000b1';
const EVENT_TYPE = 'project.stage.changed';

const READER = 1;
const SELF_ONLY = 2;
const OPERATOR = 3;
const NO_PERMISSION = 4;
const OTHER_TENANT = 9;
const SUBTREE_READER = 5;
const PROJECT_READER = 6;
const OTHER_PROJECT = '00000000-0000-4000-8000-0000000000c2';

const ROLE_SELF_READER = 1;
const ROLE_SELF_ONLY = 2;
const ROLE_OPERATOR = 3;
const ROLE_NOTHING = 4;

interface Reply {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
}

interface View {
  id: string;
  title: string;
  priority: string;
  status: string;
  read_at?: string;
  ack_required: boolean;
  acknowledged_at?: string;
  resource_ref?: string;
}

describe('notification inbox, read and acknowledge (ST-NOT-001 backend)', () => {
  const harness = new AuthzHarness();
  const store = new NotificationStore();
  let app: RunningApp;

  const call = async (method: string, path: string, member: number, options: { body?: unknown; key?: string; tenant?: string } = {}): Promise<Reply> => {
    const token = signTenantContext(contextFor(options.tenant ?? TENANT_A, memberId(member)), SIGNING_KEY);
    const headers: Record<string, string> = { [TENANT_HEADER]: token, 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${path}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
  };
  const list = (member: number, query = ''): Promise<Reply> => call('GET', `/me/notifications${query}`, member);
  const read = (member: number, id: string, key?: string): Promise<Reply> => call('POST', `/notifications/${id}/read`, member, { body: { opened_via: 'IN_APP' }, key });
  const acknowledge = (member: number, id: string, body: unknown = {}): Promise<Reply> => call('POST', `/notifications/${id}/acknowledge`, member, { body });
  const itemsOf = (reply: Reply): View[] => reply.json.items as View[];

  async function admin<T extends object>(sql: string, params: unknown[] = []): Promise<T[]> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      return (await client.query(sql, params)).rows as T[];
    } finally {
      await client.end();
    }
  }

  /** A Delivered notification for a member of tenant A about the project, from a real outbox event. */
  async function seed(
    member: number,
    options: { ack?: boolean; resource?: boolean; tenant?: string; project?: string; owner?: { id: string; path: string } } = {},
  ): Promise<string> {
    const tenant = options.tenant ?? TENANT_A;
    const ctx = contextFor(tenant, memberId(member));
    const project = options.project ?? PROJECT;
    // The owner unit and its path are what the event saw when it was written: the path can be stale by the time it is read.
    const owner = options.owner === undefined ? {} : { ownerUnitId: options.owner.id, ownerUnitPath: options.owner.path };
    const notification = options.resource === false ? {} : { resource: { type: 'project', id: project, ...owner }, deepLink: `/prj/prj-01/${project}` };
    return harness.tenants.withTenant(ctx, async (tx) => {
      const { id: eventId } = await enqueueOutbox(tx, {
        aggregateType: 'project',
        aggregateId: PROJECT,
        aggregateVersion: 1,
        type: EVENT_TYPE,
        schemaVersion: 1,
        payload: { notification },
        eventKey: `evt-${randomUUID()}`,
        correlationId: randomUUID(),
      });
      const result = await store.insert(tx, {
        eventId,
        workflowVersionId: WORKFLOW,
        recipientId: memberId(member),
        purpose: 'OPERATIONAL',
        dedupeKey: `n1:${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`,
        expiresAt: new Date(Date.now() + 3_600_000),
        sourceEventType: EVENT_TYPE,
        eventVersion: 1,
        priority: 'HIGH',
        ackRequired: options.ack ?? false,
      });
      return result.id;
    });
  }

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: 1, path: '/1/' }, { n: 2, path: '/1/2/', parent: 1 }, { n: 3, path: '/3/' }]);
    await harness.seedUnits(TENANT_B, [{ n: 1, path: '/1/' }]);
    for (const member of [READER, SELF_ONLY, OPERATOR, NO_PERMISSION, SUBTREE_READER, PROJECT_READER]) await harness.seedMembership(TENANT_A, member, 1);
    await harness.seedMembership(TENANT_B, OTHER_TENANT, 1);
    await harness.seedRole(TENANT_A, ROLE_SELF_READER, 'SELF_READER', ['notification.self', 'project.read'], 30);
    await harness.seedRole(TENANT_A, ROLE_SELF_ONLY, 'SELF_ONLY', ['notification.self'], 30);
    await harness.seedRole(TENANT_A, ROLE_OPERATOR, 'OPERATOR', ['notification_instance.read', 'notification.self'], 30);
    await harness.seedRole(TENANT_A, ROLE_NOTHING, 'NOTHING', ['report.read'], 30);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: READER, role: ROLE_SELF_READER, kind: 'TENANT' },
      { n: 2, member: SELF_ONLY, role: ROLE_SELF_ONLY, kind: 'TENANT' },
      { n: 3, member: OPERATOR, role: ROLE_OPERATOR, kind: 'TENANT' },
      { n: 4, member: NO_PERMISSION, role: ROLE_NOTHING, kind: 'TENANT' },
      { n: 5, member: SUBTREE_READER, role: ROLE_SELF_READER, kind: 'UNIT_SUBTREE', refs: [unitId(1)] },
      { n: 6, member: PROJECT_READER, role: ROLE_SELF_READER, kind: 'PROJECT', refs: [PROJECT] },
    ]);
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.owner(tenant, [
        [
          `insert into machvon.workflow_version (tenant_id, id, business_type, revision, definition_json, status, kind, event_type, created_by, definition_hash)
           values ($1, $2, 'NOTIFICATION', 1, '{}'::jsonb, 'Published', 'NOTIFICATION', $3, $4, repeat('a', 64))`,
          [tenant, WORKFLOW, EVENT_TYPE, '00000000-0000-4000-8000-0000000000f0'],
        ],
      ]);
    }
    const database = new TenantDatabase(harness.appPool);
    const access = new EffectiveAccessStore(database, new InMemoryAuthzCache());
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database }), PolicyModule.register({ database, access })],
      controllers: [NotificationsController, NotificationInstancesController],
      providers: [
        { provide: TenantDatabase, useValue: database },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  describe('the inbox', () => {
    it('lists the caller own notifications newest first as keys and an opaque reference, in keyset pages, and nobody else', async () => {
      const mine: string[] = [];
      for (let n = 0; n < 5; n += 1) mine.push(await seed(READER, { ack: n === 0 }));
      await seed(SELF_ONLY);
      const first = await list(READER, '?limit=3');
      expect(first.status).toBe(200);
      expect(itemsOf(first)).toHaveLength(3);
      expect(first.json.next_cursor).not.toBeNull();
      const second = await list(READER, `?limit=3&cursor=${first.json.next_cursor as string}`);
      expect([...itemsOf(first), ...itemsOf(second)].map((item) => item.id).sort()).toEqual([...mine].sort());
      const item = itemsOf(first)[0];
      expect(item).toMatchObject({ title: 'notification.event.project.stage.changed.title', priority: 'HIGH', status: 'Delivered', resource_ref: `/prj/prj-01/${PROJECT}` });
      expect(Object.keys(item ?? {}).sort()).toEqual(['ack_required', 'id', 'priority', 'resource_ref', 'status', 'title']);
    });

    it('AC-ST-NOT-001-4, AC-ST-KERNEL-061-1 (revocation clause): once the member cannot read the resource the content is replaced by "unavailable" and nothing else is sent', async () => {
      const id = await seed(SELF_ONLY);
      const before = itemsOf(await list(SELF_ONLY)).find((item) => item.id === id);
      expect(before).toMatchObject({ title: 'notification.content.unavailable.title' });
      expect(before?.resource_ref).toBeUndefined();
      expect(JSON.stringify(before)).not.toContain(PROJECT);

      // Give the member the right to read projects, then take it away again (scope version bumped, as the grant commands do).
      await harness.seedGrants(TENANT_A, [{ n: 20, member: SELF_ONLY, role: ROLE_SELF_READER, kind: 'TENANT' }]);
      await admin('update machvon.membership set scope_version = scope_version + 1 where tenant_id = $1 and id = $2', [TENANT_A, memberId(SELF_ONLY)]);
      const during = itemsOf(await list(SELF_ONLY)).find((item) => item.id === id);
      expect(during).toMatchObject({ title: 'notification.event.project.stage.changed.title', resource_ref: `/prj/prj-01/${PROJECT}` });

      await admin("update machvon.role_grant set status = 'Revoked', revoked_at = now() where tenant_id = $1 and id = $2", [TENANT_A, grantId(20)]);
      await admin('update machvon.membership set scope_version = scope_version + 1 where tenant_id = $1 and id = $2', [TENANT_A, memberId(SELF_ONLY)]);
      const after = itemsOf(await list(SELF_ONLY)).find((item) => item.id === id);
      expect(after).toMatchObject({ title: 'notification.content.unavailable.title' });
      expect(after?.resource_ref).toBeUndefined();
    });

    it('reads the owner unit of the resource as it is now: after the unit moved out of the reader subtree the content is unavailable', async () => {
      const id = await seed(SUBTREE_READER, { owner: { id: unitId(2), path: '/1/2/' } });
      const before = itemsOf(await list(SUBTREE_READER)).find((item) => item.id === id);
      expect(before).toMatchObject({ title: 'notification.event.project.stage.changed.title', resource_ref: `/prj/prj-01/${PROJECT}` });

      // The event still says /1/2/ (written before the move); the unit now lives under /3/.
      await admin('update machvon.organization_unit set path = $3, parent_id = $4, depth = 1 where tenant_id = $1 and id = $2', [TENANT_A, unitId(2), '/3/2/', unitId(3)]);
      const after = itemsOf(await list(SUBTREE_READER)).find((item) => item.id === id);
      expect(after).toMatchObject({ title: 'notification.content.unavailable.title' });
      expect(after?.resource_ref).toBeUndefined();
      expect(JSON.stringify(after)).not.toContain(PROJECT);

      // Moved back: readable again, so the answer follows the unit, not the event.
      await admin('update machvon.organization_unit set path = $3, parent_id = $4, depth = 1 where tenant_id = $1 and id = $2', [TENANT_A, unitId(2), '/1/2/', unitId(1)]);
      expect(itemsOf(await list(SUBTREE_READER)).find((item) => item.id === id)).toMatchObject({ title: 'notification.event.project.stage.changed.title' });
    });

    it('treats an owner unit that no longer exists as unknown: a unit-scoped reader loses it, a tenant-wide reader keeps it', async () => {
      const missing = unitId(99);
      const scoped = await seed(SUBTREE_READER, { owner: { id: missing, path: '/1/99/' } });
      const wide = await seed(READER, { owner: { id: missing, path: '/1/99/' } });
      expect(itemsOf(await list(SUBTREE_READER)).find((item) => item.id === scoped)).toMatchObject({ title: 'notification.content.unavailable.title' });
      expect(itemsOf(await list(READER)).find((item) => item.id === wide)).toMatchObject({ title: 'notification.event.project.stage.changed.title' });
    });

    it('keeps a project-scoped reader to the project of the grant: a notification about another project is unavailable', async () => {
      const own = await seed(PROJECT_READER, { project: PROJECT });
      const other = await seed(PROJECT_READER, { project: OTHER_PROJECT });
      const items = itemsOf(await list(PROJECT_READER));
      expect(items.find((item) => item.id === own)).toMatchObject({ title: 'notification.event.project.stage.changed.title' });
      const foreign = items.find((item) => item.id === other);
      expect(foreign).toMatchObject({ title: 'notification.content.unavailable.title' });
      expect(JSON.stringify(foreign)).not.toContain(OTHER_PROJECT);
    });

    it('answers 422 VALIDATION_FAILED naming the cursor for a cursor that is not a timestamp', async () => {
      const cursor = Buffer.from(JSON.stringify(['not-a-date', randomUUID()]), 'utf8').toString('base64url');
      const reply = await list(READER, `?cursor=${cursor}`);
      expect(reply.status).toBe(422);
      expect(reply.json.code).toBe('VALIDATION_FAILED');
    });

    it('shows a notification without a resource to its recipient', async () => {
      const id = await seed(SELF_ONLY, { resource: false });
      expect(itemsOf(await list(SELF_ONLY)).find((item) => item.id === id)).toMatchObject({ title: 'notification.event.project.stage.changed.title' });
    });

    it('refuses a caller without notification.self with 403 SCOPE_DENIED', async () => {
      const reply = await list(NO_PERMISSION);
      expect(reply.status).toBe(403);
      expect(reply.json.code).toBe('SCOPE_DENIED');
    });
  });

  describe('markNotificationRead', () => {
    it('sets read_at once, answers a CommandResult, repeats harmlessly and audits the read', async () => {
      const id = await seed(READER);
      const first = await read(READER, id);
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ status: 'READ', resource_id: id });
      const second = await read(READER, id);
      expect(second.status).toBe(200);
      expect(second.json.resource_version).toBe(first.json.resource_version);
      const item = itemsOf(await list(READER)).find((entry) => entry.id === id);
      expect(item).toMatchObject({ status: 'Read' });
      expect(typeof item?.read_at).toBe('string');
      const audits = await admin<{ n: string }>("select count(*) as n from machvon.audit_event where action = 'notification.read' and resource_id = $1 and outcome = 'SUCCESS'", [id]);
      expect(Number(audits[0]?.n)).toBe(2);
    });

    it('replays the first answer for the same idempotency key', async () => {
      const id = await seed(READER);
      const key = `key-${randomUUID()}`;
      const first = await read(READER, id, key);
      const replay = await read(READER, id, key);
      expect(replay.headers.get('idempotency-replayed')).toBe('true');
      expect(replay.json).toEqual(first.json);
    });

    it('AC-ST-KERNEL-061-1 (other-user clause): answers 404 for a notification of another member and for one that does not exist, without telling them apart', async () => {
      const id = await seed(READER);
      const foreign = await read(SELF_ONLY, id);
      const missing = await read(SELF_ONLY, randomUUID());
      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect({ ...foreign.json, correlation_id: 'x' }).toEqual({ ...missing.json, correlation_id: 'x' });
    });

    it('refuses a body that is not a read receipt', async () => {
      const id = await seed(READER);
      const reply = await call('POST', `/notifications/${id}/read`, READER, { body: { opened_via: 'CARRIER_PIGEON' } });
      expect([400, 422]).toContain(reply.status);
      const unknown = await call('POST', `/notifications/${id}/read`, READER, { body: { opened_via: 'IN_APP', extra: 1 } });
      expect(unknown.status).toBe(400);
      expect(unknown.json.code).toBe('FIELD_NOT_ALLOWED');
    });
  });

  describe('acknowledgeNotification (BR-NOT-05)', () => {
    it('refuses a notification that does not require acknowledgement with 422 ACK_NOT_REQUIRED (AC-ST-NOT-001-3)', async () => {
      const id = await seed(READER, { ack: false });
      await read(READER, id);
      const reply = await acknowledge(READER, id);
      expect(reply.status).toBe(422);
      expect(reply.json.code).toBe('ACK_NOT_REQUIRED');
    });

    it('refuses acknowledging before reading, then acknowledges after reading: read is not acknowledged (AC-ST-NOT-001-3)', async () => {
      const id = await seed(READER, { ack: true });
      const early = await acknowledge(READER, id);
      expect(early.status).toBe(409);
      expect(early.json.code).toBe('NOTIFICATION_STATE_INVALID');
      await read(READER, id);
      const opened = itemsOf(await list(READER)).find((item) => item.id === id);
      expect(opened?.acknowledged_at).toBeUndefined();
      const done = await acknowledge(READER, id, { comment: 'Received, will act today' });
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'ACKNOWLEDGED', resource_id: id });
      const acknowledged = itemsOf(await list(READER)).find((item) => item.id === id);
      expect(typeof acknowledged?.acknowledged_at).toBe('string');
      const events = await admin<{ payload: { comment?: string; recipient_id: string } }>("select payload from machvon.outbox_event where type = 'not.notification.acknowledged.v1' and aggregate_id = $1", [id]);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({ comment: 'Received, will act today', recipient_id: memberId(READER) });
      const audit = await admin<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where action = 'notification.acknowledge' and resource_id = $1", [id]);
      expect(JSON.stringify(audit[0]?.safe_diff)).not.toContain('Received');
    });

    it('UAT-AC181 the inbox row has no read_at before it is opened, then Read with a read_at, then acknowledged at or after the read, and a notification that needs no acknowledgement answers 422 ACK_NOT_REQUIRED', async () => {
      // N-81 asks for an acknowledgement and N-82 does not; both are Delivered to the same person (the push stand-in is the delivered row the store writes).
      const n81 = await seed(READER, { ack: true });
      const n82 = await seed(READER, { ack: false });
      const stamps = (id: string) => admin<{ status: string; read_at: Date | null; acknowledged_at: Date | null }>('select status, read_at, acknowledged_at from machvon.notification_instance where id = $1', [id]);
      // Step 1: read straight after the push: read_at is null, in the row and in the inbox read.
      expect(await stamps(n81)).toEqual([expect.objectContaining({ status: 'Delivered', read_at: null, acknowledged_at: null })]);
      const before = itemsOf(await list(READER)).find((item) => item.id === n81);
      expect(before).toMatchObject({ status: 'Delivered', ack_required: true });
      expect(before?.read_at).toBeUndefined();
      // Step 2: opening it (NOT-02) sets the status to Read and the time of the read.
      expect(await read(READER, n81)).toMatchObject({ status: 200, json: { status: 'READ', resource_id: n81 } });
      const [opened] = await stamps(n81);
      expect(opened).toMatchObject({ status: 'Read', acknowledged_at: null });
      expect(opened?.read_at).toBeInstanceOf(Date);
      expect(itemsOf(await list(READER)).find((item) => item.id === n81)).toMatchObject({ status: 'Read', read_at: expect.any(String) });
      // Step 3: the acknowledgement is stamped at or after the read.
      expect(await acknowledge(READER, n81)).toMatchObject({ status: 200, json: { status: 'ACKNOWLEDGED', resource_id: n81 } });
      const [acknowledged] = await stamps(n81);
      expect(acknowledged?.acknowledged_at).toBeInstanceOf(Date);
      expect((acknowledged?.acknowledged_at as Date).getTime()).toBeGreaterThanOrEqual((acknowledged?.read_at as Date).getTime());
      // Step 4: N-82 needs no acknowledgement: 422 ACK_NOT_REQUIRED, and nothing is stamped.
      await read(READER, n82);
      const refused = await acknowledge(READER, n82);
      expect([refused.status, refused.json.code]).toEqual([422, 'ACK_NOT_REQUIRED']);
      expect((await stamps(n82))[0]?.acknowledged_at).toBeNull();
      // The negative control: a check that a refusal is a 200 must fail on the answer above.
      expect(() => expect([refused.status, refused.json.code]).toEqual([200, 'ACKNOWLEDGED'])).toThrow();
    });

    it('refuses an expired notification with 409 NOTIFICATION_EXPIRED', async () => {
      const id = await seed(READER, { ack: true });
      await read(READER, id);
      await admin("update machvon.notification_instance set expires_at = now() - interval '1 minute' where id = $1", [id]);
      const reply = await acknowledge(READER, id);
      expect(reply.status).toBe(409);
      expect(reply.json.code).toBe('NOTIFICATION_EXPIRED');
    });

    it('refuses a comment longer than 1000 characters and an unknown field', async () => {
      const id = await seed(READER, { ack: true });
      await read(READER, id);
      expect([400, 422]).toContain((await acknowledge(READER, id, { comment: 'x'.repeat(1001) })).status);
      expect((await acknowledge(READER, id, { note: 'x' })).json.code).toBe('FIELD_NOT_ALLOWED');
    });
  });

  describe('operator reads of the notification instances', () => {
    it('lists the metadata of every notification of the tenant, without content, and finds one by id', async () => {
      const id = await seed(READER);
      const page = await call('GET', '/resources/notification_instance?limit=200', OPERATOR);
      expect(page.status).toBe(200);
      const items = page.json.items as Array<Record<string, unknown>>;
      expect(new Set(items.map((item) => item.recipient_id)).size).toBeGreaterThan(1);
      const row = items.find((item) => item.id === id);
      expect(row).toMatchObject({ recipient_id: memberId(READER), purpose: 'OPERATIONAL', source_event_type: EVENT_TYPE, priority: 'HIGH' });
      expect(JSON.stringify(row)).not.toContain(PROJECT);
      expect(row).not.toHaveProperty('title');
      const one = await call('GET', `/resources/notification_instance/${id}`, OPERATOR);
      expect(one.status).toBe(200);
      expect(one.json.id).toBe(id);
    });

    it('is refused without notification_instance.read, and a notification of another tenant is a 404 without leakage', async () => {
      expect((await call('GET', '/resources/notification_instance', READER)).status).toBe(403);
      const foreign = await seed(OTHER_TENANT, { tenant: TENANT_B });
      const reply = await call('GET', `/resources/notification_instance/${foreign}`, OPERATOR);
      expect(reply.status).toBe(404);
      expect(JSON.stringify(reply.json)).not.toContain(foreign);
      const page = await call('GET', '/resources/notification_instance?limit=200', OPERATOR);
      expect((page.json.items as Array<{ id: string }>).some((item) => item.id === foreign)).toBe(false);
    });
  });

  it('keeps fixture ids distinct (guard against fixture drift)', () => {
    expect(new Set([roleId(ROLE_SELF_READER), roleId(ROLE_OPERATOR), grantId(1)]).size).toBe(3);
  });
});
