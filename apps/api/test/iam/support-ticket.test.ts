import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { iamModule } from '../../src/modules/iam';
import { SupportTicketController } from '../../src/modules/iam/support-ticket.controller';
import { PermitGateController } from '../../src/modules/pmt/gate.controller';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const MEMBER = 1; // holds what the MEMBER role holds for tickets: support.ticket.create and support.ticket.read
const OTHER_MEMBER = 2; // the same
const MANAGER = 3; // support.ticket.manage and support.ticket.read on the whole tenant
const SUBTREE_MANAGER = 4; // the same on a subtree only: not the tenant
const NOBODY = 5;
const B_MEMBER = 1; // of tenant B

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the support ticket over HTTP (ST-IAM-007)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const itemsOf = (reply: Reply): Array<Record<string, unknown>> => reply.json.items as Array<Record<string, unknown>>;
  const idOf = (reply: Reply): string => reply.json.resource_id as string;
  const body = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    category: 'ACCESS',
    subject: 'I cannot open the project register',
    description: 'Since this morning the register says I have no access to it.',
    ...overrides,
  });
  const create = (payload: Record<string, unknown>, member = MEMBER, options: { key?: string; tenantId?: string } = {}) =>
    call('POST', '/support-tickets', { member, body: payload, ...(options.key === undefined ? {} : { key: options.key }), ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }) });

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: '/u1/' }, { n: 2, path: '/u1/u2/', parent: 1 }]);
    for (const n of [MEMBER, OTHER_MEMBER, MANAGER, SUBTREE_MANAGER, NOBODY]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, B_MEMBER, 1);
    await harness.seedRole(TENANT_A, 1, 'TICKET_MEMBER', ['support.ticket.create', 'support.ticket.read'], 5);
    await harness.seedRole(TENANT_A, 2, 'TICKET_MANAGER', ['support.ticket.read', 'support.ticket.manage'], 50);
    await harness.seedRole(TENANT_B, 1, 'TICKET_MEMBER', ['support.ticket.create', 'support.ticket.read'], 5);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MEMBER, role: 1, kind: 'TENANT' },
      { n: 2, member: OTHER_MEMBER, role: 1, kind: 'TENANT' },
      { n: 3, member: MANAGER, role: 2, kind: 'TENANT' },
      { n: 4, member: SUBTREE_MANAGER, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_MEMBER, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [SupportTicketController, PermitGateController],
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

  it('is registered in the module of IAM', () => {
    expect(iamModule.controllers).toContain(SupportTicketController);
  });

  describe('createSupportTicket', () => {
    it('creates an open ticket with its code, its priority and its SLA, an audit row and an event that carry no text of the member (AC-ST-IAM-007-1)', async () => {
      const made = await create(body());
      expect(made.status).toBe(200);
      expect(made.json).toMatchObject({ status: 'Open', resource_version: 1 });
      const ticketId = idOf(made);
      const [ticket] = await rows<{ ticket_code: string; priority: string; status: string; requester_membership_id: string; sla_due_at: Date; created_at: Date }>(
        'select ticket_code, priority, status, requester_membership_id, sla_due_at, created_at from machvon.support_ticket where id = $1',
        [ticketId],
      );
      expect(ticket).toMatchObject({ ticket_code: expect.stringMatching(/^SUP-\d{4}-\d{6}$/), priority: 'P2', status: 'Open', requester_membership_id: memberId(MEMBER) });
      expect((ticket?.sla_due_at.getTime() ?? 0) - (ticket?.created_at.getTime() ?? 0)).toBeGreaterThan(0);
      const audits = await rows<{ action: string; actor_id: string; diff: Record<string, unknown> }>('select action, actor_id, safe_diff as diff from machvon.audit_event where resource_id = $1', [ticketId]);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ action: 'support.ticket_created', actor_id: memberId(MEMBER), diff: { ticket_code: ticket?.ticket_code, category: 'ACCESS', priority: 'P2' } });
      const events = await rows<{ type: string; payload: Record<string, unknown> }>('select type, payload from machvon.outbox_event where aggregate_id = $1', [ticketId]);
      expect(events.map((event) => event.type)).toEqual(['iam.support_ticket.created.v1']);
      expect(events[0]?.payload).toMatchObject({ ticket_id: ticketId, ticket_code: ticket?.ticket_code, category: 'ACCESS', priority: 'P2', requester_membership_id: memberId(MEMBER) });
      for (const record of [audits[0]?.diff, events[0]?.payload]) {
        expect(JSON.stringify(record)).not.toContain('project register');
        expect(JSON.stringify(record)).not.toContain('this morning');
      }
    });

    it('numbers the tickets of a tenant one after the other and answers a repeated request with the first answer', async () => {
      const key = `key-${randomUUID()}`;
      const first = await create(body({ category: 'INCIDENT' }), MEMBER, { key });
      const replay = await create(body({ category: 'INCIDENT' }), MEMBER, { key });
      expect(replay.json.resource_id).toBe(first.json.resource_id);
      const second = await create(body({ category: 'HOWTO' }), OTHER_MEMBER);
      const codes = await rows<{ ticket_code: string; priority: string }>('select ticket_code, priority from machvon.support_ticket where id = any($1::uuid[]) order by ticket_code', [[idOf(first), idOf(second)]]);
      expect(codes.map((code) => code.priority)).toEqual(['P1', 'P4']);
      const [low, high] = codes.map((code) => Number(code.ticket_code.slice(-6)));
      expect((high ?? 0) - (low ?? 0)).toBe(1);
      expect(await rows('select 1 from machvon.support_ticket where id = $1', [idOf(first)])).toHaveLength(1);
    });

    it('takes only the fields of the contract, and refuses what is not valid, writing nothing', async () => {
      const before = (await rows('select 1 from machvon.support_ticket')).length;
      for (const extra of [{ priority: 'P1' }, { status: 'Closed' }, { requester_membership_id: memberId(OTHER_MEMBER) }, { ticket_code: 'SUP-2026-000001' }, { sla_due_at: '2030-01-01T00:00:00Z' }]) {
        const reply = await create(body(extra));
        expect([reply.status, reply.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      }
      for (const [change, field] of [
        [{ subject: 'Help' }, 'subject'],
        [{ description: 'Help me' }, 'description'],
        [{ attachment_ids: [randomUUID()] }, 'attachment_ids'],
      ] as const) {
        const reply = await create(body(change));
        expect([reply.status, reply.json.code, reply.json.detail]).toEqual([422, 'VALIDATION_FAILED', field]);
      }
      expect((await create({ category: 'OTHER', subject: 'A subject' })).status).toBe(400);
      expect((await create(body({ category: 'OPINION' }))).status).toBeGreaterThanOrEqual(400);
      expect((await rows('select 1 from machvon.support_ticket')).length).toBe(before);
    });

    it('is for members only: someone without the right is refused', async () => {
      const reply = await create(body(), NOBODY);
      expect([reply.status, reply.json.code]).toEqual([403, 'SCOPE_DENIED']);
    });
  });

  describe('the list (IAM-08)', () => {
    it('shows a member their own tickets with the metadata and the SLA, newest first, and not what they wrote or the tickets of others', async () => {
      const mine = idOf(await create(body({ subject: 'Mine and only mine for the list' })));
      const theirs = idOf(await create(body({ subject: 'Theirs and only theirs for the list' }), OTHER_MEMBER));
      const reply = await call('GET', '/resources/support_ticket', { member: MEMBER });
      expect(reply.status).toBe(200);
      const ids = itemsOf(reply).map((item) => item.id);
      expect(ids).toContain(mine);
      expect(ids).not.toContain(theirs);
      const line = itemsOf(reply).find((item) => item.id === mine);
      expect(line).toMatchObject({ ticket_code: expect.stringMatching(/^SUP-\d{4}-\d{6}$/), category: 'ACCESS', subject: 'Mine and only mine for the list', priority: 'P2', status: 'Open', attachment_count: 0, own: true, version: 1 });
      expect(Object.keys(line ?? {}).sort()).toEqual(['attachment_count', 'category', 'created_at', 'id', 'own', 'priority', 'sla_due_at', 'status', 'subject', 'ticket_code', 'version']);
      expect(JSON.stringify(reply.json)).not.toContain('this morning');
      expect(JSON.stringify(reply.json)).not.toContain(memberId(MEMBER));
    });

    it('shows every ticket of the tenant to someone who manages support on the whole tenant, and says which are theirs; a manager of a subtree sees their own only', async () => {
      const mine = idOf(await create(body({ subject: 'Seen by the manager of the tenant' })));
      const managers = await call('GET', '/resources/support_ticket', { member: MANAGER });
      const line = itemsOf(managers).find((item) => item.id === mine);
      expect(line).toMatchObject({ own: false });
      const subtree = await call('GET', '/resources/support_ticket', { member: SUBTREE_MANAGER });
      expect(itemsOf(subtree).some((item) => item.id === mine)).toBe(false);
    });

    it('filters by status, pages with a cursor and keeps to the tenant of the caller', async () => {
      const id = idOf(await create(body({ subject: 'To be moved on by the operator' })));
      await rows("update machvon.support_ticket set status = 'InProgress', version = version + 1 where id = $1", [id]);
      const progress = await call('GET', '/resources/support_ticket?status=InProgress', { member: MEMBER });
      expect(itemsOf(progress).map((item) => item.id)).toContain(id);
      expect(itemsOf(progress).every((item) => item.status === 'InProgress')).toBe(true);
      const page1 = await call('GET', '/resources/support_ticket?limit=1', { member: MEMBER });
      expect(itemsOf(page1)).toHaveLength(1);
      expect(typeof page1.json.next_cursor).toBe('string');
      const page2 = await call('GET', `/resources/support_ticket?limit=1&cursor=${encodeURIComponent(page1.json.next_cursor as string)}`, { member: MEMBER });
      expect(itemsOf(page2)[0]?.id).not.toBe(itemsOf(page1)[0]?.id);
      expect(itemsOf(await call('GET', '/resources/support_ticket', { member: B_MEMBER, tenantId: TENANT_B }))).toEqual([]);
      expect((await call('GET', '/resources/support_ticket?status=Gone', { member: MEMBER })).status).toBe(422);
      expect((await call('GET', '/resources/support_ticket?limit=0', { member: MEMBER })).status).toBe(422);
      expect((await call('GET', '/resources/support_ticket', { member: NOBODY })).status).toBe(403);
    });
  });

  describe('the operator with only a ticket', () => {
    const operator = { 'x-test-claims': JSON.stringify({ aud: 'control', roles: ['SupportOperator'], sid: 'operator-session' }) };

    async function asOperator(url: string): Promise<Reply> {
      const response = await fetch(`${app.baseUrl}${url}`, { headers: { [TENANT_HEADER]: tokenOf(MEMBER), 'content-type': 'application/json', ...operator } });
      return { status: response.status, json: (await response.json()) as Record<string, unknown> };
    }

    it('is refused the business data of the tenant with SCOPE_DENIED and the refusal leaves an audit row, even for a read (AC-ST-IAM-007-2)', async () => {
      const denied = await asOperator('/resources/permit_gate_rule');
      expect([denied.status, denied.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const audits = await rows<{ actor_id: string; outcome: string; diff: Record<string, unknown> }>(
        "select actor_id, outcome, safe_diff as diff from machvon.audit_event where action = 'authz.denied:get_resources_permit_gate_rule' order by occurred_at desc limit 1",
      );
      expect(audits).toEqual([{ actor_id: memberId(MEMBER), outcome: 'DENIED', diff: { reason: 'PLANE' } }]);
    });

    it('is not what a member with only the rights of a ticket is: they reach no business data either, but they raise and read their own tickets', async () => {
      const denied = await call('GET', '/resources/permit_gate_rule', { member: MEMBER });
      expect([denied.status, denied.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect((await create(body({ subject: 'Still allowed to ask for help' }))).status).toBe(200);
      expect((await call('GET', '/resources/support_ticket', { member: MEMBER })).status).toBe(200);
    });
  });
});
