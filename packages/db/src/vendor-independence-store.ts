import { createHash, randomUUID } from 'node:crypto';
import { DomainError, assertFindingDecision, decisionFitsFinding, detectIndependence, foldForMatch, hasControlChar, independenceGate, matchKeyOf, versionConflict } from '@machvon/kernel';
import type { FindingDecision, FindingKind, FindingStrength, IndependenceFinding, IndependenceGate, IndependencePerson, IndependencePolicy, InterestFacts, InterestKind, OwnerKeys, PartyFacts, PartyRef } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';
import type { Policy } from './vendor-policy.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const iso = (column: string): string => `to_char(${column} at time zone 'UTC', ${ISO})`;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const isDay = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

// -- Interests ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface InterestRow {
  id: string;
  membershipId: string;
  memberName: string | null;
  kind: InterestKind;
  relatedName: string | null;
  relation: string | null;
  hasRelatedIdentity: boolean;
  contractorId: string | null;
  contractorName: string | null;
  taxHead: string | null;
  sharePct: string | null;
  sinceOn: string;
  endedOn: string | null;
  endedReason: string | null;
  documentId: string | null;
  createdBy: string;
  version: number;
}

export interface NewInterest {
  membershipId: string;
  kind: InterestKind;
  relatedName?: string | undefined;
  /** The number of an identity document of a relative: kept only as a blind index, never stored. */
  relatedIdentityNumber?: string | undefined;
  relation?: string | undefined;
  contractorId?: string | undefined;
  taxCode?: string | undefined;
  sharePct?: string | undefined;
  sinceOn?: string | undefined;
  endedOn?: string | undefined;
  documentId?: string | undefined;
}

interface InterestSql {
  id: string;
  membership_id: string;
  member_name: string | null;
  kind: InterestKind;
  related_name: string | null;
  relation: string | null;
  has_identity: boolean;
  contractor_id: string | null;
  contractor_name: string | null;
  tax_head: string | null;
  share_pct: string | null;
  since_on: string;
  ended_on: string | null;
  ended_reason: string | null;
  document_id: string | null;
  created_by: string;
  version: string;
}

const INTEREST_SELECT = `select i.id, i.membership_id, d.display_name as member_name, i.kind, i.related_name, i.relation, (i.related_identity_key is not null) as has_identity, i.contractor_id, c.legal_name as contractor_name,
  i.tax_head, i.share_pct::text as share_pct, i.since_on::text as since_on, i.ended_on::text as ended_on, i.ended_reason, i.document_id, i.created_by, i.version::text as version
  from machvon.vendor_person_interest i
  left join machvon.tenant_user_directory d on d.tenant_id = i.tenant_id and d.membership_id = i.membership_id
  left join machvon.contractor c on c.tenant_id = i.tenant_id and c.id = i.contractor_id`;

const toInterest = (row: InterestSql): InterestRow => ({
  id: row.id,
  membershipId: row.membership_id,
  memberName: row.member_name,
  kind: row.kind,
  relatedName: row.related_name,
  relation: row.relation,
  hasRelatedIdentity: row.has_identity,
  contractorId: row.contractor_id,
  contractorName: row.contractor_name,
  taxHead: row.tax_head,
  sharePct: row.share_pct,
  sinceOn: row.since_on,
  endedOn: row.ended_on,
  endedReason: row.ended_reason,
  documentId: row.document_id,
  createdBy: row.created_by,
  version: Number(row.version),
});

function textOf(value: string, field: string, min: number, max: number): string {
  const text = value.trim();
  if (text.length < min || text.length > max || hasControlChar(text)) throw invalid(field);
  return text;
}

/** The head of a tax code: the first ten digits (a branch counted with its head office). */
export const taxHeadOf = (taxCode: string): string | null => {
  const digits = taxCode.replace(/[^0-9]/g, '');
  return digits.length >= 10 ? digits.slice(0, 10) : null;
};

// -- Checks and findings --------------------------------------------------------------------------------------------------------------------------------------------------------

export interface IndependenceFindingRow {
  id: string;
  checkId: string;
  packageId: string;
  fingerprint: string;
  kind: FindingKind;
  strength: FindingStrength;
  parties: [PartyRef, PartyRef];
  partyNames: [string | null, string | null];
  evidence: Record<string, string | number | boolean | null>;
  raisedBy: string;
  carriedFromId: string | null;
  decision: FindingDecision | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  version: number;
}

