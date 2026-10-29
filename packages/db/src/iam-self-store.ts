import { DomainError, maskEmail, maskPhone, versionConflict } from '@machvon/kernel';
import type { ProfilePatch } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

const TIME = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface ProfileRecord {
  userId: string;
  displayName: string;
  emailMasked: string;
  locale: string;
  timeZone: string;
  phoneMasked: string | null;
  version: number;
}

export interface SessionView {
  id: string;
  assurance: 'aal1' | 'aal2';
  userAgentSummary: string;
  createdAt: string;
  lastSeenAt: string;
  deviceId: string | null;
  devicePlatform: string | null;
}

export interface DeviceView {
  id: string;
  platform: string;
  devicePublicId: string;
  lastSeenAt: string;
  revokedAt: string | null;
}

/** What revoking a session did: the sessions that are revoked now (its own, and those of the device it was opened on) and the device that went with it. */
export interface SessionRevocation {
  revokedSessionIds: string[];
  revokedDeviceId: string | null;
  alreadyRevoked: boolean;
  idpSessionIds: string[];
}

export interface DeviceRevocation {
  revokedSessionIds: string[];
  alreadyRevoked: boolean;
  idpSessionIds: string[];
}

interface ProfileRow {
  user_id: string;
  display_name: string;
  email: string;
  locale: string;
  time_zone: string;
  phone_e164: string | null;
  version: string;
}

const toProfile = (row: ProfileRow): ProfileRecord => ({
  userId: row.user_id,
  displayName: row.display_name,
  emailMasked: maskEmail(row.email),
  locale: row.locale,
  timeZone: row.time_zone,
  phoneMasked: row.phone_e164 === null ? null : maskPhone(row.phone_e164),
  version: Number(row.version),
});

/**
 * The self-service of a person (ST-IAM-006, IAM-05, IAM-06): their own profile, their own sessions and their own devices, and nobody else's. Every method takes the membership of the caller and only ever
 * reaches the rows of that membership in the tenant of the transaction: what belongs to another member is not there for the caller (404).
 */
