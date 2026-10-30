import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { ContactConsentStore, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { ContactConsentReadsController } from '../../src/notifications/consents/consents.controller';
import { ContactConsentsController } from '../../src/omni/contacts/contact-consents.controller';
import { ContactsController } from '../../src/omni/contacts/contacts.controller';
import { IDENTITY_OTP_SENDER, MockOtpSender } from '../../src/omni/contacts/identity-otp';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const AGENT = 1; // keeps the directory and the consents, reads them
const SUPERVISOR = 2; // the same, and verifies by a document and merges
const READER = 3; // reads the consents
const NOBODY = 4;
const SCOPED_AGENT = 5; // the permissions of an agent on one unit only
const OTHER_TENANT_AGENT = 1; // of tenant B
const REASON = 'The person asked by message to stop the conversations.';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the consent of a contact outside the tenant (ST-OMNI-003, OMNI-04, BR-NOT-07)', () => {
  const harness = new AuthzHarness();
  const consents = new ContactConsentStore();
  let app: RunningApp;
  let phones = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  const rows = <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

  async function call(method: 'GET' | 'POST', url: string, options: { member?: number; tenantId?: string; body?: unknown; ifMatch?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member ?? AGENT, options.tenantId), 'content-type': 'application/json' };
    if (method === 'POST') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, ...(method === 'POST' ? { body: JSON.stringify(options.body ?? {}) } : {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const phone = (): string => `09${String(20_000_000 + (phones += 1))}`;
  /** A contact with an identity on a channel, verified by a document of the supervisor (or only added, when `verify` is false). */
  async function contact(name = 'Phạm Văn D', channels: Array<'PHONE' | 'EMAIL' | 'ZALO' | 'WHATSAPP'> = ['PHONE'], verify = true): Promise<string> {
    const made = await call('POST', '/contacts', { body: { display_name: name, classification: 'CITIZEN' } });
    const contactId = made.json.resource_id as string;
    for (const channel of channels) {
      const value = channel === 'EMAIL' ? `p${phones += 1}@example.com` : channel === 'ZALO' ? `uid_${randomUUID().slice(0, 8)}` : phone();
      const added = await call('POST', `/contacts/${contactId}/identities`, { body: { channel, external_id: value } });
      if (!verify) continue;
      const identityId = added.json.resource_id as string;
      const version = Number((await rows<{ version: string }>('select version::text as version from machvon.contact_identity where id = $1', [identityId]))[0]?.version);
      expect((await call('POST', `/contacts/${contactId}/identities/${identityId}/verify`, { member: SUPERVISOR, ifMatch: `"${version}"`, body: { method: 'ADMIN_DOCUMENT', document_ref: 'decision-17' } })).status).toBe(200);
    }
    return contactId;
  }
  const grant = (contactId: string, change: Record<string, unknown> = {}, member = AGENT) =>
    call('POST', `/contacts/${contactId}/consents`, { member, body: { channel: 'SMS', purpose: 'SUPPORT_CONVERSATION', consent_text_version: 'v3', capture_method: 'IN_APP', ...change } });
  const versionOf = async (consentId: string): Promise<number> => Number((await rows<{ version: string }>('select version::text as version from machvon.contact_consent where id = $1', [consentId]))[0]?.version);
  const withdraw = async (consentId: string, member = AGENT, reason = REASON) => call('POST', `/contact-consents/${consentId}/withdraw`, { member, ifMatch: `"${await versionOf(consentId)}"`, body: { reason } });
  const latest = (contactId: string, channel: string, purpose: string) => (harness.tenants as TenantDatabase).withTenant({ tenantId: TENANT_A, membershipId: memberId(AGENT), scopeVersion: 1 }, (tx) => consents.latestForContact(tx, contactId, channel, purpose));

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
    for (const member of [AGENT, SUPERVISOR, READER, NOBODY, SCOPED_AGENT]) await harness.seedMembership(TENANT_A, member, 1, { validFrom: '2026-01-01T00:00:00Z' });
    await harness.seedMembership(TENANT_B, OTHER_TENANT_AGENT, 1, { validFrom: '2026-01-01T00:00:00Z' });
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedRole(tenant, 1, 'OMNI_AGENT_TEST', ['omni.contact.manage', 'omni.consent.manage', 'contact.read', 'contact_consent.read'], 35);
      await harness.seedRole(tenant, 2, 'OMNI_SUPERVISOR_TEST', ['omni.contact.manage', 'omni.contact.merge', 'omni.consent.manage', 'contact.read', 'contact_consent.read'], 50);
      await harness.seedRole(tenant, 3, 'CONSENT_READER', ['contact_consent.read'], 10);
    }
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: AGENT, role: 1, kind: 'TENANT' },
      { n: 2, member: SUPERVISOR, role: 2, kind: 'TENANT' },
      { n: 3, member: READER, role: 3, kind: 'TENANT' },
      { n: 4, member: SCOPED_AGENT, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(1)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT_AGENT, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [ContactsController, ContactConsentsController, ContactConsentReadsController],
      providers: [{ provide: TenantDatabase, useValue: tenants }, { provide: IDENTITY_OTP_SENDER, useValue: new MockOtpSender() }, { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }],
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await harness.stop();
  }, 60_000);

  it('AC-ST-OMNI-003-1 UAT-AC22: withdrawing the support consent of a contact with a support and a reminder consent ends that one with its moment, writes one audit row and one not.consent.changed.v1, and leaves the other', async () => {
    const owner = await contact();
    const support = await grant(owner, { purpose: 'SUPPORT_CONVERSATION', capture_method: 'CHANNEL_OPT_IN', evidence_reference: 'message-opt-in-77' });
    const reminder = await grant(owner, { purpose: 'REMINDER', capture_method: 'PAPER_SCANNED', evidence_reference: 'minutes-3' });
    expect(support.status).toBe(201);
    expect(support.json).toMatchObject({ status: 'Granted', resource_version: 1 });
    expect(await latest(owner, 'SMS', 'SUPPORT_CONVERSATION')).toEqual({ status: 'Granted' });
    const supportId = support.json.resource_id as string;
    const done = await withdraw(supportId);
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ status: 'Withdrawn', resource_version: 2 });
    const [row] = await rows<{ status: string; revoked_at: Date | null; withdrawn_reason: string; contact_id: string; membership_id: string | null }>(
      'select status, revoked_at, withdrawn_reason, contact_id, membership_id from machvon.contact_consent where id = $1',
      [supportId],
    );
    expect(row).toMatchObject({ status: 'Withdrawn', revoked_at: expect.any(Date), withdrawn_reason: REASON, contact_id: owner, membership_id: null });
    expect(await latest(owner, 'SMS', 'SUPPORT_CONVERSATION')).toEqual({ status: 'Withdrawn' });
    expect(await latest(owner, 'SMS', 'REMINDER')).toEqual({ status: 'Granted' });
    expect((await rows<{ status: string }>('select status from machvon.contact_consent where id = $1', [reminder.json.resource_id]))[0]?.status).toBe('Granted');
    // One trail row and one event for the withdrawal, about the contact; the reference of the proof is not on the trail.
    const trail = await rows<{ safe_diff: Record<string, unknown>; reason: string }>("select safe_diff, reason from machvon.audit_event where action = 'consent.withdrawn' and resource_id = $1", [supportId]);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ reason: REASON, safe_diff: { subject_kind: 'CONTACT', subject_id: owner, channel: 'SMS', purpose: 'SUPPORT_CONVERSATION' } });
    expect(JSON.stringify(await rows("select safe_diff from machvon.audit_event where resource_id = $1", [supportId]))).not.toContain('message-opt-in-77');
    const events = await rows<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where type = 'not.consent.changed.v1' and aggregate_id = $1 order by aggregate_version", [supportId]);
    expect(events.map((event) => event.payload.status)).toEqual(['Granted', 'Withdrawn']);
    expect(events[1]?.payload).toMatchObject({ consent_id: supportId, subject_kind: 'CONTACT', subject_id: owner, channel: 'SMS', purpose: 'SUPPORT_CONVERSATION' });
    // A withdrawn consent can be taken again: a new row, and the latest decides.
    const again = await grant(owner, { purpose: 'SUPPORT_CONVERSATION' });
    expect(again.status).toBe(201);
    expect(await latest(owner, 'SMS', 'SUPPORT_CONVERSATION')).toEqual({ status: 'Granted' });
  });

  it('takes a consent only on an identity of the contact that is Verified on the channel (422 IDENTITY_UNVERIFIED), and not for a push', async () => {
    const onlyPhone = await contact('Only a phone', ['PHONE']);
    const unverified = await contact('Not verified', ['EMAIL'], false);
    expect((await grant(onlyPhone, { channel: 'EMAIL' })).json.code).toBe('IDENTITY_UNVERIFIED');
    expect((await grant(onlyPhone, { channel: 'ZALO' })).json.code).toBe('IDENTITY_UNVERIFIED');
    const pending = await grant(unverified, { channel: 'EMAIL' });
    expect(pending.status).toBe(422);
    expect(pending.json.code).toBe('IDENTITY_UNVERIFIED');
    expect((await grant(onlyPhone, { channel: 'PUSH' })).json.code).toBe('VALIDATION_FAILED');
    // Each channel rests on the identity that carries it.
    const many = await contact('Many', ['PHONE', 'EMAIL', 'ZALO', 'WHATSAPP']);
    for (const channel of ['SMS', 'EMAIL', 'ZALO', 'WHATSAPP']) expect((await grant(many, { channel })).status).toBe(201);
  });

  it('is 409 CONSENT_ALREADY_GRANTED for a second live consent on the channel and the purpose, also when two are taken at once', async () => {
    const owner = await contact();
    expect((await grant(owner)).status).toBe(201);
    const second = await grant(owner);
    expect(second.status).toBe(409);
    expect(second.json.code).toBe('CONSENT_ALREADY_GRANTED');
    const another = await contact('Raced');
    const raced = await Promise.all([grant(another), grant(another), grant(another)]);
    expect(raced.map((reply) => reply.status).sort()).toEqual([201, 409, 409]);
    expect(await rows("select 1 from machvon.contact_consent where contact_id = $1 and status = 'Granted'", [another])).toHaveLength(1);
  });

  it('wants the proof when what was taken leaves one, the terms version and a purpose that exists, and refuses a contact that is not found or was merged away', async () => {
    const owner = await contact();
    expect((await grant(owner, { capture_method: 'PAPER_SCANNED' })).json.code).toBe('VALIDATION_FAILED');
    expect((await grant(owner, { consent_text_version: '' })).json.code).toBe('VALIDATION_FAILED');
    expect((await grant(owner, { purpose: 'MARKETING' })).json.code).toBe('VALIDATION_FAILED');
    expect((await grant(randomUUID())).status).toBe(404);
    // A contact merged into another takes no consent of its own: the contact that is alive does.
    const survivor = await contact('Survivor');
    const merged = await contact('Merged away');
    const number = phone();
    for (const [target, channel] of [[survivor, 'PHONE'], [merged, 'WHATSAPP']] as const) {
      const added = await call('POST', `/contacts/${target}/identities`, { body: { channel, external_id: number } });
      const identityId = added.json.resource_id as string;
      const version = Number((await rows<{ version: string }>('select version::text as version from machvon.contact_identity where id = $1', [identityId]))[0]?.version);
      await call('POST', `/contacts/${target}/identities/${identityId}/verify`, { member: SUPERVISOR, ifMatch: `"${version}"`, body: { method: 'ADMIN_DOCUMENT', document_ref: 'decision-18' } });
    }
    const survivorPhone = (await rows<{ id: string }>("select id from machvon.contact_identity where contact_id = $1 and channel = 'PHONE' and external_id_hash = (select external_id_hash from machvon.contact_identity where contact_id = $2 and channel = 'WHATSAPP')", [survivor, merged]))[0]?.id;
    expect((await call('POST', '/contacts/merges', { member: SUPERVISOR, body: { survivor_contact_id: survivor, merged_contact_id: merged, shared_verified_identity_id: survivorPhone, reason: 'The same person on two channels.' } })).status).toBe(200);
    const refused = await grant(merged, { channel: 'WHATSAPP' });
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe('CONTACT_STATE_INVALID');
    // The survivor shows the identities of the merged contact, so a consent on its WhatsApp is taken on the survivor.
    expect((await grant(survivor, { channel: 'WHATSAPP' })).status).toBe(201);
  });

  it('keeps the consents of a contact that was merged with it and finds them through the merge: the latest word about the channel and the purpose decides, and they are not added up', async () => {
    const survivor = await contact('A survivor');
    const merged = await contact('A merged');
    const number = phone();
    const identities: string[] = [];
    for (const [target, channel] of [[survivor, 'PHONE'], [merged, 'WHATSAPP']] as const) {
      const added = await call('POST', `/contacts/${target}/identities`, { body: { channel, external_id: number } });
      const identityId = added.json.resource_id as string;
      identities.push(identityId);
      const version = Number((await rows<{ version: string }>('select version::text as version from machvon.contact_identity where id = $1', [identityId]))[0]?.version);
      await call('POST', `/contacts/${target}/identities/${identityId}/verify`, { member: SUPERVISOR, ifMatch: `"${version}"`, body: { method: 'ADMIN_DOCUMENT', document_ref: 'decision-19' } });
    }
    const given = await grant(merged, { channel: 'WHATSAPP', purpose: 'REMINDER' });
    expect(given.status).toBe(201);
    expect(await latest(survivor, 'WHATSAPP', 'REMINDER')).toBeUndefined();
    await call('POST', '/contacts/merges', { member: SUPERVISOR, body: { survivor_contact_id: survivor, merged_contact_id: merged, shared_verified_identity_id: identities[0], reason: 'The same person on two channels.' } });
    // The consent stays with the contact that gave it, and the survivor finds it through the merge.
    expect((await rows<{ contact_id: string }>('select contact_id from machvon.contact_consent where id = $1', [given.json.resource_id]))[0]?.contact_id).toBe(merged);
    expect(await latest(survivor, 'WHATSAPP', 'REMINDER')).toEqual({ status: 'Granted' });
    // It is withdrawn where it is: the survivor has none of its own, and the word that counts is the withdrawal.
    expect((await withdraw(given.json.resource_id as string)).status).toBe(200);
    expect(await latest(survivor, 'WHATSAPP', 'REMINDER')).toEqual({ status: 'Withdrawn' });
    // The merged contact, chosen on its own, still shows the consents it gave and can withdraw them; the survivor shows them too.
    const ofMerged = (await call('GET', `/resources/contact_consent?contact_id=${merged}`, { member: READER })).json.items as Array<{ id: string }>;
    expect(ofMerged.map((item) => item.id)).toEqual([given.json.resource_id]);
    const ofSurvivor = (await call('GET', `/resources/contact_consent?contact_id=${survivor}`, { member: READER })).json.items as Array<{ id: string }>;
    expect(ofSurvivor.map((item) => item.id)).toEqual([given.json.resource_id]);
    // Nothing was added: the survivor has no consent of its own for a purpose the merged contact never gave.
    expect(await latest(survivor, 'WHATSAPP', 'ANNOUNCEMENT')).toBeUndefined();
    expect(await rows('select 1 from machvon.contact_consent where contact_id = $1', [survivor])).toHaveLength(0);
  });

  it('withdraws with a reason and the version read: a stale version is 409, an ended consent is 409 CONSENT_STATE_INVALID, a reason that is too short is 422, a consent of a member of the tenant is not found here', async () => {
    const owner = await contact();
    const granted = (await grant(owner)).json.resource_id as string;
    expect((await call('POST', `/contact-consents/${granted}/withdraw`, { body: { reason: REASON } })).status).toBe(428);
    const stale = await call('POST', `/contact-consents/${granted}/withdraw`, { ifMatch: '"9"', body: { reason: REASON } });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('VERSION_CONFLICT');
    expect((await withdraw(granted, AGENT, 'short')).json.code).toBe('VALIDATION_FAILED');
    expect((await withdraw(granted)).status).toBe(200);
    const twice = await call('POST', `/contact-consents/${granted}/withdraw`, { ifMatch: '"2"', body: { reason: REASON } });
    expect(twice.status).toBe(409);
    expect(twice.json.code).toBe('CONSENT_STATE_INVALID');
    expect((await call('POST', `/contact-consents/${randomUUID()}/withdraw`, { ifMatch: '"1"', body: { reason: REASON } })).status).toBe(404);
    // The consent of a member of the tenant is the member's to withdraw.
    const memberConsent = randomUUID();
    await rows(
      `insert into machvon.contact_consent (tenant_id, id, contact_id, membership_id, channel, purpose, status, evidence_reference, effective_at, legal_basis, consent_text_version, capture_method)
       values ($1, $2, null, $3, 'SMS', 'OPERATIONAL', 'Granted', 'test', now(), 'CONSENT', 'v1', 'IN_APP')`,
      [TENANT_A, memberConsent, memberId(READER)],
    );
    expect((await call('POST', `/contact-consents/${memberConsent}/withdraw`, { ifMatch: '"1"', body: { reason: REASON } })).status).toBe(404);
  });

  it('lists the consents of one contact, with the ones of the contacts merged into it, without the proof or the reason, and the list of the tenant without a filter', async () => {
    const owner = await contact('Listed');
    const one = await grant(owner, { purpose: 'OPERATIONAL', capture_method: 'PAPER_SCANNED', evidence_reference: 'secret-minutes-9' });
    await withdraw(one.json.resource_id as string);
    await grant(owner, { purpose: 'OPERATIONAL' });
    await grant(owner, { purpose: 'ANNOUNCEMENT' });
    const mine = await call('GET', `/resources/contact_consent?contact_id=${owner}&limit=50`, { member: READER });
    expect(mine.status).toBe(200);
    const items = mine.json.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3);
    expect(items.every((item) => item.subject_id === owner && item.subject_kind === 'CONTACT')).toBe(true);
    expect(items.map((item) => item.status).sort()).toEqual(['Granted', 'Granted', 'Withdrawn']);
    expect(JSON.stringify(mine.json)).not.toContain('secret-minutes-9');
    expect(JSON.stringify(mine.json)).not.toContain(REASON);
    expect(items[0]).toMatchObject({ capture_method: expect.any(String), consent_text_version: 'v3' });
    const all = await call('GET', '/resources/contact_consent?limit=200', { member: READER });
    expect((all.json.items as unknown[]).length).toBeGreaterThan(3);
    expect((await call('GET', '/resources/contact_consent?contact_id=not-an-id', { member: READER })).json.code).toBe('VALIDATION_FAILED');
    expect((await call('GET', `/resources/contact_consent?contact_id=${randomUUID()}`, { member: READER })).json.items).toEqual([]);
  });

  it('keeps the permissions apart: a reader takes and withdraws nothing, a grant on one unit alone reaches nothing, and tenants are apart', async () => {
    const owner = await contact();
    const granted = (await grant(owner)).json.resource_id as string;
    expect((await grant(owner, { purpose: 'REMINDER' }, READER)).status).toBe(403);
    expect((await grant(owner, { purpose: 'REMINDER' }, NOBODY)).status).toBe(403);
    expect((await grant(owner, { purpose: 'REMINDER' }, SCOPED_AGENT)).status).toBe(403);
    expect((await withdraw(granted, READER)).status).toBe(403);
    expect((await withdraw(granted, SCOPED_AGENT)).status).toBe(403);
    expect((await call('GET', `/resources/contact_consent?contact_id=${owner}`, { member: NOBODY })).status).toBe(403);
    expect((await call('GET', `/resources/contact_consent?contact_id=${owner}`, { member: SCOPED_AGENT })).json.items).toEqual([]);
    expect((await rows<{ status: string }>('select status from machvon.contact_consent where id = $1', [granted]))[0]?.status).toBe('Granted');
    // The tenant B agent finds neither the contact nor the consent.
    expect((await call('POST', `/contacts/${owner}/consents`, { member: OTHER_TENANT_AGENT, tenantId: TENANT_B, body: { channel: 'SMS', purpose: 'REMINDER', consent_text_version: 'v1', capture_method: 'IN_APP' } })).status).toBe(404);
    expect((await call('POST', `/contact-consents/${granted}/withdraw`, { member: OTHER_TENANT_AGENT, tenantId: TENANT_B, ifMatch: '"1"', body: { reason: REASON } })).status).toBe(404);
    expect((await call('GET', `/resources/contact_consent?contact_id=${owner}`, { member: OTHER_TENANT_AGENT, tenantId: TENANT_B })).json.items).toEqual([]);
  });
});
