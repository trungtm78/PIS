import { randomUUID } from 'node:crypto';
import { DomainError, assertFourEyes, vietnamDateOf, versionConflict, hasControlCharExceptWhitespace } from '@machvon/kernel';
import { assertTimestampCursor, timestampKey } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';
import { vietnameseData } from './vietnamese-data.ts';

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
// Text may carry line breaks and tabs; every other control character (and NUL, which PostgreSQL cannot hold) is refused.
const MAX_CODE = 80;
const MAX_DOMAIN = 50;
const MAX_TERM = 300;
const MIN_DEFINITION = 20;
const MAX_DEFINITION = 2000;
const MAX_FORMULA = 120;
const MAX_LEGAL_BASIS = 2000;
const MIN_REASON = 5;
const MAX_REASON = 2000;
const OWNER_ROLE = 'TENANT_OWNER';

export const GLOSSARY_STATUSES = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED', 'DEPRECATED', 'REJECTED'] as const;
export type GlossaryStatus = (typeof GLOSSARY_STATUSES)[number];
/** The decisions of MdmDecision, shared with the master change requests: a return sends the term back to its author as a DRAFT. */
export type GlossaryDecision = 'approve' | 'reject' | 'return';
export const DISBURSEMENT_DOMAIN = 'DISBURSEMENT';

export interface GlossaryTermRow {
  id: string;
  termCode: string;
  termVi: string;
  definition: string;
  formulaRef: string | null;
  domain: string;
  ownerMembershipId: string;
  legalBasis: string | null;
  revision: number;
  status: GlossaryStatus;
  approvedBy: string | null;
  effectiveFrom: string | null;
  supersedesId: string | null;
  createdBy: string;
  /** Creation time to the microsecond (UTC): the ordering key of the list and its cursor. */
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  publishedBy: string | null;
  publishedAt: string | null;
  version: number;
}

export interface GlossaryTermInput {
  termCode: string;
  termVi: string;
  definition: string;
  formulaRef?: string | undefined;
  domain: string;
  ownerMembershipId: string;
  legalBasis?: string | undefined;
  supersedesId?: string | undefined;
}

export interface GlossaryFilter {
  domain?: string | undefined;
  status?: GlossaryStatus | undefined;
  termCode?: string | undefined;
}

/** Whether the definitions of a domain are signed: every term the domain requires has a PUBLISHED revision. */
export interface DefinitionStatus {
  status: 'SIGNED' | 'PROPOSED_PENDING_SIGNOFF';
  /** The required terms that have no PUBLISHED revision yet. */
  missing: string[];
}

interface SeedTerm {
  termCode: string;
  termVi: string;
  definition: string;
  formulaRef: string;
}

const DISBURSEMENT_TEXT = vietnameseData<{ basis: string; terms: Record<string, { termVi: string; definition: string }> }>('glossary-disbursement');
const DISBURSEMENT_BASIS = DISBURSEMENT_TEXT.basis;
/** The Vietnamese term and definition of a seeded term, from the data file. */
const seedText = (termCode: string): { termVi: string; definition: string } => DISBURSEMENT_TEXT.terms[termCode] ?? { termVi: termCode, definition: termCode };

/**
 * The definitions that the disbursement figures stand on (DIS BR-DIS-03, 05, 06, 12): the period delta, the year-to-date and project-to-date
 * cumulatives and the two denominators of the rate. They are the working assumption of the design until the capital business owner signs
 * them (D03): seeded IN_REVIEW, never published by the platform. The disbursement counted is the one paid by the Treasury on or before the
 * cut-off date (BR-DIS-06), which every term below carries.
 */
