import { DomainError } from '@machvon/kernel';
import { assertTimestampCursor } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';

const TIME = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const UNIQUE_VIOLATION = '23505';

/**
 * The push policy of a person with several devices (ST-MOB-031, NOT 3.7, CR-SMP-06): a notification is pushed to ONE device, the owner, so that the same event does not ring on every phone, tablet and browser of the person. The owner is the live device
 * the person used last (`last_seen_at` is moved by every registration, which the application makes whenever it opens the inbox or the provider rotates the token) among the devices that can be pushed to: registered, with a token in the vault and with the
 * operating system's permission granted or provisional. A tie goes to the lower id, so the choice is the same for every reader. The two fragments are the whole policy; `pushOwner` and the list of the person's devices (IAM `listMyDevices`) both read them.
 */
export const PUSH_ELIGIBLE_SQL = "revoked_at is null and push_secret_ref is not null and permission_state in ('granted', 'provisional')";
export const PUSH_OWNER_ORDER_SQL = 'last_seen_at desc, id';

export interface RegisterDevice {
  membershipId: string;
  devicePublicId: string;
  platform: string;
  permissionState: string;
  appVersion: string;
  locale: string;
  /**
   * The SHA-256 of the push token: what is kept in the database to tell that the token changed, never the token. Undefined for a device that has no token (a build without a push provider, a permission that was refused): it is
   * registered all the same, for the offline command queue, and nothing is pushed to it.
   */
  tokenFingerprint: string | undefined;
}

export interface DeviceRegistrationRecord {
  id: string;
  membershipId: string;
  platform: string;
  devicePublicId: string;
  permissionState: string;
  appVersion: string;
  locale: string;
  lastSeenAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
  sortKey: string;
}

interface DeviceRow {
  id: string;
  membership_id: string;
  platform: string;
  device_public_id: string;
  permission_state: string;
  app_version: string;
  locale: string;
  last_seen_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
  sort_key: string;
}

const COLUMNS = `id, membership_id, platform, device_public_id, permission_state, app_version, locale, ${TIME('last_seen_at')} as last_seen_at, ${TIME('revoked_at')} as revoked_at, revoke_reason,
  to_char(date_trunc('milliseconds', last_seen_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"000Z"') as sort_key`;

const toRecord = (row: DeviceRow): DeviceRegistrationRecord => ({
  id: row.id,
  membershipId: row.membership_id,
  platform: row.platform,
  devicePublicId: row.device_public_id,
  permissionState: row.permission_state,
  appVersion: row.app_version,
  locale: row.locale,
  lastSeenAt: row.last_seen_at,
  revokedAt: row.revoked_at,
  revokeReason: row.revoke_reason,
  sortKey: row.sort_key,
});

/**
 * The push devices of the members (ST-NOT-006, NOT 3.7). A member has at most one live registration for a device (a unique index of V002 on tenant, membership and the public id of the device), so registering again is
 * the same registration with what changed: the token (its fingerprint), the permission the operating system gave, the version of the app, the locale. The token itself is in the vault, referenced by `push_secret_ref`;
 * the database keeps its fingerprint only. The token is optional (FIXAE-1, V2900): a device without a push provider is registered with neither a reference nor a fingerprint, so that it has the id its offline command queue needs;
 * it is never a push target. A revoked device keeps its row as history, without its reference (IAM-1 guards that).
 */
