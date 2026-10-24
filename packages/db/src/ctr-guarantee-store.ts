import { randomUUID } from 'node:crypto';
import { DomainError, assertFourEyes, compareDecimal, vietnamDateOf, versionConflict } from '@machvon/kernel';
import { SCOPE_FROM, TIMESTAMP, calendarDate, textOf, wholeAmount } from './ctr-contract-store.ts';
import type { ContractPlace, ContractScopes } from './ctr-contract-store.ts';
import { CtrContractSource } from './ctr-contract-source.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export const GUARANTEE_KINDS = ['PERFORMANCE', 'ADVANCE', 'WARRANTY', 'INSURANCE'] as const;
export type GuaranteeKind = (typeof GUARANTEE_KINDS)[number];
export const GUARANTEE_STATUSES = ['PENDING_VERIFICATION', 'ACTIVE', 'EXPIRED', 'RELEASED', 'CALLED', 'SUPERSEDED', 'REJECTED'] as const;
export type GuaranteeStatus = (typeof GUARANTEE_STATUSES)[number];
export type GuaranteeVerificationStatus = 'UNVERIFIED' | 'VERIFIED' | 'FAILED';

/** The days before the expiry at which the holders of a contract are told (CTR 3.5): the smallest threshold that the days left have reached. */
export const ALERT_THRESHOLDS = [0, 7, 15, 30] as const;
export type AlertThreshold = (typeof ALERT_THRESHOLDS)[number];

