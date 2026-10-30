import { randomUUID } from 'node:crypto';
import { IamSelfStore } from '../src/iam-self-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const self = new IamSelfStore();
const ME = 1;
const OTHER = 2;
const OTHER_TENANT_MEMBER = 3;

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = ME, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; extensions?: unknown }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: unknown };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

async function session(member: number, options: { revoked?: boolean; device?: string | null } = {}): Promise<string> {
  const id = randomUUID();
  await owner(
    `insert into machvon.user_session (tenant_id, id, user_account_id, membership_id, idp_session_id, assurance_level, ip_hash, user_agent_summary, device_registration_id, revoked_at, revoke_reason)
     values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, (select user_id from machvon.membership where id = $2::uuid), $2::uuid, $3, 'aal1', repeat('a', 64), 'Chrome on Windows', $4::uuid, case when $5 then now() end, case when $5 then 'EARLIER' end)`,
    [id, memberId(member), `idp-${id}`, options.device ?? null, options.revoked ?? false],
  );
  return id;
}

async function device(member: number, platform = 'android'): Promise<string> {
  const id = randomUUID();
  await owner(
    `insert into machvon.device_registration (tenant_id, id, membership_id, device_public_id, push_secret_ref, platform, last_seen_at, token_fingerprint, app_version)
     values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4, $5, now(), repeat('b', 64), '1.0.0')`,
    [id, memberId(member), `dev-${id}`, `secret://push/${id}`, platform],
  );
  return id;
}

