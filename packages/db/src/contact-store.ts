import { DomainError, assertMergeable } from '@machvon/kernel';
import type { ContactClassification, ContactDraft, IdentityChannel, MergeIdentity, MergeRequest, VerificationMethod } from '@machvon/kernel';
import { assertTimestampCursor } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';

const TIME = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const UNIQUE_VIOLATION = '23505';

export type ContactStatus = 'Unverified' | 'Verified' | 'Merged' | 'Blocked';
export type IdentityStatus = 'Pending' | 'Verified' | 'Revoked';

/** An identity as it may be shown: the masked copy, never the value or the hash or the code. */
export interface IdentityRecord {
  id: string;
  /** The contact that holds it (a contact that was merged keeps its identities, and the contact it was merged into shows them). */
  contactId: string;
  channel: IdentityChannel;
  masked: string;
  status: IdentityStatus;
  verificationMethod: VerificationMethod | null;
  verifiedAt: string | null;
  createdAt: string;
  version: number;
}

export interface ContactRecord {
  id: string;
  displayName: string;
  classification: ContactClassification;
  status: ContactStatus;
  preferredChannel: IdentityChannel | null;
  mergedIntoId: string | null;
  identities: IdentityRecord[];
  /** The live contacts that share a Verified identity with this one, and the identity of this contact that names the share. */
  mergeCandidates: Array<{ contactId: string; displayName: string; identityId: string }>;
  createdAt: string;
  version: number;
  sortKey: string;
}

interface ContactRow {
  id: string;
  display_name: string;
  classification: ContactClassification;
  status: ContactStatus;
  preferred_channel: IdentityChannel | null;
  merged_into_id: string | null;
  created_at: string;
  version: string;
  sort_key: string;
}

interface IdentityRow {
  id: string;
  contact_id: string;
  channel: IdentityChannel;
  external_id_masked: string;
  status: IdentityStatus;
  verification_method: VerificationMethod | null;
  verified_at: string | null;
  created_at: string;
  version: string;
}

const CONTACT_COLUMNS = `c.id, c.display_name, c.classification, c.status, c.preferred_channel, c.merged_into_id, ${TIME('c.created_at')} as created_at, c.version::text as version,
  ${TIME('c.created_at')} as sort_key`;
const IDENTITY_COLUMNS = `i.id, i.contact_id, i.channel, i.external_id_masked, i.status, i.verification_method, ${TIME('i.verified_at')} as verified_at, ${TIME('i.created_at')} as created_at, i.version::text as version`;

const toIdentity = (row: IdentityRow): IdentityRecord => ({
  id: row.id,
  contactId: row.contact_id,
  channel: row.channel,
  masked: row.external_id_masked,
  status: row.status,
  verificationMethod: row.verification_method,
  verifiedAt: row.verified_at,
  createdAt: row.created_at,
  version: Number(row.version),
});

const toContact = (row: ContactRow, identities: IdentityRecord[], mergeCandidates: ContactRecord['mergeCandidates'] = []): ContactRecord => ({
  id: row.id,
  displayName: row.display_name,
  classification: row.classification,
  status: row.status,
  preferredChannel: row.preferred_channel,
  mergedIntoId: row.merged_into_id,
  identities,
  mergeCandidates,
  createdAt: row.created_at,
  version: Number(row.version),
  sortKey: row.sort_key,
});

export interface NewIdentity {
  channel: IdentityChannel;
  hash: string;
  masked: string;
}

/** What adding an identity did: it is new (a code may be sent), it is the contact's own Pending one (a code may be sent again), or the contact has it already. */
export type AddIdentityOutcome = { kind: 'ADDED' | 'PENDING_AGAIN'; identity: IdentityRecord } | { kind: 'UNCHANGED'; identity: IdentityRecord };

export interface OtpHeld {
  hash: string | null;
  expiresAt: Date | null;
  failures: number;
  lockedUntil: Date | null;
}

export interface MergeOutcome {
  survivor: ContactRecord;
  merged: ContactRecord;
  movedConversations: number;
}

