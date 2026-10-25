import { randomUUID } from 'node:crypto';
import { DomainError, maskAddress, maskName, maskNationalId, maskPhone, normalizeNationalId, normalizePhone } from '@machvon/kernel';
import type { EffectiveAccess, FieldCipher } from '@machvon/kernel';
import { timestampKey } from './keyset.ts';
import { LndLandSource } from './lnd-land-source.ts';
import { dateOf, lowerId, textOf } from './lnd-values.ts';
import { scopePredicate } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';
import { withUniqueClaim } from './unique-claim.ts';

const TABLE = 'affected_household';
const MAX_TEXT = 2000;
const MAX_PAGE = 200;
const MAX_MEMBERS = 1000;
const SHARE = /^(\d{1,3})(\.\d{1,4})?$/;
const FULLY_MASKED = '************';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const LEGAL_BASES = ['PUBLIC_TASK_LAND_LAW', 'LEGAL_OBLIGATION', 'CONSENT'] as const;
export type LegalBasis = (typeof LEGAL_BASES)[number];
export const RIGHT_KINDS = ['OWNER', 'USER', 'LESSEE', 'OCCUPANT_NO_TITLE'] as const;
export type RightKind = (typeof RIGHT_KINDS)[number];
export const REQUEST_KINDS = ['ACCESS', 'RECTIFY', 'WITHDRAW_CONSENT', 'ERASE', 'RESTRICT'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];
export const REQUEST_OUTCOMES = ['FULFILLED', 'PARTIAL', 'REFUSED'] as const;
export type RequestOutcome = (typeof REQUEST_OUTCOMES)[number];
export type ErasedField = 'head_name' | 'national_id' | 'phone' | 'address_text';
/** What an erased name is replaced by: the household stays as a record, because the payments made to it must be kept. */
const ERASED_NAME = '[erased]';
export const HOUSEHOLD_STATUSES = ['REGISTERED', 'INVENTORIED', 'PLAN_LISTED', 'COMPENSATED', 'RESETTLED', 'CLOSED', 'DISPUTED'] as const;
export type HouseholdStatus = (typeof HOUSEHOLD_STATUSES)[number];

/** The value of `app.scope_units` for a caller: `*` for the whole tenant, the ids of the units its grants reach, or nothing. */
export type ScopeUnits = string;

export interface NewHousehold {
  projectId: string;
  ownerUnitId: string;
  headName: string;
  nationalId?: string | undefined;
  phone?: string | undefined;
  addressText?: string | undefined;
  memberCount?: number | undefined;
  policyBeneficiary?: boolean | undefined;
  legalBasis: string;
  legalBasisRef: string;
  consentRecordId?: string | undefined;
  retentionUntil: string;
}

/** What registering a household did: ids and the values that are not personal, which is all the audit row and the event may carry. */
export interface RegisteredHousehold {
  id: string;
  projectId: string;
  ownerUnitId: string;
  householdCode: string;
  legalBasis: LegalBasis;
  legalBasisRef: string;
  retentionUntil: string;
  status: HouseholdStatus;
  version: number;
  /** Which personal fields were stored sealed, never their values. */
  sealed: string[];
}

export interface HouseholdRequestInput {
  requestKind: string;
  requesterVerified: boolean;
  outcome: string;
  reason: string;
}

/** What handling a request did: ids, the kind and the outcome, the names of the fields that were erased (never their values) and the payment records that had to be kept. */
export interface HandledRequest {
  id: string;
  householdId: string;
  projectId: string;
  ownerUnitId: string;
  requestKind: RequestKind;
  outcome: RequestOutcome;
  erasedFields: ErasedField[];
  retainedPayments: number;
  restricted: boolean;
  anonymised: boolean;
  version: number;
}

export interface NewHouseholdLink {
  parcelId: string;
  rightKind: string;
  sharePct?: string | undefined;
  titleDocumentVersionId?: string | undefined;
}

export interface HouseholdLink {
  id: string;
  householdId: string;
  parcelId: string;
  ownerUnitId: string;
  projectId: string;
  rightKind: RightKind;
  sharePct: string;
  titleDocumentVersionId: string | null;
}

