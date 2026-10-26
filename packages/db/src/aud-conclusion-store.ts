import { DomainError, FINANCIAL_RECOMMENDATION_TYPES, assertWithinConclusionTotal, financialShortfall, nextEngagementStatus, recommendationAmount, wholeDong } from '@machvon/kernel';
import type { ConclusionKind, EngagementStatus, FindingCategory, FindingSeverity, RecommendationType } from '@machvon/kernel';
import { AudEngagementStore } from './aud-engagement-store.ts';
import type { EngagementRow, ResolvedTarget, ScopeTarget } from './aud-engagement-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';
import { withUniqueClaim } from './unique-claim.ts';

const FINANCIAL_SQL = FINANCIAL_RECOMMENDATION_TYPES.map((type) => `'${type}'`).join(', ');
const NOT_FOUND = (): DomainError => new DomainError('RESOURCE_NOT_FOUND', 404);

export interface NewConclusion {
  conclusionKind: ConclusionKind;
  conclusionDocumentId: string;
  issuedOn: string;
  receivedOn: string;
  implementationDueOn: string | undefined;
  reportDueOn: string | undefined;
  summary: string;
  totalFinancialVnd: string;
  isPublic: boolean;
  supersedesId: string | undefined;
}

export interface NewFinding {
  findingCode: string;
  category: FindingCategory;
  projectId: string | undefined;
  contractId: string | undefined;
  organizationUnitId: string | undefined;
  description: string;
  legalBasisCited: string | undefined;
  amountVnd: string | undefined;
  severity: FindingSeverity;
}

export interface NewRecommendation {
  findingId: string | undefined;
  recCode: string;
  recType: RecommendationType;
  description: string;
  amountVnd: string | undefined;
  projectId: string | undefined;
}

/** A conclusion as a command locks it: the engagement it belongs to and the total its recommendations are held to. */
export interface ConclusionRow {
  id: string;
  engagementId: string;
  engagementCode: string;
  engagementStatus: EngagementStatus;
  conclusionKind: ConclusionKind;
  status: string;
  totalFinancialVnd: string;
}

export interface ConclusionLine {
  id: string;
  engagementId: string;
  conclusionKind: ConclusionKind;
  document: { id: string; title: string; symbol: string | null };
  revision: number;
  supersedesId: string | null;
  issuedOn: string;
  receivedOn: string;
  implementationDueOn: string | null;
  reportDueOn: string | null;
  summary: string;
  totalFinancialVnd: string;
  recommendedVnd: string;
  shortfallVnd: string;
  isPublic: boolean;
  status: string;
  findingCount: number;
  recommendationCount: number;
  version: number;
}

export interface FindingLine {
  id: string;
  conclusionId: string;
  findingCode: string;
  category: FindingCategory;
  project: { id: string; code: string; name: string } | null;
  contract: { id: string; code: string } | null;
  unit: { id: string; code: string; name: string } | null;
  description: string;
  legalBasisCited: string | null;
  amountVnd: string | null;
  severity: FindingSeverity;
  createdAt: string;
}

export interface RecommendationLine {
  id: string;
  conclusionId: string;
  findingId: string | null;
  recCode: string;
  recType: RecommendationType;
  description: string;
  amountVnd: string | null;
  recoveredVnd: string;
  projectId: string | null;
  ownerUnitId: string | null;
  dueOn: string | null;
  status: string;
  isOverdue: boolean;
  createdAt: string;
}

interface ConclusionSql {
  id: string;
  engagement_id: string;
  conclusion_kind: ConclusionKind;
  document_id: string;
  document_title: string | null;
  document_symbol: string | null;
  revision: number;
  supersedes_id: string | null;
  issued_on: string;
  received_on: string;
  implementation_due_on: string | null;
  report_due_on: string | null;
  summary: string;
  total_financial_vnd: string;
  recommended_vnd: string;
  is_public: boolean;
  status: string;
  finding_count: string;
  recommendation_count: string;
  version: string;
}

