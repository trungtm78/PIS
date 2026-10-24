import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { ContactConsentReadsController, MyConsentsController } from '../../src/notifications/consents/consents.controller';
import { MyPreferencesController } from '../../src/notifications/preferences/preferences.controller';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const ACTOR = '00000000-0000-4000-8000-0000000000f0';
const ANNA = 1; // a member with a phone, holds notification.self
const BEN = 2; // a member with a phone, holds notification.self
const NO_PHONE = 3; // holds notification.self, has no phone on the account
const AUDITOR = 4; // holds notification.self and contact_consent.read on the whole tenant
const UNIT_AUDITOR = 5; // the same, on one unit only
const TENANT_B_MEMBER = 1;
const WORKFLOW_URGENT = '00000000-0000-4000-8000-0000000000b2';
const PERMISSIONS = ['notification.self'];
const AUDIT_PERMISSIONS = ['notification.self', 'contact_consent.read'];

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('preferences, quiet hours and the consent history over HTTP (ST-NOT-003, NOT-03, NOT-17)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  const rows = <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

  async function call(method: 'GET' | 'POST' | 'PUT', url: string, options: { member?: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member ?? ANNA, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, ...(method === 'GET' ? {} : { body: JSON.stringify(options.body ?? {}) }) });
    const text = await response.text();
    return { status: response.status, json: JSON.parse(text) as Record<string, unknown> };
  }

  const grantBody = (values: Record<string, unknown> = {}): Record<string, unknown> => ({ channel: 'SMS', purpose: 'OPERATIONAL', consent_text_version: 'tos-2026-1', capture_method: 'IN_APP', ...values });
  const grant = (member: number, values: Record<string, unknown> = {}): Promise<Reply> => call('POST', '/me/consents', { member, body: grantBody(values) });
  const items = (reply: Reply): Array<Record<string, unknown>> => reply.json.items as Array<Record<string, unknown>>;

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }, { n: 2, path: `/${unitId(1)}/${unitId(2)}/`, parent: 1 }]);
    for (const member of [ANNA, BEN, NO_PHONE, AUDITOR, UNIT_AUDITOR]) await harness.seedMembership(TENANT_A, member, 1, { validFrom: '2026-01-01T00:00:00Z' });
    await harness.seedMembership(TENANT_B, TENANT_B_MEMBER, 1, { validFrom: '2026-01-01T00:00:00Z' });
    for (const member of [ANNA, BEN, AUDITOR, UNIT_AUDITOR]) await rows('update machvon.user_account set phone_e164 = $2 where id = $1', [id(0x60, member), `+8490000000${member}`]);
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedRole(tenant, 1, 'MEMBER', PERMISSIONS, 10);
      await harness.seedRole(tenant, 2, 'CONSENT_AUDITOR', AUDIT_PERMISSIONS, 20);
    }
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ANNA, role: 1, kind: 'TENANT' },
      { n: 2, member: BEN, role: 1, kind: 'TENANT' },
      { n: 3, member: NO_PHONE, role: 1, kind: 'TENANT' },
      { n: 4, member: AUDITOR, role: 2, kind: 'TENANT' },
      { n: 5, member: UNIT_AUDITOR, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: TENANT_B_MEMBER, role: 2, kind: 'TENANT' }]);
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.workflow_version (tenant_id, id, business_type, revision, definition_json, status, kind, event_type, created_by, definition_hash)
         values ($1, $2, 'approval.requested', 1, '{"priority":"CRITICAL"}'::jsonb, 'Published', 'NOTIFICATION', 'approval.requested', $3, repeat('b', 64))`,
        [TENANT_A, WORKFLOW_URGENT, ACTOR],
      ],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [MyPreferencesController, MyConsentsController, ContactConsentReadsController],
      providers: [{ provide: TenantDatabase, useValue: tenants }, { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }],
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await harness.stop();
  }, 60_000);

  describe('grantMyConsent and listMyConsents', () => {
    it('records the consent of the person, lists it with the version a withdrawal needs, and answers a retry with the same answer', async () => {
      const key = `grant-${randomUUID()}-${randomUUID()}`;
      const first = await call('POST', '/me/consents', { member: ANNA, body: grantBody(), key });
      expect([first.status, first.json.status, first.json.resource_version]).toEqual([201, 'Granted', 1]);
      const retried = await call('POST', '/me/consents', { member: ANNA, body: grantBody(), key });
      expect([retried.status, retried.json.resource_id, retried.json.operation_id]).toEqual([201, first.json.resource_id, first.json.operation_id]);
      const list = await call('GET', '/me/consents', { member: ANNA });
      expect(list.status).toBe(200);
      expect(items(list)).toEqual([
        { id: first.json.resource_id, channel: 'SMS', purpose: 'OPERATIONAL', status: 'Granted', effective_at: expect.any(String), consent_text_version: 'tos-2026-1', version: 1 },
      ]);
      expect(list.json.next_cursor).toBeNull();
      const [count] = await rows<{ n: string }>("select count(*)::text as n from machvon.contact_consent where membership_id = $1 and channel = 'SMS'", [memberId(ANNA)]);
      expect(count?.n).toBe('1');
    });

    it('writes an audit row without the evidence, and a change event with ids only, in the same commit', async () => {
      const granted = await grant(ANNA, { channel: 'ZALO', purpose: 'REMINDER', capture_method: 'PAPER_SCANNED', evidence_reference: 'scan://private-form-99' });
      expect(granted.status).toBe(201);
      const [audit] = await rows<{ action: string; classification: string; resource_id: string; safe_diff: Record<string, unknown>; outcome: string }>(
        "select action, classification, resource_id, safe_diff, outcome from machvon.audit_event where action = 'consent.granted' and resource_id = $1",
        [granted.json.resource_id],
      );
      expect(audit).toMatchObject({ outcome: 'SUCCESS', classification: 'PERSONAL', safe_diff: { channel: 'ZALO', purpose: 'REMINDER', capture_method: 'PAPER_SCANNED', consent_text_version: 'tos-2026-1' } });
      expect(JSON.stringify(audit)).not.toContain('private-form-99');
      expect(JSON.stringify(audit)).not.toContain('+84900000');
      const [event] = await rows<{ type: string; payload: Record<string, unknown> }>("select type, payload from machvon.outbox_event where aggregate_id = $1 and type = 'not.consent.changed.v1'", [granted.json.resource_id]);
      expect(event?.payload).toMatchObject({ consent_id: granted.json.resource_id, subject_kind: 'MEMBERSHIP', subject_id: memberId(ANNA), channel: 'ZALO', purpose: 'REMINDER', status: 'Granted' });
      expect(JSON.stringify(event)).not.toContain('private-form-99');
    });

    it('refuses a second live consent for the same channel and purpose with 409 CONSENT_ALREADY_GRANTED', async () => {
      const second = await grant(ANNA);
      expect([second.status, second.json.code]).toEqual([409, 'CONSENT_ALREADY_GRANTED']);
    });

    it('refuses a phone channel to a person without a phone with 422 CHANNEL_IDENTITY_UNVERIFIED', async () => {
      const refused = await grant(NO_PHONE, { channel: 'WHATSAPP' });
      expect([refused.status, refused.json.code]).toEqual([422, 'CHANNEL_IDENTITY_UNVERIFIED']);
      const mail = await grant(NO_PHONE, { channel: 'EMAIL', purpose: 'ANNOUNCEMENT' });
      expect(mail.status).toBe(201);
    });

    it.each([
      ['a channel that is not consentable', { channel: 'IN_APP' }],
      ['a purpose that nobody consents to', { purpose: 'SECURITY' }],
      ['a capture method that does not exist', { capture_method: 'TELEPATHY' }],
      ['an unknown member of the body', { everyone: true }],
    ])('refuses %s in the request', async (_label, values) => {
      const refused = await grant(ANNA, values);
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(refused.status).toBeLessThan(500);
    });

    it('refuses an empty text version and an over-long evidence reference with 422', async () => {
      expect((await grant(BEN, { consent_text_version: '   ' })).json.code).toBe('VALIDATION_FAILED');
      expect((await grant(BEN, { evidence_reference: 'e'.repeat(501) })).json.code).toBe('VALIDATION_FAILED');
    });

    it('lists only the consents of the caller, newest first, in pages', async () => {
      await grant(BEN, { channel: 'EMAIL', purpose: 'OPERATIONAL' });
      await grant(BEN, { channel: 'EMAIL', purpose: 'REMINDER' });
      await grant(BEN, { channel: 'SMS', purpose: 'REMINDER' });
      const all = await call('GET', '/me/consents', { member: BEN });
      expect(items(all).map((entry) => `${entry.channel}/${entry.purpose}`)).toEqual(['SMS/REMINDER', 'EMAIL/REMINDER', 'EMAIL/OPERATIONAL']);
      const page = await call('GET', '/me/consents?limit=2', { member: BEN });
      expect(items(page)).toHaveLength(2);
      expect(page.json.next_cursor).toEqual(expect.any(String));
      const next = await call('GET', `/me/consents?limit=2&cursor=${String(page.json.next_cursor)}`, { member: BEN });
      expect(items(next).map((entry) => entry.id)).toEqual([items(all)[2]?.id]);
      expect(next.json.next_cursor).toBeNull();
      expect((await call('GET', '/me/consents?cursor=nonsense', { member: BEN })).status).toBe(422);
    });
  });

  describe('withdrawMyConsent', () => {
    const withdraw = (member: number, consentId: string, version: string | undefined, reason = 'I no longer want these messages'): Promise<Reply> =>
      call('POST', `/me/consents/${consentId}/withdraw`, { member, body: { reason }, ...(version === undefined ? {} : { ifMatch: version }) });

    it('ends the consent at once: the history shows it Withdrawn, with an audit row that carries the reason and an event', async () => {
      const granted = await grant(BEN, { channel: 'ZALO', purpose: 'OPERATIONAL' });
      const id = String(granted.json.resource_id);
      const done = await withdraw(BEN, id, '"1"');
      expect([done.status, done.json.status, done.json.resource_version]).toEqual([200, 'Withdrawn', 2]);
      const history = items(await call('GET', '/me/consents', { member: BEN })).find((entry) => entry.id === id);
      expect(history).toMatchObject({ status: 'Withdrawn', version: 2, revoked_at: expect.any(String) });
      const [audit] = await rows<{ reason: string; safe_diff: Record<string, unknown> }>("select reason, safe_diff from machvon.audit_event where action = 'consent.withdrawn' and resource_id = $1", [id]);
      expect(audit).toMatchObject({ reason: 'I no longer want these messages', safe_diff: { channel: 'ZALO', purpose: 'OPERATIONAL' } });
      const events = await rows<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where aggregate_id = $1 and type = 'not.consent.changed.v1' order by aggregate_version", [id]);
      expect(events.map((event) => event.payload.status)).toEqual(['Granted', 'Withdrawn']);
    });

    it('needs the version (428), refuses a stale one (409) and a second withdrawal (409 CONSENT_STATE_INVALID)', async () => {
      const granted = await grant(BEN, { channel: 'WHATSAPP', purpose: 'OPERATIONAL' });
      const id = String(granted.json.resource_id);
      expect((await withdraw(BEN, id, undefined)).status).toBe(428);
      const stale = await withdraw(BEN, id, '"5"');
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      expect((await withdraw(BEN, id, '"1"')).status).toBe(200);
      const again = await withdraw(BEN, id, '"2"');
      expect([again.status, again.json.code]).toEqual([409, 'CONSENT_STATE_INVALID']);
    });

    it('answers 404 for the consent of someone else, for one that does not exist and for a reason that is too short with 422', async () => {
      const granted = await grant(BEN, { channel: 'WHATSAPP', purpose: 'REMINDER' });
      const id = String(granted.json.resource_id);
      expect((await withdraw(ANNA, id, '"1"')).status).toBe(404);
      expect((await withdraw(ANNA, randomUUID(), '"1"')).status).toBe(404);
      const short = await withdraw(BEN, id, '"1"', 'no');
      expect(short.status).toBeGreaterThanOrEqual(400);
      expect(short.status).toBeLessThan(500);
      expect((await withdraw(BEN, id, '"1"')).status).toBe(200);
    });

    it('lets the person give the consent again after a withdrawal, as a new row', async () => {
      const first = await grant(ANNA, { channel: 'WHATSAPP', purpose: 'ANNOUNCEMENT' });
      expect((await withdraw(ANNA, String(first.json.resource_id), '"1"')).status).toBe(200);
      const second = await grant(ANNA, { channel: 'WHATSAPP', purpose: 'ANNOUNCEMENT' });
      expect(second.status).toBe(201);
      expect(second.json.resource_id).not.toBe(first.json.resource_id);
    });
  });

  describe('updateMyNotificationPreferences', () => {
    const set = (member: number, body: Record<string, unknown>, ifMatch: string | undefined): Promise<Reply> => call('PUT', '/me/notification-preferences', { member, body, ...(ifMatch === undefined ? {} : { ifMatch }) });
    const preferences = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      items: [{ event_category: 'report', channel: 'SMS', enabled: false }, { event_category: '*', channel: 'EMAIL', enabled: true, digest_mode: 'DAILY' }],
      quiet_start: '22:00',
      quiet_end: '06:30',
      time_zone: 'Asia/Tokyo',
      ...extra,
    });

    it('saves the whole set under the version the person saw (0 the first time), audits it and moves the version', async () => {
      const first = await set(ANNA, preferences(), '"0"');
      expect([first.status, first.json.status, first.json.resource_version, first.json.resource_id]).toEqual([200, 'Updated', 1, memberId(ANNA)]);
      const stored = await rows<{ event_category: string; channel: string; enabled: boolean; digest_mode: string }>(
        'select event_category, channel, enabled, digest_mode from machvon.notification_preference where membership_id = $1 order by event_category, channel',
        [memberId(ANNA)],
      );
      expect(stored).toEqual([
        { event_category: '*', channel: 'EMAIL', enabled: true, digest_mode: 'DAILY' },
        { event_category: 'report', channel: 'SMS', enabled: false, digest_mode: 'IMMEDIATE' },
      ]);
      const [profile] = await rows<{ quiet_start: string; quiet_end: string; time_zone: string; version: string }>(
        'select quiet_start::text as quiet_start, quiet_end::text as quiet_end, time_zone, version::text as version from machvon.notification_preference_profile where membership_id = $1',
        [memberId(ANNA)],
      );
      expect(profile).toEqual({ quiet_start: '22:00:00', quiet_end: '06:30:00', time_zone: 'Asia/Tokyo', version: '1' });
      const [audit] = await rows<{ classification: string; safe_diff: Record<string, unknown> }>("select classification, safe_diff from machvon.audit_event where action = 'notification.preferences_updated' and resource_id = $1", [memberId(ANNA)]);
      expect(audit).toMatchObject({ classification: 'PERSONAL', safe_diff: { items: 2, channels_off: 1, quiet_hours: 'SET', time_zone: 'Asia/Tokyo' } });
      const second = await set(ANNA, preferences({ items: [] }), '"1"');
      expect(second.json.resource_version).toBe(2);
    });

    it('turns the quiet hours off when none are sent', async () => {
      const saved = await set(BEN, { items: [] }, '"0"');
      expect(saved.status).toBe(200);
      const [profile] = await rows<{ quiet_start: string | null }>('select quiet_start::text as quiet_start from machvon.notification_preference_profile where membership_id = $1', [memberId(BEN)]);
      expect(profile?.quiet_start).toBeNull();
    });

    it('refuses a stale version (409) and a missing one (428)', async () => {
      const stale = await set(ANNA, preferences(), '"1"');
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      expect((await set(ANNA, preferences(), undefined)).status).toBe(428);
    });

    it('refuses to switch off the inbox of a category that holds an urgent event with 422 MANDATORY_CHANNEL_LOCKED, and accepts it for another', async () => {
      const locked = await set(NO_PHONE, { items: [{ event_category: 'approval', channel: 'IN_APP', enabled: false }] }, '"0"');
      expect([locked.status, locked.json.code]).toEqual([422, 'MANDATORY_CHANNEL_LOCKED']);
      const [none] = await rows<{ n: string }>('select count(*)::text as n from machvon.notification_preference where membership_id = $1', [memberId(NO_PHONE)]);
      expect(none?.n).toBe('0');
      const allowed = await set(NO_PHONE, { items: [{ event_category: 'report', channel: 'IN_APP', enabled: false }] }, '"0"');
      expect(allowed.status).toBe(200);
    });

    it.each([
      ['a start that is not a clock time', { quiet_start: '29:00' }],
      ['hours that are half given', { quiet_end: undefined }],
      ['an empty window', { quiet_start: '07:00', quiet_end: '07:00' }],
      ['a time zone that does not exist', { time_zone: 'Mars/Olympus' }],
      ['a category that is not a name', { items: [{ event_category: 'Report Overdue', channel: 'SMS', enabled: true }] }],
      ['the same channel twice for a category', { items: [{ event_category: 'report', channel: 'SMS', enabled: true }, { event_category: 'report', channel: 'SMS', enabled: false }] }],
    ])('refuses %s with 422', async (_label, values) => {
      const refused = await set(UNIT_AUDITOR, preferences(values), '"0"');
      expect([refused.status, refused.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    });

    it('refuses an unknown channel in the request body', async () => {
      const refused = await set(UNIT_AUDITOR, { items: [{ event_category: 'report', channel: 'FAX', enabled: true }] }, '"0"');
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(refused.status).toBeLessThan(500);
    });
  });

  describe('the consents of the tenant for the operator', () => {
    it('lists them with whose they are and what they cover, never the evidence or the reason', async () => {
      const list = await call('GET', '/resources/contact_consent?limit=200', { member: AUDITOR });
      expect(list.status).toBe(200);
      const listed = items(list);
      expect(listed.length).toBeGreaterThan(5);
      expect(listed[0]).toEqual({
        id: expect.any(String),
        subject_kind: 'MEMBERSHIP',
        subject_id: expect.any(String),
        channel: expect.any(String),
        purpose: expect.any(String),
        status: expect.any(String),
        effective_at: expect.any(String),
        revoked_at: null,
        consent_text_version: expect.any(String),
        capture_method: expect.any(String),
        legal_basis: 'CONSENT',
        version: expect.any(Number),
      });
      expect(JSON.stringify(list.json)).not.toContain('private-form-99');
      expect(JSON.stringify(list.json)).not.toContain('I no longer want');
      const page = await call('GET', '/resources/contact_consent?limit=2', { member: AUDITOR });
      expect(items(page)).toHaveLength(2);
      const next = await call('GET', `/resources/contact_consent?limit=2&cursor=${String(page.json.next_cursor)}`, { member: AUDITOR });
      expect(items(next)[0]?.id).not.toBe(items(page)[0]?.id);
    });

    it('shows one consent by its id, and answers 404 for an id that is not in the tenant', async () => {
      const [one] = items(await call('GET', '/resources/contact_consent?limit=1', { member: AUDITOR }));
      const found = await call('GET', `/resources/contact_consent/${String(one?.id)}`, { member: AUDITOR });
      expect([found.status, found.json.id]).toEqual([200, one?.id]);
      expect((await call('GET', `/resources/contact_consent/${randomUUID()}`, { member: AUDITOR })).status).toBe(404);
    });

    it('shows nothing to a grant on one unit: the list is empty and the id answers 404 (the consents span the people of every unit)', async () => {
      const [one] = items(await call('GET', '/resources/contact_consent?limit=1', { member: AUDITOR }));
      const list = await call('GET', '/resources/contact_consent', { member: UNIT_AUDITOR });
      expect([list.status, items(list), list.json.next_cursor]).toEqual([200, [], null]);
      expect((await call('GET', `/resources/contact_consent/${String(one?.id)}`, { member: UNIT_AUDITOR })).status).toBe(404);
    });

    it('is refused to a member who holds notification.self only (403), and shows another tenant nothing of this one', async () => {
      expect((await call('GET', '/resources/contact_consent', { member: ANNA })).status).toBe(403);
      const [one] = items(await call('GET', '/resources/contact_consent?limit=1', { member: AUDITOR }));
      expect((await call('GET', `/resources/contact_consent/${String(one?.id)}`, { member: TENANT_B_MEMBER, tenantId: TENANT_B })).status).toBe(404);
      expect(items(await call('GET', '/resources/contact_consent', { member: TENANT_B_MEMBER, tenantId: TENANT_B }))).toEqual([]);
    });

    it('does not let a member read or withdraw the consent of a member of another tenant', async () => {
      const [one] = items(await call('GET', '/resources/contact_consent?limit=1', { member: AUDITOR }));
      const attempt = await call('POST', `/me/consents/${String(one?.id)}/withdraw`, { member: TENANT_B_MEMBER, tenantId: TENANT_B, body: { reason: 'A foreign withdrawal attempt' }, ifMatch: '"1"' });
      expect(attempt.status).toBe(404);
    });
  });
});