export interface HouseholdFilter {
  projectId?: string | undefined;
  status?: string | undefined;
  limit: number;
  after?: { code: string; id: string } | undefined;
}

/** A household as it is shown: the personal fields in their masked form, the sealed ones not at all. */
export interface HouseholdLine {
  id: string;
  projectId: string;
  ownerUnitId: string;
  householdCode: string;
  headNameMasked: string;
  /** The masked identity number, with its last four characters; shown only to whoever may read personal data, and fully hidden to the others. */
  nationalIdMasked: string | null;
  phoneMasked: string | null;
  addressMasked: string | null;
  memberCount: number | null;
  policyBeneficiary: boolean;
  legalBasis: LegalBasis;
  legalBasisRef: string;
  consentRecordId: string | null;
  retentionUntil: string;
  dsrOpen: boolean;
  /** The processing of the data was restricted at the request of the person: the sealed data is not opened. */
  processingRestricted: boolean;
  /** The personal data was erased at the request of the person; the household is an anonymous record. */
  anonymised: boolean;
  status: HouseholdStatus;
  parcels: Array<{ id: string; parcelId: string; parcelCode: string; rightKind: RightKind; sharePct: string }>;
  createdAt: string;
  version: number;
}

/** The personal data of a household in the clear: for the person who may read it, and each time it is read the caller audits that it was (not the values). */
export interface HouseholdIdentity {
  id: string;
  projectId: string;
  ownerUnitId: string;
  householdCode: string;
  headName: string;
  nationalId: string | null;
  phone: string | null;
  addressText: string | null;
}

interface LineSql {
  id: string;
  project_id: string;
  owner_unit_id: string;
  household_code: string;
  head_name: string;
  national_id_masked: string | null;
  phone_masked: string | null;
  address_text: string | null;
  member_count: number | null;
  policy_beneficiary: boolean;
  legal_basis: LegalBasis;
  legal_basis_ref: string;
  consent_record_id: string | null;
  retention_until: string;
  dsr_open: boolean;
  processing_restricted: boolean;
  anonymised: boolean;
  status: HouseholdStatus;
  created_at: string;
  version: string;
}

const invalid = (field: string, reason?: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, reason === undefined ? undefined : { extensions: { reason } });

/**
 * The units a caller may see personal data of: `*` when a grant that carries the permission covers the whole tenant, otherwise the ids of every unit its grants reach (a unit tree or a single unit; the
 * grants on a project or a contract reach no household, because a household belongs to a unit), and nothing when it has none. It is the value that goes into `app.scope_units`, which the restrictive policy
 * `scope_units_guard` of the tables of households tests: with no value, no row is seen.
 */
export async function householdScopeUnits(tx: TenantTx, access: EffectiveAccess, permission: string, now: Date): Promise<ScopeUnits> {
  const predicate = scopePredicate(access, permission, now, { unitPath: 'u.path', unitId: 'u.id' }, 1);
  if (predicate.sql === 'true') return '*';
  if (predicate.sql === 'false') return '';
  const rows = await tx.query<{ id: string }>(`select u.id from machvon.organization_unit u where ${predicate.sql} order by u.id`, predicate.params);
  return rows.map((row) => row.id).join(',');
}

/** Whether the unit is among the units of the scope. */
export const unitInScope = (units: ScopeUnits, unitId: string): boolean => units === '*' || units.split(',').includes(unitId);

/** Puts the scope into the transaction for the policy `scope_units_guard`: until it is put, the household tables show no row. */
export async function enterScope(tx: TenantTx, units: ScopeUnits): Promise<void> {
  await tx.query("select set_config('app.scope_units', $1, true)", [units]);
}