interface FindingSql {
  id: string;
  conclusion_id: string;
  finding_code: string;
  category: FindingCategory;
  project_id: string | null;
  project_code: string | null;
  project_name: string | null;
  contract_id: string | null;
  contract_code: string | null;
  unit_id: string | null;
  unit_code: string | null;
  unit_name: string | null;
  description: string;
  legal_basis_cited: string | null;
  amount_vnd: string | null;
  severity: FindingSeverity;
  created_at: string;
}

interface RecommendationSql {
  id: string;
  conclusion_id: string;
  finding_id: string | null;
  rec_code: string;
  rec_type: RecommendationType;
  description: string;
  amount_vnd: string | null;
  recovered_vnd: string;
  project_id: string | null;
  owner_unit_id: string | null;
  due_on: string | null;
  status: string;
  is_overdue: boolean;
  created_at: string;
}

const CONCLUSION_COLUMNS = `c.id, c.engagement_id, c.conclusion_kind, c.conclusion_document_id as document_id, doc.title as document_title, doc.symbol as document_symbol, c.revision, c.supersedes_id,
  c.issued_on::text as issued_on, c.received_on::text as received_on, c.implementation_due_on::text as implementation_due_on, c.report_due_on::text as report_due_on, c.summary,
  c.total_financial_vnd::text as total_financial_vnd,
  coalesce((select sum(r.amount_vnd) from machvon.audit_recommendation r
             where r.tenant_id = c.tenant_id and r.conclusion_id = c.id and r.rec_type in (${FINANCIAL_SQL}) and r.status <> 'CANCELLED'), 0)::text as recommended_vnd,
  c.is_public, c.status,
  (select count(*) from machvon.audit_finding f where f.tenant_id = c.tenant_id and f.conclusion_id = c.id)::text as finding_count,
  (select count(*) from machvon.audit_recommendation r where r.tenant_id = c.tenant_id and r.conclusion_id = c.id)::text as recommendation_count, c.version::text as version`;

const FINDING_COLUMNS = `f.id, f.conclusion_id, f.finding_code, f.category, f.project_id, p.code as project_code, p.name as project_name, f.contract_id, k.code as contract_code,
  f.organization_unit_id as unit_id, u.code as unit_code, u.name as unit_name, f.description, f.legal_basis_cited, f.amount_vnd::text as amount_vnd, f.severity, f.created_at::text as created_at`;

const RECOMMENDATION_COLUMNS = `r.id, r.conclusion_id, r.finding_id, r.rec_code, r.rec_type, r.description, r.amount_vnd::text as amount_vnd, r.recovered_vnd::text as recovered_vnd, r.project_id,
  r.owner_unit_id, r.due_on::text as due_on, r.status, r.is_overdue, r.created_at::text as created_at`;

const toConclusion = (row: ConclusionSql): ConclusionLine => ({
  id: row.id,
  engagementId: row.engagement_id,
  conclusionKind: row.conclusion_kind,
  document: { id: row.document_id, title: row.document_title ?? '', symbol: row.document_symbol },
  revision: row.revision,
  supersedesId: row.supersedes_id,
  issuedOn: row.issued_on,
  receivedOn: row.received_on,
  implementationDueOn: row.implementation_due_on,
  reportDueOn: row.report_due_on,
  summary: row.summary,
  totalFinancialVnd: row.total_financial_vnd,
  recommendedVnd: row.recommended_vnd,
  shortfallVnd: financialShortfall(row.total_financial_vnd, row.recommended_vnd),
  isPublic: row.is_public,
  status: row.status,
  findingCount: Number(row.finding_count),
  recommendationCount: Number(row.recommendation_count),
  version: Number(row.version),
});

