import { randomUUID } from 'node:crypto';
import { DomainError, isInForce, versionConflict, vietnamDateOf } from '@machvon/kernel';
import { normaliseTaxIdentifier } from './bid-tax-identifier.ts';
import { timestampKey } from './keyset.ts';
import type { AdapterStatus } from './outgoing-document-store.ts';
import type { TenantTx } from './tenant-database.ts';

const UNIQUE_VIOLATION = '23505';
const MAX_NAME = 500;
const MAX_FORM = 100;
const MAX_NOTE = 1000;
const CONTRACTOR_MASTER_TYPE = 'CONTRACTOR';

export type VerificationStatus = 'UNVERIFIED' | 'VERIFIED' | 'REJECTED';
export type VerificationDecision = 'VERIFIED' | 'REJECTED';
export type VerificationBasis = 'EVIDENCE_DOCUMENT' | 'EVIDENCE_DOCUMENT_AND_LOOKUP';
export type LookupOutcome = 'MATCH' | 'NOT_FOUND' | 'NAME_MISMATCH' | 'UNAVAILABLE';
export type RestrictionKind = 'DEBARMENT' | 'SUSPENSION' | 'WARNING';
export type RestrictionSource = 'NATIONAL_E_PROCUREMENT_IMPORT' | 'DECISION';

export const RESTRICTION_KINDS: readonly RestrictionKind[] = ['DEBARMENT', 'SUSPENSION', 'WARNING'];

/** What an official lookup of the tax id answered, and through which adapter: the adapter status is the verdict on the adapter, not on the contractor. */
export interface LookupRecord {
  adapterStatus: AdapterStatus;
  outcome: LookupOutcome;
  /** The time of the answer, to the microsecond (UTC). */
  checkedAt: string;
}

export interface ContractorRow {
  id: string;
  taxIdentifier: string;
  legalName: string;
  legalForm: string | null;
  verificationStatus: VerificationStatus;
  verificationBasis: VerificationBasis | null;
  lookup: LookupRecord | null;
  masterRecordId: string | null;
  profileDocumentId: string;
  verifiedBy: string | null;
  verifiedAt: string | null;
  verificationEvidenceDocumentId: string | null;
  createdBy: string | null;
  /** The contracts of the contractor (the contract module owns them; the registry only counts them). */
  contractCount: number;
  version: number;
  /** Creation time to the microsecond (UTC): the ordering key of the list and its cursor. */
  createdAtKey: string;
}

export interface RestrictionRow {
  id: string;
  contractorId: string;
  kind: RestrictionKind;
  source: RestrictionSource;
  effectiveFrom: string;
  effectiveUntil: string | null;
  decisionDocumentId: string | null;
  note: string | null;
  createdBy: string;
  version: number;
}

export interface RegisterInput {
  taxIdentifier: string;
  legalName: string;
  legalForm?: string | undefined;
  profileDocumentId: string;
  masterRecordId?: string | undefined;
}

export interface VerifyInput {
  decision: VerificationDecision;
  evidenceDocumentId: string;
  /** What the lookup answered; absent when none was asked (a rejection) or when it is not to be recorded. */
  lookup?: LookupRecord | undefined;
  /** How the identity was verified; only for a VERIFIED decision. */
  basis?: VerificationBasis | undefined;
}

export interface RestrictionInput {
  kind: RestrictionKind;
  effectiveFrom: string;
  effectiveUntil?: string | undefined;
  decisionDocumentId: string;
  note?: string | undefined;
}

/** Who the caller is in the registry: a guest contractor sees the contractor of their invitation and nobody else. */
export type CallerContractor = { guest: false } | { guest: true; contractorId: string };

/** The contractor of a guest whose row names none: it belongs to no row, so such a guest sees nothing (the table forbids the state; this fails closed). */
const NO_CONTRACTOR = '00000000-0000-0000-0000-000000000000';

interface SqlRow {
  id: string;
  tax_identifier: string;
  legal_name: string;
  legal_form: string | null;
  verification_status: VerificationStatus;
  verification_basis: VerificationBasis | null;
  lookup_adapter_status: AdapterStatus | null;
  lookup_outcome: LookupOutcome | null;
  lookup_checked_at: string | null;
  master_record_id: string | null;
  profile_document_id: string;
  verified_by: string | null;
  verified_at: string | null;
  verification_evidence_document_id: string | null;
  created_by: string | null;
  contract_count: string;
  version: string;
  created_at_key: string;
}

