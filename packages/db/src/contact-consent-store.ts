import { DomainError, versionConflict } from '@machvon/kernel';
import type { ConsentChannel, ConsentPurpose, ConsentState } from '@machvon/kernel';
import { assertTimestampCursor, timestampKey } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';

const UNIQUE_VIOLATION = '23505';
const MAX_TEXT_VERSION = 50;
const MAX_EVIDENCE = 500;
const MIN_REASON = 10;
const MAX_REASON = 2000;

export type ConsentStatus = 'Granted' | 'Withdrawn' | 'Expired';
export type CaptureMethod = 'IN_APP' | 'WEB_FORM' | 'CHANNEL_OPT_IN' | 'PAPER_SCANNED';

/** One consent of the history (NOT-17): the facts of the grant and, once it ended, the moment and the reason. */
export interface ConsentRow {
  id: string;
  /** `MEMBERSHIP` for a member of the tenant, `CONTACT` for an outside contact (OMNI shares the table). */
  subjectKind: 'MEMBERSHIP' | 'CONTACT';
  subjectId: string;
  channel: string;
  purpose: string;
  status: ConsentStatus;
  effectiveAt: string;
  revokedAt: string | null;
  consentTextVersion: string;
  captureMethod: CaptureMethod;
  legalBasis: string;
  version: number;
  /** Microsecond text of `effective_at`: the ordering key of the history and its cursor. */
  effectiveKey: string;
}

export interface ConsentGrantInput {
  channel: ConsentChannel;
  purpose: ConsentPurpose;
  consentTextVersion: string;
  captureMethod: CaptureMethod;
  /** Where the proof of the consent is kept (a form, a scan); without one the grant itself, in the application, is the proof. */
  evidenceReference?: string | undefined;
}

export interface ConsentPage {
  limit: number;
  after: { code: string; id: string } | undefined;
}

interface Sql {
  id: string;
  membership_id: string | null;
  contact_id: string | null;
  channel: string;
  purpose: string;
  status: ConsentStatus;
  effective_at: string;
  revoked_at: string | null;
  consent_text_version: string;
  capture_method: CaptureMethod;
  legal_basis: string;
  version: string;
  effective_key: string;
}