const toFinding = (row: FindingSql): FindingLine => ({
  id: row.id,
  conclusionId: row.conclusion_id,
  findingCode: row.finding_code,
  category: row.category,
  project: row.project_id === null ? null : { id: row.project_id, code: row.project_code ?? '', name: row.project_name ?? '' },
  contract: row.contract_id === null ? null : { id: row.contract_id, code: row.contract_code ?? '' },
  unit: row.unit_id === null ? null : { id: row.unit_id, code: row.unit_code ?? '', name: row.unit_name ?? '' },
  description: row.description,
  legalBasisCited: row.legal_basis_cited,
  amountVnd: row.amount_vnd,
  severity: row.severity,
  createdAt: row.created_at,
});

const toRecommendation = (row: RecommendationSql): RecommendationLine => ({
  id: row.id,
  conclusionId: row.conclusion_id,
  findingId: row.finding_id,
  recCode: row.rec_code,
  recType: row.rec_type,
  description: row.description,
  amountVnd: row.amount_vnd,
  recoveredVnd: row.recovered_vnd,
  projectId: row.project_id,
  ownerUnitId: row.owner_unit_id,
  dueOn: row.due_on,
  status: row.status,
  isOverdue: row.is_overdue,
  createdAt: row.created_at,
});

/**
 * Whether a place lies inside the scope of an engagement (AUD 2: a coordinator writes nothing about a place outside the engagement). A unit item covers the units under it and the projects and
 * contracts owned there; a project item covers itself, its contracts and the unit that owns it; a contract item covers itself and the unit that owns its project.
 */
export function withinEngagementScope(target: ResolvedTarget, scope: readonly ResolvedTarget[]): boolean {
  return scope.some((item) => {
    if (item.kind === 'UNIT') return target.ownerUnitPath.startsWith(item.ownerUnitPath);
    if (item.kind === 'PROJECT') return (target.kind === 'PROJECT' && target.id === item.id) || (target.kind === 'CONTRACT' && target.projectId === item.id) || (target.kind === 'UNIT' && target.id === item.ownerUnitId);
    return (target.kind === 'CONTRACT' && target.id === item.id) || (target.kind === 'UNIT' && target.id === item.ownerUnitId);
  });
}

/**
 * Conclusions, findings and recommendations of an engagement (ST-AUD-002, AUD 3.2). A conclusion is recorded against a document that DOC holds in force and moves the engagement to
 * FOLLOW_UP in the same transaction; the findings and the recommendations hang on it and are about places inside the scope of the engagement. The money of the financial
 * recommendations is added up under a lock of the conclusion and never passes its total (BR-AUD-05), and the table holds the same rule. Reads go through `engagementScope`.
 */
export class AudConclusionStore {
  private readonly engagements = new AudEngagementStore();