/**
 * The contact directory (ST-OMNI-002, OMNI.md 3.5, BR-OMNI-05). A contact keeps the identities it was added with, even when it is merged into another one: the contact that survives shows them, and a lookup by identity follows the merge to the
 * contact that is alive. Every query runs in the caller's tenant transaction.
 */
export class ContactStore {
  async create(tx: TenantTx, draft: ContactDraft): Promise<ContactRecord> {
    const [made] = await tx.query<{ id: string }>(
      `insert into machvon.contact (tenant_id, id, display_name, verified_identities, classification, status, preferred_channel)
       values (${TENANT}, gen_random_uuid(), $1, '[]'::jsonb, $2, 'Unverified', $3) returning id`,
      [draft.displayName, draft.classification, draft.preferredChannel ?? null],
    );
    return await this.require(tx, (made as { id: string }).id);
  }

  async find(tx: TenantTx, id: string): Promise<ContactRecord | undefined> {
    const [row] = await tx.query<ContactRow>(`select ${CONTACT_COLUMNS} from machvon.contact c where c.id = $1::uuid`, [id]);
    if (row === undefined) return undefined;
    return toContact(row, (await this.identitiesOf(tx, [row.id])).get(row.id) ?? [], (await this.candidatesOf(tx, [row.id])).get(row.id) ?? []);
  }

  async require(tx: TenantTx, id: string): Promise<ContactRecord> {
    const found = await this.find(tx, id);
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return found;
  }

  async list(tx: TenantTx, page: { limit: number; after: { code: string; id: string } | undefined }): Promise<ContactRecord[]> {
    assertTimestampCursor(page.after?.code);
    const rows = await tx.query<ContactRow>(
      `select ${CONTACT_COLUMNS} from machvon.contact c
        where ($1::timestamptz is null or (c.created_at, c.id) < ($1::timestamptz, $2::uuid))
        order by c.created_at desc, c.id desc limit $3::int`,
      [page.after?.code ?? null, page.after?.id ?? null, page.limit],
    );
    const ids = rows.map((row) => row.id);
    const identities = await this.identitiesOf(tx, ids);
    const candidates = await this.candidatesOf(tx, ids);
    return rows.map((row) => toContact(row, identities.get(row.id) ?? [], candidates.get(row.id) ?? []));
  }

  /**
   * For each live contact, the other live contacts that hold a Verified identity with the same hash as one of its own Verified identities (on the phone of one and the WhatsApp of the other): the contacts it can be merged with.
   * A contact that was merged or is blocked has none, and is none for another.
   */
  private async candidatesOf(tx: TenantTx, contactIds: readonly string[]): Promise<Map<string, ContactRecord['mergeCandidates']>> {
    const result = new Map<string, ContactRecord['mergeCandidates']>();
    if (contactIds.length === 0) return result;
    // An identity belongs to the contact that is alive: its own, or the one its contact was merged into.
    const rows = await tx.query<{ owner_id: string; contact_id: string; display_name: string; identity_id: string }>(
      `with verified as (
          select i.id, i.external_id_hash, i.created_at, coalesce(c.merged_into_id, c.id) as owner_id
            from machvon.contact_identity i join machvon.contact c on c.tenant_id = i.tenant_id and c.id = i.contact_id
           where i.status = 'Verified')
       select distinct on (a.owner_id, b.owner_id) a.owner_id, b.owner_id as contact_id, o.display_name, a.id as identity_id
         from verified a
         join verified b on b.external_id_hash = a.external_id_hash and b.owner_id <> a.owner_id
         join machvon.contact owner on owner.id = a.owner_id and owner.status in ('Unverified', 'Verified')
         join machvon.contact o on o.id = b.owner_id and o.status in ('Unverified', 'Verified')
        where a.owner_id = any($1::uuid[])
        order by a.owner_id, b.owner_id, a.created_at, a.id`,
      [contactIds],
    );
    for (const row of rows) {
      const own = result.get(row.owner_id) ?? [];
      own.push({ contactId: row.contact_id, displayName: row.display_name, identityId: row.identity_id });
      result.set(row.owner_id, own);
    }
    return result;
  }