export interface CheckRow {
  id: string;
  packageId: string;
  runBy: string;
  runAt: string;
  ruleVersion: string;
  ruleUnverified: boolean;
  inputsDigest: string;
  panelIds: string[];
  staffIds: string[];
  ownerTaxHead: string | null;
  biddersCount: number;
  findingsCount: number;
  strongCount: number;
}

export interface IndependenceView {
  check: CheckRow;
  findings: IndependenceFindingRow[];
  gate: IndependenceGate;
}

export interface RunCheckInput {
  panelMembershipIds: readonly string[];
  staffMembershipIds: readonly string[];
  /** The tax code of the owner organisation (the investor); optional. */
  ownerTaxCode?: string | undefined;
}

interface CheckSql {
  id: string;
  package_id: string;
  run_by: string;
  run_at: string;
  rule_version: string;
  rule_unverified: boolean;
  inputs_digest: string;
  panel_ids: string[];
  staff_ids: string[];
  owner_tax_head: string | null;
  bidders_count: number;
  findings_count: number;
  strong_count: number;
}

interface FindingSql {
  id: string;
  check_id: string;
  package_id: string;
  fingerprint: string;
  kind: FindingKind;
  strength: FindingStrength;
  parties: [PartyRef, PartyRef];
  evidence: Record<string, string | number | boolean | null>;
  raised_by: string;
  carried_from_id: string | null;
  decision: FindingDecision | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  version: string;
}

const CHECK_SELECT = `select id, package_id, run_by, ${iso('run_at')} as run_at, rule_version, rule_unverified, inputs_digest, panel_ids, staff_ids, owner_tax_head, bidders_count, findings_count, strong_count from machvon.vendor_independence_check`;
const FINDING_SELECT = `select id, check_id, package_id, fingerprint, kind, strength, parties, evidence, raised_by, carried_from_id, decision, decided_by, ${iso('decided_at')} as decided_at, decision_reason, version::text as version from machvon.vendor_independence_finding`;

const toCheck = (row: CheckSql): CheckRow => ({
  id: row.id,
  packageId: row.package_id,
  runBy: row.run_by,
  runAt: row.run_at,
  ruleVersion: row.rule_version,
  ruleUnverified: row.rule_unverified,
  inputsDigest: row.inputs_digest,
  panelIds: row.panel_ids,
  staffIds: row.staff_ids,
  ownerTaxHead: row.owner_tax_head,
  biddersCount: row.bidders_count,
  findingsCount: row.findings_count,
  strongCount: row.strong_count,
});

const toFinding = (row: FindingSql, names: ReadonlyMap<string, string>): IndependenceFindingRow => ({
  id: row.id,
  checkId: row.check_id,
  packageId: row.package_id,
  fingerprint: row.fingerprint,
  kind: row.kind,
  strength: row.strength,
  parties: row.parties,
  partyNames: [names.get(row.parties[0].id) ?? null, names.get(row.parties[1].id) ?? null],
  evidence: row.evidence,
  raisedBy: row.raised_by,
  carriedFromId: row.carried_from_id,
  decision: row.decision,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at,
  decisionReason: row.decision_reason,
  version: Number(row.version),
});

/** One figure of the register for the indicator `VENDOR_INDEPENDENCE_CHECKED`. */
export interface IndependenceFigure {
  code: string;
  numerator: number;
  denominator: number;
  asOf: string;
}

/**
 * The independence of the bidders of a package, the people who evaluate it and its owner (VND-2, V5). A member of staff declares what they have to declare about themselves (a relative who represents or owns a
 * bidder, a share, a former employment, an advice); a person with the right runs the check for a package: the facts are the keys of the profiles of VND-1 (never the personal values), the kernel finds the links, and
 * every link is a finding that another person decides once. A finding that a later run finds again keeps its decision, so nobody is asked twice; a finding that is gone is not shown in the latest run.
 */