  /**
   * Records the conclusion of an engagement that is ONGOING or AWAITING_CONCLUSION and moves it to FOLLOW_UP (409 ENGAGEMENT_STATE_INVALID from any other state). The document must be
   * a received or reference document in force (422 DECISION_DOCUMENT_NOT_EFFECTIVE); the days are in order and not in the future; a revision that supersedes another arrives with the
   * amended conclusions (ST-AUD-007), so a conclusion that names one, or one that finds another of its kind, is 409 CONCLUSION_REVISION_INVALID.
   */
  async record(tx: TenantTx, engagement: EngagementRow, input: NewConclusion, today: string, actor: string): Promise<{ id: string; engagementVersion: number }> {
    const status = nextEngagementStatus(engagement.status, 'recordConclusion');
    const [document] = await tx.query<{ doc_kind: string; effect_status: string }>('select doc_kind, effect_status from machvon.document where id = $1::uuid', [input.conclusionDocumentId]);
    if (document === undefined || !['INCOMING', 'REFERENCE'].includes(document.doc_kind) || document.effect_status !== 'EFFECTIVE') {
      throw new DomainError('DECISION_DOCUMENT_NOT_EFFECTIVE', 422);
    }
    const summary = input.summary.trim();
    if (summary.length < 10) throw new DomainError('VALIDATION_FAILED', 422, 'summary');
    const total = wholeDong(input.totalFinancialVnd, 'total_financial_vnd');
    if (input.receivedOn < input.issuedOn || input.receivedOn > today) throw new DomainError('VALIDATION_FAILED', 422, 'received_on');
    if (input.implementationDueOn !== undefined && input.implementationDueOn < input.issuedOn) throw new DomainError('VALIDATION_FAILED', 422, 'implementation_due_on');
    if (input.reportDueOn !== undefined && input.reportDueOn < input.issuedOn) throw new DomainError('VALIDATION_FAILED', 422, 'report_due_on');
    const [earlier] = await tx.query<{ id: string }>('select id from machvon.audit_conclusion where engagement_id = $1::uuid limit 1', [engagement.id]);
    if (input.supersedesId !== undefined || earlier !== undefined) throw new DomainError('CONCLUSION_REVISION_INVALID', 409);
    const created = await withUniqueClaim(tx, { constraint: 'audit_conclusion_rev_uq', code: 'CONCLUSION_REVISION_INVALID', status: 409 }, async () => {
      const [row] = await tx.query<{ id: string }>(
        `insert into machvon.audit_conclusion
           (tenant_id, id, engagement_id, conclusion_kind, conclusion_document_id, revision, issued_on, received_on, implementation_due_on, report_due_on, summary,
            total_financial_vnd, is_public, status, created_by, updated_by, version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3::uuid, 1, $4::date, $5::date, $6::date, $7::date, $8,
                 $9::numeric, $10, 'RECEIVED', $11::uuid, $11::uuid, 1)
         returning id`,
        [engagement.id, input.conclusionKind, input.conclusionDocumentId, input.issuedOn, input.receivedOn, input.implementationDueOn ?? null, input.reportDueOn ?? null, summary, total, input.isPublic, actor],
      );
      return row as { id: string };
    });
    const [updated] = await tx.query<{ version: string }>(
      `update machvon.audit_engagement set status = $2, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid returning version::text as version`,
      [engagement.id, status, actor],
    );
    return { id: created.id, engagementVersion: Number((updated as { version: string }).version) };
  }

  /**
   * Locks a conclusion for a command in the scope of the caller (404 outside it, 403 when the caller sees it and may not act on it, by the second scope). Only the current revision of a
   * conclusion of an engagement that is being followed up takes more: 409 CONCLUSION_REVISION_INVALID for a revision that was superseded, 409 ENGAGEMENT_STATE_INVALID for an engagement that is over.
   */
  async lock(tx: TenantTx, id: string, seen: ScopeBuilder, acts: ScopeBuilder): Promise<ConclusionRow> {
    const visible = seen(2);
    const [located] = await tx.query<{ id: string }>(
      `select c.id from machvon.audit_conclusion c join machvon.audit_engagement e on e.tenant_id = c.tenant_id and e.id = c.engagement_id where c.id = $1::uuid and ${visible.sql}`,
      [id, ...visible.params],
    );
    if (located === undefined) throw NOT_FOUND();
    const [row] = await tx.query<{ id: string; engagement_id: string; engagement_code: string; engagement_status: EngagementStatus; conclusion_kind: ConclusionKind; status: string; total: string }>(
      `select c.id, c.engagement_id, e.engagement_code, e.status as engagement_status, c.conclusion_kind, c.status, c.total_financial_vnd::text as total
         from machvon.audit_conclusion c join machvon.audit_engagement e on e.tenant_id = c.tenant_id and e.id = c.engagement_id
        where c.id = $1::uuid for update of c`,
      [id],
    );
    if (row === undefined) throw NOT_FOUND();
    const own = acts(2);
    const [allowed] = await tx.query<{ id: string }>(
      `select c.id from machvon.audit_conclusion c join machvon.audit_engagement e on e.tenant_id = c.tenant_id and e.id = c.engagement_id where c.id = $1::uuid and ${own.sql}`,
      [id, ...own.params],
    );
    if (allowed === undefined) throw new DomainError('SCOPE_DENIED', 403);
    if (row.engagement_status !== 'FOLLOW_UP') throw new DomainError('ENGAGEMENT_STATE_INVALID', 409, `${row.engagement_status}->follow_up`);
    if (!['RECEIVED', 'ANALYSED'].includes(row.status)) throw new DomainError('CONCLUSION_REVISION_INVALID', 409);
    return {
      id: row.id,
      engagementId: row.engagement_id,
      engagementCode: row.engagement_code,
      engagementStatus: row.engagement_status,
      conclusionKind: row.conclusion_kind,
      status: row.status,
      totalFinancialVnd: row.total,
    };
  }