  /** The identities of each contact: its own, and, for a contact that is alive, those of the contacts that were merged into it. Newest last. */
  private async identitiesOf(tx: TenantTx, contactIds: readonly string[]): Promise<Map<string, IdentityRecord[]>> {
    const result = new Map<string, IdentityRecord[]>();
    if (contactIds.length === 0) return result;
    const rows = await tx.query<IdentityRow & { owner_id: string }>(
      `select ${IDENTITY_COLUMNS}, o.owner_id
         from machvon.contact_identity i
         join (select c.id as owner_id, c.id as source_id from machvon.contact c where c.id = any($1::uuid[])
               union all
               select m.merged_into_id, m.id from machvon.contact m where m.merged_into_id = any($1::uuid[])) o on o.source_id = i.contact_id
        order by i.created_at, i.id`,
      [contactIds],
    );
    for (const row of rows) {
      const own = result.get(row.owner_id) ?? [];
      own.push(toIdentity(row));
      result.set(row.owner_id, own);
    }
    return result;
  }

  /** Takes the contact row for the rest of the transaction. */
  async lock(tx: TenantTx, id: string): Promise<ContactRecord> {
    await tx.query('select 1 from machvon.contact where id = $1::uuid for update', [id]);
    return await this.require(tx, id);
  }

  /**
   * Adds an identity to a contact as Pending. An identity another contact holds (also one that was merged into this contact: that is this contact's own) is 409 IDENTITY_TAKEN; one the contact holds already is returned as it
   * is, a Pending one so that a new code may be sent for it.
   */
  async addIdentity(tx: TenantTx, contactId: string, input: NewIdentity): Promise<AddIdentityOutcome> {
    const contact = await this.lock(tx, contactId);
    if (contact.status === 'Merged' || contact.status === 'Blocked') throw new DomainError('CONTACT_STATE_INVALID', 409, 'status');
    const held = await this.holderOf(tx, input);
    if (held !== undefined) {
      if (held.holderId !== contactId && held.mergedIntoId !== contactId) throw new DomainError('IDENTITY_TAKEN', 409, 'external_id');
      const identity = await this.requireIdentity(tx, held.id);
      return identity.status === 'Pending' ? { kind: 'PENDING_AGAIN', identity } : { kind: 'UNCHANGED', identity };
    }
    try {
      await tx.query('savepoint contact_identity_add');
      const [made] = await tx.query<{ id: string }>(
        `insert into machvon.contact_identity (tenant_id, id, contact_id, channel, external_id_hash, external_id_masked, status)
         values (${TENANT}, gen_random_uuid(), $1::uuid, $2, $3, $4, 'Pending') returning id`,
        [contactId, input.channel, input.hash, input.masked],
      );
      await tx.query('release savepoint contact_identity_add');
      return { kind: 'ADDED', identity: await this.requireIdentity(tx, (made as { id: string }).id) };
    } catch (error) {
      // Two agents adding the same number at once: the second finds it taken.
      if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
      await tx.query('rollback to savepoint contact_identity_add');
      throw new DomainError('IDENTITY_TAKEN', 409, 'external_id');
    }
  }

  private async holderOf(tx: TenantTx, input: NewIdentity): Promise<{ id: string; holderId: string; mergedIntoId: string | null } | undefined> {
    const [row] = await tx.query<{ id: string; holder_id: string; merged_into_id: string | null }>(
      `select i.id, i.contact_id as holder_id, c.merged_into_id from machvon.contact_identity i join machvon.contact c on c.tenant_id = i.tenant_id and c.id = i.contact_id
        where i.channel = $1 and i.external_id_hash = $2`,
      [input.channel, input.hash],
    );
    return row === undefined ? undefined : { id: row.id, holderId: row.holder_id, mergedIntoId: row.merged_into_id };
  }