const UNIQUE_VIOLATION = '23505';
const NUMBER_CONSTRAINT = 'guarantee_issuer_no_uq';
const SUCCESSOR_CONSTRAINT = 'guarantee_live_successor_uq';
const MAX_ISSUER = 300;
const MAX_NUMBER = 100;
const MAX_TEXT = 2000;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
/** The states of a contract in which a guarantee can still be registered: a contract that ended, or never began, takes no new security. */
const CLOSED_CONTRACT_STATES: readonly string[] = ['TERMINATED', 'CLOSED', 'CANCELLED'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VIETNAM_DATE = `(g.expires_at at time zone 'Asia/Ho_Chi_Minh')::date`;

/** One guarantee as the register shows it, with the contract and the places its scope is judged by. */
export interface GuaranteeRow {
  id: string;
  contractId: string;
  contractCode: string;
  contractStatus: string;
  kind: GuaranteeKind;
  issuer: string;
  guaranteeNo: string | null;
  partyId: string | null;
  partyContractorId: string | null;
  partyName: string | null;
  /** An exact decimal string in VND. */
  amountVnd: string;
  validFrom: string | null;
  /** The instant of the expiry (UTC) and the calendar day it falls on in Vietnam, which is the day the alerts and the expiry count by. */
  expiresAt: string;
  expiresOn: string;
  status: GuaranteeStatus;
  verificationStatus: GuaranteeVerificationStatus;
  verifiedAt: string | null;
  verificationMethod: string | null;
  verificationEvidenceId: string | null;
  documentVersionId: string | null;
  releaseEvidenceId: string | null;
  releasedAt: string | null;
  releaseReason: string | null;
  extendedFromId: string | null;
  lastAlertDays: AlertThreshold | null;
  registeredBy: string | null;
  verifiedBy: string | null;
  releasedBy: string | null;
  createdAt: string;
  version: number;
  /** What the contract still owes of its advance; read by the screens that may see the ledger, never copied into a guarantee. */
  advanceOutstandingVnd: string;
  reach: ContractPlace;
  /** The ordering key of the list and its cursor. */
  key: string;
}

export interface ExpiringRow extends GuaranteeRow {
  daysLeft: number;
}

export interface NewGuarantee {
  kind: string;
  partyId?: string | undefined;
  issuer: string;
  guaranteeNo: string;
  amountVnd: string;
  validFrom: string;
  expiresAt: string;
  documentVersionId: string;
}

export interface GuaranteeVerification {
  outcome: string;
  method: string;
  evidenceDocumentVersionId: string;
}

export interface GuaranteeExtension {
  newExpiresAt: string;
  newGuaranteeNo: string;
  documentVersionId: string;
}

export interface GuaranteeRelease {
  releaseEvidenceId: string;
  reason: string;
}

/** What a command on a guarantee changed: the guarantee it answers for, with the figures its audit row and its event carry. */
export interface GuaranteeMove {
  id: string;
  contractId: string;
  kind: GuaranteeKind;
  amountVnd: string;
  expiresAt: string;
  status: GuaranteeStatus;
  version: number;
  fromStatus: GuaranteeStatus | null;
  /** The guarantee that an extension replaced. */
  supersededId: string | null;
  reach: ContractPlace;
}

interface RowSql {
  id: string;
  contract_id: string;
  contract_code: string;
  contract_status: string;
  kind: GuaranteeKind;
  issuer: string;
  guarantee_no: string | null;
  party_id: string | null;
  party_contractor_id: string | null;
  party_name: string | null;
  amount_vnd: string;
  valid_from: string | null;
  expires_at: string;
  expires_on: string;
  status: GuaranteeStatus;
  verification_status: GuaranteeVerificationStatus;
  verified_at: string | null;
  verification_method: string | null;
  verification_evidence_id: string | null;
  document_version_id: string | null;
  release_evidence_id: string | null;
  released_at: string | null;
  release_reason: string | null;
  extended_from_id: string | null;
  last_alert_days: AlertThreshold | null;
  registered_by: string | null;
  verified_by: string | null;
  released_by: string | null;
  created_at: string;
  version: string;
  advance_outstanding_vnd: string;
  days_left: number;
  project_id: string;
  owner_unit_id: string;
  owner_unit_path: string;
  investor_unit_id: string | null;
  investor_unit_path: string | null;
  key: string;
}

const ROW_KEY = `(c.code || '#' || to_char(g.expires_at at time zone 'UTC', 'YYYYMMDDHH24MISS') || '#' || g.kind)`;
const EXPIRY_KEY = `to_char(g.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
const FROM = `from machvon.guarantee g join ${SCOPE_FROM} on c.tenant_id = g.tenant_id and c.id = g.contract_id`;
const COLUMNS = `g.id, g.contract_id, c.code as contract_code, c.status as contract_status, g.kind, g.issuer, g.guarantee_no, g.party_id,
  (select m.contractor_id from machvon.contract_party m where m.tenant_id = g.tenant_id and m.id = g.party_id) as party_contractor_id,
  (select k.legal_name from machvon.contract_party m join machvon.contractor k on k.tenant_id = m.tenant_id and k.id = m.contractor_id where m.tenant_id = g.tenant_id and m.id = g.party_id) as party_name,
  g.amount_vnd::text as amount_vnd, g.valid_from::text as valid_from, ${TIMESTAMP('g.expires_at')} as expires_at, ${VIETNAM_DATE}::text as expires_on, g.status, g.verification_status,
  ${TIMESTAMP('g.verified_at')} as verified_at, g.verification_method, g.verification_evidence_id, g.document_version_id, g.release_evidence_id, ${TIMESTAMP('g.released_at')} as released_at,
  g.release_reason, g.extended_from_id, g.last_alert_days, g.created_by as registered_by, g.verified_by, g.released_by, ${TIMESTAMP('g.created_at')} as created_at, g.version::text as version,
  c.advance_outstanding_vnd::text as advance_outstanding_vnd, p.id as project_id, ou.id as owner_unit_id, ou.path as owner_unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path`;

const toRow = (row: RowSql): GuaranteeRow => ({
  id: row.id,
  contractId: row.contract_id,
  contractCode: row.contract_code,
  contractStatus: row.contract_status,
  kind: row.kind,
  issuer: row.issuer,
  guaranteeNo: row.guarantee_no,
  partyId: row.party_id,
  partyContractorId: row.party_contractor_id,
  partyName: row.party_name,
  amountVnd: row.amount_vnd,
  validFrom: row.valid_from,
  expiresAt: row.expires_at,
  expiresOn: row.expires_on,
  status: row.status,
  verificationStatus: row.verification_status,
  verifiedAt: row.verified_at,
  verificationMethod: row.verification_method,
  verificationEvidenceId: row.verification_evidence_id,
  documentVersionId: row.document_version_id,
  releaseEvidenceId: row.release_evidence_id,
  releasedAt: row.released_at,
  releaseReason: row.release_reason,
  extendedFromId: row.extended_from_id,
  lastAlertDays: row.last_alert_days,
  registeredBy: row.registered_by,
  verifiedBy: row.verified_by,
  releasedBy: row.released_by,
  createdAt: row.created_at,
  version: Number(row.version),
  advanceOutstandingVnd: row.advance_outstanding_vnd,
  reach: {
    contractId: row.contract_id,
    projectId: row.project_id,
    ownerUnit: { id: row.owner_unit_id, path: row.owner_unit_path },
    investorUnit: row.investor_unit_id === null || row.investor_unit_path === null ? null : { id: row.investor_unit_id, path: row.investor_unit_path },
  },
  key: '',
});

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const stateInvalid = (): DomainError => new DomainError('GUARANTEE_STATE_INVALID', 409);

/** An instant as the UTC time it is stored as; a text that is not an ISO date-time with its offset, or not a real instant, is refused. */
function instantOf(value: string, field: string): Date {
  const instant = new Date(value);
  if (!INSTANT.test(value) || Number.isNaN(instant.getTime())) throw invalid(field);
  return instant;
}

const isoOf = (instant: Date): string => instant.toISOString();

/** The threshold an expiry `daysLeft` days away has reached, or undefined while it is further than the first one (30 days). */
export function thresholdFor(daysLeft: number): AlertThreshold | undefined {
  return ALERT_THRESHOLDS.find((threshold) => daysLeft <= threshold);
}

/**
 * The guarantee register (ST-CTR-003, CTR 3.5, BR-CTR-10): a guarantee is registered under a contract, verified with the issuer by a person other
 * than the one who registered it, replaced (never silently renewed) when it is extended, and released against evidence. The statuses
 * move only along the transitions of CTR section 4 (the database holds the same table), and what a guarantee says never changes. Money is an
 * exact decimal string; every command acts on a guarantee inside the scope of its own permission over the contract.
 */
export class CtrGuaranteeStore {
  private readonly source: CtrContractSource;

  constructor(source: CtrContractSource = new CtrContractSource()) {
    this.source = source;
  }

  // ---- reads ---------------------------------------------------------------------------------------------------

  /** The guarantees in the scope of the caller, ordered by contract code and expiry; the cursor is the key and the id of the last row. */
  async list(tx: TenantTx, scope: ScopeBuilder, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<GuaranteeRow[]> {
    const predicate = scope(4);
    const rows = await tx.query<RowSql>(
      `select ${COLUMNS}, ${ROW_KEY} as key, 0 as days_left ${FROM}
        where ($1::text is null or (${ROW_KEY}, g.id) > ($1::text, $2::uuid)) and ${predicate.sql}
        order by ${ROW_KEY}, g.id limit $3`,
      [request.after?.code ?? null, request.after?.id ?? null, request.limit, ...predicate.params],
    );
    return rows.map((row) => ({ ...toRow(row), key: row.key }));
  }

  async find(tx: TenantTx, id: string, scope: ScopeBuilder): Promise<GuaranteeRow | undefined> {
    const predicate = scope(2);
    const rows = await tx.query<RowSql>(`select ${COLUMNS}, ${ROW_KEY} as key, 0 as days_left ${FROM} where g.id = $1::uuid and ${predicate.sql}`, [id, ...predicate.params]);
    const row = rows[0];
    return row === undefined ? undefined : { ...toRow(row), key: row.key };
  }

  /**
   * The ACTIVE guarantees that expire within `withinDays` calendar days of `today` (the Vietnam date), the soonest first; one that expires today
   * is 0 days away. The cursor is the instant of the expiry and the id of the last row.
   */
  async expiring(tx: TenantTx, scope: ScopeBuilder, today: string, withinDays: number, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<ExpiringRow[]> {
    const predicate = scope(6);
    const rows = await tx.query<RowSql>(
      `select ${COLUMNS}, ${EXPIRY_KEY} as key, (${VIETNAM_DATE} - $4::date) as days_left ${FROM}
        where g.status = 'ACTIVE' and (${VIETNAM_DATE} - $4::date) between 0 and $5::int
          and ($1::text is null or (${EXPIRY_KEY}, g.id) > ($1::text, $2::uuid)) and ${predicate.sql}
        order by ${EXPIRY_KEY}, g.id limit $3`,
      [request.after?.code ?? null, request.after?.id ?? null, request.limit, today, withinDays, ...predicate.params],
    );
    return rows.map((row) => ({ ...toRow(row), key: row.key, daysLeft: row.days_left }));
  }

  /** Whether the contract holds an ACTIVE guarantee of the kind that has not expired at the moment (the payments of an advance ask it). */
  async holdsActive(tx: TenantTx, contractId: string, kind: GuaranteeKind, at: Date): Promise<boolean> {
    const rows = await tx.query<{ found: boolean }>(
      `select exists (select 1 from machvon.guarantee where contract_id = $1::uuid and kind = $2 and status = 'ACTIVE' and expires_at > $3::timestamptz) as found`,
      [contractId, kind, isoOf(at)],
    );
    return rows[0]?.found === true;
  }

  // ---- commands ------------------------------------------------------------------------------------------------

  /**
   * Registers a guarantee under a contract: PENDING_VERIFICATION and UNVERIFIED until another person verifies it with the issuer. The contract
   * must not have ended, the member (when named) must be an active member of the contract, the document must exist, the amount must be above
   * zero and the expiry must come after the start and after now. The number is unique per issuer (GUARANTEE_DUPLICATE).
   */
  async register(tx: TenantTx, contractId: string, input: NewGuarantee, actor: string, scopes: ContractScopes, now: Date): Promise<GuaranteeMove> {
    const contract = await this.lockContract(tx, contractId, scopes);
    if (CLOSED_CONTRACT_STATES.includes(contract.status)) throw new DomainError('CONTRACT_STATE_INVALID', 409);
    if (!(GUARANTEE_KINDS as readonly string[]).includes(input.kind)) throw invalid('kind');
    const issuer = textOf(input.issuer, 'issuer', MAX_ISSUER);
    const guaranteeNo = textOf(input.guaranteeNo, 'guarantee_no', MAX_NUMBER);
    const amount = wholeAmount(input.amountVnd, 'amount_vnd');
    if (compareDecimal(amount, '0') === 0) throw invalid('amount_vnd');
    const validFrom = calendarDate(input.validFrom, 'valid_from');
    const expiresAt = instantOf(input.expiresAt, 'expires_at');
    if (vietnamDateOf(expiresAt) < validFrom || expiresAt.getTime() <= now.getTime()) throw invalid('expires_at');
    const partyId = input.partyId?.toLowerCase();
    if (partyId !== undefined && !(UUID.test(partyId) && (await this.isMember(tx, contractId, partyId)))) throw invalid('party_id');
    const documentVersionId = input.documentVersionId.toLowerCase();
    await this.assertDocument(tx, documentVersionId, 'document_version_id');
    const id = randomUUID();
    await this.insert(tx, { id, contractId, kind: input.kind as GuaranteeKind, issuer, guaranteeNo, partyId: partyId ?? null, amount, validFrom, expiresAt, documentVersionId, extendedFromId: null, actor });
    return { id, contractId, kind: input.kind as GuaranteeKind, amountVnd: amount, expiresAt: isoOf(expiresAt), status: 'PENDING_VERIFICATION', version: 1, fromStatus: null, supersededId: null, reach: contract.reach };
  }

  /**
   * Records the check with the issuer: VERIFIED makes the guarantee ACTIVE, FAILED rejects it, both with the method and the evidence of the
   * check. Only a guarantee that waits for it can be verified, and never by the person who registered it (SELF_APPROVAL_DENIED).
   */
  async verify(tx: TenantTx, id: string, expectedVersion: number, verification: GuaranteeVerification, actor: string, scopes: ContractScopes, now: Date): Promise<GuaranteeMove> {
    const held = await this.lock(tx, id, scopes);
    if (held.version !== expectedVersion) throw versionConflict(held.version);
    if (held.status !== 'PENDING_VERIFICATION') throw stateInvalid();
    if (held.registeredBy !== null) assertFourEyes(held.registeredBy, actor);
    if (verification.outcome !== 'VERIFIED' && verification.outcome !== 'FAILED') throw invalid('outcome');
    const method = textOf(verification.method, 'method', MAX_TEXT);
    const evidence = verification.evidenceDocumentVersionId.toLowerCase();
    await this.assertDocument(tx, evidence, 'evidence_document_version_id');
    const verified = verification.outcome === 'VERIFIED';
    const status: GuaranteeStatus = verified ? 'ACTIVE' : 'REJECTED';
    await tx.query(
      `update machvon.guarantee
          set status = $2, verification_status = $3, verified_by = $4::uuid, verified_at = $5::timestamptz, verification_method = $6, verification_evidence_id = $7::uuid,
              updated_at = now(), updated_by = $4::uuid, version = version + 1
        where id = $1::uuid`,
      [id, status, verified ? 'VERIFIED' : 'FAILED', actor, isoOf(now), method, evidence],
    );
    return this.moveOf(held, status, held.version + 1, held.status, null);
  }

  /**
   * Extends a guarantee by replacing it: the old one is SUPERSEDED with the expiry it had, and a new one that points at it
   * (`extended_from_id`) waits for its own verification. A guarantee never renews itself. The new expiry must be later than the old one.
   */
  async extend(tx: TenantTx, id: string, expectedVersion: number, extension: GuaranteeExtension, actor: string, scopes: ContractScopes, now: Date): Promise<GuaranteeMove> {
    const held = await this.lock(tx, id, scopes);
    if (held.version !== expectedVersion) throw versionConflict(held.version);
    if (held.status !== 'ACTIVE') throw stateInvalid();
    const newExpiry = instantOf(extension.newExpiresAt, 'new_expires_at');
    if (newExpiry.getTime() <= new Date(held.expiresAt).getTime() || newExpiry.getTime() <= now.getTime()) throw invalid('new_expires_at');
    const guaranteeNo = textOf(extension.newGuaranteeNo, 'new_guarantee_no', MAX_NUMBER);
    const documentVersionId = extension.documentVersionId.toLowerCase();
    await this.assertDocument(tx, documentVersionId, 'document_version_id');
    const replacement = randomUUID();
    // The old one leaves first, so the unique live successor and the one-lead style indexes never see two live rows for the same security.
    await tx.query(`update machvon.guarantee set status = 'SUPERSEDED', updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid`, [id, actor]);
    await this.insert(tx, {
      id: replacement,
      contractId: held.contractId,
      kind: held.kind,
      issuer: held.issuer,
      guaranteeNo,
      partyId: held.partyId,
      amount: held.amountVnd,
      validFrom: held.validFrom ?? vietnamDateOf(now),
      expiresAt: newExpiry,
      documentVersionId,
      extendedFromId: id,
      actor,
    });
    return { id: replacement, contractId: held.contractId, kind: held.kind, amountVnd: held.amountVnd, expiresAt: isoOf(newExpiry), status: 'PENDING_VERIFICATION', version: 1, fromStatus: 'ACTIVE', supersededId: id, reach: held.reach };
  }

  /**
   * Releases an ACTIVE or EXPIRED guarantee against the evidence of the release, by a person other than the registrant. An advance guarantee
   * stays while the contract still owes an advance that no other ACTIVE advance guarantee covers (RELEASE_CONDITION_NOT_MET).
   */
  async release(tx: TenantTx, id: string, expectedVersion: number, release: GuaranteeRelease, actor: string, scopes: ContractScopes, now: Date): Promise<GuaranteeMove> {
    const held = await this.lock(tx, id, scopes);
    if (held.version !== expectedVersion) throw versionConflict(held.version);
    if (held.status !== 'ACTIVE' && held.status !== 'EXPIRED') throw stateInvalid();
    if (held.registeredBy !== null) assertFourEyes(held.registeredBy, actor);
    const reason = textOf(release.reason, 'reason', MAX_TEXT);
    const evidence = release.releaseEvidenceId.toLowerCase();
    await this.assertDocument(tx, evidence, 'release_evidence_id');
    await this.assertReleasable(tx, held, now);
    await tx.query(
      `update machvon.guarantee
          set status = 'RELEASED', release_evidence_id = $2::uuid, released_at = $3::timestamptz, released_by = $4::uuid, release_reason = $5,
              updated_at = now(), updated_by = $4::uuid, version = version + 1
        where id = $1::uuid`,
      [id, evidence, isoOf(now), actor, reason],
    );
    return this.moveOf(held, 'RELEASED', held.version + 1, held.status, null);
  }

  /** Locks a guarantee for update inside the scope of the caller; one the caller can read but not change is a refusal, not a miss. */
  async lock(tx: TenantTx, id: string, scopes: ContractScopes): Promise<GuaranteeRow> {
    const predicate = scopes.update(2);
    const rows = await tx.query<RowSql>(`select ${COLUMNS}, '' as key, 0 as days_left ${FROM} where g.id = $1::uuid and ${predicate.sql} for update of g`, [id, ...predicate.params]);
    const row = rows[0];
    if (row !== undefined) return toRow(row);
    const readable = scopes.read(2);
    const seen = await tx.query<{ id: string }>(`select g.id ${FROM} where g.id = $1::uuid and ${readable.sql}`, [id, ...readable.params]);
    throw seen[0] === undefined ? new DomainError('RESOURCE_NOT_FOUND', 404) : new DomainError('SCOPE_DENIED', 403);
  }

  // ---- internals --------------------------------------------------------------------------------------------------------

  private async lockContract(tx: TenantTx, contractId: string, scopes: ContractScopes): Promise<{ status: string; reach: ContractPlace }> {
    const predicate = scopes.update(2);
    const rows = await tx.query<{ status: string; project_id: string; owner_unit_id: string; owner_unit_path: string; investor_unit_id: string | null; investor_unit_path: string | null }>(
      `select c.status, p.id as project_id, ou.id as owner_unit_id, ou.path as owner_unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path
         from ${SCOPE_FROM} where c.id = $1::uuid and ${predicate.sql} for update of c`,
      [contractId, ...predicate.params],
    );
    const row = rows[0];
    if (row === undefined) {
      const readable = scopes.read(2);
      const seen = await tx.query<{ id: string }>(`select c.id from ${SCOPE_FROM} where c.id = $1::uuid and ${readable.sql}`, [contractId, ...readable.params]);
      throw seen[0] === undefined ? new DomainError('RESOURCE_NOT_FOUND', 404) : new DomainError('SCOPE_DENIED', 403);
    }
    return {
      status: row.status,
      reach: {
        contractId,
        projectId: row.project_id,
        ownerUnit: { id: row.owner_unit_id, path: row.owner_unit_path },
        investorUnit: row.investor_unit_id === null || row.investor_unit_path === null ? null : { id: row.investor_unit_id, path: row.investor_unit_path },
      },
    };
  }

  private async isMember(tx: TenantTx, contractId: string, partyId: string): Promise<boolean> {
    const rows = await tx.query<{ found: boolean }>(`select exists (select 1 from machvon.contract_party where contract_id = $1::uuid and id = $2::uuid and status = 'ACTIVE') as found`, [contractId, partyId]);
    return rows[0]?.found === true;
  }

  private async assertDocument(tx: TenantTx, documentVersionId: string, field: string): Promise<void> {
    if (!UUID.test(documentVersionId) || !(await this.source.cleanDocumentVersionExists(tx, documentVersionId))) throw invalid(field);
  }

  private async assertReleasable(tx: TenantTx, held: GuaranteeRow, now: Date): Promise<void> {
    if (held.kind !== 'ADVANCE') return;
    // The rule reads the other advance guarantees of the contract, which this transaction does not lock: two releases that each lean on the
    // other guarantee would both pass and leave an advance owed with no cover. The contract row serialises them, and what is owed is read
    // again under that lock (a payment or a recovery may have moved it since the guarantee was read).
    const locked = await tx.query<{ outstanding: string }>('select advance_outstanding_vnd::text as outstanding from machvon.contract where id = $1::uuid for update', [held.contractId]);
    const outstanding = locked[0]?.outstanding ?? held.advanceOutstandingVnd;
    if (compareDecimal(outstanding, '0') === 0) return;
    const covered = await tx.query<{ found: boolean }>(
      `select exists (
         select 1 from machvon.guarantee
          where contract_id = $1::uuid and kind = 'ADVANCE' and status = 'ACTIVE' and id <> $2::uuid and expires_at > $3::timestamptz and amount_vnd >= $4::numeric) as found`,
      [held.contractId, held.id, isoOf(now), outstanding],
    );
    if (covered[0]?.found !== true) throw new DomainError('RELEASE_CONDITION_NOT_MET', 422, 'advance_outstanding_vnd', { extensions: { advance_outstanding_vnd: outstanding } });
  }

  private moveOf(held: GuaranteeRow, status: GuaranteeStatus, version: number, from: GuaranteeStatus | null, supersededId: string | null): GuaranteeMove {
    return { id: held.id, contractId: held.contractId, kind: held.kind, amountVnd: held.amountVnd, expiresAt: held.expiresAt, status, version, fromStatus: from, supersededId, reach: held.reach };
  }

  private async insert(
    tx: TenantTx,
    row: { id: string; contractId: string; kind: GuaranteeKind; issuer: string; guaranteeNo: string; partyId: string | null; amount: string; validFrom: string; expiresAt: Date; documentVersionId: string; extendedFromId: string | null; actor: string },
  ): Promise<void> {
    try {
      await tx.query(
        `insert into machvon.guarantee
           (tenant_id, id, contract_id, kind, issuer, guarantee_no, party_id, amount_vnd, currency, valid_from, expires_at, status, verification_status, document_version_id,
            extended_from_id, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7::numeric, 'VND', $8::date, $9::timestamptz,
                 'PENDING_VERIFICATION', 'UNVERIFIED', $10::uuid, $11::uuid, $12::uuid, $12::uuid)`,
        [row.id, row.contractId, row.kind, row.issuer, row.guaranteeNo, row.partyId, row.amount, row.validFrom, isoOf(row.expiresAt), row.documentVersionId, row.extendedFromId, row.actor],
      );
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code === UNIQUE_VIOLATION && failure.constraint === NUMBER_CONSTRAINT) throw new DomainError('GUARANTEE_DUPLICATE', 409, 'guarantee_no');
      if (failure.code === UNIQUE_VIOLATION && failure.constraint === SUCCESSOR_CONSTRAINT) throw stateInvalid();
      throw error;
    }
  }
}