interface RestrictionSql {
  id: string;
  contractor_id: string;
  kind: RestrictionKind;
  source: RestrictionSource;
  effective_from: string;
  effective_until: string | null;
  decision_document_id: string | null;
  note: string | null;
  created_by: string;
  version: string;
}

const SELECT = `select c.id, c.tax_identifier, c.legal_name, c.legal_form, c.verification_status, c.verification_basis, c.lookup_adapter_status, c.lookup_outcome,
  ${timestampKey('c.lookup_checked_at')} as lookup_checked_at, c.master_record_id, c.profile_document_id, c.verified_by, ${timestampKey('c.verified_at')} as verified_at,
  c.verification_evidence_document_id, c.created_by,
  (select count(*) from machvon.contract k where k.tenant_id = c.tenant_id and k.contractor_id = c.id)::text as contract_count,
  c.version::text as version, ${timestampKey('c.created_at')} as created_at_key
  from machvon.contractor c`;

const RESTRICTION_SELECT = `select r.id, r.contractor_id, r.kind, r.source, r.effective_from::text as effective_from, r.effective_until::text as effective_until,
  r.decision_document_id, r.note, r.created_by, r.version::text as version from machvon.contractor_restriction r`;

const toRow = (row: SqlRow): ContractorRow => ({
  id: row.id,
  taxIdentifier: row.tax_identifier,
  legalName: row.legal_name,
  legalForm: row.legal_form,
  verificationStatus: row.verification_status,
  verificationBasis: row.verification_basis,
  lookup:
    row.lookup_adapter_status === null || row.lookup_outcome === null || row.lookup_checked_at === null
      ? null
      : { adapterStatus: row.lookup_adapter_status, outcome: row.lookup_outcome, checkedAt: row.lookup_checked_at },
  masterRecordId: row.master_record_id,
  profileDocumentId: row.profile_document_id,
  verifiedBy: row.verified_by,
  verifiedAt: row.verified_at,
  verificationEvidenceDocumentId: row.verification_evidence_document_id,
  createdBy: row.created_by,
  contractCount: Number(row.contract_count),
  version: Number(row.version),
  createdAtKey: row.created_at_key,
});

