import { randomUUID } from 'node:crypto';
import {
  DomainError,
  assertOwnersCoherent,
  duplicatePairOf,
  duplicateSuggestionMove,
  foldForMatch,
  hasControlChar,
  matchKeyOf,
  normaliseAddress,
  normaliseEmail,
  normalisePhoneNumber,
  profileCoverage,
  scoreDuplicate,
  versionConflict,
} from '@machvon/kernel';
import type { ControlBasis, DuplicateFacts, DuplicateSignal, DuplicateSuggestionState, DuplicateWeights, OwnerFacts, OwnerKind, OwnershipDeclaration, ProfileCoverage, ProfileField, ProfileFacts } from '@machvon/kernel';
import { timestampKey } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
/** The most rows one page of the register reads before the coverage filter. */
const SCAN_CAP = 1000;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export interface VendorProfileRow {
  contractorId: string;
  taxIdentifier: string;
  legalName: string;
  verificationStatus: string;
  legalRepName: string | null;
  legalRepPosition: string | null;
  registeredAddress: string | null;
  phone: string | null;
  phoneSetAt: string | null;
  email: string | null;
  businessRegistrationNo: string | null;
  ownershipDeclaration: OwnershipDeclaration | null;
  profileReviewedAt: string | null;
  nextReviewDue: string | null;
  ownerCount: number;
  version: number;
}

export interface OwnerRow {
  id: string;
  contractorId: string;
  ownerKind: OwnerKind;
  ownerName: string;
  hasIdentityKey: boolean;
  sharePct: string | null;
  beneficialOwner: boolean;
  controlBasis: ControlBasis | null;
  sourceDocumentId: string | null;
  sinceOn: string;
  endedOn: string | null;
  endedReason: string | null;
  version: number;
}

export interface ProfileInput {
  legalRepName?: string | null | undefined;
  legalRepPosition?: string | null | undefined;
  registeredAddress?: string | null | undefined;
  phone?: string | null | undefined;
  email?: string | null | undefined;
  businessRegistrationNo?: string | null | undefined;
}

export interface OwnerInput {
  ownerKind: OwnerKind;
  ownerName: string;
  /** The number of an identity document or registration, kept only as a blind key for matching; never stored. */
  identityNumber?: string | undefined;
  sharePct?: string | undefined;
  beneficialOwner: boolean;
  controlBasis?: ControlBasis | undefined;
  sourceDocumentId?: string | undefined;
}

export interface SuggestionRow {
  id: string;
  contractorAId: string;
  contractorBId: string;
  contractorAName: string;
  contractorBName: string;
  contractorATax: string;
  contractorBTax: string;
  score: number;
  signals: DuplicateSignal[];
  status: DuplicateSuggestionState;
  decisionReason: string | null;
  version: number;
}

export interface RegisterFilter {
  q?: string | undefined;
  verification?: string | undefined;
  coverage?: 'COMPLETE' | 'INCOMPLETE' | undefined;
  restricted?: boolean | undefined;
  hasOpenCase?: boolean | undefined;
  limit: number;
  after?: { code: string; id: string } | undefined;
}

export interface RegisterRow {
  profile: VendorProfileRow;
  coverage: ProfileCoverage;
  restricted: boolean;
  openCases: number;
  activeAccounts: number;
  qualificationsExpiring: number;
  createdAtKey: string;
}

interface ProfileSql {
  id: string;
  tax_identifier: string;
  legal_name: string;
  verification_status: string;
  legal_rep_name: string | null;
  legal_rep_position: string | null;
  registered_address: string | null;
  phone: string | null;
  phone_set_at: string | null;
  email: string | null;
  business_registration_no: string | null;
  ownership_declaration: OwnershipDeclaration | null;
  profile_reviewed_at: string | null;
  next_review_due: string | null;
  owner_count: number;
  version: string;
}

