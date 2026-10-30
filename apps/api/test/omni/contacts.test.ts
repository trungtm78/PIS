import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, otpHashOf, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { ContactsController } from '../../src/omni/contacts/contacts.controller';
import { IDENTITY_OTP_SENDER, MockOtpSender } from '../../src/omni/contacts/identity-otp';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const AGENT = 1; // keeps the directory and reads it
const SUPERVISOR = 2; // the same, and merges
const READER = 3; // reads only
const NOBODY = 4;
const SCOPED_AGENT = 5; // holds the permissions of an agent on one unit only
const OTHER_TENANT_AGENT = 1; // of tenant B
const REASON = 'The same person wrote on the phone and on WhatsApp.';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the contact directory, verified identities and the safe merge (ST-OMNI-002, OMNI-03, BR-OMNI-05)', () => {
  const harness = new AuthzHarness();
  const sender = new MockOtpSender();
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

  const contact = async (name = 'Nguyễn Văn A', member = AGENT): Promise<string> => {
    const made = await call('POST', '/contacts', { member, body: { display_name: name, classification: 'CITIZEN' } });
    expect(made.status).toBe(201);
    return made.json.resource_id as string;
  };
  const phone = (): string => `09${String(10_000_000 + (phones += 1))}`;
  const addIdentity = (contactId: string, channel: string, externalId: string, member = AGENT) => call('POST', `/contacts/${contactId}/identities`, { member, body: { channel, external_id: externalId } });
  const identityVersion = async (identityId: string): Promise<number> => Number((await rows<{ version: string }>('select version::text as version from machvon.contact_identity where id = $1', [identityId]))[0]?.version);
  const verify = async (contactId: string, identityId: string, body: Record<string, unknown>, member = AGENT) =>
    call('POST', `/contacts/${contactId}/identities/${identityId}/verify`, { member, ifMatch: `"${await identityVersion(identityId)}"`, body });
  const merge = (survivor: string, merged: string, identityId: string, member = SUPERVISOR) =>
    call('POST', '/contacts/merges', { member, body: { survivor_contact_id: survivor, merged_contact_id: merged, shared_verified_identity_id: identityId, reason: REASON } });
  /** An identity added and verified by a document of a supervisor, for the tests that need a verified one. */
  async function verified(contactId: string, channel: 'WHATSAPP' | 'ZALO' | 'PHONE', externalId: string): Promise<string> {
    const added = await addIdentity(contactId, channel, externalId);
    expect(added.status).toBe(201);
    const identityId = added.json.resource_id as string;
    const done = await verify(contactId, identityId, { method: 'ADMIN_DOCUMENT', document_ref: 'decision-17' }, SUPERVISOR);
    expect(done.status).toBe(200);
    return identityId;
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
    for (const member of [AGENT, SUPERVISOR, READER, NOBODY, SCOPED_AGENT]) await harness.seedMembership(TENANT_A, member, 1, { validFrom: '2026-01-01T00:00:00Z' });
    await harness.seedMembership(TENANT_B, OTHER_TENANT_AGENT, 1, { validFrom: '2026-01-01T00:00:00Z' });
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedRole(tenant, 1, 'OMNI_AGENT_TEST', ['omni.contact.manage', 'contact.read'], 35);
      await harness.seedRole(tenant, 2, 'OMNI_SUPERVISOR_TEST', ['omni.contact.manage', 'omni.contact.merge', 'contact.read'], 50);
      await harness.seedRole(tenant, 3, 'CONTACT_READER', ['contact.read'], 10);
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
      controllers: [ContactsController],
      providers: [{ provide: TenantDatabase, useValue: tenants }, { provide: IDENTITY_OTP_SENDER, useValue: sender }, { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }],
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await harness.stop();
  }, 60_000);

  it('makes a contact that is Unverified, keeps its class, refuses a name that is empty or a class that does not exist, and keeps the name out of the trail', async () => {
    const made = await call('POST', '/contacts', { body: { display_name: ' Trần Thị B ', classification: 'CONTRACTOR_STAFF', preferred_channel: 'ZALO' } });
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ status: 'UNVERIFIED', resource_version: 1 });
    const view = await call('GET', `/resources/contact/${made.json.resource_id as string}`);
    expect(view.json).toMatchObject({ display_name: 'Trần Thị B', classification: 'CONTRACTOR_STAFF', status: 'Unverified', preferred_channel: 'ZALO', identities: [], merged_into_id: null });
    expect((await call('POST', '/contacts', { body: { display_name: '', classification: 'CITIZEN' } })).json.code).toBe('VALIDATION_FAILED');
    expect((await call('POST', '/contacts', { body: { display_name: 'X', classification: 'VIP' } })).json.code).toBe('VALIDATION_FAILED');
    const audit = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where action = 'contact.created' and resource_id = $1", [made.json.resource_id]);
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain('Trần');
  });

  it('adds an identity as Pending, keeps its hash and a masked copy, sends a code once the transaction is committed, and refuses a number another contact holds (409 IDENTITY_TAKEN)', async () => {
    const first = await contact();
    const number = phone();
    const added = await addIdentity(first, 'PHONE', number);
    expect(added.status).toBe(201);
    expect(added.json).toMatchObject({ status: 'PENDING', resource_version: expect.any(Number) });
    const destination = `+84${number.slice(1)}`;
    expect(sender.lastCodeFor(destination)).toMatch(/^[0-9]{6}$/);
    const [stored] = await rows<{ external_id_hash: string; external_id_masked: string; status: string; otp_hash: string | null; otp_expires_at: Date | null }>(
      'select external_id_hash, external_id_masked, status, otp_hash, otp_expires_at from machvon.contact_identity where id = $1',
      [added.json.resource_id],
    );
    expect(stored).toMatchObject({ status: 'Pending', external_id_masked: expect.stringContaining('*') });
    expect(stored?.external_id_hash).toMatch(/^[0-9a-f]{64}$/);
    // The code is kept as a hash bound to the identity and it runs out in ten minutes; the value of the number is not kept.
    expect(stored?.otp_hash).toBe(otpHashOf(added.json.resource_id as string, sender.lastCodeFor(destination) as string));
    expect((stored?.otp_expires_at?.getTime() ?? 0) - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(JSON.stringify(await rows('select * from machvon.contact_identity where id = $1', [added.json.resource_id]))).not.toContain(number);
    // The same number, written another way, is taken by another contact; on the same contact it is asked for a new code.
    const other = await contact('Other');
    const taken = await addIdentity(other, 'PHONE', `+84 ${number.slice(1)}`);
    expect(taken.status).toBe(409);
    expect(taken.json.code).toBe('IDENTITY_TAKEN');
    const before = sender.sent.length;
    const again = await addIdentity(first, 'PHONE', `+84${number.slice(1)}`);
    expect(again.status).toBe(201);
    expect(again.json.resource_id).toBe(added.json.resource_id);
    expect(sender.sent.length).toBe(before + 1);
    // The same number on WhatsApp is another channel: the other contact may hold it.
    expect((await addIdentity(other, 'WHATSAPP', number)).status).toBe(201);
    // An address at the longest the field takes, with a short local part, is masked into more characters than it has and is still taken.
    const longest = `ab@${'d'.repeat(63)}.${'e'.repeat(63)}.${'f'.repeat(65)}.com`;
    expect(longest.length).toBe(200);
    expect((await addIdentity(first, 'EMAIL', longest)).status).toBe(201);
    // What is not an identity.
    expect((await addIdentity(first, 'PHONE', '123')).json.code).toBe('VALIDATION_FAILED');
    expect((await addIdentity(first, 'FAX', '123')).json.code).toBe('VALIDATION_FAILED');
  });

  it('sends no code for an identity that is not on a phone or an address, and not for one that is verified', async () => {
    const owner = await contact();
    const before = sender.sent.length;
    const zalo = await addIdentity(owner, 'ZALO', `uid_${randomUUID().slice(0, 8)}`);
    expect(zalo.status).toBe(201);
    expect(sender.sent.length).toBe(before);
    const number = phone();
    const added = await addIdentity(owner, 'PHONE', number);
    const done = await verify(owner, added.json.resource_id as string, { method: 'OTP', otp: sender.lastCodeFor(`+84${number.slice(1)}`) as string });
    expect(done.status).toBe(200);
    const sentBefore = sender.sent.length;
    const unchanged = await addIdentity(owner, 'PHONE', number);
    expect(unchanged.status).toBe(201);
    expect(sender.sent.length).toBe(sentBefore);
    expect(unchanged.json.status).toBe('VERIFIED');
  });

  it('verifies by the code: the right code makes the identity and the contact Verified and spends the code; the version is asked for', async () => {
    const owner = await contact();
    const number = phone();
    const added = await addIdentity(owner, 'PHONE', number);
    const identityId = added.json.resource_id as string;
    expect((await call('POST', `/contacts/${owner}/identities/${identityId}/verify`, { body: { method: 'OTP', otp: '123456' } })).status).toBe(428);
    const stale = await call('POST', `/contacts/${owner}/identities/${identityId}/verify`, { ifMatch: '"99"', body: { method: 'OTP', otp: '123456' } });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('VERSION_CONFLICT');
    const code = sender.lastCodeFor(`+84${number.slice(1)}`) as string;
    const done = await verify(owner, identityId, { method: 'OTP', otp: code });
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ status: 'VERIFIED' });
    const [row] = await rows<{ status: string; verification_method: string; verified_by: string; otp_hash: string | null }>('select status, verification_method, verified_by, otp_hash from machvon.contact_identity where id = $1', [identityId]);
    expect(row).toMatchObject({ status: 'Verified', verification_method: 'OTP', verified_by: memberId(AGENT), otp_hash: null });
    const view = await call('GET', `/resources/contact/${owner}`);
    expect(view.json).toMatchObject({ status: 'Verified' });
    expect((view.json.identities as Array<Record<string, unknown>>)[0]).toMatchObject({ status: 'Verified', verification_method: 'OTP', channel: 'PHONE' });
    // A summary of the verified identities is kept on the contact row, masked.
    const [summary] = await rows<{ verified_identities: Array<{ masked: string }> }>('select verified_identities from machvon.contact where id = $1', [owner]);
    expect(summary?.verified_identities).toHaveLength(1);
    // It is not verified twice.
    const twice = await verify(owner, identityId, { method: 'OTP', otp: code });
    expect(twice.status).toBe(409);
    expect(twice.json.code).toBe('CONTACT_STATE_INVALID');
  });

  it('counts the wrong codes in the open, locks the identity for 30 minutes at the fifth, answers locked to the right code during the lock, and lets the right code in once the lock has run out', async () => {
    const owner = await contact();
    const number = phone();
    const identityId = (await addIdentity(owner, 'PHONE', number)).json.resource_id as string;
    const code = sender.lastCodeFor(`+84${number.slice(1)}`) as string;
    const wrong = code === '000000' ? '111111' : '000000';
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const reply = await verify(owner, identityId, { method: 'OTP', otp: wrong });
      expect(reply.status).toBe(422);
      expect(reply.json.code).toBe('OTP_INVALID');
      expect(reply.json.locked_until).toBeUndefined();
    }
    // The failures are committed with the refusal.
    expect((await rows<{ otp_failed_count: number }>('select otp_failed_count from machvon.contact_identity where id = $1', [identityId]))[0]?.otp_failed_count).toBe(4);
    const fifth = await verify(owner, identityId, { method: 'OTP', otp: wrong });
    expect(fifth.json.code).toBe('OTP_INVALID');
    expect(typeof fifth.json.locked_until).toBe('string');
    const lock = Date.parse(fifth.json.locked_until as string) - Date.now();
    expect(lock).toBeGreaterThan(29 * 60_000);
    expect(lock).toBeLessThanOrEqual(30 * 60_000);
    const during = await verify(owner, identityId, { method: 'OTP', otp: code });
    expect(during.status).toBe(422);
    expect(during.json.code).toBe('OTP_INVALID');
    expect(typeof during.json.locked_until).toBe('string');
    expect((await rows<{ status: string }>('select status from machvon.contact_identity where id = $1', [identityId]))[0]?.status).toBe('Pending');
    // Every refusal is on the trail, without the code.
    const trail = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where action = 'contact.identity_verification_failed' and resource_id = $1", [owner]);
    expect(trail.length).toBeGreaterThanOrEqual(6);
    expect(JSON.stringify(trail)).not.toContain(code);
    // The lock runs out: a wrong code is the first of a new count, and the right one passes.
    await rows("update machvon.contact_identity set otp_locked_until = now() - interval '1 minute' where id = $1", [identityId]);
    expect((await verify(owner, identityId, { method: 'OTP', otp: wrong })).json.code).toBe('OTP_INVALID');
    expect((await rows<{ otp_failed_count: number }>('select otp_failed_count from machvon.contact_identity where id = $1', [identityId]))[0]?.otp_failed_count).toBe(1);
    expect((await verify(owner, identityId, { method: 'OTP', otp: code })).status).toBe(200);
  }, 120_000);

  it('locks the identity again after a lock has run out: the wrong codes that follow are counted from one, five of them lock it, and the expired lock does not stay on the row', async () => {
    const owner = await contact();
    const number = phone();
    const identityId = (await addIdentity(owner, 'PHONE', number)).json.resource_id as string;
    const code = sender.lastCodeFor(`+84${number.slice(1)}`) as string;
    const wrong = code === '000000' ? '111111' : '000000';
    for (let attempt = 1; attempt <= 5; attempt += 1) await verify(owner, identityId, { method: 'OTP', otp: wrong });
    await rows("update machvon.contact_identity set otp_locked_until = now() - interval '1 minute' where id = $1", [identityId]);
    for (let attempt = 1; attempt <= 4; attempt += 1) expect((await verify(owner, identityId, { method: 'OTP', otp: wrong })).json.locked_until).toBeUndefined();
    const [open] = await rows<{ otp_failed_count: number; otp_locked_until: Date | null }>('select otp_failed_count, otp_locked_until from machvon.contact_identity where id = $1', [identityId]);
    expect(open).toEqual({ otp_failed_count: 4, otp_locked_until: null });
    const again = await verify(owner, identityId, { method: 'OTP', otp: wrong });
    expect(typeof again.json.locked_until).toBe('string');
    expect((await verify(owner, identityId, { method: 'OTP', otp: code })).json.code).toBe('OTP_INVALID');
  }, 120_000);

  it('does not take a code that has run out (10 minutes) or that was never sent', async () => {
    const owner = await contact();
    const number = phone();
    const identityId = (await addIdentity(owner, 'PHONE', number)).json.resource_id as string;
    const code = sender.lastCodeFor(`+84${number.slice(1)}`) as string;
    await rows("update machvon.contact_identity set otp_expires_at = now() - interval '1 second' where id = $1", [identityId]);
    expect((await verify(owner, identityId, { method: 'OTP', otp: code })).json.code).toBe('OTP_INVALID');
    // Asking again sends a new code, and that one is good.
    await addIdentity(owner, 'PHONE', number);
    expect((await verify(owner, identityId, { method: 'OTP', otp: sender.lastCodeFor(`+84${number.slice(1)}`) as string })).status).toBe(200);
  });

  it('does not verify by the word of a person that the provider vouches for the identity, and verifies by a document only for a supervisor, with the reference on the identity and on the trail', async () => {
    const owner = await contact();
    const phoneId = (await addIdentity(owner, 'PHONE', phone())).json.resource_id as string;
    // The provider's word is written by the processing of the inbound messages, so a person cannot give it, an agent or a supervisor, on the phone or on Zalo.
    for (const member of [AGENT, SUPERVISOR]) {
      const providerOnPhone = await verify(owner, phoneId, { method: 'PROVIDER_VERIFIED' }, member);
      expect(providerOnPhone.status).toBe(422);
      expect(providerOnPhone.json.code).toBe('VALIDATION_FAILED');
    }
    const zaloId = (await addIdentity(owner, 'ZALO', `uid_${randomUUID().slice(0, 8)}`)).json.resource_id as string;
    expect((await verify(owner, zaloId, { method: 'OTP', otp: '123456' })).json.code).toBe('VALIDATION_FAILED');
    expect((await verify(owner, zaloId, { method: 'PROVIDER_VERIFIED' }, SUPERVISOR)).json.code).toBe('VALIDATION_FAILED');
    expect((await rows<{ status: string }>('select status from machvon.contact_identity where id = $1', [zaloId]))[0]?.status).toBe('Pending');
    // A document: an agent is 403, the supervisor passes.
    const denied = await verify(owner, phoneId, { method: 'ADMIN_DOCUMENT', document_ref: 'decision-17' }, AGENT);
    expect(denied.status).toBe(403);
    expect((await verify(owner, phoneId, { method: 'ADMIN_DOCUMENT' }, SUPERVISOR)).json.code).toBe('VALIDATION_FAILED');
    expect((await verify(owner, phoneId, { method: 'ADMIN_DOCUMENT', document_ref: 'decision-17' }, SUPERVISOR)).status).toBe(200);
    expect((await rows<{ verification_ref: string }>('select verification_ref from machvon.contact_identity where id = $1', [phoneId]))[0]?.verification_ref).toBe('decision-17');
    const trail = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where action = 'contact.identity_verified' and resource_id = $1 order by occurred_at", [owner]);
    expect(trail.map((entry) => entry.safe_diff.method)).toEqual(['ADMIN_DOCUMENT']);
  });

  it('AC-ST-OMNI-002-1 UAT-AC197: two contacts with the same name are not merged without a verified identity they share (422 RECIPIENT_AMBIGUOUS), and are merged with one, with the audit trail, the event and the conversations moved', async () => {
    const survivor = await contact('Lê Văn C');
    const merged = await contact('Lê Văn C');
    const number = phone();
    const survivorPhone = await verified(survivor, 'PHONE', number);
    // Nothing is shared yet: the second has no identity at all, then one that is not the same.
    const none = await merge(survivor, merged, survivorPhone);
    expect(none.status).toBe(422);
    expect(none.json.code).toBe('RECIPIENT_AMBIGUOUS');
    await verified(merged, 'WHATSAPP', phone());
    expect((await merge(survivor, merged, survivorPhone)).json.code).toBe('RECIPIENT_AMBIGUOUS');
    // The second contact holds the same number on WhatsApp, not yet verified: still not shared.
    const mergedWhatsapp = (await addIdentity(merged, 'WHATSAPP', number)).json.resource_id as string;
    expect((await merge(survivor, merged, survivorPhone)).json.code).toBe('RECIPIENT_AMBIGUOUS');
    expect((await merge(survivor, merged, mergedWhatsapp)).json.code).toBe('IDENTITY_UNVERIFIED');
    expect(await rows("select 1 from machvon.contact where id = $1 and status = 'Merged'", [merged])).toHaveLength(0);
    // A conversation of the contact that will be merged.
    await rows(
      `insert into machvon.channel_account (tenant_id, id, channel, external_account_id, credential_secret_ref, capability_version, status, verified_at, webhook_secret_ref, display_name)
       values ($1, $2, 'ZALO_OA', 'zalo-1', 'secret://t/x', 'v1', 'Active', now(), 'secret://t/y', 'Zalo') on conflict do nothing`,
      [TENANT_A, id(0xd0, 1)],
    );
    await rows(
      `insert into machvon.conversation (tenant_id, id, channel_account_id, external_thread_id, resource_links, status, contact_id, verified_contact_id) values ($1, $2, $3, $4, '[]'::jsonb, 'New', $5, $5)`,
      [TENANT_A, id(0xc1, 1), id(0xd0, 1), `thread-${randomUUID()}`, merged],
    );
    // Until the second contact's number is verified the screen has nothing to offer: no contact is a candidate for the merge.
    expect(((await call('GET', `/resources/contact/${survivor}`)).json.merge_candidates as unknown[])).toEqual([]);
    expect((await verify(merged, mergedWhatsapp, { method: 'ADMIN_DOCUMENT', document_ref: 'decision-18' }, SUPERVISOR)).status).toBe(200);
    // Now each is a candidate for the other, with the identity that names the share; two contacts with the same name and nothing shared are not.
    expect((await call('GET', `/resources/contact/${survivor}`)).json.merge_candidates).toEqual([{ contact_id: merged, display_name: 'Lê Văn C', identity_id: survivorPhone }]);
    expect((await call('GET', `/resources/contact/${merged}`)).json.merge_candidates).toEqual([{ contact_id: survivor, display_name: 'Lê Văn C', identity_id: mergedWhatsapp }]);
    // Agents do not merge; a supervisor does, on the identity of either contact.
    expect((await merge(survivor, merged, survivorPhone, AGENT)).status).toBe(403);
    const done = await merge(survivor, merged, survivorPhone);
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ status: 'MERGED', resource_id: survivor });
    const [mergedRow] = await rows<{ status: string; merged_into_id: string }>('select status, merged_into_id from machvon.contact where id = $1', [merged]);
    expect(mergedRow).toEqual({ status: 'Merged', merged_into_id: survivor });
    const [conversation] = await rows<{ contact_id: string; verified_contact_id: string }>('select contact_id, verified_contact_id from machvon.conversation where id = $1', [id(0xc1, 1)]);
    expect(conversation).toEqual({ contact_id: survivor, verified_contact_id: survivor });
    // The survivor shows the identities of both; the contact merged keeps its own.
    const view = await call('GET', `/resources/contact/${survivor}`);
    expect((view.json.identities as Array<{ contact_id: string }>).map((identity) => identity.contact_id).sort()).toEqual([survivor, merged, merged].sort());
    expect(view.json).toMatchObject({ status: 'Verified', merged_into_id: null });
    expect((await call('GET', `/resources/contact/${merged}`)).json).toMatchObject({ status: 'Merged', merged_into_id: survivor, merge_candidates: [] });
    expect((view.json as { merge_candidates: unknown[] }).merge_candidates).toEqual([]);
    // The full trail: both ids, the identity that joins them (masked), the reason and what moved; and the event.
    const trail = await rows<{ safe_diff: Record<string, unknown>; reason: string }>("select safe_diff, reason from machvon.audit_event where action = 'contact.merged' and resource_id = $1", [survivor]);
    expect(trail).toHaveLength(1);
    expect(trail[0]?.reason).toBe(REASON);
    expect(trail[0]?.safe_diff).toMatchObject({ survivor_contact_id: survivor, merged_contact_id: merged, shared_identity_id: survivorPhone, moved_conversations: 1 });
    expect(JSON.stringify(trail)).not.toContain(number);
    expect(await rows("select 1 from machvon.outbox_event where type = 'omni.contact.merged.v1' and aggregate_id = $1", [survivor])).toHaveLength(1);
    // A contact that was merged is not merged again, nor takes an identity.
    expect((await merge(survivor, merged, survivorPhone)).json.code).toBe('CONTACT_STATE_INVALID');
    expect((await addIdentity(merged, 'EMAIL', 'late@example.com')).json.code).toBe('CONTACT_STATE_INVALID');
    expect((await merge(survivor, survivor, survivorPhone)).json.code).toBe('VALIDATION_FAILED');
  }, 120_000);

  it('keeps the chain of merges one step long: a contact merged into one that is merged in its turn belongs to the last survivor, with its identities, and its numbers are the survivor\'s', async () => {
    const first = await contact('First');
    const second = await contact('Second');
    const third = await contact('Third');
    const numberA = phone();
    const numberB = phone();
    // first and second share numberA; second and third share numberB.
    const firstPhone = await verified(first, 'PHONE', numberA);
    await verified(second, 'WHATSAPP', numberA);
    const secondPhone = await verified(second, 'PHONE', numberB);
    await verified(third, 'WHATSAPP', numberB);
    expect((await merge(second, first, firstPhone)).status).toBe(200);
    expect((await merge(third, second, secondPhone)).status).toBe(200);
    const [pointing] = await rows<{ merged_into_id: string }>('select merged_into_id from machvon.contact where id = $1', [first]);
    expect(pointing?.merged_into_id).toBe(third);
    const view = await call('GET', `/resources/contact/${third}`);
    expect((view.json.identities as Array<{ contact_id: string }>).map((identity) => identity.contact_id).sort()).toEqual([first, second, second, third].sort());
    const [summary] = await rows<{ verified_identities: unknown[] }>('select verified_identities from machvon.contact where id = $1', [third]);
    expect(summary?.verified_identities).toHaveLength(4);
    // The number of the first contact is, through the chain, the survivor's: adding it to the survivor is its own, adding it elsewhere is taken.
    expect((await addIdentity(third, 'PHONE', numberA)).status).toBe(201);
    expect((await addIdentity(await contact('Stranger'), 'PHONE', numberA)).json.code).toBe('IDENTITY_TAKEN');
  }, 120_000);

  it('counts the identities of a contact that was merged as the survivor\'s in the next merge and offers it as a candidate, and verifies a pending one of it through the survivor', async () => {
    const a = await contact('A');
    const b = await contact('B');
    const c = await contact('C');
    const shared = phone();
    const other = phone();
    const aShared = await verified(a, 'PHONE', shared);
    await verified(b, 'WHATSAPP', shared);
    const aOther = await verified(a, 'PHONE', other);
    await verified(c, 'WHATSAPP', other);
    // A pending identity of A, with a code sent.
    const pendingNumber = phone();
    const pending = (await addIdentity(a, 'PHONE', pendingNumber)).json.resource_id as string;
    // Before the first merge B shares nothing with C.
    expect((await call('GET', `/resources/contact/${b}`)).json.merge_candidates).toEqual([{ contact_id: a, display_name: 'A', identity_id: expect.any(String) }]);
    expect((await merge(b, a, aShared)).status).toBe(200);
    // A is merged into B: the number A shared with C is B's now, so C is a candidate for B and B may be merged with C on it.
    const candidates = (await call('GET', `/resources/contact/${b}`)).json.merge_candidates as Array<{ contact_id: string; identity_id: string }>;
    expect(candidates).toEqual([expect.objectContaining({ contact_id: c, identity_id: aOther })]);
    // The identity A had not yet verified is verified through B, who is alive: the code is asked for again and used there.
    const before = sender.sent.length;
    expect((await addIdentity(b, 'PHONE', pendingNumber)).status).toBe(201);
    expect(sender.sent.length).toBe(before + 1);
    const done = await verify(b, pending, { method: 'OTP', otp: sender.lastCodeFor(`+84${pendingNumber.slice(1)}`) as string });
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ status: 'VERIFIED' });
    expect((await merge(b, c, aOther)).status).toBe(200);
    expect(await rows("select 1 from machvon.contact where id in ($1, $2) and status = 'Merged' and merged_into_id = $3", [a, c, b])).toHaveLength(2);
  }, 120_000);

  it('takes the number of a contact that was merged as the number of the contact it was merged into', async () => {
    const survivor = await contact('Survivor');
    const merged = await contact('Merged away');
    const number = phone();
    const survivorId = await verified(survivor, 'PHONE', number);
    await verified(merged, 'WHATSAPP', number);
    expect((await merge(survivor, merged, survivorId)).status).toBe(200);
    // The WhatsApp number now belongs to the survivor's chain: adding it to the survivor is its own, adding it elsewhere is taken.
    const stranger = await contact('Stranger');
    expect((await addIdentity(stranger, 'WHATSAPP', number)).json.code).toBe('IDENTITY_TAKEN');
    expect((await addIdentity(survivor, 'WHATSAPP', number)).status).toBe(201);
  });

  it('lists the contacts newest first, a page at a time, with the identities masked and nothing that could be used: no value, no hash, no code', async () => {
    const all = await call('GET', '/resources/contact?limit=200', { member: READER });
    expect(all.status).toBe(200);
    const items = all.json.items as Array<{ created_at: string; identities: Array<Record<string, unknown>> }>;
    expect(items.length).toBeGreaterThan(5);
    const stamps = items.map((item) => item.created_at);
    expect([...stamps].sort().reverse()).toEqual(stamps);
    const text = JSON.stringify(all.json);
    expect(text).not.toMatch(/otp|hash|external_id\b/);
    expect(text).not.toMatch(/\+84[0-9]{9}/);
    const first = await call('GET', '/resources/contact?limit=2', { member: READER });
    expect((first.json.items as unknown[]).length).toBe(2);
    expect(first.json.next_cursor).toEqual(expect.any(String));
    const second = await call('GET', `/resources/contact?limit=2&cursor=${encodeURIComponent(first.json.next_cursor as string)}`, { member: READER });
    expect((second.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual((items as unknown as Array<{ id: string }>).slice(2, 4).map((item) => item.id));
    expect((await call('GET', `/resources/contact/${randomUUID()}`, { member: READER })).status).toBe(404);
  });

  it('keeps the permissions apart: a reader reads and changes nothing, an agent does not merge, and nobody without the permission does anything', async () => {
    const owner = await contact();
    expect((await call('POST', '/contacts', { member: READER, body: { display_name: 'X', classification: 'OTHER' } })).status).toBe(403);
    expect((await addIdentity(owner, 'EMAIL', 'reader@example.com', READER)).status).toBe(403);
    expect((await call('GET', '/resources/contact', { member: NOBODY })).status).toBe(403);
    expect((await call('POST', '/contacts', { member: NOBODY, body: { display_name: 'X', classification: 'OTHER' } })).status).toBe(403);
    expect((await call('POST', '/contacts/merges', { member: AGENT, body: { survivor_contact_id: owner, merged_contact_id: owner, shared_verified_identity_id: owner, reason: REASON } })).status).toBe(403);
  });

  it('is the tenant\'s directory, not a unit\'s: a grant on one unit alone reads and changes nothing in it', async () => {
    const owner = await contact();
    const identityId = (await addIdentity(owner, 'PHONE', phone())).json.resource_id as string;
    expect((await call('GET', '/resources/contact', { member: SCOPED_AGENT })).status).toBe(403);
    expect((await call('GET', `/resources/contact/${owner}`, { member: SCOPED_AGENT })).status).toBe(403);
    expect((await call('POST', '/contacts', { member: SCOPED_AGENT, body: { display_name: 'X', classification: 'OTHER' } })).status).toBe(403);
    expect((await addIdentity(owner, 'EMAIL', 'scoped@example.com', SCOPED_AGENT)).status).toBe(403);
    expect((await verify(owner, identityId, { method: 'ADMIN_DOCUMENT', document_ref: 'decision-17' }, SCOPED_AGENT)).status).toBe(403);
    expect((await merge(owner, owner, identityId, SCOPED_AGENT)).status).toBe(403);
    expect((await rows<{ status: string }>('select status from machvon.contact_identity where id = $1', [identityId]))[0]?.status).toBe('Pending');
  });

  it('moves the version of the survivor with every merge, also when it was Verified already, and the event carries that version', async () => {
    const survivor = await contact('Survivor');
    const merged = await contact('Merged away');
    const number = phone();
    const survivorPhone = await verified(survivor, 'PHONE', number);
    await verified(merged, 'WHATSAPP', number);
    const before = Number((await rows<{ version: string }>('select version::text as version from machvon.contact where id = $1', [survivor]))[0]?.version);
    const done = await merge(survivor, merged, survivorPhone);
    expect(done.status).toBe(200);
    // The survivor was Verified already, and what it shows changed: its version moved all the same.
    expect(done.json.resource_version as number).toBeGreaterThan(before);
    const events = await rows<{ aggregate_version: string }>("select aggregate_version::text from machvon.outbox_event where type = 'omni.contact.merged.v1' and aggregate_id = $1", [survivor]);
    expect(events.map((event) => Number(event.aggregate_version))).toEqual([done.json.resource_version]);
  });

  it('keeps tenants apart: a contact of another tenant is not found, and an identity of another tenant is not taken', async () => {
    const owner = await contact('Tenant A');
    const number = phone();
    await addIdentity(owner, 'PHONE', number);
    const other = await call('POST', '/contacts', { member: OTHER_TENANT_AGENT, tenantId: TENANT_B, body: { display_name: 'Tenant B', classification: 'CITIZEN' } });
    expect(other.status).toBe(201);
    // The same number in another tenant is another contact's: the directories are apart.
    expect((await call('POST', `/contacts/${other.json.resource_id as string}/identities`, { member: OTHER_TENANT_AGENT, tenantId: TENANT_B, body: { channel: 'PHONE', external_id: number } })).status).toBe(201);
    expect((await call('GET', `/resources/contact/${owner}`, { member: OTHER_TENANT_AGENT, tenantId: TENANT_B })).status).toBe(404);
    expect((await call('POST', `/contacts/${owner}/identities`, { member: OTHER_TENANT_AGENT, tenantId: TENANT_B, body: { channel: 'EMAIL', external_id: 'a@example.com' } })).status).toBe(404);
  });
});