export const DISBURSEMENT_TERMS: readonly SeedTerm[] = [
  {
    termCode: 'GIAI_NGAN_PERIOD',
    termVi: seedText('GIAI_NGAN_PERIOD').termVi,
    definition: seedText('GIAI_NGAN_PERIOD').definition,
    formulaRef: 'period_delta = cumulative(period) - cumulative(previous period, same plan_year)',
  },
  {
    termCode: 'GIAI_NGAN_YTD',
    termVi: seedText('GIAI_NGAN_YTD').termVi,
    definition: seedText('GIAI_NGAN_YTD').definition,
    formulaRef: 'ytd = SUM(treasury_amount WHERE plan_year_start <= treasury_paid_on <= cutoff)',
  },
  {
    termCode: 'GIAI_NGAN_PTD',
    termVi: seedText('GIAI_NGAN_PTD').termVi,
    definition: seedText('GIAI_NGAN_PTD').definition,
    formulaRef: 'ptd = SUM(treasury_amount WHERE treasury_paid_on <= cutoff, all plan years)',
  },
  {
    termCode: 'MAU_SO_KH_TTG_GIAO',
    termVi: seedText('MAU_SO_KH_TTG_GIAO').termVi,
    definition: seedText('MAU_SO_KH_TTG_GIAO').definition,
    formulaRef: 'rate_pm_pct = D / plan_pm_assigned_vnd * 100',
  },
  {
    termCode: 'MAU_SO_KH_TONG',
    termVi: seedText('MAU_SO_KH_TONG').termVi,
    definition: seedText('MAU_SO_KH_TONG').definition,
    formulaRef: 'rate_total_pct = D / (plan_pm_assigned_vnd + plan_local_added_vnd) * 100',
  },
];

/** The terms a domain needs published before its figures count as signed. Only the disbursement domain has a sign-off (D03). */
const REQUIRED_TERMS: Readonly<Record<string, readonly string[]>> = {
  [DISBURSEMENT_DOMAIN]: DISBURSEMENT_TERMS.map((term) => term.termCode),
};

interface SqlRow {
  id: string;
  term_code: string;
  term_vi: string;
  definition: string;
  formula_ref: string | null;
  domain: string;
  owner_membership_id: string;
  legal_basis: string | null;
  revision: number;
  status: GlossaryStatus;
  approved_by: string | null;
  effective_from: string | null;
  supersedes_id: string | null;
  created_by: string;
  created_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  published_by: string | null;
  published_at: string | null;
  version: string;
}

const SELECT = `select id, term_code, term_vi, definition, formula_ref, domain, owner_membership_id, legal_basis, revision, status, approved_by,
  effective_from::text as effective_from, supersedes_id, created_by, ${timestampKey('created_at')} as created_at, decided_by,
  ${timestampKey('decided_at')} as decided_at, decision_reason, published_by, ${timestampKey('published_at')} as published_at, version::text as version
  from machvon.glossary_term`;

const toRow = (row: SqlRow): GlossaryTermRow => ({
  id: row.id,
  termCode: row.term_code,
  termVi: row.term_vi,
  definition: row.definition,
  formulaRef: row.formula_ref,
  domain: row.domain,
  ownerMembershipId: row.owner_membership_id,
  legalBasis: row.legal_basis,
  revision: row.revision,
  status: row.status,
  approvedBy: row.approved_by,
  effectiveFrom: row.effective_from,
  supersedesId: row.supersedes_id,
  createdBy: row.created_by,
  createdAt: row.created_at,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at,
  decisionReason: row.decision_reason,
  publishedBy: row.published_by,
  publishedAt: row.published_at,
  version: Number(row.version),
});

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** A text as it is stored: trimmed, within its length, without control characters; an optional text that is empty is absent. */
function textOf(value: string | undefined, field: string, min: number, max: number, optional = false): string | null {
  const text = (value ?? '').trim();
  if (optional && text === '') return null;
  if (text.length < min || text.length > max || hasControlCharExceptWhitespace(text)) throw invalid(field);
  return text;
}

function codeOf(value: string, field: string, max: number): string {
  const code = value.trim();
  if (code.length === 0 || code.length > max || !CODE_PATTERN.test(code)) throw invalid(field);
  return code;
}

const denied = (status: string, action: string): DomainError => new DomainError('STAGE_TRANSITION_DENIED', 409, `${status}->${action}`);