  /** The places a finding or a recommendation names, as they stand in the tenant (404 for one that is not there) and inside the engagement (422 TARGET_OUT_OF_ENGAGEMENT). */
  private async assertTargets(tx: TenantTx, engagementId: string, named: ReadonlyArray<{ field: string; target: ScopeTarget }>): Promise<void> {
    if (named.length === 0) return;
    const resolved = await this.engagements.resolveTargets(tx, named.map((entry) => entry.target));
    const items = await tx.query<{ scope_kind: ScopeTarget['kind']; target_id: string }>(
      'select scope_kind, coalesce(organization_unit_id, project_id, contract_id) as target_id from machvon.audit_scope_item where engagement_id = $1::uuid',
      [engagementId],
    );
    const scope = await this.engagements.resolveTargets(tx, items.map((item) => ({ kind: item.scope_kind, id: item.target_id })));
    for (const entry of named) {
      const found = resolved.find((candidate) => candidate.kind === entry.target.kind && candidate.id === entry.target.id.toLowerCase());
      if (found === undefined || !withinEngagementScope(found, scope)) throw new DomainError('TARGET_OUT_OF_ENGAGEMENT', 422, entry.field);
    }
  }

  /** Records a finding of a conclusion: a code used once in it (409 FINDING_CODE_DUPLICATE), about places of the engagement, with an amount that is a whole number of dong when it has one. */
  async recordFinding(tx: TenantTx, conclusion: ConclusionRow, input: NewFinding, actor: string): Promise<{ id: string }> {
    const code = input.findingCode.trim();
    if (code.length < 1) throw new DomainError('VALIDATION_FAILED', 422, 'finding_code');
    const description = input.description.trim();
    if (description.length < 10) throw new DomainError('VALIDATION_FAILED', 422, 'description');
    const amount = input.amountVnd === undefined ? null : wholeDong(input.amountVnd, 'amount_vnd');
    await this.assertNamed(tx, conclusion.engagementId, input);
    return withUniqueClaim(tx, { constraint: 'audit_finding_code_uq', code: 'FINDING_CODE_DUPLICATE', status: 409 }, async () => {
      const [row] = await tx.query<{ id: string }>(
        `insert into machvon.audit_finding
           (tenant_id, id, conclusion_id, finding_code, category, project_id, contract_id, organization_unit_id, description, legal_basis_cited, amount_vnd, severity, created_by, updated_by, version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3, $4::uuid, $5::uuid, $6::uuid, $7, $8, $9::numeric, $10, $11::uuid, $11::uuid, 1)
         returning id`,
        [conclusion.id, code, input.category, input.projectId ?? null, input.contractId ?? null, input.organizationUnitId ?? null, description, (input.legalBasisCited ?? '').trim() || null, amount, input.severity, actor],
      );
      return row as { id: string };
    });
  }

  private assertNamed(tx: TenantTx, engagementId: string, input: Pick<NewFinding, 'projectId' | 'contractId' | 'organizationUnitId'>): Promise<void> {
    const named: Array<{ field: string; target: ScopeTarget }> = [];
    if (input.projectId !== undefined) named.push({ field: 'project_id', target: { kind: 'PROJECT', id: input.projectId } });
    if (input.contractId !== undefined) named.push({ field: 'contract_id', target: { kind: 'CONTRACT', id: input.contractId } });
    if (input.organizationUnitId !== undefined) named.push({ field: 'organization_unit_id', target: { kind: 'UNIT', id: input.organizationUnitId } });
    return this.assertTargets(tx, engagementId, named);
  }