export class VendorIndependenceStore {
  // -- Interests ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  async interests(tx: TenantTx, filter: { membershipId?: string | undefined; activeOnly?: boolean | undefined } = {}): Promise<InterestRow[]> {
    const rows = await tx.query<InterestSql>(`${INTEREST_SELECT} where ($1::uuid is null or i.membership_id = $1::uuid) and (not $2::boolean or i.ended_on is null) order by d.display_name nulls last, i.kind, i.id limit 500`, [filter.membershipId ?? null, filter.activeOnly ?? false]);
    return rows.map(toInterest);
  }

  async findInterest(tx: TenantTx, id: string): Promise<InterestRow | undefined> {
    const rows = await tx.query<InterestSql>(`${INTEREST_SELECT} where i.id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : toInterest(rows[0]);
  }

  async declare(tx: TenantTx, input: NewInterest, actor: string, identityKeyOf: (number: string) => string, today: string): Promise<InterestRow> {
    if ((await tx.query('select 1 from machvon.membership where id = $1::uuid', [input.membershipId])).length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    let relatedName: string | null = null;
    let relatedNameKey: string | null = null;
    let relatedIdentityKey: string | null = null;
    if (input.kind === 'RELATIVE') {
      if (input.relatedName === undefined) throw invalid('related_name');
      relatedName = textOf(input.relatedName, 'related_name', 2, 300);
      relatedNameKey = matchKeyOf(foldForMatch(relatedName));
      if (input.relatedIdentityNumber !== undefined) relatedIdentityKey = identityKeyOf(textOf(input.relatedIdentityNumber, 'related_identity_number', 5, 40).replace(/[\s-]/g, ''));
    }
    let taxHead: string | null = null;
    if (input.taxCode !== undefined) {
      taxHead = taxHeadOf(input.taxCode);
      if (taxHead === null) throw invalid('tax_code');
    }
    if (input.contractorId !== undefined && (await tx.query('select 1 from machvon.contractor where id = $1::uuid', [input.contractorId])).length === 0) throw invalid('contractor_id');
    if (input.kind !== 'RELATIVE' && input.contractorId === undefined && taxHead === null) throw invalid('contractor_id');
    if (input.kind === 'SHAREHOLDING' && (input.sharePct === undefined || !/^\d{1,3}(\.\d{1,2})?$/.test(input.sharePct) || Number(input.sharePct) > 100)) throw invalid('share_pct');
    if (input.documentId !== undefined && (await tx.query('select 1 from machvon.document where id = $1::uuid', [input.documentId])).length === 0) throw invalid('document_id');
    const sinceOn = input.sinceOn ?? today;
    if (!isDay(sinceOn)) throw invalid('since_on');
    if (input.endedOn !== undefined && (!isDay(input.endedOn) || (input.kind !== 'FORMER_EMPLOYMENT' && input.endedOn < sinceOn))) throw invalid('ended_on');
    const relation = input.relation === undefined ? null : textOf(input.relation, 'relation', 2, 100);
    const id = randomUUID();
    await tx.query(
      `insert into machvon.vendor_person_interest (tenant_id, id, membership_id, kind, related_name, related_name_key, related_identity_key, relation, contractor_id, tax_head, share_pct, since_on, ended_on, document_id, created_by, updated_by)
       values (${TENANT}, $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::uuid, $9, $10::numeric, $11::date, $12::date, $13::uuid, $14::uuid, $14::uuid)`,
      [id, input.membershipId, input.kind, relatedName, relatedNameKey, relatedIdentityKey, relation, input.contractorId ?? null, taxHead, input.sharePct ?? null, sinceOn, input.endedOn ?? null, input.documentId ?? null, actor],
    );
    return (await this.findInterest(tx, id)) as InterestRow;
  }

  /** An interest ends with a reason (5 to 500 characters), on a day not before it began; it is not deleted and an end stays. */
  async end(tx: TenantTx, id: string, expectedVersion: number, reason: string, endedOn: string, actor: string): Promise<InterestRow> {
    const why = textOf(reason, 'reason', 5, 500);
    if (!isDay(endedOn)) throw invalid('ended_on');
    const [row] = await tx.query<{ ended_reason: string | null; version: string; since_on: string; kind: InterestKind }>('select ended_reason, version::text as version, since_on::text as since_on, kind from machvon.vendor_person_interest where id = $1::uuid for update', [id]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    if (row.ended_reason !== null) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'ended_on');
    if (endedOn < row.since_on && row.kind !== 'FORMER_EMPLOYMENT') throw invalid('ended_on');
    await tx.query('update machvon.vendor_person_interest set ended_on = $2::date, ended_reason = $3, updated_at = now(), updated_by = $4::uuid, version = version + 1 where id = $1::uuid', [id, endedOn, why, actor]);
    return (await this.findInterest(tx, id)) as InterestRow;
  }

  // -- Facts --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  private async bidderFacts(tx: TenantTx, packageId: string): Promise<{ parties: PartyFacts[]; heads: Map<string, string> }> {
    const rows = await tx.query<{ id: string; tax: string; address_key: string | null; phone_key: string | null; email_key: string | null; legal_rep_key: string | null; accounts: string[] }>(
      `select c.id, c.tax_identifier as tax, c.address_key, c.phone_key, c.email_key, c.legal_rep_key,
              coalesce((select array_agg(a.account_no_key::text) from machvon.contractor_bank_account a where a.tenant_id = c.tenant_id and a.contractor_id = c.id and a.state in ('ACTIVE', 'SUPERSEDED')), '{}') as accounts
         from machvon.contractor c where c.id in (select p.contractor_id from machvon.proposal p where p.package_id = $1::uuid and p.status = 'RECEIVED') order by c.id`,
      [packageId],
    );
    const owners = await tx.query<{ contractor_id: string; owner_kind: string; name_key: string; identity_key: string | null; share_pct: string | null }>(
      `select o.contractor_id, o.owner_kind, o.name_key::text as name_key, o.identity_key::text as identity_key, o.share_pct::text as share_pct
         from machvon.contractor_owner o where o.ended_on is null and o.contractor_id = any($1::uuid[]) order by o.contractor_id, o.id`,
      [rows.map((row) => row.id)],
    );
    const headOf = new Map<string, string>();
    for (const row of rows) {
      const head = taxHeadOf(row.tax);
      if (head !== null) headOf.set(row.id, head);
    }
    return {
      heads: headOf,
      parties: rows.map((row): PartyFacts => ({
        contractorId: row.id,
        taxHead: headOf.get(row.id) ?? null,
        addressKey: row.address_key,
        phoneKey: row.phone_key,
        emailKey: row.email_key,
        legalRepKey: row.legal_rep_key,
        owners: owners.filter((owner) => owner.contractor_id === row.id).map((owner): OwnerKeys => ({ nameKey: owner.name_key, identityKey: owner.identity_key, taxHead: null, sharePct: owner.share_pct === null ? null : Number(owner.share_pct) })),
        bankAccountKeys: row.accounts,
      })),
    };
  }

  private async peopleFacts(tx: TenantTx, panel: readonly string[], staff: readonly string[], today: string): Promise<IndependencePerson[]> {
    const ids = [...new Set([...panel, ...staff])];
    if (ids.length === 0) return [];
    const names = await tx.query<{ membership_id: string; display_name: string }>('select membership_id, display_name from machvon.tenant_user_directory where membership_id = any($1::uuid[])', [ids]);
    if (names.length !== ids.length) throw invalid('membership_ids');
    const interests = await tx.query<{ id: string; membership_id: string; kind: InterestKind; related_name_key: string | null; related_identity_key: string | null; contractor_id: string | null; tax_head: string | null; share_pct: string | null; ended_on: string | null }>(
      `select i.id, i.membership_id, i.kind, i.related_name_key::text as related_name_key, i.related_identity_key::text as related_identity_key, i.contractor_id, coalesce(i.tax_head, left(regexp_replace(c.tax_identifier, '[^0-9]', '', 'g'), 10)) as tax_head, i.share_pct::text as share_pct, i.ended_on::text as ended_on
         from machvon.vendor_person_interest i left join machvon.contractor c on c.tenant_id = i.tenant_id and c.id = i.contractor_id
        where i.membership_id = any($1::uuid[]) and (i.ended_on is null or i.kind = 'FORMER_EMPLOYMENT') order by i.id`,
      [ids],
    );
    void today;
    const nameOf = new Map(names.map((row) => [row.membership_id, row.display_name]));
    return ids.sort().map((membershipId): IndependencePerson => ({
      membershipId,
      role: panel.includes(membershipId) ? 'EVALUATOR' : 'PROJECT_STAFF',
      nameKey: matchKeyOf(foldForMatch(nameOf.get(membershipId) as string)),
      identityKey: null,
      interests: interests
        .filter((row) => row.membership_id === membershipId)
        .map((row): InterestFacts => ({ id: row.id, kind: row.kind, relatedNameKey: row.related_name_key, relatedIdentityKey: row.related_identity_key, contractorId: row.contractor_id, taxHead: row.tax_head, sharePct: row.share_pct === null ? null : Number(row.share_pct), endedOn: row.ended_on })),
    }));
  }

  // -- Run -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /**
   * Runs the detection for a package and writes the check with its findings. The facts are the profiles of the bidders (the proposals received for the package), the panel and the staff named, and the owner
   * organisation. A run over the same facts and the same rule as the latest one changes nothing and answers the latest check (so a replay is harmless). A finding found again keeps the decision it had.
   * The owner of an organisation is tied to a registered contractor by the blind index of its tax code: an organisation entered with its tax code as identity number is recognised, one entered without is not (a limit of the data, not guessed).
   */
  async run(tx: TenantTx, packageId: string, input: RunCheckInput, actor: string, identityKeyOf: (number: string) => string, today: string, policy: Policy<IndependencePolicy>): Promise<{ view: IndependenceView; created: boolean }> {
    if ((await tx.query('select 1 from machvon.procurement_package where id = $1::uuid', [packageId])).length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (input.panelMembershipIds.length + input.staffMembershipIds.length > 200) throw invalid('panel_membership_ids');
    const bidders = await this.bidderFacts(tx, packageId);
    const heads = [...new Set(bidders.heads.values())];
    const ownerHead = input.ownerTaxCode === undefined ? null : taxHeadOf(input.ownerTaxCode);
    if (input.ownerTaxCode !== undefined && ownerHead === null) throw invalid('owner_tax_code');
    const candidates = new Set([...heads, ...(ownerHead === null ? [] : [ownerHead])]);
    const keyOfHead = new Map([...candidates].map((head) => [identityKeyOf(head), head]));
    const tied = (parties: readonly PartyFacts[]): PartyFacts[] => parties.map((party) => ({ ...party, owners: party.owners.map((owner) => ({ ...owner, taxHead: owner.identityKey === null ? null : (keyOfHead.get(owner.identityKey) ?? null) })) }));
    const parties = tied(bidders.parties);
    let ownerKeys: readonly OwnerKeys[] = [];
    if (ownerHead !== null) {
      const registered = await tx.query<{ id: string }>("select id from machvon.contractor where left(regexp_replace(tax_identifier, '[^0-9]', '', 'g'), 10) = $1 order by id", [ownerHead]);
      if (registered.length > 0) {
        const owned = await tx.query<{ name_key: string; identity_key: string | null; share_pct: string | null }>('select name_key::text as name_key, identity_key::text as identity_key, share_pct::text as share_pct from machvon.contractor_owner where ended_on is null and contractor_id = any($1::uuid[]) order by id', [registered.map((row) => row.id)]);
        ownerKeys = tied([{ contractorId: 'owner', taxHead: ownerHead, addressKey: null, phoneKey: null, emailKey: null, legalRepKey: null, bankAccountKeys: [], owners: owned.map((row): OwnerKeys => ({ nameKey: row.name_key, identityKey: row.identity_key, taxHead: null, sharePct: row.share_pct === null ? null : Number(row.share_pct) })) }])[0]?.owners ?? [];
      }
    }
    const people = await this.peopleFacts(tx, input.panelMembershipIds, input.staffMembershipIds, today);
    const found = detectIndependence({ bidders: parties, people, owner: { taxHead: ownerHead, ownerKeys }, today }, policy.value);
    const digest = createHash('sha256').update(JSON.stringify({ parties, people, ownerHead, ownerKeys, policy: policy.value, found: found.map((one) => one.fingerprint) })).digest('hex');
    const latest = await this.latestCheck(tx, packageId);
    if (latest !== undefined && latest.inputsDigest === digest && latest.ruleVersion === policy.version) return { view: await this.view(tx, latest, policy.value), created: false };
    const checkId = randomUUID();
    const strong = found.filter((one) => one.strength === 'STRONG').length;
    await tx.query(
      `insert into machvon.vendor_independence_check (tenant_id, id, package_id, run_by, rule_version, rule_unverified, inputs_digest, panel_ids, staff_ids, owner_tax_head, bidders_count, findings_count, strong_count)
       values (${TENANT}, $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::uuid[], $8::uuid[], $9, $10, $11, $12)`,
      [checkId, packageId, actor, policy.version, policy.unverified, digest, [...input.panelMembershipIds], [...input.staffMembershipIds], ownerHead, parties.length, found.length, strong],
    );
    for (const one of found) await this.writeFinding(tx, checkId, packageId, one, actor);
    const check = (await this.latestCheck(tx, packageId)) as CheckRow;
    return { view: await this.view(tx, check, policy.value), created: true };
  }

  private async writeFinding(tx: TenantTx, checkId: string, packageId: string, one: IndependenceFinding, actor: string): Promise<void> {
    const [before] = await tx.query<{ id: string; raised_by: string; decision: FindingDecision | null; decided_by: string | null; decided_at: string | null; decision_reason: string | null }>(
      `select id, raised_by, decision, decided_by, decided_at::text as decided_at, decision_reason from machvon.vendor_independence_finding where package_id = $1::uuid and fingerprint = $2 order by created_at desc, id desc limit 1`,
      [packageId, one.fingerprint],
    );
    await tx.query(
      `insert into machvon.vendor_independence_finding (tenant_id, id, check_id, package_id, fingerprint, kind, strength, parties, evidence, raised_by, carried_from_id, decision, decided_by, decided_at, decision_reason)
       values (${TENANT}, gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7::jsonb, $8::uuid, $9::uuid, $10, $11::uuid, $12::timestamptz, $13)`,
      [checkId, packageId, one.fingerprint, one.kind, one.strength, JSON.stringify(one.parties), JSON.stringify(one.evidence), before?.raised_by ?? actor, before?.id ?? null, before?.decision ?? null, before?.decided_by ?? null, before?.decided_at ?? null, before?.decision_reason ?? null],
    );
  }

  // -- Reads --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  async latestCheck(tx: TenantTx, packageId: string): Promise<CheckRow | undefined> {
    const rows = await tx.query<CheckSql>(`${CHECK_SELECT} where package_id = $1::uuid order by run_at desc, id desc limit 1`, [packageId]);
    return rows[0] === undefined ? undefined : toCheck(rows[0]);
  }

  private async view(tx: TenantTx, check: CheckRow, policy: IndependencePolicy): Promise<IndependenceView> {
    const rows = await tx.query<FindingSql>(`${FINDING_SELECT} where check_id = $1::uuid order by strength desc, fingerprint`, [check.id]);
    const ids = new Set<string>();
    for (const row of rows) for (const side of row.parties) ids.add(side.id);
    const names = new Map<string, string>();
    if (ids.size > 0) {
      const list = [...ids].filter((id) => /^[0-9a-f-]{36}$/.test(id));
      for (const row of await tx.query<{ id: string; name: string }>('select id, legal_name as name from machvon.contractor where id = any($1::uuid[])', [list])) names.set(row.id, row.name);
      for (const row of await tx.query<{ id: string; name: string }>('select membership_id as id, display_name as name from machvon.tenant_user_directory where membership_id = any($1::uuid[])', [list])) names.set(row.id, row.name);
    }
    names.set('owner', 'owner');
    const findings = rows.map((row) => toFinding(row, names));
    return { check, findings, gate: independenceGate(findings.map((one) => ({ strength: one.strength, decision: one.decision })), policy) };
  }

  /** The latest check of a package with its findings and the gate, or undefined when the package was never checked. */
  async latest(tx: TenantTx, packageId: string, policy: Policy<IndependencePolicy>): Promise<IndependenceView | undefined> {
    const check = await this.latestCheck(tx, packageId);
    return check === undefined ? undefined : this.view(tx, check, policy.value);
  }

  /** The gate of a package: closed when the latest check has a finding that is blocked or (by the rule) a strong one nobody decided; a package never checked has no gate (it is not blocked). */
  async gate(tx: TenantTx, packageId: string, policy: Policy<IndependencePolicy>): Promise<(IndependenceGate & { checked: boolean }) | { checked: false }> {
    const view = await this.latest(tx, packageId, policy);
    return view === undefined ? { checked: false } : { ...view.gate, checked: true };
  }

  async findFinding(tx: TenantTx, id: string): Promise<IndependenceFindingRow | undefined> {
    const rows = await tx.query<FindingSql>(`${FINDING_SELECT} where id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : toFinding(rows[0], new Map());
  }

  /**
   * A person other than the one who ran the check and the one who first raised the finding decides it once: CLEARED, RECUSED (a person only) or BLOCKED (a bidder or the owner only), with a reason of 20 characters.
   * A finding of a check that a later run replaced is not decided (409 `STAGE_TRANSITION_DENIED`): the later run carries the decision it needs.
   */
  async decide(tx: TenantTx, findingId: string, expectedVersion: number, decision: string, reason: string, actor: string): Promise<IndependenceFindingRow> {
    const [row] = await tx.query<{ check_id: string; package_id: string; kind: FindingKind; version: string; decision: FindingDecision | null; run_by: string; raised_by: string }>(
      `select f.check_id, f.package_id, f.kind, f.version::text as version, f.decision, k.run_by, f.raised_by from machvon.vendor_independence_finding f join machvon.vendor_independence_check k on k.tenant_id = f.tenant_id and k.id = f.check_id where f.id = $1::uuid for update of f`,
      [findingId],
    );
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    const latest = await this.latestCheck(tx, row.package_id);
    if (latest === undefined || latest.id !== row.check_id) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    if (actor === row.raised_by) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    const checked = assertFindingDecision({ decision, reason, decidedBy: actor, ranBy: row.run_by, alreadyDecided: row.decision !== null });
    if (!decisionFitsFinding(row.kind, checked)) throw new DomainError('INDEPENDENCE_DECISION_INVALID', 422, 'decision');
    await tx.query('update machvon.vendor_independence_finding set decision = $2, decided_by = $3::uuid, decided_at = now(), decision_reason = $4, version = version + 1 where id = $1::uuid', [findingId, checked, actor, reason.trim()]);
    return (await this.findFinding(tx, findingId)) as IndependenceFindingRow;
  }

  // -- Figures and the alerts -------------------------------------------------------------------------------------------------------------------------------------------------------

  /** Packages with a bid received and the share of them that were checked (indicator `VENDOR_INDEPENDENCE_CHECKED`). */
  async figures(tx: TenantTx, now: Date): Promise<IndependenceFigure[]> {
    const [row] = await tx.query<{ checked: string; bidded: string }>(
      `select count(*) filter (where exists (select 1 from machvon.vendor_independence_check k where k.tenant_id = p.tenant_id and k.package_id = p.id))::text as checked, count(*)::text as bidded
         from machvon.procurement_package p where exists (select 1 from machvon.proposal x where x.tenant_id = p.tenant_id and x.package_id = p.id and x.status = 'RECEIVED')`,
    );
    return [{ code: 'VENDOR_INDEPENDENCE_CHECKED', numerator: Number(row?.checked ?? 0), denominator: Number(row?.bidded ?? 0), asOf: now.toISOString().slice(0, 10) }];
  }

  /** The undecided findings of the latest check of each package, for the alert centre: oldest first. */
  async openFindings(tx: TenantTx, limit = 500): Promise<Array<{ id: string; packageId: string; packageCode: string; kind: FindingKind; strength: FindingStrength; raisedAt: string }>> {
    const rows = await tx.query<{ id: string; package_id: string; code: string; kind: FindingKind; strength: FindingStrength; raised_at: string }>(
      `select f.id, f.package_id, p.code, f.kind, f.strength, ${iso('k.run_at')} as raised_at
         from machvon.vendor_independence_finding f
         join machvon.vendor_independence_check k on k.tenant_id = f.tenant_id and k.id = f.check_id
         join machvon.procurement_package p on p.tenant_id = f.tenant_id and p.id = f.package_id
        where f.decision is null and k.id = (select k2.id from machvon.vendor_independence_check k2 where k2.tenant_id = f.tenant_id and k2.package_id = f.package_id order by k2.run_at desc, k2.id desc limit 1)
        order by k.run_at, f.id limit $1`,
      [limit],
    );
    return rows.map((row) => ({ id: row.id, packageId: row.package_id, packageCode: row.code, kind: row.kind, strength: row.strength, raisedAt: row.raised_at }));
  }
}

/** The precondition port for the award of a package: closed only when a check was run and its gate is closed (422 `INDEPENDENCE_FINDING_OPEN`). The lead wires it into the result store. */
export class VendorIndependenceGate {
  private readonly store = new VendorIndependenceStore();

  async assertOpen(tx: TenantTx, packageId: string, policy: Policy<IndependencePolicy>): Promise<void> {
    const gate = await this.store.gate(tx, packageId, policy);
    if (gate.checked && !('open' in gate && gate.open)) throw new DomainError('INDEPENDENCE_FINDING_OPEN', 422, 'package_id', { extensions: { blocked: 'blocked' in gate ? gate.blocked : 0, undecided_strong: 'undecidedStrong' in gate ? gate.undecidedStrong : 0 } });
  }
}