  /**
   * The contact that is alive and holds an identity (the one it was merged into when the holder was merged), or nothing when no contact has it. A message that comes in from an identity is the message of this contact.
   */
  async ownerOfIdentity(tx: TenantTx, channel: IdentityChannel, hash: string): Promise<{ contactId: string; status: ContactStatus; identityId: string; identityStatus: IdentityStatus } | undefined> {
    const [row] = await tx.query<{ contact_id: string; status: ContactStatus; identity_id: string; identity_status: IdentityStatus }>(
      `select o.id as contact_id, o.status, i.id as identity_id, i.status as identity_status
         from machvon.contact_identity i
         join machvon.contact h on h.tenant_id = i.tenant_id and h.id = i.contact_id
         join machvon.contact o on o.tenant_id = h.tenant_id and o.id = coalesce(h.merged_into_id, h.id)
        where i.channel = $1 and i.external_id_hash = $2`,
      [channel, hash],
    );
    return row === undefined ? undefined : { contactId: row.contact_id, status: row.status, identityId: row.identity_id, identityStatus: row.identity_status };
  }

  async requireIdentity(tx: TenantTx, id: string): Promise<IdentityRecord> {
    const [row] = await tx.query<IdentityRow>(`select ${IDENTITY_COLUMNS} from machvon.contact_identity i where i.id = $1::uuid`, [id]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return toIdentity(row);
  }

  /** Keeps the hash of the code sent for an identity and when it runs out; a new code clears the wrong codes counted for the old one but not a lock. */
  async setOtp(tx: TenantTx, identityId: string, hash: string, expiresAt: Date): Promise<void> {
    await tx.query('update machvon.contact_identity set otp_hash = $2, otp_expires_at = $3::timestamptz, version = version + 1 where id = $1::uuid', [identityId, hash, expiresAt.toISOString()]);
  }

  /** The state of the code of an identity, with the identity locked for the rest of the transaction. The identity is the contact's own or one of a contact that was merged into it (it is verified through the contact that is alive). */
  async lockOtp(tx: TenantTx, contactId: string, identityId: string): Promise<{ identity: IdentityRecord; otp: OtpHeld }> {
    const [row] = await tx.query<IdentityRow & { otp_hash: string | null; otp_expires_at: Date | null; otp_failed_count: number; otp_locked_until: Date | null }>(
      `select ${IDENTITY_COLUMNS}, i.otp_hash, i.otp_expires_at, i.otp_failed_count, i.otp_locked_until from machvon.contact_identity i join machvon.contact c on c.tenant_id = i.tenant_id and c.id = i.contact_id where i.id = $1::uuid and coalesce(c.merged_into_id, c.id) = $2::uuid for update of i`,
      [identityId, contactId],
    );
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { identity: toIdentity(row), otp: { hash: row.otp_hash, expiresAt: row.otp_expires_at, failures: row.otp_failed_count, lockedUntil: row.otp_locked_until } };
  }

  /** Counts a wrong code. A lock that has run out is cleared by it, so the count that starts again can lock the identity again. */
  async recordOtpFailure(tx: TenantTx, identityId: string, failures: number, lockedUntil: Date | undefined, now: Date): Promise<void> {
    await tx.query(
      `update machvon.contact_identity set otp_failed_count = $2,
          otp_locked_until = coalesce($3::timestamptz, case when otp_locked_until > $4::timestamptz then otp_locked_until end), version = version + 1
        where id = $1::uuid`,
      [identityId, failures, lockedUntil?.toISOString() ?? null, now.toISOString()],
    );
  }

  /** Marks an identity Verified with the method and the person; the code is spent. The contact becomes Verified when it was Unverified. */
  async markVerified(tx: TenantTx, contactId: string, identityId: string, input: { method: VerificationMethod; by: string; at: Date; ref: string | undefined }): Promise<IdentityRecord> {
    await tx.query(
      `update machvon.contact_identity set status = 'Verified', verification_method = $2, verified_at = $3::timestamptz, verified_by = $4::uuid, verification_ref = $5,
          otp_hash = null, otp_expires_at = null, otp_failed_count = 0, otp_locked_until = null, version = version + 1
        where id = $1::uuid`,
      [identityId, input.method, input.at.toISOString(), input.by, input.ref ?? null],
    );
    await tx.query("update machvon.contact set status = 'Verified', version = version + 1 where id = $1::uuid and status = 'Unverified'", [contactId]);
    await this.refreshSummary(tx, contactId);
    return await this.requireIdentity(tx, identityId);
  }

  /** The summary kept on the contact row: the masked verified identities, own and merged in. */
  private async refreshSummary(tx: TenantTx, contactId: string): Promise<void> {
    await tx.query(
      `update machvon.contact c set verified_identities = coalesce((
          select jsonb_agg(jsonb_build_object('identity_id', i.id, 'channel', i.channel, 'masked', i.external_id_masked) order by i.created_at, i.id)
            from machvon.contact_identity i
           where i.status = 'Verified' and (i.contact_id = c.id or i.contact_id in (select m.id from machvon.contact m where m.merged_into_id = c.id))), '[]'::jsonb)
        where c.id = $1::uuid`,
      [contactId],
    );
  }

  /**
   * Merges one contact into another on a verified identity they share (BR-OMNI-05). Both are locked in the order of their ids; the rule is the kernel's. The contact that is merged becomes Merged and points to the survivor, its
   * conversations go to the survivor, and what was granted to it (the consents) stays with it and is found through the merge. Returns both as they are now and how many conversations moved.
   */
  async merge(tx: TenantTx, request: MergeRequest): Promise<MergeOutcome> {
    const ordered = [request.survivorId, request.mergedId].sort();
    for (const id of ordered) await tx.query('select 1 from machvon.contact where id = $1::uuid for update', [id]);
    const survivor = await this.require(tx, request.survivorId);
    const merged = await this.require(tx, request.mergedId);
    // The identities of each of the two are those it holds and those of the contacts that were merged into it.
    const identities = await tx.query<{ id: string; owner_id: string; channel: string; external_id_hash: string; status: string }>(
      `select i.id, coalesce(c.merged_into_id, c.id) as owner_id, i.channel, i.external_id_hash, i.status
         from machvon.contact_identity i join machvon.contact c on c.tenant_id = i.tenant_id and c.id = i.contact_id
        where coalesce(c.merged_into_id, c.id) = any($1::uuid[])`,
      [[survivor.id, merged.id]],
    );
    const all: MergeIdentity[] = identities.map((row) => ({ id: row.id, contactId: row.owner_id, channel: row.channel, hash: row.external_id_hash, status: row.status }));
    assertMergeable({ survivor: { id: survivor.id, status: survivor.status }, merged: { id: merged.id, status: merged.status }, named: all.find((identity) => identity.id === request.identityId), identities: all });
    await tx.query("update machvon.contact set status = 'Merged', merged_into_id = $2::uuid, version = version + 1 where id = $1::uuid", [merged.id, survivor.id]);
    // The chain of merges is one step long: what had been merged into the contact that goes away now points to the survivor, so a lookup, the identities and the summary need follow one hop only.
    await tx.query('update machvon.contact set merged_into_id = $2::uuid, version = version + 1 where merged_into_id = $1::uuid', [merged.id, survivor.id]);
    const moved = await tx.query<{ id: string }>(
      `update machvon.conversation set contact_id = case when contact_id = $1::uuid then $2::uuid else contact_id end,
          verified_contact_id = case when verified_contact_id = $1::uuid then $2::uuid else verified_contact_id end, version = version + 1
        where contact_id = $1::uuid or verified_contact_id = $1::uuid returning id`,
      [merged.id, survivor.id],
    );
    // The survivor is changed by every merge (what it shows, and its state when it was not yet Verified): its version moves, and the event carries it.
    await tx.query("update machvon.contact set status = case when status = 'Unverified' then 'Verified' else status end, version = version + 1 where id = $1::uuid", [survivor.id]);
    await this.refreshSummary(tx, survivor.id);
    return { survivor: await this.require(tx, survivor.id), merged: await this.require(tx, merged.id), movedConversations: moved.length };
  }
}