const toRestriction = (row: RestrictionSql): RestrictionRow => ({
  id: row.id,
  contractorId: row.contractor_id,
  kind: row.kind,
  source: row.source,
  effectiveFrom: row.effective_from,
  effectiveUntil: row.effective_until,
  decisionDocumentId: row.decision_document_id,
  note: row.note,
  createdBy: row.created_by,
  version: Number(row.version),
});

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** A name as it is stored: trimmed, not empty, without control characters, within its length. */
function nameOf(value: string, field: string, max: number): string {
  const text = value.trim();
  // eslint-disable-next-line no-control-regex
  if (text === '' || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw invalid(field);
  return text;
}

/** A note as it is stored: trimmed, within its length, without control characters other than line breaks and tabs. */
function noteOf(value: string | undefined): string | null {
  const text = value?.trim() ?? '';
  // eslint-disable-next-line no-control-regex
  if (text.length > MAX_NOTE || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw invalid('note');
  return text === '' ? null : text;
}

function dateOf(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw invalid(field);
  return value;
}

/** What makes a verified contractor a duplicate: the one already verified with the tax id, and the master entries of both for the merge in MDM. */
export interface DuplicateTaxId {
  verifiedContractorId: string;
  verifiedMasterRecordId: string | null;
}

/**
 * The contractor registry (ST-BID-002, BID 3 F2): a contractor is identified by a tax id that a person verified on evidence (and, when an
 * official lookup is bound and says so itself, by that lookup too); two contractors never hold the same verified tax id and are never merged
 * by name here, a duplicate is sent to master data. Restrictions are legal records that the registrations of proposals and the submission of
 * results look at (`assertMayTakePart`). The unique index of the table is the last word on duplicates; this store turns it into the answer.
 */
export class BidContractorStore {
  async find(tx: TenantTx, id: string, lock = false): Promise<ContractorRow | undefined> {
    const rows = await tx.query<SqlRow>(`${SELECT} where c.id = $1::uuid${lock ? ' for update of c' : ''}`, [id]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  /** The contractors of the tenant, the newest first; `only` narrows the answer to one contractor (a guest sees their own). */
  async list(tx: TenantTx, only: string | null, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<ContractorRow[]> {
    const rows = await tx.query<SqlRow>(
      `${SELECT}
        where ($1::uuid is null or c.id = $1::uuid) and ($2::text is null or (${timestampKey('c.created_at')}, c.id) < ($2::text, $3::uuid))
        order by c.created_at desc, c.id desc limit $4`,
      [only, request.after?.code ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map(toRow);
  }

  /** Whether the membership is a guest contractor and, if so, of which contractor. */
  async callerOf(tx: TenantTx, membershipId: string): Promise<CallerContractor> {
    const rows = await tx.query<{ membership_type: string; contractor_id: string | null }>('select membership_type, contractor_id from machvon.membership where id = $1::uuid', [membershipId]);
    const row = rows[0];
    return row?.membership_type === 'GUEST_CONTRACTOR' ? { guest: true, contractorId: row.contractor_id ?? NO_CONTRACTOR } : { guest: false };
  }

  /** The restrictions of some contractors, the latest start first; a contractor without any has no entry. */
  async restrictionsOf(tx: TenantTx, contractorIds: readonly string[]): Promise<Map<string, RestrictionRow[]>> {
    const found = new Map<string, RestrictionRow[]>();
    if (contractorIds.length === 0) return found;
    const rows = await tx.query<RestrictionSql>(`${RESTRICTION_SELECT} where r.contractor_id = any($1::uuid[]) order by r.effective_from desc, r.created_at desc, r.id desc`, [[...contractorIds]]);
    for (const row of rows) {
      const list = found.get(row.contractor_id) ?? [];
      list.push(toRestriction(row));
      found.set(row.contractor_id, list);
    }
    return found;
  }

  /** The restrictions in force on a date (the Vietnam date of today by default): the last day of a restriction is a day on which it still applies. */
  async restrictionsInForce(tx: TenantTx, contractorIds: readonly string[], on: string = vietnamDateOf(new Date())): Promise<Map<string, RestrictionRow>> {
    const found = new Map<string, RestrictionRow>();
    if (contractorIds.length === 0) return found;
    const rows = await tx.query<RestrictionSql>(
      `${RESTRICTION_SELECT}
        where r.contractor_id = any($1::uuid[]) and r.effective_from <= $2::date and (r.effective_until is null or r.effective_until >= $2::date)
        order by r.effective_from desc, r.created_at desc, r.id desc`,
      [[...contractorIds], on],
    );
    // The latest start stands for the contractor in a list; every restriction in force blocks.
    for (const row of rows) if (!found.has(row.contractor_id)) found.set(row.contractor_id, toRestriction(row));
    return found;
  }

  /**
   * Registers a contractor as UNVERIFIED and links it to its entry in master data by the tax id (never by name). A tax id that a verified
   * contractor holds already is refused; an unverified duplicate is allowed (two claims of one tax id wait for a decision, and the second
   * to be verified meets the first).
   */
  async register(tx: TenantTx, input: RegisterInput, actor: string): Promise<{ id: string; version: number; masterRecordId: string | null }> {
    const taxIdentifier = normaliseTaxIdentifier(input.taxIdentifier);
    const legalName = nameOf(input.legalName, 'legal_name', MAX_NAME);
    const legalForm = input.legalForm === undefined || input.legalForm.trim() === '' ? null : nameOf(input.legalForm, 'legal_form', MAX_FORM);
    await this.assertDocument(tx, input.profileDocumentId, 'profile_document_id');
    const verified = await this.verifiedHolder(tx, taxIdentifier);
    if (verified !== undefined) {
      throw new DomainError('CONTRACTOR_ALREADY_VERIFIED', 422, 'tax_identifier', { extensions: { existing_contractor_id: verified.verifiedContractorId } });
    }
    const masterRecordId = await this.masterLink(tx, taxIdentifier, input.masterRecordId);
    const id = randomUUID();
    await tx.query(
      `insert into machvon.contractor
         (tenant_id, id, tax_identifier, legal_name, legal_form, verification_status, profile_document_id, master_record_id, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4, 'UNVERIFIED', $5::uuid, $6::uuid, $7::uuid, $7::uuid)`,
      [id, taxIdentifier, legalName, legalForm, input.profileDocumentId, masterRecordId, actor],
    );
    return { id, version: 1, masterRecordId };
  }

  /** Whether the contractor can take a verification decision from this person on this version; the caller may use it before asking a lookup. */
  assertDecidable(row: ContractorRow, expectedVersion: number, actor: string): void {
    if (row.version !== expectedVersion) throw versionConflict(row.version);
    // Whoever registered the contractor cannot be the one who verifies it.
    if (row.createdBy === actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    if (row.verificationStatus !== 'UNVERIFIED') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'verification_status');
  }

  /**
   * Records the decision on an UNVERIFIED contractor. A VERIFIED decision is refused with TAX_ID_DUPLICATE_VERIFIED when another contractor
   * holds the tax id as VERIFIED (the answer names it and the master entries of both, so the duplicate goes to the merge of master data).
   * The basis is `EVIDENCE_DOCUMENT_AND_LOOKUP` only when the lookup was answered MATCH through an adapter whose own status is VERIFIED.
   */
  async verify(tx: TenantTx, id: string, expectedVersion: number, input: VerifyInput, actor: string): Promise<{ row: ContractorRow; version: number }> {
    const row = await this.find(tx, id, true);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    this.assertDecidable(row, expectedVersion, actor);
    await this.assertDocument(tx, input.evidenceDocumentId, 'verification_evidence_document_id');
    let masterRecordId = row.masterRecordId;
    let basis: VerificationBasis | null = null;
    let lookup: LookupRecord | null = null;
    if (input.decision === 'VERIFIED') {
      const holder = await this.verifiedHolder(tx, row.taxIdentifier);
      if (holder !== undefined) throw this.duplicate(holder, row);
      masterRecordId ??= await this.masterLink(tx, row.taxIdentifier, undefined);
      lookup = input.lookup ?? null;
      basis = lookup?.adapterStatus === 'VERIFIED' && lookup.outcome === 'MATCH' ? 'EVIDENCE_DOCUMENT_AND_LOOKUP' : 'EVIDENCE_DOCUMENT';
    }
    // A savepoint keeps the transaction usable when the unique index refuses the write: without it the lookup of the holder below would
    // fail with "current transaction is aborted" instead of the 409 that names the duplicate.
    await tx.query('savepoint contractor_verification');
    try {
      await tx.query(
        `update machvon.contractor
            set verification_status = $2, verification_basis = $3, lookup_adapter_status = $4, lookup_outcome = $5, lookup_checked_at = $6::timestamptz,
                master_record_id = $7::uuid, verified_by = $8::uuid, verified_at = now(), verification_evidence_document_id = $9::uuid,
                updated_at = now(), updated_by = $8::uuid, version = version + 1
          where id = $1::uuid`,
        [id, input.decision, basis, lookup?.adapterStatus ?? null, lookup?.outcome ?? null, lookup?.checkedAt ?? null, masterRecordId, actor, input.evidenceDocumentId],
      );
      await tx.query('release savepoint contractor_verification');
    } catch (error) {
      if (input.decision === 'VERIFIED' && (error as { code?: string }).code === UNIQUE_VIOLATION) {
        // Another transaction verified the same tax id between the check and the write: the unique index has the last word.
        await tx.query('rollback to savepoint contractor_verification');
        const holder = await this.verifiedHolder(tx, row.taxIdentifier);
        throw holder === undefined ? error : this.duplicate(holder, row);
      }
      throw error;
    }
    return { row: (await this.find(tx, id)) as ContractorRow, version: row.version + 1 };
  }

  /**
   * Adds a restriction on a decision that is in force (a decision of another state is DECISION_DOCUMENT_NOT_EFFECTIVE). The restriction is a
   * record: it is not edited, and a decision that ends it earlier is a later change of its end date.
   */
  async recordRestriction(tx: TenantTx, contractorId: string, input: RestrictionInput, actor: string): Promise<{ id: string; version: number }> {
    if (!RESTRICTION_KINDS.includes(input.kind)) throw invalid('kind');
    const effectiveFrom = dateOf(input.effectiveFrom, 'effective_from');
    const effectiveUntil = input.effectiveUntil === undefined ? null : dateOf(input.effectiveUntil, 'effective_until');
    if (effectiveUntil !== null && effectiveUntil < effectiveFrom) throw invalid('effective_until');
    const note = noteOf(input.note);
    if ((await this.find(tx, contractorId)) === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const documents = await tx.query<{ effect_status: string }>('select effect_status from machvon.document where id = $1::uuid', [input.decisionDocumentId]);
    if (documents[0] === undefined) throw invalid('decision_document_id');
    if (!isInForce(documents[0].effect_status)) throw new DomainError('DECISION_DOCUMENT_NOT_EFFECTIVE', 422, 'decision_document_id');
    const id = randomUUID();
    await tx.query(
      `insert into machvon.contractor_restriction
         (tenant_id, id, contractor_id, kind, source, effective_from, effective_until, decision_document_id, note, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, 'DECISION', $4::date, $5::date, $6::uuid, $7, $8::uuid, $8::uuid)`,
      [id, contractorId, input.kind, effectiveFrom, effectiveUntil, input.decisionDocumentId, note, actor],
    );
    return { id, version: 1 };
  }

  /**
   * What the proposals and the results of procurement ask before they take a contractor in (BR-BID-01): a restriction in force on the date is
   * CONTRACTOR_RESTRICTED, whatever else is true of the contractor, and a contractor whose tax id nobody verified is CONTRACTOR_NOT_VERIFIED.
   */
  async assertMayTakePart(tx: TenantTx, contractorId: string, on: string = vietnamDateOf(new Date())): Promise<ContractorRow> {
    const row = await this.find(tx, contractorId);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const restriction = (await this.restrictionsInForce(tx, [contractorId], on)).get(contractorId);
    if (restriction !== undefined) {
      throw new DomainError('CONTRACTOR_RESTRICTED', 422, undefined, {
        extensions: { restriction: { kind: restriction.kind, effective_from: restriction.effectiveFrom, effective_until: restriction.effectiveUntil } },
      });
    }
    if (row.verificationStatus !== 'VERIFIED') throw new DomainError('CONTRACTOR_NOT_VERIFIED', 422);
    return row;
  }

  private async assertDocument(tx: TenantTx, documentId: string, field: string): Promise<void> {
    const documents = await tx.query('select 1 from machvon.document where id = $1::uuid', [documentId]);
    if (documents.length === 0) throw invalid(field);
  }

  private async verifiedHolder(tx: TenantTx, taxIdentifier: string): Promise<DuplicateTaxId | undefined> {
    const rows = await tx.query<{ id: string; master_record_id: string | null }>(
      "select id, master_record_id from machvon.contractor where tax_identifier = $1 and verification_status = 'VERIFIED'",
      [taxIdentifier],
    );
    return rows[0] === undefined ? undefined : { verifiedContractorId: rows[0].id, verifiedMasterRecordId: rows[0].master_record_id };
  }

  /** The answer for a tax id that a verified contractor holds: no automatic merge, the way to the merge in master data is in the answer. */
  private duplicate(holder: DuplicateTaxId, row: ContractorRow): DomainError {
    return new DomainError('TAX_ID_DUPLICATE_VERIFIED', 409, 'tax_identifier', {
      extensions: {
        merge_suggestion: {
          target: 'MDM',
          action: 'MERGE',
          verified_contractor_id: holder.verifiedContractorId,
          verified_master_record_id: holder.verifiedMasterRecordId,
          contractor_id: row.id,
          master_record_id: row.masterRecordId,
        },
      },
    });
  }

  /**
   * The master entry of the contractor: the one named, which must be a live CONTRACTOR entry keyed by the same tax id, or the live entry that
   * carries the tax id as its key. A name never links anything. No entry is fine: master data may not hold the contractor yet.
   */
  private async masterLink(tx: TenantTx, taxIdentifier: string, requested: string | undefined): Promise<string | null> {
    if (requested !== undefined) {
      const rows = await tx.query<{ master_type: string; business_key: string; status: string }>('select master_type, business_key, status from machvon.master_record where id = $1::uuid', [requested]);
      const entry = rows[0];
      // An entry of another tenant is indistinguishable from one that does not exist.
      if (entry === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      if (entry.master_type !== CONTRACTOR_MASTER_TYPE || entry.business_key !== taxIdentifier || entry.status === 'MERGED' || entry.status === 'RETIRED') throw invalid('master_record_id');
      return requested;
    }
    const rows = await tx.query<{ id: string }>(
      `select id from machvon.master_record where master_type = $1 and business_key = $2 and status not in ('MERGED', 'RETIRED')
        order by (namespace = 'TENANT') desc, id limit 1`,
      [CONTRACTOR_MASTER_TYPE, taxIdentifier],
    );
    return rows[0]?.id ?? null;
  }
}