export class IamSelfStore {
  async profile(tx: TenantTx, membershipId: string): Promise<ProfileRecord> {
    const [row] = await tx.query<ProfileRow>('select user_id, display_name, email, locale, time_zone, phone_e164, version::text as version from machvon.my_profile($1::uuid)', [membershipId]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return toProfile(row);
  }

  /**
   * Changes the profile at the version read. A stale version is 409 `VERSION_CONFLICT` carrying what the profile says now (the screen puts it beside what the person entered); nothing is written then.
   */
  async updateProfile(tx: TenantTx, membershipId: string, expectedVersion: number, patch: ProfilePatch): Promise<ProfileRecord> {
    const [done] = await tx.query<{ was_updated: boolean; new_version: string }>('select was_updated, new_version::text as new_version from machvon.update_my_profile($1::uuid, $2::bigint, $3, $4, $5, $6, $7)', [
      membershipId,
      expectedVersion,
      patch.displayName ?? null,
      patch.locale ?? null,
      patch.timeZone ?? null,
      patch.phoneE164 !== undefined,
      patch.phoneE164 ?? null,
    ]);
    if (done === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const current = await this.profile(tx, membershipId);
    if (!done.was_updated) {
      throw versionConflict(current.version, { display_name: current.displayName, locale: current.locale, time_zone: current.timeZone, phone_masked: current.phoneMasked });
    }
    return current;
  }

  /** The live sessions of the member, the latest first; a revoked session is not listed. */
  async sessions(tx: TenantTx, membershipId: string): Promise<SessionView[]> {
    const rows = await tx.query<{ id: string; assurance_level: 'aal1' | 'aal2'; user_agent_summary: string; created_at: string; last_seen_at: string; device_registration_id: string | null; platform: string | null }>(
      `select s.id, s.assurance_level, s.user_agent_summary, ${TIME('s.created_at')} as created_at, ${TIME('s.last_seen_at')} as last_seen_at, s.device_registration_id, d.platform
         from machvon.user_session s left join machvon.device_registration d on d.tenant_id = s.tenant_id and d.id = s.device_registration_id
        where s.membership_id = $1::uuid and s.revoked_at is null order by s.created_at desc, s.id desc limit 200`,
      [membershipId],
    );
    return rows.map((row) => ({
      id: row.id,
      assurance: row.assurance_level,
      userAgentSummary: row.user_agent_summary,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      deviceId: row.device_registration_id,
      devicePlatform: row.platform,
    }));
  }

  /** The devices of the member, the live ones first, then the revoked (kept as history). */
  async devices(tx: TenantTx, membershipId: string): Promise<DeviceView[]> {
    const rows = await tx.query<{ id: string; platform: string; device_public_id: string; last_seen_at: string; revoked_at: string | null }>(
      `select id, platform, device_public_id, ${TIME('last_seen_at')} as last_seen_at, ${TIME('revoked_at')} as revoked_at
         from machvon.device_registration where membership_id = $1::uuid order by (revoked_at is not null), last_seen_at desc, id limit 200`,
      [membershipId],
    );
    return rows.map((row) => ({ id: row.id, platform: row.platform, devicePublicId: row.device_public_id, lastSeenAt: row.last_seen_at, revokedAt: row.revoked_at }));
  }

  /**
   * Signs out one session of the caller: not the one the request is made with (422 `SESSION_CURRENT`: the person signs out of it in the usual way), not another member's (404). Asking again for a session that is
   * revoked changes nothing and answers the same. A session opened on a device takes the device with it: the device is removed and every live session opened on it is signed out, so that a device that signed out
   * receives no push and keeps no session. The device is locked before the session, as in `revokeDevice`, so that the two never wait for each other.
   */
  async revokeSession(tx: TenantTx, membershipId: string, sessionId: string, currentSessionId: string, reason: string): Promise<SessionRevocation> {
    const [peek] = await tx.query<{ id: string; device_registration_id: string | null }>('select id, device_registration_id from machvon.user_session where id = $1::uuid and membership_id = $2::uuid', [sessionId, membershipId]);
    if (peek === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (peek.id === currentSessionId) throw new DomainError('SESSION_CURRENT', 422);
    // Removing the device of a session would sign out every session opened on it: if the session of the request is one of them, it is the current session that would go.
    if (peek.device_registration_id !== null) {
      const [mine] = await tx.query<{ device_registration_id: string | null }>('select device_registration_id from machvon.user_session where id = $1::uuid and membership_id = $2::uuid', [currentSessionId, membershipId]);
      if (mine?.device_registration_id === peek.device_registration_id) throw new DomainError('SESSION_CURRENT', 422);
    }
    if (peek.device_registration_id !== null) await tx.query('select id from machvon.device_registration where id = $1::uuid and membership_id = $2::uuid for update', [peek.device_registration_id, membershipId]);
    const [row] = await tx.query<{ id: string; idp_session_id: string; revoked: boolean; device_registration_id: string | null }>(
      'select id, idp_session_id, revoked_at is not null as revoked, device_registration_id from machvon.user_session where id = $1::uuid and membership_id = $2::uuid for update',
      [sessionId, membershipId],
    );
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (row.revoked) return { revokedSessionIds: [], revokedDeviceId: null, alreadyRevoked: true, idpSessionIds: [] };
    if (row.device_registration_id !== null) {
      const closed = await this.closeDevice(tx, membershipId, row.device_registration_id, reason);
      return { revokedSessionIds: closed.sessions.map((entry) => entry.id), revokedDeviceId: closed.deviceRevoked ? row.device_registration_id : null, alreadyRevoked: false, idpSessionIds: closed.sessions.map((entry) => entry.idp) };
    }
    await tx.query('update machvon.user_session set revoked_at = now(), revoke_reason = $2 where id = $1::uuid and revoked_at is null', [row.id, reason]);
    return { revokedSessionIds: [row.id], revokedDeviceId: null, alreadyRevoked: false, idpSessionIds: [row.idp_session_id] };
  }

  /** Removes a device of the caller: the row is revoked and the reference of its push token is taken away; every live session opened on it is signed out (the request's own, if it was opened on it). Asking again closes any that is still live. */
  async revokeDevice(tx: TenantTx, membershipId: string, deviceId: string, reason: string): Promise<DeviceRevocation> {
    const [device] = await tx.query<{ id: string }>('select id from machvon.device_registration where id = $1::uuid and membership_id = $2::uuid for update', [deviceId, membershipId]);
    if (device === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const closed = await this.closeDevice(tx, membershipId, device.id, reason);
    return { revokedSessionIds: closed.sessions.map((entry) => entry.id), alreadyRevoked: !closed.deviceRevoked && closed.sessions.length === 0, idpSessionIds: closed.sessions.map((entry) => entry.idp) };
  }

  /** The device (locked by the caller) is revoked if it is live, and every live session opened on it is signed out, whether or not the device was live. */
  private async closeDevice(tx: TenantTx, membershipId: string, deviceId: string, reason: string): Promise<{ deviceRevoked: boolean; sessions: Array<{ id: string; idp: string }> }> {
    const removed = await tx.query<{ id: string }>('update machvon.device_registration set revoked_at = now(), push_secret_ref = null, revoke_reason = $2 where id = $1::uuid and revoked_at is null returning id', [deviceId, reason]);
    const closed = await tx.query<{ id: string; idp_session_id: string }>(
      'update machvon.user_session set revoked_at = now(), revoke_reason = $2 where device_registration_id = $1::uuid and membership_id = $3::uuid and revoked_at is null returning id, idp_session_id',
      [deviceId, reason, membershipId],
    );
    return { deviceRevoked: removed.length > 0, sessions: closed.map((row) => ({ id: row.id, idp: row.idp_session_id })) };
  }
}
