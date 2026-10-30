import { AuthzHarness, TENANT_A, id, memberId } from './support/authz-fixtures';

const SEGMENT_HASH = 'c'.repeat(64);

describe('the guards of the contact tables (ST-OMNI-002, V1283, BR-OMNI-05)', () => {
  const harness = new AuthzHarness();
  let counter = 0;

  const owner = <T extends object>(text: string, params: unknown[] = []): Promise<T[]> => harness.owner<T>(TENANT_A, [[text, params]]);
  const refused = async (text: string, params: unknown[] = []): Promise<string> => {
    try {
      await owner(text, params);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error('it was allowed');
  };

  async function contact(status = 'Unverified', mergedInto: string | null = null): Promise<string> {
    const contactId = id(0xc2, (counter += 1));
    await owner(
      `insert into machvon.contact (tenant_id, id, display_name, verified_identities, classification, status, merged_into_id) values ($1, $2, 'Guarded', '[]'::jsonb, 'CITIZEN', $3, $4)`,
      [TENANT_A, contactId, status, mergedInto],
    );
    return contactId;
  }
  async function identity(contactId: string, status = 'Pending'): Promise<string> {
    const identityId = id(0xc3, (counter += 1));
    await owner(
      `insert into machvon.contact_identity (tenant_id, id, contact_id, channel, external_id_hash, external_id_masked, status, verification_method, verified_at, verified_by)
       values ($1, $2, $3, 'PHONE', $4, '+84*******01', $5, case when $5 = 'Verified' then 'ADMIN_DOCUMENT' end, case when $5 = 'Verified' then now() end, case when $5 = 'Verified' then $6::uuid end)`,
      [TENANT_A, identityId, contactId, `${String(counter).padStart(8, '0')}${SEGMENT_HASH}`.slice(0, 64), status, memberId(1)],
    );
    return identityId;
  }

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: 1, path: `/${id(0x10, 1)}/` }]);
    await harness.seedMembership(TENANT_A, 1, 1, { validFrom: '2026-01-01T00:00:00Z' });
  }, 180_000);

  afterAll(() => harness.stop(), 60_000);

  it('keeps a contact and an identity and never deletes them', async () => {
    const contactId = await contact();
    const identityId = await identity(contactId);
    expect(await refused('delete from machvon.contact_identity where id = $1', [identityId])).toMatch(/CONTACT_IMMUTABLE/);
    expect(await refused('delete from machvon.contact where id = $1', [contactId])).toMatch(/CONTACT_IMMUTABLE/);
  });

  it('writes who a contact is once: the name and the class do not change', async () => {
    const contactId = await contact();
    expect(await refused("update machvon.contact set display_name = 'Someone else' where id = $1", [contactId])).toMatch(/CONTACT_IMMUTABLE/);
    expect(await refused("update machvon.contact set classification = 'OTHER' where id = $1", [contactId])).toMatch(/CONTACT_IMMUTABLE/);
  });

  it('moves a contact only the ways the table allows: to Verified, to Merged, to Blocked and back, never out of Merged and never to a contact that was merged', async () => {
    const live = await contact('Verified');
    const blocked = await contact('Unverified');
    await owner("update machvon.contact set status = 'Blocked' where id = $1", [blocked]);
    await owner("update machvon.contact set status = 'Verified' where id = $1", [blocked]);
    expect(await refused("update machvon.contact set status = 'Unverified' where id = $1", [live])).toMatch(/CONTACT_STATE_INVALID/);
    const away = await contact('Verified');
    await owner("update machvon.contact set status = 'Merged', merged_into_id = $2 where id = $1", [away, live]);
    expect(await refused("update machvon.contact set status = 'Verified', merged_into_id = null where id = $1", [away])).toMatch(/CONTACT_IMMUTABLE/);
    // What pointed to it follows when that one is merged in its turn; nothing else about it changes.
    const next = await contact('Verified');
    await owner("update machvon.contact set status = 'Merged', merged_into_id = $2 where id = $1", [live, next]);
    await owner('update machvon.contact set merged_into_id = $2 where id = $1', [away, next]);
    expect(await refused("update machvon.contact set status = 'Verified', merged_into_id = null where id = $1", [away])).toMatch(/CONTACT_IMMUTABLE/);
    const another = await contact('Verified');
    expect(await refused("update machvon.contact set status = 'Merged', merged_into_id = $2 where id = $1", [another, away])).toMatch(/CONTACT_STATE_INVALID/);
  });

  it('writes what an identity is once: its contact, channel, hash and masked copy do not change', async () => {
    const contactId = await contact();
    const other = await contact();
    const identityId = await identity(contactId);
    for (const change of [`contact_id = '${other}'`, "channel = 'EMAIL'", `external_id_hash = repeat('d', 64)`, "external_id_masked = '+84*******02'"]) {
      expect(await refused(`update machvon.contact_identity set ${change} where id = $1`, [identityId])).toMatch(/CONTACT_IMMUTABLE/);
    }
  });

  it('moves an identity forward only, keeps what verified it, and wants a method with the moment', async () => {
    const contactId = await contact();
    const identityId = await identity(contactId);
    expect(await refused("update machvon.contact_identity set status = 'Verified' where id = $1", [identityId])).toMatch(/violates check constraint/);
    await owner("update machvon.contact_identity set status = 'Verified', verification_method = 'OTP', verified_at = now(), verified_by = $2 where id = $1", [identityId, memberId(1)]);
    expect(await refused("update machvon.contact_identity set status = 'Pending', verification_method = null, verified_at = null where id = $1", [identityId])).toMatch(/CONTACT_STATE_INVALID/);
    expect(await refused("update machvon.contact_identity set verification_method = 'ADMIN_DOCUMENT' where id = $1", [identityId])).toMatch(/CONTACT_IMMUTABLE/);
    expect(await refused("update machvon.contact_identity set status = 'Revoked' where id = $1", [identityId])).toMatch(/CONTACT_STATE_INVALID/);
    await owner("update machvon.contact_identity set status = 'Revoked' where id = $1", [await identity(contactId)]);
  });

  it('keeps the code with its expiry or neither, and the count of the wrong codes from going below zero', async () => {
    const identityId = await identity(await contact());
    expect(await refused("update machvon.contact_identity set otp_hash = repeat('e', 64) where id = $1", [identityId])).toMatch(/contact_identity_otp_ck/);
    expect(await refused('update machvon.contact_identity set otp_failed_count = -1 where id = $1', [identityId])).toMatch(/violates check constraint/);
    await owner("update machvon.contact_identity set otp_hash = repeat('e', 64), otp_expires_at = now() + interval '10 minutes' where id = $1", [identityId]);
  });

  it('keeps the same identity of a channel to one contact in the tenant', async () => {
    const first = await contact();
    const second = await contact();
    const taken = `${'f'.repeat(63)}1`;
    await owner(`insert into machvon.contact_identity (tenant_id, id, contact_id, channel, external_id_hash, external_id_masked, status) values ($1, $2, $3, 'PHONE', $4, '+84*******03', 'Pending')`, [TENANT_A, id(0xc4, 1), first, taken]);
    expect(
      await refused(`insert into machvon.contact_identity (tenant_id, id, contact_id, channel, external_id_hash, external_id_masked, status) values ($1, $2, $3, 'PHONE', $4, '+84*******03', 'Pending')`, [TENANT_A, id(0xc4, 2), second, taken]),
    ).toMatch(/duplicate key/);
    // The same hash on another channel is another identity: that is how one person is recognised across the phone and WhatsApp.
    await owner(`insert into machvon.contact_identity (tenant_id, id, contact_id, channel, external_id_hash, external_id_masked, status) values ($1, $2, $3, 'WHATSAPP', $4, '+84*******03', 'Pending')`, [TENANT_A, id(0xc4, 3), second, taken]);
  });
});
