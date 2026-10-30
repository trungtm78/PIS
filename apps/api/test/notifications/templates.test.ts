import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { CHANNEL_ADAPTERS, ChannelAdapterRegistry, InMemoryChannelAdapter } from '../../src/notifications/delivery/channel-adapters';
import { NotificationTemplatesController } from '../../src/notifications/templates/templates.controller';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const AUTHOR = 1; // template.manage on the whole tenant
const APPROVER = 2; // template.manage and template.approve on the whole tenant
const SUBTREE = 3; // both, on one unit only
const NOBODY = 4;
const LISTED = 5; // a member on the list of test recipients
const NOT_LISTED = 6; // a member who is not
const OTHER_TENANT_ADMIN = 1; // of tenant B
const REASON = 'Reviewed with the owner of the process.';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const SCHEMA = {
  type: 'object',
  properties: {
    code: { type: 'string', classification: 'PUBLIC' },
    unit: { type: 'string', classification: 'INTERNAL' },
    amount: { type: 'money', classification: 'INTERNAL' },
    secret: { type: 'string', classification: 'CONFIDENTIAL' },
  },
};

describe('the templates of the messages, their review and the test sends (ST-NOT-005, NOT-07, NOT-08)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let email: InMemoryChannelAdapter;
  let sms: InMemoryChannelAdapter;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  const rows = <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

  async function call(method: 'GET' | 'POST' | 'PUT', url: string, options: { member?: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member ?? AUTHOR, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, ...(method === 'GET' ? {} : { body: JSON.stringify(options.body ?? {}) }) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const code = (): string => `tpl.matrix-${(counter += 1)}-${randomUUID().slice(0, 6)}`;
  const body = (channel: string, content: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
    code: code(),
    channel,
    locale: 'vi-VN',
    purpose: 'OPERATIONAL',
    content_ast: content,
    variable_schema: SCHEMA,
    ...(channel.startsWith('PUSH') ? { lockscreen_safe: true } : {}),
    ...overrides,
  });
  const create = (payload: Record<string, unknown>, member = AUTHOR, tenantId = TENANT_A) => call('POST', '/notification-templates', { member, tenantId, body: payload });
  const submit = (id: string, version: number, member = AUTHOR) => call('POST', `/notification-templates/${id}/submit`, { member, ifMatch: `"${version}"`, body: { reason: REASON } });
  const decide = (id: string, version: number, decision = 'approve', member = APPROVER) =>
    call('POST', `/notification-templates/${id}/decision`, { member, ifMatch: `"${version}"`, body: { decision, reason: REASON, evidence_ids: [] } });
  const revisions = async (query = ''): Promise<Array<Record<string, unknown>>> => (await call('GET', `/resources/notification_template_version${query}`)).json.items as Array<Record<string, unknown>>;
  const idOf = (reply: Reply): string => reply.json.resource_id as string;

  /** A revision written by the author and approved by the other person. */
  async function active(channel = 'SMS', content: Record<string, unknown> = { body: 'Dossier {{code}} needs a look' }, overrides: Record<string, unknown> = {}): Promise<string> {
    const made = await create(body(channel, content, overrides));
    expect(made.status).toBe(201);
    const sent = await submit(idOf(made), 1);
    expect(sent.status).toBe(202);
    const done = await decide(idOf(made), sent.json.resource_version as number);
    expect(done.status).toBe(200);
    return idOf(made);
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }, { n: 2, path: `/${unitId(1)}/${unitId(2)}/`, parent: 1 }]);
    // A crowd of members for the lists that are replaced at the same moment.
    for (let n = 20; n < 32; n += 1) await harness.seedMembership(TENANT_A, n, 1, { validFrom: '2026-01-01T00:00:00Z' });
    for (const [member, unit] of [[AUTHOR, 1], [APPROVER, 1], [SUBTREE, 2], [NOBODY, 1], [LISTED, 1], [NOT_LISTED, 1]] as const) await harness.seedMembership(TENANT_A, member, unit, { validFrom: '2026-01-01T00:00:00Z' });
    await harness.seedMembership(TENANT_B, OTHER_TENANT_ADMIN, 1, { validFrom: '2026-01-01T00:00:00Z' });
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedRole(tenant, 1, 'TEMPLATE_AUTHOR', ['notification.template.manage', 'notification_template_version.read'], 50);
      await harness.seedRole(tenant, 2, 'TEMPLATE_APPROVER', ['notification.template.manage', 'notification.template.approve', 'notification_template_version.read'], 50);
    }
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: AUTHOR, role: 1, kind: 'TENANT' },
      { n: 2, member: APPROVER, role: 2, kind: 'TENANT' },
      { n: 3, member: SUBTREE, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT_ADMIN, role: 2, kind: 'TENANT' }]);
    await rows(
      `insert into machvon.channel_account (tenant_id, id, channel, external_account_id, credential_secret_ref, capability_version, status, verified_at)
       values ($1, gen_random_uuid(), 'EMAIL', 'relay-1', 'secret://test/mail', 'v1', 'Active', now()), ($1, gen_random_uuid(), 'SMS', 'sms-1', 'secret://test/sms', 'v1', 'Active', now())`,
      [TENANT_A],
    );
    await rows("update machvon.user_account set phone_e164 = '+84900000005' where id = (select user_id from machvon.membership where id = $1)", [memberId(LISTED)]);
    email = new InMemoryChannelAdapter({ provider: 'mem-mail', channel: 'EMAIL' });
    sms = new InMemoryChannelAdapter({ provider: 'mem-sms', channel: 'SMS' });
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [NotificationTemplatesController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: CHANNEL_ADAPTERS, useValue: new ChannelAdapterRegistry([email, sms], 'test') },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await harness.stop();
  }, 60_000);

  describe('writing a revision (NOT-07)', () => {
    it('writes a Draft and numbers the revisions of a code × channel × locale one after the other', async () => {
      const first = body('EMAIL', { subject: 'Dossier {{code}}', body: 'Dossier {{code}} of {{unit}}' });
      const one = await create(first);
      expect(one.status).toBe(201);
      expect(one.json).toMatchObject({ status: 'DRAFT', resource_version: 1 });
      const two = await create({ ...first, content_ast: { subject: 'Dossier {{code}}', body: 'Changed {{code}}' }, supersedes_id: idOf(one) });
      const listed = await revisions(`?code=${first.code}`);
      expect(listed.map((row) => [row.revision, row.status])).toEqual([[2, 'Draft'], [1, 'Draft']]);
      expect(listed[0]).toMatchObject({ id: idOf(two), supersedes_id: idOf(one), created_by: memberId(AUTHOR), channel: 'EMAIL', locale: 'vi-VN', lockscreen_safe: false });
      // Another locale or channel of the same code is a line of its own.
      expect((await revisions(`?code=${first.code}&locale=en-US`)).length).toBe(0);
      const [kept] = await rows<{ content_hash: string }>('select content_hash from machvon.notification_template_version where id = $1', [idOf(two)]);
      expect(kept?.content_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('AC-ST-NOT-005-1 UAT-AC28: refuses a push template that uses a money variable with 422 TEMPLATE_VARIABLE_CLASSIFIED, and nothing is stored or sent', async () => {
      const before = (await revisions('?limit=200')).length;
      const refused = await create(body('PUSH_FCM', { body: 'You owe {{amount}}' }));
      expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'TEMPLATE_VARIABLE_CLASSIFIED', 'variable_schema.amount']);
      const sms = await create(body('SMS', { body: 'You owe {{amount}}' }));
      expect([sms.status, sms.json.code]).toEqual([422, 'TEMPLATE_VARIABLE_CLASSIFIED']);
      expect(await revisions('?limit=200')).toHaveLength(before);
    });

    it('AC-ST-NOT-005-2 UAT-AC188: refuses a confidential variable in a ZNS template with 422, and the database refuses a push template that is not lock-screen safe', async () => {
      const zns = await create(body('ZALO_ZNS', { body: 'See {{secret}}' }));
      expect([zns.status, zns.json.code]).toEqual([422, 'TEMPLATE_VARIABLE_CLASSIFIED']);
      const api = await create(body('PUSH_APNS', { body: 'Hello' }, { lockscreen_safe: false }));
      expect([api.status, api.json.code, api.json.detail]).toEqual([422, 'TEMPLATE_INVALID', 'lockscreen_safe']);
      // Straight into the table, past the API: the CHECK of the database says no.
      const failure = await rows(
        `insert into machvon.notification_template_version (tenant_id, id, code, channel, locale, revision, content_ast, variable_schema, status, purpose, lockscreen_safe, content_hash, created_by)
         values ($1, gen_random_uuid(), 'tpl.db-check', 'PUSH_FCM', 'vi-VN', 1, '{"body":"x"}'::jsonb, '{}'::jsonb, 'Draft', 'OPERATIONAL', false, repeat('a', 64), $2)`,
        [TENANT_A, memberId(AUTHOR)],
      ).then(
        () => undefined,
        (error: { code?: string; message: string }) => error,
      );
      expect(failure?.code).toBe('23514');
      expect(failure?.message).toContain('notification_template_push_ck');
    });

    it('refuses a placeholder that is not declared, a code or channel the contract does not know, and a write without the right', async () => {
      const undeclared = await create(body('EMAIL', { body: 'Hello {{nobody}}' }));
      expect([undeclared.status, undeclared.json.code, undeclared.json.detail]).toEqual([422, 'TEMPLATE_INVALID', 'content_ast.nobody']);
      // The request is judged by the contract in the application (400); here, without its pipe, by the rules of the template (422).
      expect([400, 422]).toContain((await create(body('EMAIL', { body: 'x' }, { code: 'X' }))).status);
      expect([400, 422]).toContain((await create(body('TELEGRAM', { body: 'x' }))).status);
      expect((await create(body('EMAIL', { body: 'x' }), SUBTREE)).status).toBe(403);
      expect((await create(body('EMAIL', { body: 'x' }), NOBODY)).status).toBe(403);
      const another = await create(body('EMAIL', { body: 'x' }), AUTHOR);
      const stranger = await create({ ...body('EMAIL', { body: 'x' }), supersedes_id: idOf(another) });
      expect([stranger.status, stranger.json.detail]).toEqual([422, 'supersedes_id']);
    });
  });

  describe('the review (NOT-07)', () => {
    it('sends an e-mail, SMS, push or inbox template to InReview and a provider template to PendingProvider; a revision that is not a Draft is TEMPLATE_IMMUTABLE', async () => {
      const mail = await create(body('EMAIL', { body: 'Dossier {{code}}' }));
      const sent = await submit(idOf(mail), 1);
      expect(sent.json).toMatchObject({ status: 'INREVIEW', resource_version: 2 });
      const zns = await create(body('ZALO_ZNS', { body: 'Dossier {{code}}' }));
      expect((await submit(idOf(zns), 1)).json).toMatchObject({ status: 'PENDINGPROVIDER' });
      const again = await submit(idOf(mail), 2);
      expect([again.status, again.json.code]).toEqual([409, 'TEMPLATE_IMMUTABLE']);
      expect((await submit(idOf(mail), 99)).status).toBe(409);
      expect((await submit(randomUUID(), 1)).status).toBe(404);
    });

    it('is approved by another person, never by its author: 403 SELF_APPROVAL_DENIED, and the revision keeps waiting', async () => {
      // The approver also writes this one, so only the rule of the two people stands between the author and the approval.
      const made = await create(body('SMS', { body: 'Dossier {{code}}' }), APPROVER);
      expect((await submit(idOf(made), 1, APPROVER)).status).toBe(202);
      const self = await decide(idOf(made), 2, 'approve', APPROVER);
      expect([self.status, self.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect((await revisions()).map((row) => row.id)).toContain(idOf(made));
      // Another person with the right takes it; the author of the other revision cannot approve it either (no right to approve).
      expect((await decide(idOf(made), 2, 'approve', AUTHOR)).status).toBe(403);
    });

    it('leaves one Active revision when two revisions of a line are approved at the same moment, and the table would refuse a second', async () => {
      const line = code();
      const make = async (): Promise<string> => {
        const made = await create({ ...body('SMS', { body: 'Dossier {{code}}' }), code: line });
        await submit(idOf(made), 1);
        return idOf(made);
      };
      const [one, two] = [await make(), await make()];
      const answers = await Promise.all([decide(one, 2), decide(two, 2)]);
      expect(answers.every((answer) => answer.status === 200)).toBe(true);
      const states = (await revisions(`?code=${line}`)).map((row) => row.status).sort();
      expect(states).toEqual(['Active', 'Retired']);
      const second = await rows(
        `insert into machvon.notification_template_version (tenant_id, id, code, channel, locale, revision, content_ast, variable_schema, status, purpose, content_hash, created_by)
         values ($1, gen_random_uuid(), $2, 'SMS', 'vi-VN', 99, '{"body":"x"}'::jsonb, '{}'::jsonb, 'Active', 'OPERATIONAL', repeat('a', 64), $3)`,
        [TENANT_A, line, memberId(AUTHOR)],
      ).then(
        () => undefined,
        (error: { message: string }) => error,
      );
      expect(second?.message).toContain('notification_template_active_uq');
    });

    it('makes the approved revision Active and Retires the one before it; a returned revision goes back to Draft and a rejected one is closed', async () => {
      const line = code();
      const make = async (): Promise<string> => idOf(await create({ ...body('SMS', { body: 'Dossier {{code}}' }), code: line }));
      const one = await make();
      await submit(one, 1);
      expect((await decide(one, 2)).json).toMatchObject({ status: 'ACTIVE' });
      const two = await make();
      await submit(two, 1);
      expect((await decide(two, 2)).json).toMatchObject({ status: 'ACTIVE' });
      const byId = new Map((await revisions(`?code=${line}`)).map((row) => [row.id as string, row]));
      expect(byId.get(one)).toMatchObject({ status: 'Retired' });
      expect(byId.get(two)).toMatchObject({ status: 'Active', approved_by: memberId(APPROVER) });
      const three = await make();
      await submit(three, 1);
      expect((await decide(three, 2, 'return')).json).toMatchObject({ status: 'DRAFT' });
      expect((await submit(three, 3)).json).toMatchObject({ status: 'INREVIEW' });
      expect((await decide(three, 4, 'reject')).json).toMatchObject({ status: 'REJECTED' });
      expect((await decide(three, 5)).status).toBe(409);
      expect((await revisions(`?code=${line}&status=Active`)).map((row) => row.id)).toEqual([two]);
    });

    it('does not make a provider template Active before the provider has approved it: 409 TEMPLATE_PROVIDER_PENDING', async () => {
      const zns = await create(body('ZALO_ZNS', { body: 'Dossier {{code}}' }));
      await submit(idOf(zns), 1);
      const refused = await decide(idOf(zns), 2);
      expect([refused.status, refused.json.code]).toEqual([409, 'TEMPLATE_PROVIDER_PENDING']);
      expect((await revisions(`?status=PendingProvider`)).map((row) => row.id)).toContain(idOf(zns));
    });

    it('is the right of who may approve on the whole tenant: a person on one unit, or without the right, is refused', async () => {
      const made = await create(body('SMS', { body: 'Dossier {{code}}' }));
      await submit(idOf(made), 1);
      expect((await decide(idOf(made), 2, 'approve', SUBTREE)).status).toBe(403);
      expect((await decide(idOf(made), 2, 'approve', NOBODY)).status).toBe(403);
      expect((await decide(idOf(made), 2, 'approve', AUTHOR)).status).toBe(403);
      expect((await call('POST', `/notification-templates/${idOf(made)}/decision`, { member: APPROVER, body: { decision: 'approve', reason: REASON, evidence_ids: [] } })).status).toBe(428);
    });

    it('never changes what a revision says once it has left Draft: the table refuses the edit, and nobody deletes a revision', async () => {
      const id = await active('EMAIL', { subject: 'Dossier {{code}}', body: 'Dossier {{code}}' });
      for (const text of [
        "update machvon.notification_template_version set content_ast = '{\"body\":\"other\"}'::jsonb where id = $1",
        "update machvon.notification_template_version set purpose = 'SECURITY' where id = $1",
        "update machvon.notification_template_version set status = 'Draft' where id = $1",
        'delete from machvon.notification_template_version where id = $1',
      ]) {
        const failure = await rows(text, [id]).then(
          () => undefined,
          (error: { message: string }) => error,
        );
        expect(failure?.message).toMatch(/TEMPLATE_IMMUTABLE|permission denied/);
      }
    });
  });

  describe('the reads (NOT-07, NOT-08)', () => {
    it('reads one revision and a page of them, newest first, filtered by code, channel, locale and status; another tenant sees none', async () => {
      const id = await active('SMS', { body: 'Dossier {{code}}' });
      const one = await call('GET', `/resources/notification_template_version/${id}`);
      expect(one.status).toBe(200);
      expect(one.json).toMatchObject({ id, channel: 'SMS', status: 'Active', provider_status: 'NOT_REQUIRED', content_ast: { body: 'Dossier {{code}}' } });
      expect((await call('GET', `/resources/notification_template_version/${randomUUID()}`)).status).toBe(404);
      expect((await call('GET', `/resources/notification_template_version/${id}`, { member: OTHER_TENANT_ADMIN, tenantId: TENANT_B })).status).toBe(404);
      expect((await call('GET', '/resources/notification_template_version?limit=200', { member: OTHER_TENANT_ADMIN, tenantId: TENANT_B })).json.items).toEqual([]);
      expect((await call('GET', '/resources/notification_template_version?status=Bogus')).status).toBe(422);
      // A grant of the read on one unit does not read what is the whole tenant's.
      expect((await call('GET', '/resources/notification_template_version', { member: SUBTREE })).status).toBe(403);
      expect((await call('GET', `/resources/notification_template_version/${id}`, { member: SUBTREE })).status).toBe(403);
      expect((await call('GET', '/resources/notification_template_version', { member: NOBODY })).status).toBe(403);
      const all = await revisions('?limit=200');
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: Reply = await call('GET', `/resources/notification_template_version?limit=3${cursor === null ? '' : `&cursor=${cursor}`}`);
        seen.push(...(page.json.items as Array<{ id: string }>).map((row) => row.id));
        cursor = page.json.next_cursor as string | null;
      } while (cursor !== null);
      expect(seen).toEqual(all.map((row) => row.id));
    });
  });

  describe('the test sends (NOT-08)', () => {
    const SAMPLES = { code: 'D-17', unit: 'Cao Bang' };
    const listRecipients = (...members: number[]) => call('PUT', '/notification-test-recipients', { body: { membership_ids: members.map((member) => memberId(member)) } });
    const testSend = (id: string, recipients: number[], samples: Record<string, unknown> = SAMPLES, member = AUTHOR) =>
      call('POST', `/notification-templates/${id}/test-sends`, { member, body: { test_recipient_ids: recipients.map((recipient) => memberId(recipient)), sample_variables: samples } });
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 100));

    it('keeps the list of the people a test may go to: at most ten, Active members of the tenant, readable by who manages templates', async () => {
      expect((await listRecipients(LISTED, APPROVER)).status).toBe(200);
      expect((await call('GET', '/notification-test-recipients')).json.membership_ids).toEqual(expect.arrayContaining([memberId(LISTED), memberId(APPROVER)]));
      expect((await call('PUT', '/notification-test-recipients', { body: { membership_ids: [randomUUID()] } })).json.code).toBe('TEST_RECIPIENT_NOT_ALLOWED');
      const tooMany = await call('PUT', '/notification-test-recipients', { body: { membership_ids: Array.from({ length: 11 }, () => randomUUID()) } });
      expect([400, 422]).toContain(tooMany.status);
      expect((await call('GET', '/notification-test-recipients', { member: NOBODY })).status).toBe(403);
      expect((await call('PUT', '/notification-test-recipients', { member: SUBTREE, body: { membership_ids: [] } })).status).toBe(403);
      expect((await call('GET', '/notification-test-recipients', { member: OTHER_TENANT_ADMIN, tenantId: TENANT_B })).json.membership_ids).toEqual([]);
      await listRecipients(LISTED);
      expect((await call('GET', '/notification-test-recipients')).json.membership_ids).toEqual([memberId(LISTED)]);
    });

    it('keeps the limit of ten when two lists are replaced at the same moment: the last one wins whole, never the sum of both', async () => {
      await listRecipients();
      const first = Array.from({ length: 6 }, (_unused, index) => memberId(20 + index));
      const second = Array.from({ length: 6 }, (_unused, index) => memberId(26 + index));
      const answers = await Promise.all([call('PUT', '/notification-test-recipients', { body: { membership_ids: first } }), call('PUT', '/notification-test-recipients', { body: { membership_ids: second } })]);
      expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
      const kept = (await call('GET', '/notification-test-recipients')).json.membership_ids as string[];
      expect(kept).toHaveLength(6);
      expect([...kept].sort()).toEqual([...(kept.every((id) => first.includes(id)) ? first : second)].sort());
      await listRecipients(LISTED);
    });

    it('AC-ST-NOT-005-3 UAT-AC189: refuses a recipient outside the list with 422 TEST_RECIPIENT_NOT_ALLOWED, then sends to one inside it with the [TEST] prefix, and nothing is counted', async () => {
      await listRecipients(LISTED);
      const id = await active('SMS', { body: 'Dossier {{code}} of {{unit}}' });
      const before = sms.requests.length;
      const refused = await testSend(id, [LISTED, NOT_LISTED]);
      expect([refused.status, refused.json.code]).toEqual([422, 'TEST_RECIPIENT_NOT_ALLOWED']);
      await settle();
      expect(sms.requests).toHaveLength(before);
      const notificationsBefore = await rows<{ n: string }>('select count(*)::text as n from machvon.notification_instance');
      const sent = await testSend(id, [LISTED]);
      expect(sent.status).toBe(202);
      await settle();
      expect(sms.requests).toHaveLength(before + 1);
      const message = sms.requests[before];
      expect(message?.text).toBe('[TEST] Dossier D-17 of Cao Bang');
      expect(message?.accountId).toBe('sms-1');
      // A test is not a notification: there is no row to count, no attempt, no metric; the audit row has numbers only.
      expect(await rows<{ n: string }>('select count(*)::text as n from machvon.notification_instance')).toEqual(notificationsBefore);
      const audits = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where resource_id = $1 and action = 'notification.test_sent'", [id]);
      expect(audits).toHaveLength(1);
      expect(audits[0]?.safe_diff).toMatchObject({ channel: 'SMS', requested: 1, sent: 1 });
      expect(JSON.stringify(audits)).not.toContain('Dossier');
    });

    it('does not write to a member who has been suspended since the list was made: 422, and nothing goes out', async () => {
      await listRecipients(LISTED);
      const id = await active('SMS', { body: 'Dossier {{code}} of {{unit}}' });
      await rows("update machvon.membership set status = 'Suspended' where id = $1", [memberId(LISTED)]);
      const before = sms.requests.length;
      try {
        const refused = await testSend(id, [LISTED]);
        expect([refused.status, refused.json.code]).toEqual([422, 'TEST_RECIPIENT_NOT_ALLOWED']);
        await settle();
        expect(sms.requests).toHaveLength(before);
      } finally {
        await rows("update machvon.membership set status = 'Active' where id = $1", [memberId(LISTED)]);
      }
    });

    it('prefixes the subject of an e-mail too, renders a push and an inbox template without sending it, and refuses samples the template does not declare', async () => {
      await listRecipients(LISTED);
      const mail = await active('EMAIL', { subject: 'Dossier {{code}}', body: 'Dossier {{code}}' });
      const before = email.requests.length;
      expect((await testSend(mail, [LISTED], { code: 'D-9' })).status).toBe(202);
      await settle();
      expect(email.requests[before]).toMatchObject({ subject: '[TEST] Dossier D-9', text: '[TEST] Dossier D-9' });
      const push = await active('PUSH_FCM', { body: 'A dossier needs a look' });
      expect((await testSend(push, [LISTED], {})).status).toBe(202);
      const inbox = await active('IN_APP', { body: 'Dossier {{code}}' });
      expect((await testSend(inbox, [LISTED], { code: 'D-1' })).status).toBe(202);
      for (const samples of [{}, { code: 'D-1', unit: 7 }, { code: 'D-1', unit: 'x', extra: 'y' }]) {
        const refused = await testSend(await active('SMS', { body: 'Dossier {{code}} of {{unit}}' }), [LISTED], samples);
        expect([refused.status, refused.json.code]).toEqual([422, 'TEMPLATE_INVALID']);
      }
      await settle();
      expect(email.requests).toHaveLength(before + 1);
    });

    it('does not test a revision that was refused, retired or belongs to a provider, and needs the right on the whole tenant', async () => {
      await listRecipients(LISTED);
      const made = await create(body('SMS', { body: 'Dossier {{code}} of {{unit}}' }));
      await submit(idOf(made), 1);
      await decide(idOf(made), 2, 'reject');
      expect((await testSend(idOf(made), [LISTED])).status).toBe(422);
      const zns = await create(body('ZALO_ZNS', { body: 'Dossier {{code}}' }));
      expect((await testSend(idOf(zns), [LISTED], { code: 'D' })).status).toBe(422);
      const draft = await create(body('SMS', { body: 'Dossier {{code}} of {{unit}}' }));
      expect((await testSend(idOf(draft), [LISTED], SAMPLES, SUBTREE)).status).toBe(403);
      expect((await testSend(idOf(draft), [LISTED], SAMPLES, NOBODY)).status).toBe(403);
      expect((await testSend(randomUUID(), [LISTED])).status).toBe(404);
      const none = await call('POST', `/notification-templates/${idOf(draft)}/test-sends`, { body: { test_recipient_ids: [], sample_variables: SAMPLES } });
      expect([400, 422]).toContain(none.status);
    });
  });
});