describe('the profile, the sessions and the devices of a person (ST-IAM-006)', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: 1, path: '/u1/' }]);
    await harness.seedUnits(TENANT_B, [{ n: 1, path: '/u1/' }]);
    for (const n of [ME, OTHER]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, OTHER_TENANT_member(), 1);
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the profile', () => {
    it('is read as the person is, with the email and the phone masked', async () => {
      await owner("update machvon.user_account set phone_e164 = '+84901234567' where id = (select user_id from machvon.membership where id = $1)", [memberId(ME)]);
      const profile = await as((tx) => self.profile(tx, memberId(ME)));
      expect(profile).toMatchObject({ displayName: 'User 1', emailMasked: 'u***@example.test', phoneMasked: '*********567', locale: 'vi-VN', timeZone: 'Asia/Ho_Chi_Minh' });
      expect(JSON.stringify(profile)).not.toContain('user1@example.test');
      expect(JSON.stringify(profile)).not.toContain('+84901234567');
    });

    it('AC-ST-IAM-006-2: is changed at the version read, and a stale version is told what the profile says now', async () => {
      const before = await as((tx) => self.profile(tx, memberId(ME)));
      const changed = await as((tx) => self.updateProfile(tx, memberId(ME), before.version, { displayName: 'Nguyen Van An', locale: 'en-US' }));
      expect(changed).toMatchObject({ displayName: 'Nguyen Van An', locale: 'en-US', timeZone: 'Asia/Ho_Chi_Minh', version: before.version + 1 });
      // The phone and the time zone were not in the body: they stay.
      expect(changed.phoneMasked).toBe('*********567');
      const stale = await refusal(as((tx) => self.updateProfile(tx, memberId(ME), before.version, { displayName: 'Someone Else' })));
      expect(stale).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(JSON.stringify(stale.extensions)).toContain('Nguyen Van An');
      expect((await as((tx) => self.profile(tx, memberId(ME)))).displayName).toBe('Nguyen Van An');
      const phone = await as((tx) => self.updateProfile(tx, memberId(ME), changed.version, { phoneE164: '+84912345678', timeZone: 'Asia/Bangkok' }));
      expect(phone).toMatchObject({ phoneMasked: '*********678', timeZone: 'Asia/Bangkok', version: changed.version + 1 });
    });

    it('is not reached for another person: the profile is the one of the membership of the transaction, and a membership of another tenant is not found', async () => {
      const other = await as((tx) => self.profile(tx, memberId(OTHER)), OTHER);
      expect(other.displayName).toBe('User 2');
      expect(await refusal(as((tx) => self.profile(tx, memberId(OTHER_TENANT_member())), ME))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => self.updateProfile(tx, memberId(OTHER_TENANT_member()), 1, { displayName: 'Intruder' }), ME))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect((await owner<{ display_name: string }>('select display_name from machvon.user_account where id = (select user_id from machvon.membership where id = $1 limit 1)', [memberId(OTHER_TENANT_member())], TENANT_B))[0]?.display_name).toBe('User 3');
    });

    it('is not reached by the application role except through the two functions', async () => {
      await expect(as((tx) => tx.query('select display_name from machvon.user_account limit 1'))).rejects.toThrow(/permission denied/);
      await expect(as((tx) => tx.query("update machvon.user_account set display_name = 'x'"))).rejects.toThrow(/permission denied/);
    });
  });

  describe('the sessions (revokeMySession)', () => {
    it('lists the live sessions of the member only, the latest first, and not the revoked ones', async () => {
      const first = await session(ME);
      const second = await session(ME);
      await session(ME, { revoked: true });
      await session(OTHER);
      const listed = await as((tx) => self.sessions(tx, memberId(ME)));
      const ids = listed.map((row) => row.id);
      expect(ids.slice(0, 2)).toEqual([second, first]);
      expect(listed.every((row) => row.userAgentSummary === 'Chrome on Windows')).toBe(true);
      expect(JSON.stringify(listed)).not.toContain('aaaaaaaaaaaaaaaa');
    });

    it('takes the locks again, device first, when a device is tied to the session while the revocation is running: it then closes the device too, and the token reference goes with it', async () => {
      const mine = await session(ME);
      const current = await session(ME);
      const bound = await device(ME);
      let tied = false;
      const result = await as((tx) => {
        // Between the look at the session and the lock on it (the first lock on the session), the device registers for the session (another transaction, committed).
        const interleaved: TenantTx = {
          query: async <R,>(sql: string, params?: unknown[]): Promise<R[]> => {
            if (!tied && sql.startsWith('select id, idp_session_id, revoked_at is not null')) {
              tied = true;
              await owner('update machvon.user_session set device_registration_id = $1::uuid where id = $2::uuid', [bound, mine]);
            }
            return tx.query<R>(sql, params);
          },
        };
        return self.revokeSession(interleaved, memberId(ME), mine, current, 'USER_REVOKED');
      });
      expect(tied).toBe(true);
      expect(result).toMatchObject({ alreadyRevoked: false, revokedDeviceId: bound, revokedSessionIds: [mine] });
      expect(result.removedSecretRefs).toEqual([`secret://push/${bound}`]);
      const [row] = await owner<{ revoked_at: Date | null; push_secret_ref: string | null }>('select revoked_at, push_secret_ref from machvon.device_registration where id = $1', [bound]);
      expect(row?.revoked_at).not.toBeNull();
      expect(row?.push_secret_ref).toBeNull();
    });

    it('asks the caller to try again, and revokes nothing, when the session is moved to another device every time it is looked at', async () => {
      const mine = await session(ME);
      const current = await session(ME);
      const devices = [await device(ME), await device(ME), await device(ME), await device(ME), await device(ME)];
      let moves = 0;
      const failure = await refusal(
        as((tx) => {
          const interleaved: TenantTx = {
            query: async <R,>(sql: string, params?: unknown[]): Promise<R[]> => {
              if (sql.startsWith('select id, idp_session_id, revoked_at is not null') && moves < devices.length) {
                await owner('update machvon.user_session set device_registration_id = $1::uuid where id = $2::uuid', [devices[moves], mine]);
                moves += 1;
              }
              return tx.query<R>(sql, params);
            },
          };
          return self.revokeSession(interleaved, memberId(ME), mine, current, 'USER_REVOKED');
        }),
      );
      expect(failure).toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS', status: 409 });
      expect(moves).toBe(4);
      const [row] = await owner<{ revoked_at: Date | null }>('select revoked_at from machvon.user_session where id = $1', [mine]);
      expect(row?.revoked_at).toBeNull();
      const open = await owner<{ n: string }>('select count(*)::text as n from machvon.device_registration where id = any($1::uuid[]) and revoked_at is null', [devices]);
      expect(open[0]?.n).toBe('5');
    });

    it('AC-ST-IAM-006-1: revokes another session of the member, never the one the request is made with, never another member\'s, and does the same twice', async () => {
      const mine = await session(ME);
      const current = await session(ME);
      const theirs = await session(OTHER);
      expect(await refusal(as((tx) => self.revokeSession(tx, memberId(ME), current, current, 'USER_REVOKED')))).toMatchObject({ code: 'SESSION_CURRENT', status: 422 });
      expect(await refusal(as((tx) => self.revokeSession(tx, memberId(ME), theirs, current, 'USER_REVOKED')))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => self.revokeSession(tx, memberId(ME), randomUUID(), current, 'USER_REVOKED')))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      const done = await as((tx) => self.revokeSession(tx, memberId(ME), mine, current, 'USER_REVOKED'));
      expect(done).toMatchObject({ revokedSessionIds: [mine], alreadyRevoked: false, revokedDeviceId: null });
      const again = await as((tx) => self.revokeSession(tx, memberId(ME), mine, current, 'USER_REVOKED'));
      expect(again).toMatchObject({ revokedSessionIds: [], alreadyRevoked: true });
      const stored = await owner<{ id: string; revoked: boolean; revoke_reason: string | null }>('select id, revoked_at is not null as revoked, revoke_reason from machvon.user_session where id = any($1::uuid[])', [[mine, current, theirs]]);
      expect(Object.fromEntries(stored.map((row) => [row.id, [row.revoked, row.revoke_reason]]))).toEqual({ [mine]: [true, 'USER_REVOKED'], [current]: [false, null], [theirs]: [false, null] });
      // The session is isolated: another tenant cannot see or revoke it.
      expect(await refusal(as((tx) => self.revokeSession(tx, memberId(OTHER_TENANT_member()), current, current, 'USER_REVOKED'), OTHER_TENANT_member(), TENANT_B))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('is kept as it was: the time and the reason of a revocation are not rewritten, ', async () => {
      const id = await session(ME, { revoked: true });
      await expect(owner("update machvon.user_session set revoke_reason = 'CHANGED' where id = $1", [id])).rejects.toThrow(/stays revoked/);
      await expect(owner('update machvon.user_session set revoked_at = null where id = $1', [id])).rejects.toThrow(/stays revoked/);
    });
  });

  describe('the devices (revokeMyDevice)', () => {
    it('lists the devices of the member, the live ones first and the revoked ones as history', async () => {
      const live = await device(ME, 'ios');
      const gone = await device(ME);
      await as((tx) => self.revokeDevice(tx, memberId(ME), gone, 'USER_REVOKED'));
      await device(OTHER);
      const listed = await as((tx) => self.devices(tx, memberId(ME)));
      const mine = listed.filter((row) => [live, gone].includes(row.id));
      expect(mine.map((row) => [row.id, row.revokedAt === null])).toEqual([[live, true], [gone, false]]);
      expect(mine[0]).toMatchObject({ platform: 'ios' });
    });

    it('AC-ST-IAM-006-3, UAT-AC192: removes a device: one row, revoked, its push token gone, the sessions opened on it signed out, and the same twice changes nothing', async () => {
      const id = await device(ME);
      const onIt = await session(ME, { device: id });
      const elsewhere = await session(ME);
      const done = await as((tx) => self.revokeDevice(tx, memberId(ME), id, 'USER_REVOKED'));
      expect(done).toMatchObject({ alreadyRevoked: false, revokedSessionIds: [onIt] });
      expect(await owner<{ revoked: boolean; push_secret_ref: string | null }>('select revoked_at is not null as revoked, push_secret_ref from machvon.device_registration where id = $1', [id])).toEqual([{ revoked: true, push_secret_ref: null }]);
      expect(await owner('select id from machvon.device_registration where membership_id = $1 and id = $2', [memberId(ME), id])).toHaveLength(1);
      const sessions = await owner<{ id: string; revoked: boolean }>('select id, revoked_at is not null as revoked from machvon.user_session where id = any($1::uuid[])', [[onIt, elsewhere]]);
      expect(Object.fromEntries(sessions.map((row) => [row.id, row.revoked]))).toEqual({ [onIt]: true, [elsewhere]: false });
      expect(await as((tx) => self.revokeDevice(tx, memberId(ME), id, 'USER_REVOKED'))).toMatchObject({ alreadyRevoked: true, revokedSessionIds: [] });
    });

    it('AC-ST-IAM-006-3: signing out of a session opened on a device removes the device with it', async () => {
      const id = await device(ME);
      const onIt = await session(ME, { device: id });
      const current = await session(ME);
      const done = await as((tx) => self.revokeSession(tx, memberId(ME), onIt, current, 'USER_REVOKED'));
      expect(done.revokedDeviceId).toBe(id);
      expect(await owner('select push_secret_ref, revoke_reason from machvon.device_registration where id = $1 and revoked_at is not null', [id])).toEqual([{ push_secret_ref: null, revoke_reason: 'USER_REVOKED' }]);
    });

    it('takes every session opened on a device with it: signing out of one, or removing the device again, leaves none live', async () => {
      const id = await device(ME);
      const first = await session(ME, { device: id });
      const second = await session(ME, { device: id });
      const current = await session(ME);
      const done = await as((tx) => self.revokeSession(tx, memberId(ME), first, current, 'USER_REVOKED'));
      expect(done.revokedDeviceId).toBe(id);
      expect([...done.revokedSessionIds].sort()).toEqual([first, second].sort());
      expect(done.idpSessionIds).toHaveLength(2);
      expect((await owner<{ revoked: boolean }>('select revoked_at is not null as revoked from machvon.user_session where id = $1', [second]))[0]?.revoked).toBe(true);
      expect((await owner<{ revoked: boolean }>('select revoked_at is not null as revoked from machvon.user_session where id = $1', [current]))[0]?.revoked).toBe(false);
      // A session opened on the device after it was removed (a straggler) is closed by asking again; with none, asking again changes nothing.
      const straggler = await session(ME, { device: id });
      const again = await as((tx) => self.revokeDevice(tx, memberId(ME), id, 'USER_REVOKED'));
      expect(again).toMatchObject({ alreadyRevoked: false, revokedSessionIds: [straggler] });
      expect(await as((tx) => self.revokeDevice(tx, memberId(ME), id, 'USER_REVOKED'))).toMatchObject({ alreadyRevoked: true, revokedSessionIds: [] });
    });

    it('does not sign out the current session through its device: a session that shares the device of the request is refused as the current one', async () => {
      const id = await device(ME);
      const current = await session(ME, { device: id });
      const sibling = await session(ME, { device: id });
      expect(await refusal(as((tx) => self.revokeSession(tx, memberId(ME), sibling, current, 'USER_REVOKED')))).toMatchObject({ code: 'SESSION_CURRENT', status: 422 });
      expect(await owner('select id from machvon.user_session where id = any($1::uuid[]) and revoked_at is not null', [[current, sibling]])).toEqual([]);
      expect(await owner('select id from machvon.device_registration where id = $1 and revoked_at is not null', [id])).toEqual([]);
    });

    it('does not deadlock when a session and its device are revoked at the same moment', async () => {
      const id = await device(ME);
      const onIt = await session(ME, { device: id });
      const current = await session(ME);
      const results = await Promise.allSettled([
        as((tx) => self.revokeSession(tx, memberId(ME), onIt, current, 'USER_REVOKED')),
        as((tx) => self.revokeDevice(tx, memberId(ME), id, 'USER_REVOKED')),
        as((tx) => self.revokeSession(tx, memberId(ME), onIt, current, 'USER_REVOKED')),
        as((tx) => self.revokeDevice(tx, memberId(ME), id, 'USER_REVOKED')),
      ]);
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
      expect((await owner<{ revoked: boolean }>('select revoked_at is not null as revoked from machvon.user_session where id = $1', [onIt]))[0]?.revoked).toBe(true);
    });

    it('is not another member\'s to remove, and the database keeps one row per device and a revoked device revoked', async () => {
      const theirs = await device(OTHER);
      expect(await refusal(as((tx) => self.revokeDevice(tx, memberId(ME), theirs, 'USER_REVOKED')))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => self.revokeDevice(tx, memberId(ME), randomUUID(), 'USER_REVOKED')))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      const [row] = await owner<{ device_public_id: string }>('select device_public_id from machvon.device_registration where id = $1', [theirs]);
      await expect(
        owner(
          `insert into machvon.device_registration (tenant_id, id, membership_id, device_public_id, push_secret_ref, platform, last_seen_at, token_fingerprint, app_version)
           values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, 'secret://x', 'ios', now(), repeat('c', 64), '1.0.0')`,
          [memberId(OTHER), row?.device_public_id],
        ),
      ).rejects.toThrow(/duplicate key/);
      const mine = await device(ME);
      await as((tx) => self.revokeDevice(tx, memberId(ME), mine, 'USER_REVOKED'));
      await expect(owner("update machvon.device_registration set push_secret_ref = 'secret://again' where id = $1", [mine])).rejects.toThrow(/stays revoked/);
      await expect(owner('update machvon.device_registration set revoked_at = null where id = $1', [mine])).rejects.toThrow(/stays revoked|violates check/);
    });
  });
});

function OTHER_TENANT_member(): number {
  return OTHER_TENANT_MEMBER;
}
