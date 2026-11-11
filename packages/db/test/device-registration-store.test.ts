import { randomUUID } from 'node:crypto';
import { DeviceRegistrationStore } from '../src/device-registration-store';
import type { RegisterDevice } from '../src/device-registration-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, contextFor, memberId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const store = new DeviceRegistrationStore();
const ME = 1;
const FINGERPRINT = 'a'.repeat(64);
const OTHER_FINGERPRINT = 'b'.repeat(64);

const as = <T>(work: (tx: TenantTx) => Promise<T>): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(ME)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);
const input = (devicePublicId: string, overrides: Partial<RegisterDevice> = {}): RegisterDevice => ({
  membershipId: memberId(ME),
  devicePublicId,
  platform: 'android',
  permissionState: 'granted',
  appVersion: '1.0.0',
  locale: 'vi-VN',
  tokenFingerprint: undefined,
  ...overrides,
});
const register = (body: RegisterDevice) => as((tx) => store.register(tx, body, randomUUID(), `secret://push/${randomUUID()}`));
const rowOf = async (id: string) => (await owner<{ push_secret_ref: string | null; token_fingerprint: string | null; permission_state: string }>('select push_secret_ref, token_fingerprint, permission_state from machvon.device_registration where id = $1', [id]))[0];

describe('the device registration without a push token (FIXAE-1, V2900)', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: 1, path: '/u1/' }]);
    await harness.seedMembership(TENANT_A, ME, 1);
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  it('keeps a device without a token with no reference and no fingerprint, and never offers it as a push target, whatever permission it reports', async () => {
    const publicId = `device-no-push-${randomUUID()}`;
    const first = await register(input(publicId, { permissionState: 'unavailable' }));
    expect(first).toMatchObject({ created: true, tokenChanged: false, secretRef: undefined, previousRef: undefined });
    expect(await rowOf(first.id)).toEqual({ push_secret_ref: null, token_fingerprint: null, permission_state: 'unavailable' });
    const granted = await register(input(publicId, { permissionState: 'granted' }));
    expect(granted).toMatchObject({ id: first.id, created: false, tokenChanged: false, secretRef: undefined });
    const targets = await as((tx) => store.pushTargets(tx, [memberId(ME)], ['android']));
    expect(targets.map((target) => target.id)).not.toContain(first.id);
    expect(await as((tx) => store.pushOwner(tx, memberId(ME)))).toBeUndefined();
  });

  it('gives a token to the same registration later, and takes it back when the device says it has none: the previous reference is handed back to be removed from the vault', async () => {
    const publicId = `device-later-${randomUUID()}`;
    const first = await register(input(publicId, { permissionState: 'unknown' }));
    const given = await register(input(publicId, { tokenFingerprint: FINGERPRINT }));
    expect(given).toMatchObject({ id: first.id, created: false, tokenChanged: true, previousRef: undefined });
    expect(given.secretRef).toMatch(/^secret:\/\/push\//);
    expect((await as((tx) => store.pushTargets(tx, [memberId(ME)], ['android']))).map((target) => target.id)).toContain(first.id);

    const same = await register(input(publicId, { tokenFingerprint: FINGERPRINT }));
    expect(same).toMatchObject({ tokenChanged: false, secretRef: given.secretRef, previousRef: undefined });
    const rotated = await register(input(publicId, { tokenFingerprint: OTHER_FINGERPRINT }));
    expect(rotated).toMatchObject({ tokenChanged: true, previousRef: given.secretRef });

    const lost = await register(input(publicId, { permissionState: 'denied' }));
    expect(lost).toMatchObject({ id: first.id, tokenChanged: true, secretRef: undefined, previousRef: rotated.secretRef });
    expect(await rowOf(first.id)).toEqual({ push_secret_ref: null, token_fingerprint: null, permission_state: 'denied' });
    expect((await as((tx) => store.pushTargets(tx, [memberId(ME)], ['android']))).map((target) => target.id)).not.toContain(first.id);
  });

  it('keeps the rules of the table: a reference needs a fingerprint, a revoked device has no reference, and the permission state is one of the five', async () => {
    const publicId = `device-rules-${randomUUID()}`;
    const { id } = await register(input(publicId));
    const insert = (columns: string, values: string, params: unknown[]) =>
      owner(`insert into machvon.device_registration (tenant_id, id, membership_id, device_public_id, platform, last_seen_at, app_version, ${columns}) values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, 'android', now(), '1.0.0', ${values})`, [memberId(ME), `device-bad-${randomUUID()}`, ...params]);
    await expect(insert('push_secret_ref', '$3', ['secret://push/x'])).rejects.toMatchObject({ code: '23514' });
    await expect(insert('revoked_at, push_secret_ref, token_fingerprint', "now(), $3, repeat('c', 64)", ['secret://push/y'])).rejects.toMatchObject({ code: '23514' });
    await expect(insert('permission_state', '$3', ['maybe'])).rejects.toMatchObject({ code: '23514' });
    await expect(owner("update machvon.device_registration set revoked_at = now() where id = $1", [id])).resolves.toEqual([]);
    await expect(owner("update machvon.device_registration set push_secret_ref = 'secret://push/z', token_fingerprint = repeat('d', 64) where id = $1", [id])).rejects.toMatchObject({ code: '23514' });
  });
});