/**
 * The households affected by a land recovery (ST-LND-002, LND 3.5, BR-LND-09, UAT-AC379, UAT-AC380). The personal data is collected once, sealed with the envelope encryption of the platform
 * (the name, the identity number, the telephone, the address), found again only by a blind index (a duplicate identity number in a project) and shown masked; the masked forms are all that a row holds in the
 * clear. A household is registered on a legal basis for processing and for as long as the data is kept (422 `LEGAL_BASIS_REQUIRED`, 422 `CONSENT_REQUIRED`); it belongs to the unit that answers for it and is seen only
 * from inside that unit, by the policy of the database as well as by the application.
 */
export class LndHouseholdStore {
  private readonly cipher: FieldCipher;
  private readonly source: LndLandSource;

  constructor(cipher: FieldCipher, source: LndLandSource = new LndLandSource()) {
    this.cipher = cipher;
    this.source = source;
  }

  async register(tx: TenantTx, input: NewHousehold, actor: string, units: ScopeUnits, today: string): Promise<RegisteredHousehold> {
    const projectId = lowerId(input.projectId);
    const ownerUnitId = lowerId(input.ownerUnitId);
    const headName = textOf(input.headName, 'head_name', 1, MAX_TEXT);
    const legalBasis = LEGAL_BASES.find((candidate) => candidate === input.legalBasis) ?? this.badField('legal_basis');
    const legalBasisRef = input.legalBasisRef.trim();
    if (legalBasisRef === '') throw new DomainError('LEGAL_BASIS_REQUIRED', 422, 'legal_basis_ref');
    if (legalBasisRef.length > MAX_TEXT) throw invalid('legal_basis_ref');
    const consentId = input.consentRecordId === undefined ? null : lowerId(input.consentRecordId);
    if (consentId !== null && !UUID.test(consentId)) throw invalid('consent_record_id');
    if (legalBasis === 'CONSENT' && consentId === null) throw new DomainError('CONSENT_REQUIRED', 422, 'consent_record_id');
    const retentionUntil = dateOf(input.retentionUntil, 'retention_until');
    if (retentionUntil < today) throw invalid('retention_until', 'IN_THE_PAST');
    const nationalId = input.nationalId === undefined ? undefined : normalizeNationalId(input.nationalId);
    const phone = input.phone === undefined ? undefined : normalizePhone(input.phone);
    const address = input.addressText === undefined ? undefined : textOf(input.addressText, 'address_text', 1, MAX_TEXT);
    if (input.memberCount !== undefined && (!Number.isInteger(input.memberCount) || input.memberCount < 1 || input.memberCount > MAX_MEMBERS)) throw invalid('member_count');
    // A household is registered by someone whose scope holds its unit: a unit outside it, or one that is not there, is told the same way.
    await enterScope(tx, units);
    if ((await this.source.projectRef(tx, projectId)) === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if ((await this.source.unitRef(tx, ownerUnitId)) === undefined || !unitInScope(units, ownerUnitId)) throw new DomainError('SCOPE_DENIED', 403);

    const tenantId = await this.tenantOf(tx);
    const id = randomUUID();
    const place = (column: string) => ({ tenantId, table: TABLE, column, rowId: id });
    const sealed = ['head_name'];
    if (nationalId !== undefined) sealed.push('national_id');
    if (phone !== undefined) sealed.push('phone');
    if (address !== undefined) sealed.push('address_text');
    const hash = nationalId === undefined ? null : this.cipher.blindIndex(tenantId, projectId, nationalId);
    // The code is issued by the platform, one number after another in the project; two registrations at once take their turns.
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`household-code:${projectId}`]);
    const next =
      (
        await tx.query<{ next: string }>(
          "select (coalesce(max(substring(household_code from 4)::int), 0) + 1)::text as next from machvon.affected_household where project_id = $1::uuid and household_code ~ '^HH-[0-9]+$'",
          [projectId],
        )
      )[0]?.next ?? '1';
    const householdCode = `HH-${next.padStart(6, '0')}`;
    await withUniqueClaim(tx, { constraint: 'affected_household_nid_uq', code: 'HOUSEHOLD_DUPLICATE' }, () =>
      tx.query(
        `insert into machvon.affected_household
           (tenant_id, id, project_id, owner_unit_id, household_code, head_name, head_name_enc, national_id_enc, national_id_hash, national_id_masked, phone_enc, phone_masked, address_text, address_enc, member_count,
            policy_beneficiary, legal_basis, legal_basis_ref, consent_record_id, retention_until, status, created_by, updated_by, version)
         values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::uuid, $20::date, 'REGISTERED', $21::uuid, $21::uuid, 1)`,
        [
          tenantId,
          id,
          projectId,
          ownerUnitId,
          householdCode,
          maskName(headName),
          this.cipher.seal(place('head_name_enc'), headName),
          nationalId === undefined ? null : this.cipher.seal(place('national_id_enc'), nationalId),
          hash,
          nationalId === undefined ? null : maskNationalId(nationalId),
          phone === undefined ? null : this.cipher.seal(place('phone_enc'), phone),
          phone === undefined ? null : maskPhone(phone),
          address === undefined ? null : maskAddress(address),
          address === undefined ? null : this.cipher.seal(place('address_enc'), address),
          input.memberCount ?? null,
          input.policyBeneficiary ?? false,
          legalBasis,
          legalBasisRef,
          consentId,
          retentionUntil,
          actor,
        ],
      ),
    );
    return { id, projectId, ownerUnitId, householdCode, legalBasis, legalBasisRef, retentionUntil, status: 'REGISTERED', version: 1, sealed };
  }

  /** Links a household to a parcel of its own unit and project, with the right it holds and its share; the shares of a parcel never come to more than the whole of it. */
  async link(tx: TenantTx, householdId: string, input: NewHouseholdLink, actor: string, units: ScopeUnits): Promise<HouseholdLink> {
    const id = lowerId(householdId);
    const parcelId = lowerId(input.parcelId);
    const rightKind = RIGHT_KINDS.find((candidate) => candidate === input.rightKind) ?? this.badField('right_kind');
    const share = input.sharePct === undefined ? '100' : input.sharePct.trim();
    const documentId = input.titleDocumentVersionId === undefined ? null : lowerId(input.titleDocumentVersionId);
    if (!SHARE.test(share) || Number(share) <= 0 || Number(share) > 100) throw invalid('share_pct');
    if (documentId !== null && !UUID.test(documentId)) throw invalid('title_document_version_id');
    await enterScope(tx, units);
    const household = (await tx.query<{ owner_unit_id: string; project_id: string }>('select owner_unit_id, project_id from machvon.affected_household where id = $1::uuid for update', [id]))[0];
    // A household outside the scope of the caller is not there for them.
    if (household === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const parcel = (await tx.query<{ owner_unit_id: string; project_id: string }>('select owner_unit_id, project_id from machvon.land_parcel where id = $1::uuid for update', [parcelId]))[0];
    if (parcel === undefined) throw invalid('parcel_id', 'NOT_FOUND');
    if (parcel.project_id !== household.project_id) throw invalid('parcel_id', 'NOT_A_PARCEL_OF_THE_PROJECT');
    if (parcel.owner_unit_id !== household.owner_unit_id) throw invalid('parcel_id', 'NOT_A_PARCEL_OF_THE_UNIT');
    if (documentId !== null) {
      const document = (await tx.query<{ scan_status: string }>('select scan_status from machvon.document_version where id = $1::uuid', [documentId]))[0];
      if (document === undefined) throw invalid('title_document_version_id', 'NOT_FOUND');
      if (document.scan_status !== 'CLEAN') throw new DomainError('DOCUMENT_NOT_CLEAN', 422, 'title_document_version_id');
    }
    // The same pair is told as a duplicate whatever the shares: the unique index below settles two links that race.
    if ((await tx.query('select 1 from machvon.household_parcel where household_id = $1::uuid and parcel_id = $2::uuid', [id, parcelId])).length > 0) throw new DomainError('LINK_DUPLICATE', 409, 'parcel_id');
    const others = (await tx.query<{ total: string }>('select coalesce(sum(share_pct), 0)::text as total from machvon.household_parcel where parcel_id = $1::uuid', [parcelId]))[0]?.total ?? '0';
    if (Number(others) + Number(share) > 100) throw new DomainError('SHARE_EXCEEDS_100', 422, 'share_pct', { extensions: { shares_pct: others, share_pct: share } });
    const linkId = randomUUID();
    await withUniqueClaim(tx, { constraint: 'household_parcel_uq', code: 'LINK_DUPLICATE' }, () =>
      tx.query(
        `insert into machvon.household_parcel (tenant_id, id, household_id, parcel_id, owner_unit_id, right_kind, share_pct, title_document_version_id, created_by, updated_by, version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::numeric, $7::uuid, $8::uuid, $8::uuid, 1)`,
        [linkId, id, parcelId, household.owner_unit_id, rightKind, share, documentId, actor],
      ),
    );
    return { id: linkId, householdId: id, parcelId, ownerUnitId: household.owner_unit_id, projectId: household.project_id, rightKind, sharePct: share, titleDocumentVersionId: documentId };
  }

  /** The households of the scope, the lowest code first; the identity number and the telephone number are hidden whole in a unit whose personal data the caller (`personalUnits`) may not read. */
  async list(tx: TenantTx, units: ScopeUnits, filter: HouseholdFilter, personalUnits: ScopeUnits): Promise<HouseholdLine[]> {
    const project = filter.projectId === undefined ? null : lowerId(filter.projectId);
    if (project !== null && !UUID.test(project)) throw invalid('project_id');
    const status = filter.status === undefined ? null : (HOUSEHOLD_STATUSES.find((candidate) => candidate === filter.status) ?? this.badField('status'));
    if (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > MAX_PAGE + 1) throw invalid('limit');
    await enterScope(tx, units);
    const rows = await tx.query<LineSql>(
      `select h.id, h.project_id, h.owner_unit_id, h.household_code, h.head_name, h.national_id_masked, h.phone_masked, h.address_text, h.member_count, h.policy_beneficiary, h.legal_basis, h.legal_basis_ref,
              h.consent_record_id, h.retention_until::text as retention_until, h.dsr_open, h.processing_restricted_at is not null as processing_restricted, h.anonymised_at is not null as anonymised, h.status, ${timestampKey('h.created_at')} as created_at, h.version::text as version
         from machvon.affected_household h
        where ($1::uuid is null or h.project_id = $1::uuid) and ($2::text is null or h.status = $2)
          and ($3::text is null or (h.household_code, h.id) > ($3::text, $4::uuid))
        order by h.household_code, h.id limit ${filter.limit}`,
      [project, status, filter.after?.code ?? null, filter.after?.id ?? null],
    );
    const links =
      rows.length === 0
        ? []
        : await tx.query<{ household_id: string; id: string; parcel_id: string; parcel_code: string; right_kind: RightKind; share_pct: string }>(
            `select l.household_id, l.id, l.parcel_id, p.parcel_code, l.right_kind, l.share_pct::text as share_pct
               from machvon.household_parcel l join machvon.land_parcel p on p.tenant_id = l.tenant_id and p.id = l.parcel_id
              where l.household_id = any($1::uuid[]) order by p.parcel_code, l.id`,
            [rows.map((row) => row.id)],
          );
    const hidden = (row: LineSql, masked: string | null): string | null => (masked === null ? null : unitInScope(personalUnits, row.owner_unit_id) ? masked : FULLY_MASKED);
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      ownerUnitId: row.owner_unit_id,
      householdCode: row.household_code,
      headNameMasked: row.head_name,
      nationalIdMasked: hidden(row, row.national_id_masked),
      phoneMasked: hidden(row, row.phone_masked),
      addressMasked: row.address_text,
      memberCount: row.member_count,
      policyBeneficiary: row.policy_beneficiary,
      legalBasis: row.legal_basis,
      legalBasisRef: row.legal_basis_ref,
      consentRecordId: row.consent_record_id,
      retentionUntil: row.retention_until,
      dsrOpen: row.dsr_open,
      processingRestricted: row.processing_restricted,
      anonymised: row.anonymised,
      status: row.status,
      parcels: links
        .filter((link) => link.household_id === row.id)
        .map((link) => ({ id: link.id, parcelId: link.parcel_id, parcelCode: link.parcel_code, rightKind: link.right_kind, sharePct: link.share_pct })),
      createdAt: row.created_at,
      version: Number(row.version),
    }));
  }

  /** Opens the sealed data of a household; 404 when the household is not in the scope of the caller. The caller writes the audit row that it was read. */
  async reveal(tx: TenantTx, id: string, units: ScopeUnits): Promise<HouseholdIdentity> {
    const householdId = lowerId(id);
    await enterScope(tx, units);
    const row = (
      await tx.query<{
        project_id: string;
        owner_unit_id: string;
        household_code: string;
        head_name_enc: Buffer;
        national_id_enc: Buffer | null;
        phone_enc: Buffer | null;
        address_enc: Buffer | null;
        restricted: boolean;
      }>(
        'select project_id, owner_unit_id, household_code, head_name_enc, national_id_enc, phone_enc, address_enc, processing_restricted_at is not null as restricted from machvon.affected_household where id = $1::uuid',
        [householdId],
      )
    )[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    // The person asked that the data not be processed: it is kept, and it is not opened.
    if (row.restricted) throw new DomainError('PROCESSING_RESTRICTED', 409);
    const tenantId = await this.tenantOf(tx);
    const place = (column: string) => ({ tenantId, table: TABLE, column, rowId: householdId });
    return {
      id: householdId,
      projectId: row.project_id,
      ownerUnitId: row.owner_unit_id,
      householdCode: row.household_code,
      headName: this.cipher.open(place('head_name_enc'), row.head_name_enc),
      nationalId: row.national_id_enc === null ? null : this.cipher.open(place('national_id_enc'), row.national_id_enc),
      phone: row.phone_enc === null ? null : this.cipher.open(place('phone_enc'), row.phone_enc),
      addressText: row.address_enc === null ? null : this.cipher.open(place('address_enc'), row.address_enc),
    };
  }

  /**
   * Handles a request of the person whose data a household holds (ST-LND-003, UAT-AC381). The person who asked has to be verified (422 `REQUESTER_NOT_VERIFIED`). Access and rectification are recorded as served; a restriction
   * stops the sealed data being opened; the withdrawal of a consent erases the optional data (the telephone and the address) of a household registered on that consent; an erasure that is fulfilled anonymises
   * the household, unless a payment was made to it, for which the voucher has to be kept (409 `RETENTION_LEGAL_HOLD`), and is only partly met (the optional data erased, the name and the identity kept) by the officer who says so.
   * A request that is refused changes nothing. The reason is kept with the request.
   */
  async handleRequest(tx: TenantTx, householdId: string, input: HouseholdRequestInput, actor: string, units: ScopeUnits): Promise<HandledRequest> {
    const id = lowerId(householdId);
    const requestKind = REQUEST_KINDS.find((candidate) => candidate === input.requestKind) ?? this.badField('request_kind');
    const outcome = REQUEST_OUTCOMES.find((candidate) => candidate === input.outcome) ?? this.badField('outcome');
    const reason = textOf(input.reason, 'reason', 1, MAX_TEXT);
    await enterScope(tx, units);
    const household = (
      await tx.query<{ project_id: string; owner_unit_id: string; legal_basis: LegalBasis; restricted: boolean; anonymised: boolean; has_nid: boolean; has_phone: boolean; has_address: boolean; version: string }>(
        `select project_id, owner_unit_id, legal_basis, processing_restricted_at is not null as restricted, anonymised_at is not null as anonymised, national_id_enc is not null as has_nid,
                phone_enc is not null as has_phone, address_enc is not null as has_address, version::text as version
           from machvon.affected_household where id = $1::uuid for update`,
        [id],
      )
    )[0];
    // A household outside the scope of the caller is not there for them.
    if (household === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (input.requesterVerified !== true) throw new DomainError('REQUESTER_NOT_VERIFIED', 422, 'requester_verified');
    const retained = Number((await tx.query<{ n: string }>("select count(*)::text as n from machvon.compensation_payment where household_id = $1::uuid and status in ('PAID', 'DEPOSITED')", [id]))[0]?.n ?? '0');
    let erase: 'ALL' | 'OPTIONAL' | 'NONE' = 'NONE';
    let restrict = false;
    if (outcome !== 'REFUSED') {
      if (requestKind === 'ERASE') {
        if (outcome === 'FULFILLED' && retained > 0) throw new DomainError('RETENTION_LEGAL_HOLD', 409, 'request_kind', { extensions: { retained_payments: retained } });
        erase = outcome === 'FULFILLED' ? 'ALL' : 'OPTIONAL';
      } else if (requestKind === 'WITHDRAW_CONSENT') {
        if (household.legal_basis !== 'CONSENT') throw invalid('request_kind', 'NOT_CONSENT_BASED');
        erase = 'OPTIONAL';
      } else if (requestKind === 'RESTRICT') {
        restrict = true;
      }
    }
    const erasedFields: ErasedField[] = [];
    if (erase !== 'NONE' && !household.anonymised) {
      if (erase === 'ALL') erasedFields.push('head_name');
      if (erase === 'ALL' && household.has_nid) erasedFields.push('national_id');
      if (household.has_phone) erasedFields.push('phone');
      if (household.has_address) erasedFields.push('address_text');
    }
    const anonymise = erase === 'ALL' && !household.anonymised;
    let version = Number(household.version);
    if (anonymise || erasedFields.length > 0 || (restrict && !household.restricted)) {
      const tenantId = await this.tenantOf(tx);
      const sealedName = this.cipher.seal({ tenantId, table: TABLE, column: 'head_name_enc', rowId: id }, ERASED_NAME);
      const updated = await tx.query<{ version: string }>(
        `update machvon.affected_household set
            head_name = case when $2 then $3 else head_name end,
            head_name_enc = case when $2 then $4 else head_name_enc end,
            national_id_enc = case when $2 then null else national_id_enc end,
            national_id_hash = case when $2 then null else national_id_hash end,
            national_id_masked = case when $2 then null else national_id_masked end,
            phone_enc = case when $5 then null else phone_enc end,
            phone_masked = case when $5 then null else phone_masked end,
            address_text = case when $6 then null else address_text end,
            address_enc = case when $6 then null else address_enc end,
            anonymised_at = case when $2 then now() else anonymised_at end,
            processing_restricted_at = case when $7 then coalesce(processing_restricted_at, now()) else processing_restricted_at end,
            updated_at = now(), updated_by = $8::uuid, version = version + 1
          where id = $1::uuid returning version::text as version`,
        [id, anonymise, ERASED_NAME, sealedName, erasedFields.includes('phone'), erasedFields.includes('address_text'), restrict, actor],
      );
      version = Number(updated[0]?.version ?? version + 1);
    }
    const requestId = randomUUID();
    await tx.query(
      `insert into machvon.household_data_request
         (tenant_id, id, household_id, owner_unit_id, request_kind, requester_verified, outcome, reason, erased_fields, retained_payments, restricted, handled_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, true, $5, $6, $7::text[], $8, $9, $10::uuid)`,
      [requestId, id, household.owner_unit_id, requestKind, outcome, reason, erasedFields, retained, restrict, actor],
    );
    return {
      id: requestId,
      householdId: id,
      projectId: household.project_id,
      ownerUnitId: household.owner_unit_id,
      requestKind,
      outcome,
      erasedFields,
      retainedPayments: retained,
      restricted: restrict,
      anonymised: anonymise || household.anonymised,
      version,
    };
  }

  private badField(field: string): never {
    throw invalid(field);
  }

  private async tenantOf(tx: TenantTx): Promise<string> {
    const tenant = (await tx.query<{ tenant_id: string | null }>("select nullif(current_setting('app.tenant_id', true), '')::text as tenant_id"))[0]?.tenant_id;
    if (tenant === undefined || tenant === null) throw new Error('the household store ran outside a tenant');
    return tenant;
  }
}