const ISO = (column: string): string => `to_char((${column}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const COLUMNS = `id, membership_id, contact_id, channel, purpose, status, ${ISO('effective_at')} as effective_at, ${ISO('revoked_at')} as revoked_at, consent_text_version,
  capture_method, legal_basis, version::text as version, ${timestampKey('effective_at')} as effective_key`;

const toRow = (row: Sql): ConsentRow => ({
  id: row.id,
  subjectKind: row.membership_id === null ? 'CONTACT' : 'MEMBERSHIP',
  subjectId: row.membership_id ?? row.contact_id ?? '',
  channel: row.channel,
  purpose: row.purpose,
  status: row.status,
  effectiveAt: row.effective_at,
  revokedAt: row.revoked_at,
  consentTextVersion: row.consent_text_version,
  captureMethod: row.capture_method,
  legalBasis: row.legal_basis,
  version: Number(row.version),
  effectiveKey: row.effective_key,
});

const AFTER = '($1::text is null or (effective_at, id) < ($1::timestamptz, $2::uuid))';

/**
 * The consent of people to be written to on a channel for a purpose (NOT 3.3, BR-NOT-07). The history is append-only: a grant is a new row, a
 * withdrawal ends the row that was granted (the database allows no other change), and the latest consent decides. Every method runs in the
 * caller's tenant transaction.
 */
export class ContactConsentStore {
  /**
   * The person grants consent. The channel must have an identity to write to (a phone for a phone channel, a registered device for a push): without
   * one the grant is 422 CHANNEL_IDENTITY_UNVERIFIED. A person has at most one live consent per channel and purpose; a second grant is 409
   * CONSENT_ALREADY_GRANTED, also when two requests race (the unique index decides, under a savepoint).
   */
  async grant(tx: TenantTx, membershipId: string, input: ConsentGrantInput): Promise<ConsentRow> {
    if (input.consentTextVersion === '' || input.consentTextVersion.length > MAX_TEXT_VERSION) throw new DomainError('VALIDATION_FAILED', 422, 'consent_text_version');
    if (input.evidenceReference !== undefined && (input.evidenceReference === '' || input.evidenceReference.length > MAX_EVIDENCE)) throw new DomainError('VALIDATION_FAILED', 422, 'evidence_reference');
    if (!(await this.hasIdentity(tx, membershipId, input.channel))) throw new DomainError('CHANNEL_IDENTITY_UNVERIFIED', 422, 'channel');
    await tx.query('savepoint contact_consent_grant');
    try {
      const [row] = await tx.query<Sql>(
        `insert into machvon.contact_consent
           (tenant_id, id, contact_id, membership_id, channel, purpose, status, evidence_reference, effective_at, legal_basis, consent_text_version, capture_method)
         select nullif(current_setting('app.tenant_id', true), '')::uuid, c.id, null, $1::uuid, $2, $3, 'Granted', coalesce($4, lower($5) || ':' || c.id::text), clock_timestamp(), 'CONSENT', $6, $5
           from (select gen_random_uuid() as id) c
         returning ${COLUMNS}`,
        [membershipId, input.channel, input.purpose, input.evidenceReference ?? null, input.captureMethod, input.consentTextVersion],
      );
      await tx.query('release savepoint contact_consent_grant');
      if (row === undefined) throw new Error('consent not inserted');
      return toRow(row);
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        await tx.query('rollback to savepoint contact_consent_grant');
        throw new DomainError('CONSENT_ALREADY_GRANTED', 409);
      }
      throw error;
    }
  }

  /**
   * The person withdraws a consent of their own; it takes effect at once for every send that has not been taken up. The consent of another person is
   * a missing one (404); one that already ended is 409 CONSENT_STATE_INVALID; a stale version is 409 VERSION_CONFLICT.
   */
  async withdraw(tx: TenantTx, membershipId: string, consentId: string, expectedVersion: number, reason: string): Promise<ConsentRow> {
    if (reason.length < MIN_REASON || reason.length > MAX_REASON) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
    const [current] = await tx.query<Sql>(`select ${COLUMNS} from machvon.contact_consent where id = $1::uuid and membership_id = $2::uuid for update`, [consentId, membershipId]);
    if (current === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (current.status !== 'Granted') throw new DomainError('CONSENT_STATE_INVALID', 409);
    if (Number(current.version) !== expectedVersion) throw versionConflict(Number(current.version));
    const [row] = await tx.query<Sql>(
      `update machvon.contact_consent set status = 'Withdrawn', revoked_at = clock_timestamp(), withdrawn_reason = $2, version = version + 1
        where id = $1::uuid returning ${COLUMNS}`,
      [consentId, reason],
    );
    if (row === undefined) throw new Error('consent not withdrawn');
    return toRow(row);
  }

  /** The history of a person, newest first: every consent they gave and every one they withdrew (NOT-17). */
  async historyOf(tx: TenantTx, membershipId: string, page: ConsentPage): Promise<ConsentRow[]> {
    assertTimestampCursor(page.after?.code);
    const rows = await tx.query<Sql>(
      `select ${COLUMNS} from machvon.contact_consent where ${AFTER} and membership_id = $3::uuid order by effective_at desc, id desc limit $4`,
      [page.after?.code ?? null, page.after?.id ?? null, membershipId, page.limit],
    );
    return rows.map(toRow);
  }

  /** The consent that decides now for a person, a channel and a purpose: the latest one in the history, whatever became of it. */
  async latest(tx: TenantTx, membershipId: string, channel: string, purpose: string): Promise<ConsentState | undefined> {
    const [row] = await tx.query<{ status: ConsentStatus }>(
      `select status from machvon.contact_consent
        where membership_id = $1::uuid and channel = $2 and purpose = $3
        order by greatest(effective_at, coalesce(revoked_at, effective_at)) desc, effective_at desc, id desc limit 1`,
      [membershipId, channel, purpose],
    );
    return row;
  }

  /** The consents of the tenant for the operator (the contact_consent reads), newest first. */
  async list(tx: TenantTx, page: ConsentPage): Promise<ConsentRow[]> {
    assertTimestampCursor(page.after?.code);
    const rows = await tx.query<Sql>(`select ${COLUMNS} from machvon.contact_consent where ${AFTER} order by effective_at desc, id desc limit $3`, [page.after?.code ?? null, page.after?.id ?? null, page.limit]);
    return rows.map(toRow);
  }

  async find(tx: TenantTx, id: string): Promise<ConsentRow | undefined> {
    const [row] = await tx.query<Sql>(`select ${COLUMNS} from machvon.contact_consent where id = $1::uuid`, [id]);
    return row === undefined ? undefined : toRow(row);
  }

  /** Whether the channel has an address to write to for the person. */
  private async hasIdentity(tx: TenantTx, membershipId: string, channel: ConsentChannel): Promise<boolean> {
    if (channel === 'PUSH') {
      const [device] = await tx.query<{ ok: boolean }>('select true as ok from machvon.device_registration where membership_id = $1::uuid and revoked_at is null limit 1', [membershipId]);
      return device !== undefined;
    }
    // The directory masks an address but still shows that there is one; the grant never reads the address itself.
    const [person] = await tx.query<{ email: string | null; phone: string | null }>('select email, phone from machvon.tenant_user_directory where membership_id = $1::uuid', [membershipId]);
    if (person === undefined) return false;
    return channel === 'EMAIL' ? person.email !== null : person.phone !== null;
  }
}