  /**
   * Creates a recommendation of a conclusion, OPEN. A financial one names an amount (422 AMOUNT_REQUIRED) and the financial ones of the conclusion add up to no more than its total (422
   * FINANCIAL_TOTAL_MISMATCH, BR-AUD-05); the sum is read under the lock of the conclusion that `lock` took, so two at once cannot both pass. The code is used once in the conclusion (409
   * REC_CODE_DUPLICATE); a finding it answers is one of the same conclusion. Returns the sum after it and what is left of the total.
   */
  async createRecommendation(tx: TenantTx, conclusion: ConclusionRow, input: NewRecommendation, actor: string): Promise<{ id: string; recommendedVnd: string; shortfallVnd: string }> {
    const code = input.recCode.trim();
    if (code.length < 1) throw new DomainError('VALIDATION_FAILED', 422, 'rec_code');
    const description = input.description.trim();
    if (description.length < 10) throw new DomainError('VALIDATION_FAILED', 422, 'description');
    const amount = recommendationAmount(input.recType, input.amountVnd);
    if (input.findingId !== undefined) {
      const [finding] = await tx.query<{ id: string }>('select id from machvon.audit_finding where id = $1::uuid and conclusion_id = $2::uuid', [input.findingId, conclusion.id]);
      if (finding === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'finding_id');
    }
    if (input.projectId !== undefined) await this.assertTargets(tx, conclusion.engagementId, [{ field: 'project_id', target: { kind: 'PROJECT', id: input.projectId } }]);
    const recommended = await this.recommendedTotal(tx, conclusion.id);
    if (amount !== null) assertWithinConclusionTotal(conclusion.totalFinancialVnd, recommended, amount);
    const created = await withUniqueClaim(tx, { constraint: 'audit_recommendation_code_uq', code: 'REC_CODE_DUPLICATE', status: 409 }, async () => {
      const [row] = await tx.query<{ id: string }>(
        `insert into machvon.audit_recommendation
           (tenant_id, id, conclusion_id, finding_id, rec_code, rec_type, description, amount_vnd, project_id, status, created_by, updated_by, version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, $6::numeric, $7::uuid, 'OPEN', $8::uuid, $8::uuid, 1)
         returning id`,
        [conclusion.id, input.findingId ?? null, code, input.recType, description, amount, input.projectId ?? null, actor],
      );
      return row as { id: string };
    });
    const after = (BigInt(recommended) + BigInt(amount ?? '0')).toString();
    return { id: created.id, recommendedVnd: after, shortfallVnd: financialShortfall(conclusion.totalFinancialVnd, after) };
  }

  /** The financial recommendations of a conclusion added up, the cancelled ones left out. */
  async recommendedTotal(tx: TenantTx, conclusionId: string): Promise<string> {
    const [row] = await tx.query<{ total: string }>(
      `select coalesce(sum(amount_vnd), 0)::text as total from machvon.audit_recommendation
        where conclusion_id = $1::uuid and rec_type in (${FINANCIAL_SQL}) and status <> 'CANCELLED'`,
      [conclusionId],
    );
    return (row as { total: string }).total;
  }

  /** The conclusions of an engagement in the scope of the caller, the newest revision first, each with what its recommendations add up to and what is left; empty outside the scope. */
  async listConclusions(tx: TenantTx, engagementId: string, scope: ScopeBuilder): Promise<ConclusionLine[]> {
    const predicate = scope(2);
    const rows = await tx.query<ConclusionSql>(
      `select ${CONCLUSION_COLUMNS}
         from machvon.audit_conclusion c
         join machvon.audit_engagement e on e.tenant_id = c.tenant_id and e.id = c.engagement_id
         left join machvon.document doc on doc.tenant_id = c.tenant_id and doc.id = c.conclusion_document_id
        where c.engagement_id = $1::uuid and ${predicate.sql}
        order by c.revision desc, c.id`,
      [engagementId, ...predicate.params],
    );
    return rows.map(toConclusion);
  }