export class DeviceRegistrationStore {
  /**
   * Registers the device of the member, or brings the live registration up to date. `newId` is used only when there is no live registration. `newRef` is the place of a token that is new: every token has a reference
   * of its own, so a command that does not commit leaves the token the registration had untouched (the row goes back to its old reference with the transaction) and only has to remove the one it wrote. When the token
   * has not changed the registration keeps its reference; when it has, `previousRef` is the reference the row had, to be removed from the vault once the change has committed.
   * A registration without a token (`tokenFingerprint` undefined) keeps no reference: `secretRef` is undefined, and a token the device held before is released through `previousRef` (the device says it has none now).
   */
  async register(
    tx: TenantTx,
    input: RegisterDevice,
    newId: string,
    newRef: string,
  ): Promise<{ id: string; secretRef: string | undefined; previousRef: string | undefined; created: boolean; tokenChanged: boolean }> {
    const fingerprint = input.tokenFingerprint ?? null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const [live] = await tx.query<{ id: string; platform: string; push_secret_ref: string | null; token_fingerprint: string | null }>(
        'select id, platform, push_secret_ref, token_fingerprint from machvon.device_registration where membership_id = $1::uuid and device_public_id = $2 and revoked_at is null for update',
        [input.membershipId, input.devicePublicId],
      );
      if (live !== undefined) {
        // The platform is what the device is: a device that says another platform is not this device, and nothing about it is changed.
        if (live.platform !== input.platform) throw new DomainError('VALIDATION_FAILED', 422, 'platform');
        const tokenChanged = live.token_fingerprint !== fingerprint;
        const secretRef = fingerprint === null ? null : tokenChanged || live.push_secret_ref === null ? newRef : live.push_secret_ref;
        await tx.query(
          // The platform is what the device is: it is not rewritten here (a device that says another platform is another device).
          'update machvon.device_registration set permission_state = $2, app_version = $3, locale = $4, token_fingerprint = $5, push_secret_ref = $6, last_seen_at = now() where id = $1::uuid',
          [live.id, input.permissionState, input.appVersion, input.locale, fingerprint, secretRef],
        );
        const previousRef = secretRef !== live.push_secret_ref && live.push_secret_ref !== null ? live.push_secret_ref : undefined;
        return { id: live.id, secretRef: secretRef ?? undefined, previousRef, created: false, tokenChanged };
      }
      await tx.query('savepoint device_registration_new');
      try {
        await tx.query(
          `insert into machvon.device_registration (tenant_id, id, membership_id, device_public_id, push_secret_ref, platform, last_seen_at, token_fingerprint, permission_state, app_version, locale)
           values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4, $5, now(), $6, $7, $8, $9)`,
          [newId, input.membershipId, input.devicePublicId, fingerprint === null ? null : newRef, input.platform, fingerprint, input.permissionState, input.appVersion, input.locale],
        );
        await tx.query('release savepoint device_registration_new');
        return { id: newId, secretRef: fingerprint === null ? undefined : newRef, previousRef: undefined, created: true, tokenChanged: fingerprint !== null };
      } catch (error) {
        // Two registrations of the same device at the same moment: the second finds the first on its next look and updates it.
        if ((error as { code?: string }).code !== UNIQUE_VIOLATION || attempt === 1) throw error;
        await tx.query('rollback to savepoint device_registration_new');
      }
    }
    throw new DomainError('IDEMPOTENCY_IN_PROGRESS', 409);
  }

  /**
   * The devices a push may go to now: registered, with a token in the vault, and with the operating system's permission (granted or provisional) for the platforms the channel reaches. Of one member, of several, or
   * of the whole tenant (`membershipIds` undefined) for a message that is for everyone.
   */
  async pushTargets(tx: TenantTx, membershipIds: readonly string[] | undefined, platforms: readonly string[]): Promise<Array<{ id: string; membershipId: string; platform: string; secretRef: string }>> {
    const rows = await tx.query<{ id: string; membership_id: string; platform: string; push_secret_ref: string }>(
      `select id, membership_id, platform, push_secret_ref from machvon.device_registration
        where revoked_at is null and push_secret_ref is not null and permission_state in ('granted', 'provisional') and platform = any($1::text[]) and ($2::uuid[] is null or membership_id = any($2::uuid[]))
        order by last_seen_at desc, id`,
      [platforms, membershipIds === undefined ? null : [...membershipIds]],
    );
    return rows.map((row) => ({ id: row.id, membershipId: row.membership_id, platform: row.platform, secretRef: row.push_secret_ref }));
  }

  /**
   * The device a person's push goes to (the owner, see PUSH_ELIGIBLE_SQL), or undefined when the person has none that can be pushed to. It is decided across the platforms: a person whose last device is an iPhone is pushed on the iPhone
   * even when they also hold an Android phone, and the FCM channel then finds no device for them.
   */
  async pushOwner(tx: TenantTx, membershipId: string): Promise<{ id: string; membershipId: string; platform: string; secretRef: string } | undefined> {
    const [row] = await tx.query<{ id: string; membership_id: string; platform: string; push_secret_ref: string }>(
      `select id, membership_id, platform, push_secret_ref from machvon.device_registration where membership_id = $1::uuid and ${PUSH_ELIGIBLE_SQL} order by ${PUSH_OWNER_ORDER_SQL} limit 1`,
      [membershipId],
    );
    return row === undefined ? undefined : { id: row.id, membershipId: row.membership_id, platform: row.platform, secretRef: row.push_secret_ref };
  }

  /**
   * Revokes the devices whose token the provider no longer knows (UNREGISTERED, BadDeviceToken): the row is revoked with the reason and loses its reference, as IAM does for a device the member removes, and the
   * references are given back so the tokens leave the vault. Each device comes with the reference of the token that was refused: a device that rotated its token while the push was in flight holds another reference now,
   * and the refusal of the old token says nothing about the new one, so it is left alone. The sessions opened on the device are not touched: the app registers again at its next start. A device already revoked is left alone.
   */
  async revokeDead(tx: TenantTx, dead: ReadonlyArray<{ id: string; secretRef: string }>, reason: string): Promise<string[]> {
    if (dead.length === 0) return [];
    const held = await tx.query<{ id: string; push_secret_ref: string | null }>(
      `select r.id, r.push_secret_ref from machvon.device_registration r join unnest($1::uuid[], $2::text[]) as d(id, ref) on d.id = r.id and d.ref = r.push_secret_ref
        where r.revoked_at is null order by r.id for update of r`,
      [dead.map((item) => item.id), dead.map((item) => item.secretRef)],
    );
    if (held.length === 0) return [];
    await tx.query('update machvon.device_registration set revoked_at = now(), push_secret_ref = null, revoke_reason = $2 where id = any($1::uuid[]) and revoked_at is null', [held.map((row) => row.id), reason]);
    return held.flatMap((row) => (row.push_secret_ref === null ? [] : [row.push_secret_ref]));
  }

  async find(tx: TenantTx, id: string): Promise<DeviceRegistrationRecord | undefined> {
    const [row] = await tx.query<DeviceRow>(`select ${COLUMNS} from machvon.device_registration where id = $1::uuid`, [id]);
    return row === undefined ? undefined : toRecord(row);
  }

  /** The devices of the tenant, the most recently seen first, a page at a time; optionally of one status, platform or member. */
  async list(
    tx: TenantTx,
    filters: { status?: 'Active' | 'Revoked' | undefined; platform?: string | undefined; membershipId?: string | undefined },
    page: { limit: number; after: { code: string; id: string } | undefined },
  ): Promise<DeviceRegistrationRecord[]> {
    assertTimestampCursor(page.after?.code);
    const rows = await tx.query<DeviceRow>(
      `select ${COLUMNS} from machvon.device_registration
        where ($1::text is null or (case when revoked_at is null then 'Active' else 'Revoked' end) = $1) and ($2::text is null or platform = $2) and ($3::uuid is null or membership_id = $3::uuid)
          and ($4::timestamptz is null or (date_trunc('milliseconds', last_seen_at), id) < ($4::timestamptz, $5::uuid))
        order by date_trunc('milliseconds', last_seen_at) desc, id desc limit $6::int`,
      [filters.status ?? null, filters.platform ?? null, filters.membershipId ?? null, page.after?.code ?? null, page.after?.id ?? null, page.limit],
    );
    return rows.map(toRecord);
  }
}