const PROFILE_SELECT = `select c.id, c.tax_identifier, c.legal_name, c.verification_status, c.legal_rep_name, c.legal_rep_position, c.registered_address, c.phone, ${timestampKey('c.phone_set_at')} as phone_set_at,
  c.email, c.business_registration_no, c.ownership_declaration, ${timestampKey('c.profile_reviewed_at')} as profile_reviewed_at, c.next_review_due::text as next_review_due,
  (select count(*) from machvon.contractor_owner o where o.tenant_id = c.tenant_id and o.contractor_id = c.id and o.ended_on is null)::int as owner_count, c.version::text as version`;

const toProfile = (row: ProfileSql): VendorProfileRow => ({
  contractorId: row.id,
  taxIdentifier: row.tax_identifier,
  legalName: row.legal_name,
  verificationStatus: row.verification_status,
  legalRepName: row.legal_rep_name,
  legalRepPosition: row.legal_rep_position,
  registeredAddress: row.registered_address,
  phone: row.phone,
  phoneSetAt: row.phone_set_at,
  email: row.email,
  businessRegistrationNo: row.business_registration_no,
  ownershipDeclaration: row.ownership_declaration,
  profileReviewedAt: row.profile_reviewed_at,
  nextReviewDue: row.next_review_due,
  ownerCount: row.owner_count,
  version: Number(row.version),
});

/** The facts the completeness of a profile is judged on. */
export const factsOfProfile = (row: VendorProfileRow): ProfileFacts => ({
  legalRepName: row.legalRepName,
  registeredAddress: row.registeredAddress,
  phone: row.phone,
  email: row.email,
  businessRegistrationNo: row.businessRegistrationNo,
  ownerCount: row.ownerCount,
  ownershipDeclaration: row.ownershipDeclaration,
});

function textOf(value: string, field: string, min: number, max: number): string {
  const text = value.trim();
  if (text.length < min || text.length > max || hasControlChar(text)) throw invalid(field);
  return text;
}

const addMonths = (day: string, months: number): string => {
  const start = new Date(`${day}T00:00:00Z`);
  const target = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(start.getUTCDate(), last))).toISOString().slice(0, 10);
};

/**
 * The master profile of a contractor (VND-1, V1): the legal representative, the registered address, the contact, the business registration number and the owners, with the normal-form key of each so that a duplicate is
 * found without comparing the words of a person. A contractor already has an identity (BID: tax id, legal name, verification); this store adds what a bid and a contract ask to be known and never changes the identity. An
 * owner is never rewritten: it ends and a new one is added. The suggestions of duplicates are for a person to dismiss or to send to the merge of master data; nothing here merges.
 */
export class VendorProfileStore {
  async find(tx: TenantTx, contractorId: string, lock = false): Promise<VendorProfileRow | undefined> {
    const rows = await tx.query<ProfileSql>(`${PROFILE_SELECT} from machvon.contractor c where c.id = $1::uuid${lock ? ' for update of c' : ''}`, [contractorId]);
    return rows[0] === undefined ? undefined : toProfile(rows[0]);
  }

  async require(tx: TenantTx, contractorId: string, lock = false): Promise<VendorProfileRow> {
    const row = await this.find(tx, contractorId, lock);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return row;
  }