  /** One conclusion in the scope of the caller; undefined when it does not exist or lies outside the scope. */
  async findConclusion(tx: TenantTx, id: string, scope: ScopeBuilder): Promise<ConclusionLine | undefined> {
    const predicate = scope(2);
    const [row] = await tx.query<ConclusionSql>(
      `select ${CONCLUSION_COLUMNS}
         from machvon.audit_conclusion c
         join machvon.audit_engagement e on e.tenant_id = c.tenant_id and e.id = c.engagement_id
         left join machvon.document doc on doc.tenant_id = c.tenant_id and doc.id = c.conclusion_document_id
        where c.id = $1::uuid and ${predicate.sql}`,
      [id, ...predicate.params],
    );
    return row === undefined ? undefined : toConclusion(row);
  }

  /** The findings of a conclusion in the scope of the caller, by code; the cursor is the code and the id of the last one. */
  async listFindings(tx: TenantTx, conclusionId: string, scope: ScopeBuilder, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<FindingLine[]> {
    const predicate = scope(5);
    const rows = await tx.query<FindingSql>(
      `select ${FINDING_COLUMNS}
         from machvon.audit_finding f
         join machvon.audit_conclusion c on c.tenant_id = f.tenant_id and c.id = f.conclusion_id
         join machvon.audit_engagement e on e.tenant_id = c.tenant_id and e.id = c.engagement_id
         left join machvon.project p on p.tenant_id = f.tenant_id and p.id = f.project_id
         left join machvon.contract k on k.tenant_id = f.tenant_id and k.id = f.contract_id
         left join machvon.organization_unit u on u.tenant_id = f.tenant_id and u.id = f.organization_unit_id
        where f.conclusion_id = $1::uuid and ($2::text is null or (f.finding_code, f.id) > ($2::text, $3::uuid)) and ${predicate.sql}
        order by f.finding_code, f.id limit $4`,
      [conclusionId, request.after?.code ?? null, request.after?.id ?? null, request.limit, ...predicate.params],
    );
    return rows.map(toFinding);
  }

  /** The recommendations in the scope of the caller, by code, narrowed by what the screens ask for; the cursor is the code and the id of the last one. */
  async listRecommendations(
    tx: TenantTx,
    scope: ScopeBuilder,
    request: {
      limit: number;
      after: { code: string; id: string } | undefined;
      conclusionId?: string | undefined;
      engagementId?: string | undefined;
      status?: string | undefined;
      recType?: string | undefined;
      ownerUnitId?: string | undefined;
      overdue?: boolean | undefined;
    },
  ): Promise<RecommendationLine[]> {
    const predicate = scope(10);
    const rows = await tx.query<RecommendationSql>(
      `select ${RECOMMENDATION_COLUMNS}
         from machvon.audit_recommendation r
         join machvon.audit_conclusion c on c.tenant_id = r.tenant_id and c.id = r.conclusion_id
         join machvon.audit_engagement e on e.tenant_id = c.tenant_id and e.id = c.engagement_id
        where ($1::text is null or (r.rec_code, r.id) > ($1::text, $2::uuid))
          and ($4::uuid is null or r.conclusion_id = $4::uuid) and ($5::uuid is null or c.engagement_id = $5::uuid)
          and ($6::text is null or r.status = $6::text) and ($7::text is null or r.rec_type = $7::text)
          and ($8::uuid is null or r.owner_unit_id = $8::uuid) and ($9::boolean is null or r.is_overdue = $9::boolean)
          and ${predicate.sql}
        order by r.rec_code, r.id limit $3`,
      [
        request.after?.code ?? null,
        request.after?.id ?? null,
        request.limit,
        request.conclusionId ?? null,
        request.engagementId ?? null,
        request.status ?? null,
        request.recType ?? null,
        request.ownerUnitId ?? null,
        request.overdue ?? null,
        ...predicate.params,
      ],
    );
    return rows.map(toRecommendation);
  }
}