/**
 * The glossary of business terms with its approval workflow (ST-MDM-008, MDM 3.1 F6): a term is proposed, submitted, decided by the owner of
 * its domain and published, and a published revision is replaced by the next one in the same transaction. Four-eyes holds at every step: the
 * proposer decides nothing and publishes nothing, and only the owner named on the term decides and publishes it. The content of a revision
 * never changes (the guard trigger of V1085); a change is a new revision.
 */
export class GlossaryStore {
  async find(tx: TenantTx, id: string, lock = false): Promise<GlossaryTermRow | undefined> {
    const rows = await tx.query<SqlRow>(`${SELECT} where id = $1::uuid${lock ? ' for update' : ''}`, [id]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  /** The terms of the tenant, the newest first, by domain, status and term code. */
  async list(tx: TenantTx, filter: GlossaryFilter, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<GlossaryTermRow[]> {
    assertTimestampCursor(request.after?.code);
    const rows = await tx.query<SqlRow>(
      `${SELECT}
        where ($1::text is null or domain = $1) and ($2::text is null or status = $2) and ($3::text is null or term_code = $3)
          and ($4::text is null or (${timestampKey('created_at')}, id) < ($4::text, $5::uuid))
        order by created_at desc, id desc limit $6`,
      [filter.domain ?? null, filter.status ?? null, filter.termCode ?? null, request.after?.code ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map(toRow);
  }

  /**
   * Proposes a term as a DRAFT. A new code starts at revision 1. A code with a PUBLISHED revision gets the next revision, which supersedes
   * it; a code whose proposals were all rejected gets the next revision with nothing to supersede. A code with a proposal still open
   * (DRAFT, IN_REVIEW or APPROVED) is GLOSSARY_TERM_DUPLICATE. The owner is another person than the proposer, or nobody could decide.
   */
  async propose(tx: TenantTx, input: GlossaryTermInput, actor: string): Promise<{ id: string; version: number; revision: number }> {
    const termCode = codeOf(input.termCode, 'term_code', MAX_CODE);
    const domain = codeOf(input.domain, 'domain', MAX_DOMAIN);
    const termVi = textOf(input.termVi, 'term_vi', 1, MAX_TERM) as string;
    const definition = textOf(input.definition, 'definition', MIN_DEFINITION, MAX_DEFINITION) as string;
    const formulaRef = textOf(input.formulaRef, 'formula_ref', 0, MAX_FORMULA, true);
    const legalBasis = textOf(input.legalBasis, 'legal_basis', 0, MAX_LEGAL_BASIS, true);
    // The owner decides and publishes: a proposer who owns the term would leave a term that four-eyes forbids anyone to decide.
    if (input.ownerMembershipId.toLowerCase() === actor.toLowerCase()) throw invalid('owner_membership_id');
    const owners = await tx.query(
      "select 1 from machvon.membership where id = $1::uuid and status = 'Active' and (valid_until is null or valid_until > now())",
      [input.ownerMembershipId],
    );
    if (owners.length === 0) throw invalid('owner_membership_id');

    // Two proposals of one code in parallel would both read the same revisions: they take turns.
    await tx.query("select pg_advisory_xact_lock(hashtextextended('glossary_term:' || current_setting('app.tenant_id') || ':' || $1::text, 0))", [termCode]);
    const earlier = await tx.query<{ id: string; revision: number; status: GlossaryStatus; domain: string }>(
      'select id, revision, status, domain from machvon.glossary_term where term_code = $1 order by revision desc',
      [termCode],
    );
    if (earlier.some((row) => row.status === 'DRAFT' || row.status === 'IN_REVIEW' || row.status === 'APPROVED')) throw new DomainError('GLOSSARY_TERM_DUPLICATE', 409);
    const published = earlier.find((row) => row.status === 'PUBLISHED');
    const supersedes = published?.id;
    if (input.supersedesId !== undefined && input.supersedesId.toLowerCase() !== supersedes) throw invalid('supersedes_id');
    // A term does not change domain between revisions: the consumers of an event read the domain to know whose figures it touches.
    if (earlier[0] !== undefined && earlier[0].domain !== domain) throw invalid('domain');
    const revision = (earlier[0]?.revision ?? 0) + 1;

    const id = randomUUID();
    try {
      await tx.query(
        `insert into machvon.glossary_term
           (tenant_id, id, term_code, term_vi, definition, formula_ref, domain, owner_membership_id, legal_basis, revision, status, supersedes_id, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4, $5, $6, $7::uuid, $8, $9, 'DRAFT', $10::uuid, $11::uuid, $11::uuid)`,
        [id, termCode, termVi, definition, formulaRef, domain, input.ownerMembershipId, legalBasis, revision, supersedes ?? null, actor],
      );
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('GLOSSARY_TERM_DUPLICATE', 409);
      throw error;
    }
    return { id, version: 1, revision };
  }

  private async lock(tx: TenantTx, id: string, expectedVersion: number): Promise<GlossaryTermRow> {
    const row = await this.find(tx, id, true);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (row.version !== expectedVersion) throw versionConflict(row.version);
    return row;
  }

  private async move(tx: TenantTx, id: string, set: string, params: unknown[]): Promise<void> {
    try {
      await tx.query(`update machvon.glossary_term set ${set}, updated_at = now(), version = version + 1 where id = $1::uuid`, [id, ...params]);
    } catch (error) {
      // The guard trigger and the CHECKs are the last word on the state machine; a path that slipped past this store is a conflict, not a fault.
      if ((error as { code?: string }).code === CHECK_VIOLATION) throw new DomainError('STAGE_TRANSITION_DENIED', 409);
      throw error;
    }
  }

  /** DRAFT to IN_REVIEW. */
  async submit(tx: TenantTx, id: string, expectedVersion: number, actor: string): Promise<{ row: GlossaryTermRow; version: number }> {
    const row = await this.lock(tx, id, expectedVersion);
    if (row.status !== 'DRAFT') throw denied(row.status, 'submit');
    await this.move(tx, id, "status = 'IN_REVIEW', updated_by = $2::uuid", [actor]);
    return { row, version: row.version + 1 };
  }

  /**
   * The decision of the owner of the domain on a term in review: approve, reject (final for this revision) or return (back to its author as
   * a DRAFT). The proposer is refused first (SELF_APPROVAL_DENIED): whose term it is does not depend on who holds the domain, and a
   * proposer is told so whatever the owner is. A person who is not the owner named on the term is then refused with SCOPE_DENIED, and the
   * term stays as it was.
   */
  async decide(
    tx: TenantTx,
    id: string,
    expectedVersion: number,
    decision: GlossaryDecision,
    reason: string,
    decider: string,
  ): Promise<{ row: GlossaryTermRow; status: GlossaryStatus; version: number }> {
    const why = textOf(reason, 'reason', MIN_REASON, MAX_REASON) as string;
    const row = await this.lock(tx, id, expectedVersion);
    assertFourEyes(row.createdBy, decider);
    if (row.ownerMembershipId.toLowerCase() !== decider.toLowerCase()) throw new DomainError('SCOPE_DENIED', 403, 'domain');
    if (row.status !== 'IN_REVIEW') throw denied(row.status, decision);
    const status: GlossaryStatus = decision === 'approve' ? 'APPROVED' : decision === 'reject' ? 'REJECTED' : 'DRAFT';
    await this.move(
      tx,
      id,
      `status = $2, approved_by = case when $2 = 'APPROVED' then $3::uuid end, decided_by = $3::uuid, decided_at = now(), decision_reason = $4, updated_by = $3::uuid`,
      [status, decider, why],
    );
    return { row, status, version: row.version + 1 };
  }

  /**
   * APPROVED to PUBLISHED, in force from today (Vietnam date). The revision it replaces becomes DEPRECATED in the same transaction, so a
   * term code has one PUBLISHED revision at every instant. The publisher is the owner of the domain and never the proposer.
   */
  async publish(
    tx: TenantTx,
    id: string,
    expectedVersion: number,
    publisher: string,
    on: string = vietnamDateOf(new Date()),
  ): Promise<{ row: GlossaryTermRow; version: number; deprecatedId: string | null }> {
    const row = await this.lock(tx, id, expectedVersion);
    assertFourEyes(row.createdBy, publisher);
    if (row.ownerMembershipId.toLowerCase() !== publisher.toLowerCase()) throw new DomainError('SCOPE_DENIED', 403, 'domain');
    if (row.status !== 'APPROVED') throw denied(row.status, 'publish');
    const previous = await tx.query<{ id: string }>("select id from machvon.glossary_term where term_code = $1 and status = 'PUBLISHED' and id <> $2::uuid for update", [row.termCode, id]);
    for (const old of previous) await this.move(tx, old.id, "status = 'DEPRECATED', updated_by = $2::uuid", [publisher]);
    await this.move(tx, id, "status = 'PUBLISHED', published_by = $2::uuid, published_at = now(), effective_from = $3::date, updated_by = $2::uuid", [publisher, on]);
    return { row, version: row.version + 1, deprecatedId: previous[0]?.id ?? null };
  }

  /**
   * Gives the tenant the definitions of the disbursement figures as terms to be signed (D03): IN_REVIEW, owned by the tenant owner. A term
   * code the tenant already has, in any status, is left as it is, so nothing that was decided is seeded again. Without an owner who is not
   * the actor there is nobody who could decide the terms (four-eyes), so none is seeded; the next run seeds them once an owner exists.
   * Returns how many were created.
   */
  async ensureDisbursementTerms(tx: TenantTx, actor: string): Promise<number> {
    const owners = await tx.query<{ id: string }>(
      `select m.id from machvon.membership m
         join machvon.role_grant g on g.membership_id = m.id
         join machvon.role_definition r on r.id = g.role_id
        where r.code = $1 and g.status = 'Active' and g.effective_from <= now() and (g.effective_until is null or g.effective_until > now())
          and m.status = 'Active' and (m.valid_until is null or m.valid_until > now()) and m.id <> $2::uuid
        order by g.effective_from, m.id limit 1`,
      [OWNER_ROLE, actor],
    );
    const owner = owners[0]?.id;
    if (owner === undefined) return 0;
    let created = 0;
    for (const term of DISBURSEMENT_TERMS) {
      const inserted = await tx.query(
        `insert into machvon.glossary_term
           (tenant_id, id, term_code, term_vi, definition, formula_ref, domain, owner_membership_id, legal_basis, revision, status, created_by, updated_by)
         select nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::text, $2::text, $3::text, $4::text, $5::text, $6::uuid, $7::text, 1, 'IN_REVIEW', $8::uuid, $8::uuid
          where not exists (select 1 from machvon.glossary_term where term_code = $1::text)
         on conflict do nothing returning id`,
        [term.termCode, term.termVi, term.definition, term.formulaRef, DISBURSEMENT_DOMAIN, owner, DISBURSEMENT_BASIS, actor],
      );
      created += inserted.length;
    }
    return created;
  }

  /** Whether the figures of a domain stand on signed definitions: every term the domain requires has a PUBLISHED revision. */
  async definitionStatus(tx: TenantTx, domain: string): Promise<DefinitionStatus> {
    const required = REQUIRED_TERMS[domain] ?? [];
    const rows = await tx.query<{ term_code: string }>("select term_code from machvon.glossary_term where domain = $1 and status = 'PUBLISHED' and term_code = any($2::text[])", [domain, [...required]]);
    const published = new Set(rows.map((row) => row.term_code));
    const missing = required.filter((code) => !published.has(code));
    return { status: required.length > 0 && missing.length === 0 ? 'SIGNED' : 'PROPOSED_PENDING_SIGNOFF', missing };
  }
}