  /** The contractors of the register with what a person wants to see at a glance. The coverage is judged against the fields the policy asks for. */
  async register(tx: TenantTx, filter: RegisterFilter, required: readonly ProfileField[], today: string, warnDays: number): Promise<RegisterRow[]> {
    const params: unknown[] = [];
    const add = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = ['true'];
    if (filter.q !== undefined && filter.q !== '') {
      const q = add(`%${filter.q.replace(/[%_\\]/g, (char) => `\\${char}`)}%`);
      where.push(`(c.legal_name ilike ${q} or c.tax_identifier like ${q})`);
    }
    if (filter.verification !== undefined) where.push(`c.verification_status = ${add(filter.verification)}`);
    if (filter.after !== undefined) where.push(`(${timestampKey('c.created_at')}, c.id) < (${add(filter.after.code)}::text, ${add(filter.after.id)}::uuid)`);
    const dayParam = add(today);
    const warnParam = add(warnDays);
    const restrictedSql = `exists (select 1 from machvon.contractor_restriction r where r.tenant_id = c.tenant_id and r.contractor_id = c.id and r.lifted_at is null and r.effective_from <= ${dayParam}::date and (r.effective_until is null or r.effective_until >= ${dayParam}::date))`;
    const openCaseSql = "exists (select 1 from machvon.restriction_case k where k.tenant_id = c.tenant_id and k.contractor_id = c.id and k.status in ('PROPOSED', 'NOTICE_SENT', 'RESPONSE_RECEIVED', 'DECIDED'))";
    if (filter.restricted !== undefined) where.push(filter.restricted ? restrictedSql : `not ${restrictedSql}`);
    if (filter.hasOpenCase !== undefined) where.push(filter.hasOpenCase ? openCaseSql : `not ${openCaseSql}`);
    const rows = await tx.query<ProfileSql & { restricted: boolean; open_cases: number; active_accounts: number; expiring: number; created_at_key: string }>(
      `${PROFILE_SELECT},
         ${restrictedSql} as restricted,
         (select count(*) from machvon.restriction_case k where k.tenant_id = c.tenant_id and k.contractor_id = c.id and k.status in ('PROPOSED', 'NOTICE_SENT', 'RESPONSE_RECEIVED', 'DECIDED'))::int as open_cases,
         (select count(*) from machvon.contractor_bank_account a where a.tenant_id = c.tenant_id and a.contractor_id = c.id and a.state = 'ACTIVE')::int as active_accounts,
         (select count(*) from machvon.contractor_qualification q where q.tenant_id = c.tenant_id and q.contractor_id = c.id and q.revoked_at is null and q.expires_on is not null and q.expires_on <= (${dayParam}::date + ${warnParam}::int))::int as expiring,
         ${timestampKey('c.created_at')} as created_at_key
       from machvon.contractor c
       where ${where.join(' and ')}
       order by c.created_at desc, c.id desc
       limit ${add(SCAN_CAP)}`,
      params,
    );
    const mapped = rows.map((row) => {
      const profile = toProfile(row);
      return { profile, coverage: profileCoverage(factsOfProfile(profile), required), restricted: row.restricted, openCases: row.open_cases, activeAccounts: row.active_accounts, qualificationsExpiring: row.expiring, createdAtKey: row.created_at_key };
    });
    // The coverage depends on the fields the policy asks for, so it is judged here; the scan is bounded and the page is the first rows that pass.
    return mapped.filter((row) => (filter.coverage === undefined ? true : filter.coverage === 'COMPLETE' ? row.coverage.complete : !row.coverage.complete)).slice(0, filter.limit + 1);
  }

  async owners(tx: TenantTx, contractorId: string, includeEnded = true): Promise<OwnerRow[]> {
    const rows = await tx.query<{
      id: string;
      contractor_id: string;
      owner_kind: OwnerKind;
      owner_name: string;
      identity_key: string | null;
      share_pct: string | null;
      beneficial_owner: boolean;
      control_basis: ControlBasis | null;
      source_document_id: string | null;
      since_on: string;
      ended_on: string | null;
      ended_reason: string | null;
      version: string;
    }>(
      `select id, contractor_id, owner_kind, owner_name, identity_key, share_pct::text as share_pct, beneficial_owner, control_basis, source_document_id, since_on::text as since_on, ended_on::text as ended_on, ended_reason, version::text as version
         from machvon.contractor_owner where contractor_id = $1::uuid ${includeEnded ? '' : 'and ended_on is null'} order by ended_on nulls first, since_on, id`,
      [contractorId],
    );
    return rows.map((row) => ({
      id: row.id,
      contractorId: row.contractor_id,
      ownerKind: row.owner_kind,
      ownerName: row.owner_name,
      hasIdentityKey: row.identity_key !== null,
      sharePct: row.share_pct,
      beneficialOwner: row.beneficial_owner,
      controlBasis: row.control_basis,
      sourceDocumentId: row.source_document_id,
      sinceOn: row.since_on,
      endedOn: row.ended_on,
      endedReason: row.ended_reason,
      version: Number(row.version),
    }));
  }

