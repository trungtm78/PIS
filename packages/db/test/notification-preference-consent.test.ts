import { createHash, randomUUID } from 'node:crypto';
import type { MetricsSink } from '@machvon/kernel';
import { AuditWriter } from '../src/audit-writer';
import { ContactConsentStore } from '../src/contact-consent-store';
import { QUIET_HOURS_OVERRIDE_METRIC, DeliveryEngine } from '../src/delivery-engine';
import { DeliveryStore } from '../src/delivery-store';
import { NotificationPreferenceStore } from '../src/notification-preference-store';
import type { PreferenceInput, PreferenceItem } from '../src/notification-preference-store';
import { NotificationStore } from '../src/notification-store';
import type { NotificationPriority } from '../src/notification-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const consents = new ContactConsentStore();
const preferences = new NotificationPreferenceStore();
const deliveries = new DeliveryStore();
const notifications = new NotificationStore();

const PERSON = 1;
const OTHER = 2;
const TOKYO_PERSON = 3;
const NO_QUIET_PERSON = 4;
const ACTOR = '00000000-0000-4000-8000-0000000000f0';
const WORKFLOW = '00000000-0000-4000-8000-0000000000b1';
const WORKFLOW_URGENT = '00000000-0000-4000-8000-0000000000b2';
const WORKFLOW_OVERRIDE = '00000000-0000-4000-8000-0000000000b3';
const WORKFLOW_LOCKED_HIGH = '00000000-0000-4000-8000-0000000000b4';
const EMAIL_ACCOUNT = id(0xd0, 1);
const SMS_ACCOUNT = id(0xd0, 2);
const PUSH_ACCOUNT = id(0xd0, 3);
const EMAIL_TEMPLATE = id(0xe0, 1);
const SMS_TEMPLATE = id(0xe0, 2);
const PUSH_TEMPLATE = id(0xe0, 3);
const EMAIL = 'smtp-relay';
const SMS = 'sms-gateway';

/** 2026-10-22 22:30 in Vietnam. */
const NIGHT = new Date('2026-10-22T15:30:00.000Z');
/** 2026-10-22 20:30 in Vietnam and 22:30 in Tokyo. */
const EVENT_TIME = new Date('2026-10-22T13:30:00.000Z');
const NOON = new Date('2026-10-22T05:00:00.000Z');

function dedupeKeyOf(input: { tenantId: string; sourceEventId: string; recipientId: string; purpose: string }): string {
  const text = [input.tenantId, input.sourceEventId, input.recipientId, input.purpose].map((part) => part.toLowerCase()).join('|');
  return `n1:${createHash('sha256').update(text).digest('hex')}`;
}

class CountingMetrics implements MetricsSink {
  readonly counted: string[] = [];

  increment(name: string): void {
    this.counted.push(name);
  }

  gauge(): void {}
}

const items = (...list: Array<Partial<PreferenceItem> & Pick<PreferenceItem, 'eventCategory' | 'channel'>>): PreferenceItem[] => list.map((item) => ({ enabled: true, digestMode: 'IMMEDIATE', ...item }));
const input = (values: Partial<PreferenceInput> = {}): PreferenceInput => ({ items: [], quietStart: '21:00', quietEnd: '07:00', ...values });

describe('preferences, consent and the gate before a send (ST-NOT-003)', () => {
  const metrics = new CountingMetrics();
  const engine = new DeliveryEngine({
    metrics,
    random: () => 0.5,
    dedupeKeyOf,
    audit: { recordInTx: (tx, actor, entry) => new AuditWriter(harness.tenants).recordInTx(tx, actor, entry) },
  });
  const as = <T>(member: number, work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
  const owner = <T extends object>(text: string, params: unknown[] = []): Promise<T[]> => harness.owner<T>(TENANT_A, [[text, params]]);

  const grantDirect = (member: number, channel: string, purpose = 'OPERATIONAL'): Promise<unknown> =>
    owner(
      `insert into machvon.contact_consent (tenant_id, id, membership_id, channel, purpose, status, evidence_reference, effective_at, consent_text_version, capture_method)
       values ($1, gen_random_uuid(), $2, $3, $4, 'Granted', 'in-app:test', clock_timestamp(), 'v1', 'IN_APP')`,
      [TENANT_A, memberId(member), channel, purpose],
    );

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: '/1/' }]);
    for (const n of [PERSON, OTHER, TOKYO_PERSON, NO_QUIET_PERSON]) await harness.seedMembership(TENANT_A, n, 1, { validFrom: '2026-01-01T00:00:00Z' });
    await harness.seedMembership(TENANT_B, PERSON, 1, { validFrom: '2026-01-01T00:00:00Z' });
    const definition = (channels: unknown[], extra: Record<string, unknown> = {}): string => JSON.stringify({ channels, ...extra });
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.workflow_version (tenant_id, id, business_type, revision, definition_json, status, kind, event_type, created_by, definition_hash)
         values ($1, $2, 'report.overdue', 1, $3::jsonb, 'Published', 'NOTIFICATION', 'report.overdue', $7, repeat('a', 64)),
                ($1, $4, 'approval.requested', 1, $5::jsonb, 'Published', 'NOTIFICATION', 'approval.requested', $7, repeat('b', 64)),
                ($1, $6, 'deadline.near', 1, $8::jsonb, 'Published', 'NOTIFICATION', 'deadline.near', $7, repeat('c', 64)),
                ($1, $9, 'guarantee.expiring', 1, $10::jsonb, 'Published', 'NOTIFICATION', 'guarantee.expiring', $7, repeat('d', 64))`,
        [
          TENANT_A,
          WORKFLOW,
          definition([{ channel: 'IN_APP' }, { channel: 'SMS', templateCode: 'sms.a' }, { channel: 'EMAIL', templateCode: 'mail.a' }]),
          WORKFLOW_URGENT,
          definition([{ channel: 'IN_APP' }, { channel: 'PUSH_FCM', templateCode: 'push.a' }], { priority: 'CRITICAL' }),
          WORKFLOW_OVERRIDE,
          ACTOR,
          definition([{ channel: 'IN_APP' }, { channel: 'PUSH_FCM', templateCode: 'push.a' }], { priority: 'CRITICAL', quietHoursOverride: true }),
          WORKFLOW_LOCKED_HIGH,
          definition([{ channel: 'IN_APP' }, { channel: 'SMS', templateCode: 'sms.a' }], { priority: 'HIGH' }),
        ],
      ],
      [
        `insert into machvon.channel_account (tenant_id, id, channel, external_account_id, credential_secret_ref, capability_version, status, verified_at, webhook_secret_ref)
         values ($1, $2, 'EMAIL', 'relay-1', 'secret://test/mail', 'v1', 'Active', now(), 'secret://test/mail-webhook'),
                ($1, $3, 'SMS', 'sms-1', 'secret://test/sms', 'v1', 'Active', now(), 'secret://test/sms-webhook'),
                ($1, $4, 'PUSH_FCM', 'push-1', 'secret://test/push', 'v1', 'Active', now(), 'secret://test/push-webhook')`,
        [TENANT_A, EMAIL_ACCOUNT, SMS_ACCOUNT, PUSH_ACCOUNT],
      ],
      [
        `insert into machvon.notification_template_version (tenant_id, id, code, channel, locale, revision, content_ast, variable_schema, status, content_hash, created_by, lockscreen_safe)
         values ($1, $2, 'mail.a', 'EMAIL', 'vi-VN', 1, '{"subject":"S","body":"B"}'::jsonb, '{}'::jsonb, 'Active', repeat('c', 64), $5, false),
                ($1, $3, 'sms.a', 'SMS', 'vi-VN', 1, '{"body":"B"}'::jsonb, '{}'::jsonb, 'Active', repeat('d', 64), $5, false),
                ($1, $4, 'push.a', 'PUSH_FCM', 'vi-VN', 1, '{"body":"B"}'::jsonb, '{}'::jsonb, 'Active', repeat('e', 64), $5, true)`,
        [TENANT_A, EMAIL_TEMPLATE, SMS_TEMPLATE, PUSH_TEMPLATE, ACTOR],
      ],
      // Tokyo, and a person who turned the quiet hours off.
      [`insert into machvon.notification_preference_profile (tenant_id, membership_id, quiet_start, quiet_end, time_zone) values ($1, $2, '21:00', '07:00', 'Asia/Tokyo')`, [TENANT_A, memberId(TOKYO_PERSON)]],
      [`insert into machvon.notification_preference_profile (tenant_id, membership_id, time_zone) values ($1, $2, 'Asia/Ho_Chi_Minh')`, [TENANT_A, memberId(NO_QUIET_PERSON)]],
    ]);
  }, 180_000);

  afterAll(() => harness.stop(), 60_000);

  describe('the consent history', () => {
    it('records a grant with its facts, and shows it first in the history of the person', async () => {
      await owner("update machvon.user_account set phone_e164 = '+84900000001' where id = $1", [id(0x60, PERSON)]);
      const row = await as(PERSON, (tx) => consents.grant(tx, memberId(PERSON), { channel: 'SMS', purpose: 'OPERATIONAL', consentTextVersion: 'tos-2026-1', captureMethod: 'IN_APP' }));
      expect(row).toMatchObject({ subjectKind: 'MEMBERSHIP', subjectId: memberId(PERSON), channel: 'SMS', purpose: 'OPERATIONAL', status: 'Granted', consentTextVersion: 'tos-2026-1', captureMethod: 'IN_APP', legalBasis: 'CONSENT', version: 1, revokedAt: null });
      const [stored] = await owner<{ evidence_reference: string }>('select evidence_reference from machvon.contact_consent where id = $1', [row.id]);
      expect(stored?.evidence_reference).toBe(`in_app:${row.id}`);
      const history = await as(PERSON, (tx) => consents.historyOf(tx, memberId(PERSON), { limit: 10, after: undefined }));
      expect(history.map((entry) => entry.id)).toEqual([row.id]);
    });

    it('keeps the evidence the person points at', async () => {
      await owner("update machvon.user_account set phone_e164 = '+84900000002' where id = $1", [id(0x60, OTHER)]);
      const row = await as(OTHER, (tx) => consents.grant(tx, memberId(OTHER), { channel: 'ZALO', purpose: 'REMINDER', consentTextVersion: 'v2', captureMethod: 'PAPER_SCANNED', evidenceReference: 'scan://form-77' }));
      const [stored] = await owner<{ evidence_reference: string }>('select evidence_reference from machvon.contact_consent where id = $1', [row.id]);
      expect(stored?.evidence_reference).toBe('scan://form-77');
    });

    it('refuses a second live consent for the channel and the purpose with 409, and leaves the transaction usable', async () => {
      await as(PERSON, async (tx) => {
        await expect(consents.grant(tx, memberId(PERSON), { channel: 'SMS', purpose: 'OPERATIONAL', consentTextVersion: 'v1', captureMethod: 'IN_APP' })).rejects.toMatchObject({ code: 'CONSENT_ALREADY_GRANTED', status: 409 });
        expect((await consents.historyOf(tx, memberId(PERSON), { limit: 10, after: undefined })).length).toBeGreaterThan(0);
      });
    });

    it('lets exactly one of two racing grants through; the other is the 409 meant for it, never a raw error', async () => {
      await owner("update machvon.user_account set phone_e164 = '+84900000003' where id = $1", [id(0x60, TOKYO_PERSON)]);
      const grant = (): Promise<unknown> => as(TOKYO_PERSON, (tx) => consents.grant(tx, memberId(TOKYO_PERSON), { channel: 'WHATSAPP', purpose: 'ANNOUNCEMENT', consentTextVersion: 'v1', captureMethod: 'WEB_FORM' }));
      const settled = await Promise.allSettled([grant(), grant()]);
      expect(settled.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const lost = settled.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
      expect(lost?.reason).toMatchObject({ code: 'CONSENT_ALREADY_GRANTED' });
    });

    it('needs an identity on the channel: a phone for a phone channel, a registered device for a push', async () => {
      await expect(as(NO_QUIET_PERSON, (tx) => consents.grant(tx, memberId(NO_QUIET_PERSON), { channel: 'SMS', purpose: 'OPERATIONAL', consentTextVersion: 'v1', captureMethod: 'IN_APP' }))).rejects.toMatchObject({
        code: 'CHANNEL_IDENTITY_UNVERIFIED',
        status: 422,
      });
      await expect(as(NO_QUIET_PERSON, (tx) => consents.grant(tx, memberId(NO_QUIET_PERSON), { channel: 'PUSH', purpose: 'ANNOUNCEMENT', consentTextVersion: 'v1', captureMethod: 'IN_APP' }))).rejects.toMatchObject({ code: 'CHANNEL_IDENTITY_UNVERIFIED' });
      await owner(
        `insert into machvon.device_registration (tenant_id, id, membership_id, device_public_id, push_secret_ref, platform, last_seen_at, token_fingerprint, app_version)
         values ($1, gen_random_uuid(), $2, 'device-1', 'vault://push/1', 'android', now(), repeat('a', 64), '1.0.0')`,
        [TENANT_A, memberId(NO_QUIET_PERSON)],
      );
      const pushed = await as(NO_QUIET_PERSON, (tx) => consents.grant(tx, memberId(NO_QUIET_PERSON), { channel: 'PUSH', purpose: 'ANNOUNCEMENT', consentTextVersion: 'v1', captureMethod: 'IN_APP' }));
      expect(pushed.channel).toBe('PUSH');
      const mail = await as(NO_QUIET_PERSON, (tx) => consents.grant(tx, memberId(NO_QUIET_PERSON), { channel: 'EMAIL', purpose: 'ANNOUNCEMENT', consentTextVersion: 'v1', captureMethod: 'IN_APP' }));
      expect(mail.channel).toBe('EMAIL');
    });

    it('withdraws a consent at once: the row ends, its version moves, and the history keeps it', async () => {
      const granted = await as(PERSON, (tx) => consents.grant(tx, memberId(PERSON), { channel: 'EMAIL', purpose: 'ANNOUNCEMENT', consentTextVersion: 'v1', captureMethod: 'WEB_FORM' }));
      const withdrawn = await as(PERSON, (tx) => consents.withdraw(tx, memberId(PERSON), granted.id, 1, 'I do not want these any more'));
      expect(withdrawn).toMatchObject({ id: granted.id, status: 'Withdrawn', version: 2 });
      expect(withdrawn.revokedAt).not.toBeNull();
      expect(await as(PERSON, (tx) => consents.latest(tx, memberId(PERSON), 'EMAIL', 'ANNOUNCEMENT'))).toEqual({ status: 'Withdrawn' });
      const [stored] = await owner<{ withdrawn_reason: string }>('select withdrawn_reason from machvon.contact_consent where id = $1', [granted.id]);
      expect(stored?.withdrawn_reason).toBe('I do not want these any more');
    });

    it('refuses to withdraw twice (409 CONSENT_STATE_INVALID), on a stale version (409 VERSION_CONFLICT), and the consent of someone else (404)', async () => {
      const granted = await as(PERSON, (tx) => consents.grant(tx, memberId(PERSON), { channel: 'EMAIL', purpose: 'REMINDER', consentTextVersion: 'v1', captureMethod: 'IN_APP' }));
      await expect(as(PERSON, (tx) => consents.withdraw(tx, memberId(PERSON), granted.id, 7, 'A stale view of the consent'))).rejects.toMatchObject({ code: 'VERSION_CONFLICT', extensions: { current_version: 1 } });
      await expect(as(OTHER, (tx) => consents.withdraw(tx, memberId(OTHER), granted.id, 1, 'Not my consent to withdraw'))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      await as(PERSON, (tx) => consents.withdraw(tx, memberId(PERSON), granted.id, 1, 'Changed my mind about reminders'));
      await expect(as(PERSON, (tx) => consents.withdraw(tx, memberId(PERSON), granted.id, 2, 'Withdrawing a second time'))).rejects.toMatchObject({ code: 'CONSENT_STATE_INVALID', status: 409 });
      await expect(as(PERSON, (tx) => consents.withdraw(tx, memberId(PERSON), randomUUID(), 1, 'A consent that does not exist'))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });

    it('lets the latest consent decide: a new grant after a withdrawal is a new row, and it is the one that counts', async () => {
      const first = await as(PERSON, (tx) => consents.grant(tx, memberId(PERSON), { channel: 'ZALO', purpose: 'OPERATIONAL', consentTextVersion: 'v1', captureMethod: 'IN_APP' }));
      expect(await as(PERSON, (tx) => consents.latest(tx, memberId(PERSON), 'ZALO', 'OPERATIONAL'))).toEqual({ status: 'Granted' });
      await as(PERSON, (tx) => consents.withdraw(tx, memberId(PERSON), first.id, 1, 'Pausing the Zalo messages'));
      expect(await as(PERSON, (tx) => consents.latest(tx, memberId(PERSON), 'ZALO', 'OPERATIONAL'))).toEqual({ status: 'Withdrawn' });
      const second = await as(PERSON, (tx) => consents.grant(tx, memberId(PERSON), { channel: 'ZALO', purpose: 'OPERATIONAL', consentTextVersion: 'v2', captureMethod: 'IN_APP' }));
      expect(second.id).not.toBe(first.id);
      expect(await as(PERSON, (tx) => consents.latest(tx, memberId(PERSON), 'ZALO', 'OPERATIONAL'))).toEqual({ status: 'Granted' });
      const history = await as(PERSON, (tx) => consents.historyOf(tx, memberId(PERSON), { limit: 50, after: undefined }));
      expect(history.filter((entry) => entry.channel === 'ZALO').map((entry) => [entry.id, entry.status])).toEqual([
        [second.id, 'Granted'],
        [first.id, 'Withdrawn'],
      ]);
      expect(await as(PERSON, (tx) => consents.latest(tx, memberId(PERSON), 'ZALO', 'ANNOUNCEMENT'))).toBeUndefined();
    });

    it('pages the history by a keyset cursor and refuses a cursor that is not one', async () => {
      const all = await as(PERSON, (tx) => consents.historyOf(tx, memberId(PERSON), { limit: 50, after: undefined }));
      expect(all.length).toBeGreaterThanOrEqual(4);
      const first = await as(PERSON, (tx) => consents.historyOf(tx, memberId(PERSON), { limit: 2, after: undefined }));
      const last = first[1];
      const next = await as(PERSON, (tx) => consents.historyOf(tx, memberId(PERSON), { limit: 2, after: last === undefined ? undefined : { code: last.effectiveKey, id: last.id } }));
      expect([...first, ...next].map((entry) => entry.id)).toEqual(all.slice(0, 4).map((entry) => entry.id));
      await expect(as(PERSON, (tx) => consents.historyOf(tx, memberId(PERSON), { limit: 2, after: { code: 'yesterday', id: randomUUID() } }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('shows the people their own history only, and the operator the whole tenant', async () => {
      const mine = await as(OTHER, (tx) => consents.historyOf(tx, memberId(OTHER), { limit: 50, after: undefined }));
      expect(mine.every((entry) => entry.subjectId === memberId(OTHER))).toBe(true);
      const everyone = await as(PERSON, (tx) => consents.list(tx, { limit: 50, after: undefined }));
      expect(new Set(everyone.map((entry) => entry.subjectId))).toEqual(new Set([memberId(PERSON), memberId(OTHER), memberId(TOKYO_PERSON), memberId(NO_QUIET_PERSON)]));
      const firstPage = await as(PERSON, (tx) => consents.list(tx, { limit: 2, after: undefined }));
      const last = firstPage[1];
      const secondPage = await as(PERSON, (tx) => consents.list(tx, { limit: 2, after: last === undefined ? undefined : { code: last.effectiveKey, id: last.id } }));
      expect([...firstPage, ...secondPage].map((entry) => entry.id)).toEqual(everyone.slice(0, 4).map((entry) => entry.id));
      const [one] = everyone;
      expect(await as(PERSON, (tx) => consents.find(tx, one?.id ?? ''))).toMatchObject({ id: one?.id });
      expect(await as(PERSON, (tx) => consents.find(tx, randomUUID()))).toBeUndefined();
    });

    it('refuses a text version, an evidence reference or a reason that cannot be kept', async () => {
      const grant = (values: { consentTextVersion?: string; evidenceReference?: string }): Promise<unknown> =>
        as(OTHER, (tx) => consents.grant(tx, memberId(OTHER), { channel: 'EMAIL', purpose: 'OPERATIONAL', consentTextVersion: 'v1', captureMethod: 'WEB_FORM', ...values }));
      await expect(grant({ consentTextVersion: '' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', detail: 'consent_text_version' });
      await expect(grant({ consentTextVersion: 'v'.repeat(51) })).rejects.toMatchObject({ detail: 'consent_text_version' });
      await expect(grant({ evidenceReference: '' })).rejects.toMatchObject({ detail: 'evidence_reference' });
      await expect(grant({ evidenceReference: 'e'.repeat(501) })).rejects.toMatchObject({ detail: 'evidence_reference' });
      await expect(as(OTHER, (tx) => consents.withdraw(tx, memberId(OTHER), randomUUID(), 1, 'short'))).rejects.toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
      await expect(as(OTHER, (tx) => consents.withdraw(tx, memberId(OTHER), randomUUID(), 1, 'r'.repeat(2001)))).rejects.toMatchObject({ detail: 'reason' });
    });

    it('is invisible to another tenant', async () => {
      const foreign = await as(PERSON, (tx) => consents.list(tx, { limit: 50, after: undefined }), TENANT_B);
      expect(foreign).toEqual([]);
    });

    it('is evidence in the database: facts never change, an ended consent is final, a row is never deleted', async () => {
      const granted = await as(PERSON, (tx) => consents.grant(tx, memberId(PERSON), { channel: 'EMAIL', purpose: 'SUPPORT_CONVERSATION', consentTextVersion: 'v1', captureMethod: 'IN_APP' }));
      await expect(owner("update machvon.contact_consent set channel = 'SMS' where id = $1", [granted.id])).rejects.toMatchObject({ message: expect.stringContaining('facts of a consent never change') });
      await expect(owner("update machvon.contact_consent set consent_text_version = 'v9' where id = $1", [granted.id])).rejects.toMatchObject({ message: expect.stringContaining('never change') });
      await expect(owner("update machvon.contact_consent set status = 'Withdrawn', revoked_at = now(), version = 5 where id = $1", [granted.id])).rejects.toMatchObject({ message: expect.stringContaining('version of a consent') });
      await expect(owner("update machvon.contact_consent set version = 2 where id = $1", [granted.id])).rejects.toMatchObject({ message: expect.stringContaining('can only end') });
      await expect(owner("update machvon.contact_consent set status = 'Withdrawn', revoked_at = now(), version = 2 where id = $1", [granted.id])).rejects.toMatchObject({
        message: expect.stringContaining('contact_consent_withdrawn_reason_chk'),
      });
      await as(PERSON, (tx) => consents.withdraw(tx, memberId(PERSON), granted.id, 1, 'Ending the support conversation consent'));
      await expect(owner("update machvon.contact_consent set status = 'Granted', revoked_at = null, withdrawn_reason = null, version = 3 where id = $1", [granted.id])).rejects.toMatchObject({
        message: expect.stringContaining('has ended is never changed'),
      });
      await expect(owner('delete from machvon.contact_consent where id = $1', [granted.id])).rejects.toMatchObject({ message: expect.stringContaining('never deleted') });
    });

    it('refuses a channel or a purpose that nobody can consent to', async () => {
      const insert = (channel: string, purpose: string): Promise<unknown> =>
        owner(
          `insert into machvon.contact_consent (tenant_id, id, membership_id, channel, purpose, status, evidence_reference, effective_at, consent_text_version, capture_method)
           values ($1, gen_random_uuid(), $2, $3, $4, 'Granted', 'x', now(), 'v1', 'IN_APP')`,
          [TENANT_A, memberId(OTHER), channel, purpose],
        );
      await expect(insert('IN_APP', 'OPERATIONAL')).rejects.toMatchObject({ message: expect.stringContaining('contact_consent_channel_chk') });
      await expect(insert('SMS', 'SECURITY')).rejects.toMatchObject({ message: expect.stringContaining('contact_consent_purpose_chk') });
    });
  });

  describe('the preferences of a person', () => {
    it('are the defaults for a person who never saved any: version 0, the default quiet hours, the Vietnamese time zone', async () => {
      expect(await as(OTHER, (tx) => preferences.read(tx, memberId(OTHER)))).toEqual({
        version: 0,
        quietHours: { start: '21:00', end: '07:00' },
        timeZone: 'Asia/Ho_Chi_Minh',
        items: [],
        isDefault: true,
      });
      expect(await as(OTHER, (tx) => preferences.channelEnabled(tx, memberId(OTHER), 'report', 'SMS'))).toBe(true);
    });

    it('are replaced as a whole under the version the person saw, starting from 0', async () => {
      const first = await as(OTHER, (tx) =>
        preferences.replace(tx, memberId(OTHER), input({ items: items({ eventCategory: 'report', channel: 'SMS', enabled: false }, { eventCategory: '*', channel: 'EMAIL', digestMode: 'DAILY' }), quietStart: '22:00', quietEnd: '06:30', timeZone: 'Asia/Tokyo' }), 0),
      );
      expect(first).toBe(1);
      const saved = await as(OTHER, (tx) => preferences.read(tx, memberId(OTHER)));
      expect(saved).toMatchObject({ version: 1, quietHours: { start: '22:00', end: '06:30' }, timeZone: 'Asia/Tokyo', isDefault: false });
      expect(saved.items).toEqual([
        { eventCategory: '*', channel: 'EMAIL', enabled: true, digestMode: 'DAILY' },
        { eventCategory: 'report', channel: 'SMS', enabled: false, digestMode: 'IMMEDIATE' },
      ]);
      const second = await as(OTHER, (tx) => preferences.replace(tx, memberId(OTHER), input({ items: items({ eventCategory: 'plan', channel: 'EMAIL' }) }), 1));
      expect(second).toBe(2);
      expect((await as(OTHER, (tx) => preferences.read(tx, memberId(OTHER)))).items.map((entry) => entry.eventCategory)).toEqual(['plan']);
    });

    it('refuses a stale version with the current one, and a first save when the person already has preferences', async () => {
      await expect(as(OTHER, (tx) => preferences.replace(tx, memberId(OTHER), input(), 1))).rejects.toMatchObject({ code: 'VERSION_CONFLICT', extensions: { current_version: 2 } });
      await expect(as(OTHER, (tx) => preferences.replace(tx, memberId(OTHER), input(), 0))).rejects.toMatchObject({ code: 'VERSION_CONFLICT', extensions: { current_version: 2 } });
      await expect(as(PERSON, (tx) => preferences.replace(tx, memberId(PERSON), input(), 3))).rejects.toMatchObject({ code: 'VERSION_CONFLICT', extensions: { current_version: 0 } });
    });

    it('lets exactly one of two first saves win', async () => {
      const save = (): Promise<number> => as(PERSON, (tx) => preferences.replace(tx, memberId(PERSON), input({ items: items({ eventCategory: 'report', channel: 'PUSH' }) }), 0));
      const settled = await Promise.allSettled([save(), save()]);
      expect(settled.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const lost = settled.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
      expect(lost?.reason).toMatchObject({ code: 'VERSION_CONFLICT' });
      expect((await as(PERSON, (tx) => preferences.read(tx, memberId(PERSON)))).version).toBe(1);
    });

    it('turn the quiet hours off when none are given, and a person without hours has none', async () => {
      await as(NO_QUIET_PERSON, (tx) => preferences.replace(tx, memberId(NO_QUIET_PERSON), { items: [] }, 1));
      expect(await as(NO_QUIET_PERSON, (tx) => preferences.quietHoursOf(tx, memberId(NO_QUIET_PERSON)))).toBeUndefined();
      const read = await as(NO_QUIET_PERSON, (tx) => preferences.read(tx, memberId(NO_QUIET_PERSON)));
      expect(read).toMatchObject({ version: 2, quietHours: undefined, timeZone: 'Asia/Ho_Chi_Minh' });
      expect(await as(TOKYO_PERSON, (tx) => preferences.quietHoursOf(tx, memberId(TOKYO_PERSON)))).toEqual({ start: '21:00', end: '07:00', timeZone: 'Asia/Tokyo' });
    });

    it.each([
      ['a duplicate pair', input({ items: items({ eventCategory: 'report', channel: 'SMS' }, { eventCategory: 'report', channel: 'SMS', enabled: false }) }), 'items'],
      ['a category with capitals', input({ items: items({ eventCategory: 'Report', channel: 'SMS' }) }), 'items.event_category'],
      ['a category with a dot', input({ items: items({ eventCategory: 'report.overdue', channel: 'SMS' }) }), 'items.event_category'],
      ['a channel that does not exist', input({ items: [{ eventCategory: 'report', channel: 'FAX' as never, enabled: true, digestMode: 'IMMEDIATE' }] }), 'items.channel'],
      ['a digest mode that does not exist', input({ items: [{ eventCategory: 'report', channel: 'SMS', enabled: true, digestMode: 'WEEKLY' as never }] }), 'items.digest_mode'],
      ['more than two hundred items', input({ items: Array.from({ length: 201 }, (_, n) => ({ eventCategory: `c${n}`, channel: 'SMS' as const, enabled: true, digestMode: 'IMMEDIATE' as const })) }), 'items'],
      ['half of the quiet hours', { items: [], quietStart: '21:00' }, 'quiet_start'],
      ['a start that is not a clock time', input({ quietStart: '29:00' }), 'quiet_start'],
      ['a start equal to the end', input({ quietStart: '07:00', quietEnd: '07:00' }), 'quiet_end'],
      ['an end that is not a clock time', input({ quietEnd: '7am' }), 'quiet_end'],
      ['a time zone that does not exist', input({ timeZone: 'Mars/Olympus' }), 'time_zone'],
    ])('refuse %s with 422', async (_name, value, detail) => {
      await expect(as(OTHER, (tx) => preferences.replace(tx, memberId(OTHER), value, 2))).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail });
    });

    it('resolve a channel by the category first, then by every category, then yes', async () => {
      await as(TOKYO_PERSON, (tx) => preferences.replace(tx, memberId(TOKYO_PERSON), input({ items: items({ eventCategory: '*', channel: 'SMS', enabled: false }, { eventCategory: 'report', channel: 'SMS', enabled: true }, { eventCategory: 'plan', channel: 'EMAIL', enabled: false }), timeZone: 'Asia/Tokyo' }), 1));
      const enabled = (category: string, channel: 'SMS' | 'EMAIL'): Promise<boolean> => as(TOKYO_PERSON, (tx) => preferences.channelEnabled(tx, memberId(TOKYO_PERSON), category, channel));
      expect(await enabled('report', 'SMS')).toBe(true);
      expect(await enabled('plan', 'SMS')).toBe(false);
      expect(await enabled('plan', 'EMAIL')).toBe(false);
      expect(await enabled('report', 'EMAIL')).toBe(true);
    });

    it('cannot switch off the inbox of a category that holds an urgent event, nor of every category when one does', async () => {
      expect(await as(PERSON, (tx) => preferences.lockedChannels(tx))).toEqual([
        { eventCategory: 'approval', channel: 'IN_APP' },
        { eventCategory: 'deadline', channel: 'IN_APP' },
        { eventCategory: 'guarantee', channel: 'IN_APP' },
      ]);
      const off = (category: string): Promise<number> => as(OTHER, async (tx) => preferences.replace(tx, memberId(OTHER), input({ items: items({ eventCategory: category, channel: 'IN_APP', enabled: false }) }), (await preferences.read(tx, memberId(OTHER))).version));
      await expect(off('approval')).rejects.toMatchObject({ code: 'MANDATORY_CHANNEL_LOCKED', status: 422 });
      await expect(off('guarantee')).rejects.toMatchObject({ code: 'MANDATORY_CHANNEL_LOCKED' });
      await expect(off('*')).rejects.toMatchObject({ code: 'MANDATORY_CHANNEL_LOCKED' });
      // A category with only ordinary events can have its inbox switched off, and the locked inbox can be left on.
      await expect(off('report')).resolves.toBeGreaterThan(0);
      await expect(as(OTHER, async (tx) => preferences.replace(tx, memberId(OTHER), input({ items: items({ eventCategory: 'approval', channel: 'IN_APP', enabled: true }, { eventCategory: 'approval', channel: 'SMS', enabled: false }) }), (await preferences.read(tx, memberId(OTHER))).version))).resolves.toBeGreaterThan(0);
    });
  });

  describe('the gate when a send is taken up', () => {
    interface Notified {
      id: string;
      attemptId: string;
    }

    /** A notification as the consumer makes it, and the id of its first queued attempt. */
    async function notify(member: number, plan: readonly string[], options: { priority?: NotificationPriority; workflow?: string; purpose?: string; eventType?: string } = {}): Promise<Notified> {
      const created = await as(member, async (tx) => {
        const eventId = randomUUID();
        const purpose = options.purpose ?? 'OPERATIONAL';
        const inserted = await notifications.insert(tx, {
          eventId,
          workflowVersionId: options.workflow ?? WORKFLOW,
          recipientId: memberId(member),
          purpose,
          dedupeKey: dedupeKeyOf({ tenantId: TENANT_A, sourceEventId: eventId, recipientId: memberId(member), purpose }),
          expiresAt: new Date('2026-10-30T00:00:00Z'),
          sourceEventType: options.eventType ?? 'report.overdue',
          eventVersion: 1,
          priority: options.priority ?? 'NORMAL',
          ackRequired: false,
          channelPlan: plan,
        });
        await engine.startChain(tx, await deliveries.requireNotification(tx, inserted.id));
        return inserted.id;
      });
      const [attempt] = await owner<{ id: string }>("select id from machvon.delivery_attempt where notification_id = $1 and status = 'Queued' order by created_at desc limit 1", [created]);
      return { id: created, attemptId: attempt?.id ?? '' };
    }

    const claim = (member: number, attemptId: string, now: Date, provider = SMS) => as(member, (tx) => engine.claim(tx, attemptId, provider, now));
    const attemptRow = async (attemptId: string): Promise<{ status: string; error_code: string | null; next_retry_at: Date | null }> => {
      const [row] = await owner<{ status: string; error_code: string | null; next_retry_at: Date | null }>('select status, error_code, next_retry_at from machvon.delivery_attempt where id = $1', [attemptId]);
      if (row === undefined) throw new Error('no attempt');
      return row;
    };
    const notificationRow = async (notificationId: string): Promise<{ status: string; suppression_reason: string | null }> => {
      const [row] = await owner<{ status: string; suppression_reason: string | null }>('select status, suppression_reason from machvon.notification_instance where id = $1', [notificationId]);
      if (row === undefined) throw new Error('no notification');
      return row;
    };

    it('suppresses a send to a person who gave no consent, makes no send, and ends a notification that has no other way to reach them', async () => {
      const sent = await notify(OTHER, ['SMS']);
      const outcome = await claim(OTHER, sent.attemptId, NOON);
      expect(outcome).toEqual({ kind: 'SKIPPED', reason: 'SUPPRESSED' });
      expect(await attemptRow(sent.attemptId)).toMatchObject({ status: 'Suppressed', error_code: 'NO_CONSENT', next_retry_at: null });
      expect(await notificationRow(sent.id)).toEqual({ status: 'Suppressed', suppression_reason: 'NO_CONSENT' });
    });

    it('lets the next channel of the plan take over when a channel is suppressed, and keeps the inbox delivery', async () => {
      await grantDirect(OTHER, 'EMAIL');
      const sent = await notify(OTHER, ['IN_APP', 'SMS', 'EMAIL']);
      expect(await claim(OTHER, sent.attemptId, NOON)).toEqual({ kind: 'SKIPPED', reason: 'SUPPRESSED' });
      const attempts = await owner<{ channel: string; status: string }>('select channel, status from machvon.delivery_attempt where notification_id = $1 order by created_at, attempt_no', [sent.id]);
      expect(attempts).toEqual([
        { channel: 'SMS', status: 'Suppressed' },
        { channel: 'EMAIL', status: 'Queued' },
      ]);
      expect((await notificationRow(sent.id)).status).toBe('Delivered');
      const [email] = await owner<{ id: string }>("select id from machvon.delivery_attempt where notification_id = $1 and channel = 'EMAIL'", [sent.id]);
      expect((await claim(OTHER, email?.id ?? '', NOON, EMAIL)).kind).toBe('CLAIMED');
    });

    it('sends once the person has consented, and not before: the latest consent decides at every check', async () => {
      await owner("update machvon.user_account set phone_e164 = '+84900000009' where id = $1", [id(0x60, NO_QUIET_PERSON)]);
      const before = await notify(NO_QUIET_PERSON, ['SMS']);
      expect((await claim(NO_QUIET_PERSON, before.attemptId, NOON)).kind).toBe('SKIPPED');
      const granted = await as(NO_QUIET_PERSON, (tx) => consents.grant(tx, memberId(NO_QUIET_PERSON), { channel: 'SMS', purpose: 'OPERATIONAL', consentTextVersion: 'v1', captureMethod: 'IN_APP' }));
      const after = await notify(NO_QUIET_PERSON, ['SMS']);
      expect((await claim(NO_QUIET_PERSON, after.attemptId, NOON)).kind).toBe('CLAIMED');
      // Withdrawn after the next one was queued and before it was taken up: suppressed, nothing sent.
      const waiting = await notify(NO_QUIET_PERSON, ['SMS']);
      await as(NO_QUIET_PERSON, (tx) => consents.withdraw(tx, memberId(NO_QUIET_PERSON), granted.id, 1, 'Stopping the text messages'));
      expect(await claim(NO_QUIET_PERSON, waiting.attemptId, NOON)).toEqual({ kind: 'SKIPPED', reason: 'SUPPRESSED' });
      expect(await attemptRow(waiting.attemptId)).toMatchObject({ status: 'Suppressed', error_code: 'NO_CONSENT' });
    });

    it('needs the consent of the purpose of the message: an announcement is not covered by a consent to operational messages', async () => {
      await grantDirect(TOKYO_PERSON, 'SMS', 'OPERATIONAL');
      const announcement = await notify(TOKYO_PERSON, ['SMS'], { purpose: 'ANNOUNCEMENT' });
      expect((await claim(TOKYO_PERSON, announcement.attemptId, NOON)).kind).toBe('SKIPPED');
      expect(await attemptRow(announcement.attemptId)).toMatchObject({ error_code: 'NO_CONSENT' });
      const security = await notify(TOKYO_PERSON, ['SMS'], { purpose: 'SECURITY' });
      expect((await claim(TOKYO_PERSON, security.attemptId, NOON)).kind).toBe('CLAIMED');
    });

    it('honours a preference that switches the channel off for the category, even for a person who consented', async () => {
      await grantDirect(PERSON, 'EMAIL');
      await as(PERSON, async (tx) => preferences.replace(tx, memberId(PERSON), input({ items: items({ eventCategory: 'report', channel: 'SMS', enabled: false }) }), (await preferences.read(tx, memberId(PERSON))).version));
      const sent = await notify(PERSON, ['SMS']);
      expect(await claim(PERSON, sent.attemptId, NOON)).toEqual({ kind: 'SKIPPED', reason: 'SUPPRESSED' });
      expect(await attemptRow(sent.attemptId)).toMatchObject({ status: 'Suppressed', error_code: 'PREFERENCE_OFF' });
      const other = await notify(PERSON, ['EMAIL']);
      expect((await claim(PERSON, other.attemptId, NOON, EMAIL)).kind).toBe('CLAIMED');
    });

    it('holds a send in the quiet hours until they end, and takes it up when they have ended (UAT-AC27 NORMAL half)', async () => {
      await as(PERSON, async (tx) => preferences.replace(tx, memberId(PERSON), input(), (await preferences.read(tx, memberId(PERSON))).version));
      const sent = await notify(PERSON, ['SMS']);
      expect(await claim(PERSON, sent.attemptId, NIGHT)).toEqual({ kind: 'SKIPPED', reason: 'DEFERRED' });
      const held = await attemptRow(sent.attemptId);
      expect(held.status).toBe('Queued');
      expect(held.error_code).toBe('QUIET_HOURS');
      expect(held.next_retry_at?.toISOString()).toBe('2026-10-23T00:00:00.000Z');
      // The dispatcher does not see it before then.
      expect(await as(PERSON, (tx) => deliveries.dueAttempts(tx, 'SMS', new Date('2026-10-22T23:59:00Z'), 10))).toEqual([]);
      expect(await claim(PERSON, sent.attemptId, new Date('2026-10-22T23:59:30Z'))).toEqual({ kind: 'SKIPPED', reason: 'NOT_DUE' });
      expect((await claim(PERSON, sent.attemptId, new Date('2026-10-23T00:00:00Z'))).kind).toBe('CLAIMED');
      expect(await attemptRow(sent.attemptId)).toMatchObject({ status: 'Sending', error_code: null, next_retry_at: null });
    });

    it('reads the hours on the wall clock of the person: the same instant sends in Vietnam and waits in Tokyo (UAT-AC185)', async () => {
      await grantDirect(TOKYO_PERSON, 'SMS', 'REMINDER');
      await grantDirect(PERSON, 'SMS', 'REMINDER');
      const vietnam = await notify(PERSON, ['SMS'], { purpose: 'REMINDER' });
      const tokyo = await notify(TOKYO_PERSON, ['SMS'], { purpose: 'REMINDER' });
      expect((await claim(PERSON, vietnam.attemptId, EVENT_TIME)).kind).toBe('CLAIMED');
      expect(await claim(TOKYO_PERSON, tokyo.attemptId, EVENT_TIME)).toEqual({ kind: 'SKIPPED', reason: 'DEFERRED' });
      expect((await attemptRow(tokyo.attemptId)).next_retry_at?.toISOString()).toBe('2026-10-22T22:00:00.000Z');
    });

    it('does not hold the inbox or e-mail, and does not hold a person who turned the quiet hours off', async () => {
      await grantDirect(NO_QUIET_PERSON, 'EMAIL');
      await grantDirect(NO_QUIET_PERSON, 'SMS');
      const mail = await notify(NO_QUIET_PERSON, ['EMAIL']);
      expect((await claim(NO_QUIET_PERSON, mail.attemptId, NIGHT, EMAIL)).kind).toBe('CLAIMED');
      const text = await notify(NO_QUIET_PERSON, ['SMS']);
      expect((await claim(NO_QUIET_PERSON, text.attemptId, NIGHT)).kind).toBe('CLAIMED');
    });

    it('sends an urgent message in the quiet hours only when its workflow says so, and then writes an audit row (UAT-AC27 CRITICAL half)', async () => {
      await as(OTHER, async (tx) => preferences.replace(tx, memberId(OTHER), input(), (await preferences.read(tx, memberId(OTHER))).version));
      const plain = await notify(OTHER, ['IN_APP', 'PUSH_FCM'], { priority: 'CRITICAL', workflow: WORKFLOW_URGENT, eventType: 'approval.requested' });
      expect(await claim(OTHER, plain.attemptId, NIGHT, 'fcm')).toEqual({ kind: 'SKIPPED', reason: 'DEFERRED' });
      const normal = await notify(OTHER, ['IN_APP', 'PUSH_FCM'], { priority: 'NORMAL', workflow: WORKFLOW_OVERRIDE, eventType: 'approval.requested' });
      expect(await claim(OTHER, normal.attemptId, NIGHT, 'fcm')).toEqual({ kind: 'SKIPPED', reason: 'DEFERRED' });
      const before = metrics.counted.filter((name) => name === QUIET_HOURS_OVERRIDE_METRIC).length;
      const urgent = await notify(OTHER, ['IN_APP', 'PUSH_FCM'], { priority: 'CRITICAL', workflow: WORKFLOW_OVERRIDE, eventType: 'approval.requested' });
      expect((await claim(OTHER, urgent.attemptId, NIGHT, 'fcm')).kind).toBe('CLAIMED');
      const audit = await owner<{ action: string; resource_id: string; actor_id: string; safe_diff: Record<string, unknown> }>(
        "select action, resource_id, actor_id, safe_diff from machvon.audit_event where action = 'notification.quiet_hours_override' and resource_id = $1",
        [urgent.id],
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]?.safe_diff).toMatchObject({ channel: 'PUSH_FCM', attempt_no: 1, priority: 'CRITICAL', sent_at: NIGHT.toISOString(), quiet_ends_at: '2026-10-23T00:00:00.000Z' });
      expect(metrics.counted.filter((name) => name === QUIET_HOURS_OVERRIDE_METRIC)).toHaveLength(before + 1);
      // The override breaks the quiet hours only: a push the person never consented to (an announcement) is still not sent.
      const refused = await notify(OTHER, ['IN_APP', 'PUSH_FCM'], { priority: 'CRITICAL', workflow: WORKFLOW_OVERRIDE, eventType: 'approval.requested', purpose: 'ANNOUNCEMENT' });
      expect(await claim(OTHER, refused.attemptId, NIGHT, 'fcm')).toEqual({ kind: 'SKIPPED', reason: 'SUPPRESSED' });
    });

    it('checks again when a retry is taken up: a retry in the quiet hours waits, and a consent withdrawn between two sends stops the chain', async () => {
      const sent = await notify(TOKYO_PERSON, ['SMS', 'EMAIL']);
      expect((await claim(TOKYO_PERSON, sent.attemptId, NOON)).kind).toBe('CLAIMED');
      await as(TOKYO_PERSON, (tx) => engine.recordSendResult(tx, sent.attemptId, { kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: 'HTTP_503' }, NOON));
      const [retry] = await owner<{ id: string }>("select id from machvon.delivery_attempt where notification_id = $1 and status = 'Queued'", [sent.id]);
      // The retry falls at 22:31 in Tokyo: it waits for the morning instead of failing.
      expect(await claim(TOKYO_PERSON, retry?.id ?? '', new Date('2026-10-22T13:31:00Z'))).toEqual({ kind: 'SKIPPED', reason: 'DEFERRED' });
    });
  });
});