  /**
   * Sets the profile fields that are given (a field left out is unchanged, `null` clears it). The tax id, the legal name and the verification are not here (BID owns them). The keys of the address, the telephone number,
   * the e-mail address and the representative are made again; the day the telephone number was put on file moves only when the number changes. The next review is `review_months` after today. 409 `VERSION_CONFLICT`.
   */
  async update(tx: TenantTx, contractorId: string, expectedVersion: number, input: ProfileInput, actor: string, today: string, reviewMonths: number): Promise<VendorProfileRow> {
    const current = await this.require(tx, contractorId, true);
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    const set: string[] = [];
    const params: unknown[] = [contractorId, actor];
    const add = (column: string, value: unknown, cast = ''): void => {
      params.push(value);
      set.push(`${column} = $${params.length}${cast}`);
    };
    if (input.legalRepName !== undefined) {
      const name = input.legalRepName === null ? null : textOf(input.legalRepName, 'legal_rep_name', 2, 300);
      add('legal_rep_name', name);
      add('legal_rep_key', name === null ? null : matchKeyOf(foldForMatch(name)));
    }
    if (input.legalRepPosition !== undefined) add('legal_rep_position', input.legalRepPosition === null ? null : textOf(input.legalRepPosition, 'legal_rep_position', 2, 200));
    if (input.registeredAddress !== undefined) {
      const address = input.registeredAddress === null ? null : textOf(input.registeredAddress, 'registered_address', 8, 500);
      const normal = address === null ? null : normaliseAddress(address);
      if (address !== null && normal === null) throw invalid('registered_address');
      add('registered_address', address);
      add('address_key', normal === null ? null : matchKeyOf(normal));
    }
    if (input.phone !== undefined) {
      const phone = input.phone === null ? null : normalisePhoneNumber(input.phone);
      if (input.phone !== null && phone === null) throw invalid('phone');
      add('phone', phone);
      add('phone_key', phone === null ? null : matchKeyOf(phone));
      if (phone !== current.phone) add('phone_set_at', phone === null ? null : new Date().toISOString(), '::timestamptz');
    }
    if (input.email !== undefined) {
      const email = input.email === null ? null : normaliseEmail(input.email);
      if (input.email !== null && email === null) throw invalid('email');
      add('email', email?.address ?? null);
      add('email_key', email === null ? null : matchKeyOf(email.address));
    }
    if (input.businessRegistrationNo !== undefined) add('business_registration_no', input.businessRegistrationNo === null ? null : textOf(input.businessRegistrationNo, 'business_registration_no', 3, 40));
    add('profile_reviewed_at', new Date().toISOString(), '::timestamptz');
    add('next_review_due', addMonths(today, reviewMonths), '::date');
    await tx.query(`update machvon.contractor set ${set.join(', ')}, updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid`, params);
    return this.require(tx, contractorId);
  }

  /** The contractor says nobody holds more than the threshold (with the person who declared it); allowed only while no owner is listed. */
  async declareNoOwnerAboveThreshold(tx: TenantTx, contractorId: string, expectedVersion: number, actor: string): Promise<VendorProfileRow> {
    const current = await this.require(tx, contractorId, true);
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    if (current.ownerCount > 0) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'ownership_declaration');
    await tx.query(
      `update machvon.contractor set ownership_declaration = 'NO_OWNER_ABOVE_THRESHOLD', ownership_declared_by = $2::uuid, ownership_declared_at = now(), updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid`,
      [contractorId, actor],
    );
    return this.require(tx, contractorId);
  }

  /**
   * Adds an owner. The active owners together with the new one must still make sense (shares not above a whole, a basis for an owner without a share). The number of an identity document is turned into a blind key by
   * `identityKeyOf` (the field cipher of the process) and never stored. The declaration of the contractor becomes OWNERS_LISTED.
   */
  async addOwner(tx: TenantTx, contractorId: string, input: OwnerInput, actor: string, identityKeyOf: (number: string) => string): Promise<OwnerRow> {
    await this.require(tx, contractorId, true);
    const candidate: OwnerFacts = { kind: input.ownerKind, name: input.ownerName, sharePct: input.sharePct ?? null, beneficialOwner: input.beneficialOwner, controlBasis: input.controlBasis ?? null };
    const active = await this.owners(tx, contractorId, false);
    assertOwnersCoherent([...active.map((owner) => ({ kind: owner.ownerKind, name: owner.ownerName, sharePct: owner.sharePct, beneficialOwner: owner.beneficialOwner, controlBasis: owner.controlBasis })), candidate]);
    const name = textOf(input.ownerName, 'owner_name', 1, 300);
    const identityKey = input.identityNumber === undefined ? null : identityKeyOf(textOf(input.identityNumber, 'identity_number', 5, 40).replace(/[\s-]/g, ''));
    if (input.sourceDocumentId !== undefined && (await tx.query('select 1 from machvon.document where id = $1::uuid', [input.sourceDocumentId])).length === 0) throw invalid('source_document_id');
    const id = randomUUID();
    await tx.query(
      `insert into machvon.contractor_owner (tenant_id, id, contractor_id, owner_kind, owner_name, name_key, identity_key, share_pct, beneficial_owner, control_basis, source_document_id, created_by, updated_by)
       values (${TENANT}, $1::uuid, $2::uuid, $3, $4, $5, $6, $7::numeric, $8, $9, $10::uuid, $11::uuid, $11::uuid)`,
      [id, contractorId, input.ownerKind, name, matchKeyOf(foldForMatch(name)), identityKey, input.sharePct ?? null, input.beneficialOwner, input.controlBasis ?? null, input.sourceDocumentId ?? null, actor],
    );
    await tx.query(
      `update machvon.contractor set ownership_declaration = 'OWNERS_LISTED', ownership_declared_by = coalesce(ownership_declared_by, $2::uuid), ownership_declared_at = coalesce(ownership_declared_at, now()), updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid`,
      [contractorId, actor],
    );
    const added = (await this.owners(tx, contractorId)).find((owner) => owner.id === id);
    return added as OwnerRow;
  }

  /** Ends an owner with a reason; the row stays as the history of ownership at the date of a bid. 404 for an owner that is not in the tenant, 409 for one that has ended. */
  async endOwner(tx: TenantTx, ownerId: string, reason: string, actor: string, today: string): Promise<OwnerRow> {
    const why = textOf(reason, 'reason', 5, 500);
    const [held] = await tx.query<{ contractor_id: string }>('select contractor_id from machvon.contractor_owner where id = $1::uuid', [ownerId]);
    if (held === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const contractorId = held.contractor_id;
    const found = (await this.owners(tx, contractorId)).find((owner) => owner.id === ownerId);
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (found.endedOn !== null) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'ended_on');
    await tx.query('update machvon.contractor_owner set ended_on = greatest($2::date, since_on), ended_reason = $3, updated_at = now(), updated_by = $4::uuid, version = version + 1 where id = $1::uuid', [ownerId, today, why, actor]);
    return (await this.owners(tx, contractorId)).find((owner) => owner.id === ownerId) as OwnerRow;
  }

  // -- Duplicates ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  private async factsOf(tx: TenantTx, ids: readonly string[]): Promise<Map<string, DuplicateFacts & { id: string; name: string; tax: string }>> {
    const rows = await tx.query<{ id: string; name: string; tax: string; address_key: string | null; phone_key: string | null; email_key: string | null; legal_rep_key: string | null; owners: string[]; accounts: string[] }>(
      `select c.id, c.legal_name as name, c.tax_identifier as tax, c.address_key, c.phone_key, c.email_key, c.legal_rep_key,
              coalesce((select array_agg(o.name_key::text) || array_agg(o.identity_key::text) filter (where o.identity_key is not null) from machvon.contractor_owner o where o.tenant_id = c.tenant_id and o.contractor_id = c.id and o.ended_on is null), '{}') as owners,
              coalesce((select array_agg(a.account_no_key::text) from machvon.contractor_bank_account a where a.tenant_id = c.tenant_id and a.contractor_id = c.id and a.state in ('ACTIVE', 'SUPERSEDED')), '{}') as accounts
         from machvon.contractor c where c.id = any($1::uuid[])`,
      [[...ids]],
    );
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          name: row.name,
          tax: row.tax,
          taxHead: row.tax.slice(0, 10),
          addressKey: row.address_key,
          phoneKey: row.phone_key,
          emailKey: row.email_key,
          legalRepKey: row.legal_rep_key,
          ownerKeys: row.owners.filter((key) => key !== null),
          bankAccountKeys: row.accounts,
        },
      ]),
    );
  }

  /** The contractors that share at least one key with this one: the candidates the score is computed for (nothing is compared by name alone). */
  private async candidatesOf(tx: TenantTx, contractorId: string): Promise<string[]> {
    const rows = await tx.query<{ id: string }>(
      `select distinct o.id from machvon.contractor c
         join machvon.contractor o on o.tenant_id = c.tenant_id and o.id <> c.id and (
              left(o.tax_identifier, 10) = left(c.tax_identifier, 10)
           or (c.address_key is not null and o.address_key = c.address_key)
           or (c.phone_key is not null and o.phone_key = c.phone_key)
           or (c.email_key is not null and o.email_key = c.email_key)
           or (c.legal_rep_key is not null and o.legal_rep_key = c.legal_rep_key)
           or exists (select 1 from machvon.contractor_owner x join machvon.contractor_owner y on y.tenant_id = x.tenant_id and y.contractor_id = o.id and y.ended_on is null and (y.name_key = x.name_key or (y.identity_key is not null and y.identity_key = x.identity_key))
                       where x.tenant_id = c.tenant_id and x.contractor_id = c.id and x.ended_on is null)
           or exists (select 1 from machvon.contractor_bank_account x join machvon.contractor_bank_account y on y.tenant_id = x.tenant_id and y.contractor_id = o.id and y.account_no_key = x.account_no_key
                       where x.tenant_id = c.tenant_id and x.contractor_id = c.id))
        where c.id = $1::uuid`,
      [contractorId],
    );
    return rows.map((row) => row.id);
  }

  /**
   * Scores a contractor against every other that shares a key and keeps the pairs at or over the line as suggestions (a pair is one row, smaller id first). A pair a person dismissed comes back only when its score
   * rises above the score it was dismissed at. Returns the suggestions now open for the contractor.
   */
  async scan(tx: TenantTx, contractorId: string, weights: DuplicateWeights): Promise<SuggestionRow[]> {
    const candidates = await this.candidatesOf(tx, contractorId);
    if (candidates.length > 0) {
      const facts = await this.factsOf(tx, [contractorId, ...candidates]);
      const mine = facts.get(contractorId);
      if (mine !== undefined) {
        for (const other of candidates) {
          const theirs = facts.get(other);
          if (theirs === undefined) continue;
          const result = scoreDuplicate(mine, theirs, weights);
          if (!result.suggested) continue;
          const [a, b] = duplicatePairOf(contractorId, other);
          await tx.query(
            `insert into machvon.contractor_duplicate_suggestion (tenant_id, id, contractor_a_id, contractor_b_id, score, signals)
             values (${TENANT}, gen_random_uuid(), $1::uuid, $2::uuid, $3, $4::text[])
             on conflict (tenant_id, contractor_a_id, contractor_b_id) do update
               set score = excluded.score, signals = excluded.signals, last_scored_at = now(),
                   status = case when machvon.contractor_duplicate_suggestion.status = 'DISMISSED' and excluded.score > coalesce(machvon.contractor_duplicate_suggestion.dismissed_score, 0) then 'OPEN' else machvon.contractor_duplicate_suggestion.status end,
                   decided_by = case when machvon.contractor_duplicate_suggestion.status = 'DISMISSED' and excluded.score > coalesce(machvon.contractor_duplicate_suggestion.dismissed_score, 0) then null else machvon.contractor_duplicate_suggestion.decided_by end,
                   decided_at = case when machvon.contractor_duplicate_suggestion.status = 'DISMISSED' and excluded.score > coalesce(machvon.contractor_duplicate_suggestion.dismissed_score, 0) then null else machvon.contractor_duplicate_suggestion.decided_at end,
                   decision_reason = case when machvon.contractor_duplicate_suggestion.status = 'DISMISSED' and excluded.score > coalesce(machvon.contractor_duplicate_suggestion.dismissed_score, 0) then null else machvon.contractor_duplicate_suggestion.decision_reason end,
                   version = machvon.contractor_duplicate_suggestion.version + (case when machvon.contractor_duplicate_suggestion.status = 'DISMISSED' and excluded.score > coalesce(machvon.contractor_duplicate_suggestion.dismissed_score, 0) then 1 else 0 end)`,
            [a, b, result.score, result.signals],
          );
        }
      }
    }
    return this.suggestions(tx, { contractorId, status: 'OPEN' });
  }

  async suggestions(tx: TenantTx, filter: { contractorId?: string | undefined; status?: DuplicateSuggestionState | undefined; limit?: number | undefined }): Promise<SuggestionRow[]> {
    const rows = await tx.query<{ id: string; a: string; b: string; a_name: string; b_name: string; a_tax: string; b_tax: string; score: number; signals: DuplicateSignal[]; status: DuplicateSuggestionState; decision_reason: string | null; version: string }>(
      `select s.id, s.contractor_a_id as a, s.contractor_b_id as b, ca.legal_name as a_name, cb.legal_name as b_name, ca.tax_identifier as a_tax, cb.tax_identifier as b_tax, s.score, s.signals, s.status, s.decision_reason, s.version::text as version
         from machvon.contractor_duplicate_suggestion s
         join machvon.contractor ca on ca.tenant_id = s.tenant_id and ca.id = s.contractor_a_id
         join machvon.contractor cb on cb.tenant_id = s.tenant_id and cb.id = s.contractor_b_id
        where ($1::uuid is null or s.contractor_a_id = $1::uuid or s.contractor_b_id = $1::uuid) and ($2::text is null or s.status = $2)
        order by s.score desc, s.id limit $3`,
      [filter.contractorId ?? null, filter.status ?? null, filter.limit ?? 200],
    );
    return rows.map((row) => ({ id: row.id, contractorAId: row.a, contractorBId: row.b, contractorAName: row.a_name, contractorBName: row.b_name, contractorATax: row.a_tax, contractorBTax: row.b_tax, score: row.score, signals: row.signals, status: row.status, decisionReason: row.decision_reason, version: Number(row.version) }));
  }

  /** Dismisses a suggestion or sends it to the merge of master data (MDM F5), with a reason, by a person; decided once (409 `STAGE_TRANSITION_DENIED`). */
  async decideSuggestion(tx: TenantTx, suggestionId: string, expectedVersion: number, decision: Exclude<DuplicateSuggestionState, 'OPEN'>, reason: string, actor: string): Promise<SuggestionRow> {
    const why = textOf(reason, 'reason', 5, 500);
    const [found] = await tx.query<{ status: DuplicateSuggestionState; version: string; score: number }>('select status, version::text as version, score from machvon.contractor_duplicate_suggestion where id = $1::uuid for update', [suggestionId]);
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(found.version) !== expectedVersion) throw versionConflict(Number(found.version));
    duplicateSuggestionMove(found.status, decision);
    await tx.query(
      `update machvon.contractor_duplicate_suggestion set status = $2, decided_by = $3::uuid, decided_at = now(), decision_reason = $4, dismissed_score = case when $2 = 'DISMISSED' then score else null end, version = version + 1 where id = $1::uuid`,
      [suggestionId, decision, actor, why],
    );
    const decided = (await this.suggestions(tx, {})).find((row) => row.id === suggestionId);
    if (decided !== undefined) return decided;
    const [row] = await tx.query<{ contractor_a_id: string }>('select contractor_a_id from machvon.contractor_duplicate_suggestion where id = $1::uuid', [suggestionId]);
    return (await this.suggestions(tx, { contractorId: row?.contractor_a_id }))[0] as SuggestionRow;
  }
}
