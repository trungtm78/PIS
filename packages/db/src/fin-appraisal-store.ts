import { randomUUID } from 'node:crypto';
import {
  DomainError,
  FIN_FORMULA_VERSION,
  FIN_LINE_KINDS,
  activeGrants,
  appraisalInputsHash,
  assertAssumptionForm,
  assertAssumptionsComplete,
  assertFinApprover,
  assertFinPeriodUnit,
  assertFinStatus,
  assertFinSubmittable,
  assertScenarios,
  computeAppraisal,
  isFinCriteriaCategory,
  isFinKind,
  normalizeFinModel,
  permissionMatches,
  requiredAssumptionKeys,
  versionConflict,
} from '@machvon/kernel';
import type {
  AppraisalComputed,
  EffectiveAccess,
  FinAssumptionInput,
  FinCriteriaCategory,
  FinCriteriaResult,
  FinCriteriaSet,
  FinCriterion,
  FinCriterionScoreInput,
  FinExportInput,
  FinKind,
  FinLineInput,
  FinModelInput,
  FinReport,
  FinScenarioInput,
  FinSensitivityConfig,
  FinStatus,
} from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import { scopePredicate } from './scope-version.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 2000;
const TENANT = `nullif(current_setting('app.tenant_id', true), '')::uuid`;
const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** The unit of an appraisal: the scope of a caller is compiled over the unit that answers for it (alias `u`). */
const UNIT_COLUMNS = { unitPath: 'u.path', unitId: 'u.id' } as const;

const FROM = `machvon.investment_appraisal a
  join machvon.organization_unit u on u.tenant_id = a.tenant_id and u.id = a.owner_unit_id
  left join machvon.project p on p.tenant_id = a.tenant_id and p.id = a.project_id
  left join machvon.procurement_package pk on pk.tenant_id = a.tenant_id and pk.id = a.package_id
  left join machvon.contract c on c.tenant_id = a.tenant_id and c.id = a.contract_id
  left join machvon.tenant_user_directory cd on cd.tenant_id = a.tenant_id and cd.membership_id = a.created_by
  left join machvon.tenant_user_directory ud on ud.tenant_id = a.tenant_id and ud.membership_id = a.updated_by
  left join machvon.tenant_user_directory sd on sd.tenant_id = a.tenant_id and sd.membership_id = a.submitted_by
  left join machvon.tenant_user_directory ad on ad.tenant_id = a.tenant_id and ad.membership_id = a.approved_by`;

/**
 * The scope of a caller over the appraisals: the units that answer for them, and the projects and contracts that a grant of a narrower scope names. Parameters are numbered from `first`; the aliases are
 * the ones of `FROM` above.
 */
export function appraisalScope(access: EffectiveAccess, permission: string, now: Date): ScopeBuilder {
  return (first: number) => {
    const unit = scopePredicate(access, permission, now, UNIT_COLUMNS, first);
    if (unit.sql === 'true') return unit;
    const projectIds = new Set<string>();
    const contractIds = new Set<string>();
    for (const grant of activeGrants(access, now)) {
      if (!grant.permissions.some((held) => permissionMatches(held, permission))) continue;
      if (grant.scope.kind === 'PROJECT') for (const id of grant.scope.refIds) projectIds.add(id);
      if (grant.scope.kind === 'CONTRACT') for (const id of grant.scope.refIds) contractIds.add(id);
    }
    const params = [...unit.params];
    const alternatives = [unit.sql];
    if (projectIds.size > 0) {
      params.push([...projectIds].sort());
      alternatives.push(`a.project_id = any($${first + params.length - 1}::uuid[])`);
    }
    if (contractIds.size > 0) {
      params.push([...contractIds].sort());
      alternatives.push(`a.contract_id = any($${first + params.length - 1}::uuid[])`);
    }
    return { sql: `(${alternatives.join(' or ')})`, params };
  };
}

const invalid = (field: string, reason?: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, reason === undefined ? undefined : { extensions: { reason } });
const idOf = (value: string | undefined | null, field: string): string => {
  if (value === undefined || value === null || !UUID.test(value)) throw invalid(field, 'NOT_AN_ID');
  return value.toLowerCase();
};
const textOf = (value: unknown, field: string, max = MAX_TEXT): string => {
  if (typeof value !== 'string') throw invalid(field, 'EMPTY');
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > max) throw invalid(field, 'EMPTY');
  return trimmed;
};

/** A decimal text as the database gives it ("1000.00") written without the zeros that carry no meaning ("1000"), so that the same inputs hash the same whatever the spelling. */
export function plainDecimal(value: string): string {
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' || trimmed === '-' ? '0' : trimmed;
}

// ---- Shapes ------------------------------------------------------------------------------------------------------------------------------

export interface AppraisalInputs {
  title: string;
  periodUnit: string;
  discountRatePct: string;
  convention: string;
  lines: readonly FinLineInput[];
  assumptions: readonly FinAssumptionInput[];
  scenarios: readonly FinScenarioInput[];
  sensitivity: FinSensitivityConfig | null;
  criteriaCategory: string | null;
  scores: readonly FinCriterionScoreInput[];
}

export interface AppraisalCreate {
  title: string;
  kind: string;
  ownerUnitId?: string | undefined;
  projectId?: string | undefined;
  packageId?: string | undefined;
  contractId?: string | undefined;
  /** The approved appraisal this one is the next version of. */
  reviseOf?: string | undefined;
  periodUnit?: string | undefined;
  discountRatePct?: string | undefined;
  convention?: string | undefined;
}

export interface CriteriaInForce {
  category: FinCriteriaCategory;
  source: 'RULE' | 'DEFAULT';
  /** The version of the rule (0 for the built-in default). */
  version: number;
  unverified: boolean;
  criteria: FinCriterion[];
}

export interface AppraisalLineView {
  period: number;
  benefit: string;
  capex: string;
  opex: string;
  maintenance: string;
  residual: string;
}

export interface AppraisalAssumptionView {
  key: string;
  value: string;
  unit: string;
  sourceKind: string;
  source: string;
  ownerId: string;
  ownerName: string | null;
}

export interface StoredResults {
  report: FinReport | null;
  criteria: FinCriteriaResult | null;
}

export interface AppraisalView {
  id: string;
  code: string;
  revision: number;
  supersedesId: string | null;
  title: string;
  kind: FinKind;
  status: FinStatus;
  version: number;
  ownerUnit: { id: string; code: string; name: string; path: string };
  project: { id: string; code: string } | null;
  package: { id: string; code: string } | null;
  contract: { id: string; code: string } | null;
  /** The next version of this appraisal when one was opened (an approved appraisal has at most one). */
  nextRevisionId: string | null;
  periodUnit: string;
  discountRatePct: string;
  convention: string;
  sensitivity: FinSensitivityConfig | null;
  criteriaCategory: string | null;
  lines: AppraisalLineView[];
  assumptions: AppraisalAssumptionView[];
  scenarios: FinScenarioInput[];
  scores: FinCriterionScoreInput[];
  /** The inputs somebody still has to answer for before the appraisal can be submitted. */
  requiredAssumptions: string[];
  missingAssumptions: string[];
  /** What the server computed last (approved: what approval froze); null when nothing was computed. */
  results: StoredResults | null;
  resultHash: string | null;
  formulaVersion: string | null;
  computedAt: string | null;
  computedBy: string | null;
  /** The stored results were computed from exactly these inputs under the formula in force. */
  resultsFresh: boolean;
  frozen: boolean;
  criteriaUsed: { source: 'RULE' | 'DEFAULT'; version: number; criteria: FinCriterion[] } | null;
  criteriaInForce: CriteriaInForce | null;
  createdBy: { id: string; name: string | null };
  updatedBy: { id: string; name: string | null };
  submittedBy: { id: string; name: string | null } | null;
  approvedBy: { id: string; name: string | null } | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  approvedAt: string | null;
  decisionReason: string | null;
  asOf: string;
}

export interface AppraisalListItem {
  id: string;
  code: string;
  revision: number;
  title: string;
  kind: FinKind;
  status: FinStatus;
  version: number;
  ownerUnit: { id: string; code: string; name: string };
  project: { id: string; code: string } | null;
  package: { id: string; code: string } | null;
  contract: { id: string; code: string } | null;
  /** What the figures below are: FROZEN at approval, COMPUTED (a draft or a submission, may be out of date) or NONE. */
  resultState: 'FROZEN' | 'COMPUTED' | 'NONE';
  npv: string | null;
  irrPct: string | null;
  paybackPeriods: string | null;
  indexPct: string | null;
  createdByName: string | null;
  approvedByName: string | null;
  updatedAt: string;
}

export interface AppraisalListFilter {
  projectId?: string | undefined;
  packageId?: string | undefined;
  contractId?: string | undefined;
  status?: string | undefined;
  kind?: string | undefined;
  q?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

/** The result of a command on an appraisal: what changed, for the audit row, the event and the answer. */
export interface AppraisalCommandResult {
  id: string;
  code: string;
  revision: number;
  kind: FinKind;
  version: number;
  status: FinStatus;
  ownerUnitId: string;
  projectId: string | null;
  resultHash: string | null;
  formulaVersion: string | null;
}

interface HeaderSql {
  id: string;
  code: string;
  revision: number;
  supersedes_id: string | null;
  title: string;
  kind: FinKind;
  owner_unit_id: string;
  owner_unit_code: string;
  owner_unit_name: string;
  owner_unit_path: string;
  project_id: string | null;
  project_code: string | null;
  package_id: string | null;
  package_code: string | null;
  contract_id: string | null;
  contract_code: string | null;
  period_unit: string;
  discount_rate_pct: string;
  convention: string;
  sensitivity: FinSensitivityConfig | null;
  criteria_category: string | null;
  status: FinStatus;
  version: string;
  results: StoredResults | null;
  results_inputs_hash: string | null;
  result_hash: string | null;
  formula_version: string | null;
  computed_at: string | null;
  computed_by: string | null;
  criteria_rule_version: number | null;
  criteria_rule_source: 'RULE' | 'DEFAULT' | null;
  criteria_snapshot: { category: string; criteria: FinCriterion[] } | null;
  criteria_result: FinCriteriaResult | null;
  frozen_results: StoredResults | null;
  frozen_result_hash: string | null;
  frozen_formula_version: string | null;
  created_by: string;
  created_by_name: string | null;
  updated_by: string;
  updated_by_name: string | null;
  submitted_by: string | null;
  submitted_by_name: string | null;
  approved_by: string | null;
  approved_by_name: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  approved_at: string | null;
  decision_reason: string | null;
}

const HEADER_COLUMNS = `a.id, a.code, a.revision, a.supersedes_id, a.title, a.kind, a.owner_unit_id, u.code as owner_unit_code, u.name as owner_unit_name, u.path as owner_unit_path, a.project_id, p.code as project_code,
  a.package_id, pk.code as package_code, a.contract_id, c.code as contract_code, a.period_unit, a.discount_rate_pct::text as discount_rate_pct, a.convention, a.sensitivity, a.criteria_category, a.status,
  a.version::text as version, a.results, a.results_inputs_hash, a.result_hash, a.formula_version, ${ISO('a.computed_at')} as computed_at, a.computed_by, a.criteria_rule_version, a.criteria_rule_source,
  a.criteria_snapshot, a.criteria_result, a.frozen_results, a.frozen_result_hash, a.frozen_formula_version, a.created_by, cd.display_name as created_by_name, a.updated_by, ud.display_name as updated_by_name,
  a.submitted_by, sd.display_name as submitted_by_name, a.approved_by, ad.display_name as approved_by_name, ${ISO('a.created_at')} as created_at, ${ISO('a.updated_at')} as updated_at,
  ${ISO('a.submitted_at')} as submitted_at, ${ISO('a.approved_at')} as approved_at, a.decision_reason`;

interface LineSql {
  period: number;
  benefit: string;
  capex: string;
  opex: string;
  maintenance: string;
  residual: string;
}

interface AssumptionSql {
  input_key: string;
  value_text: string;
  unit: string;
  source_kind: string;
  source_text: string;
  owner_id: string;
  owner_name: string | null;
}

interface Loaded {
  header: HeaderSql;
  lines: AppraisalLineView[];
  assumptions: AppraisalAssumptionView[];
  scenarios: FinScenarioInput[];
  scores: FinCriterionScoreInput[];
}

/** The model of the appraisal from its lines: an amount of zero is left out (the same inputs hash the same), a period with nothing in it keeps the horizon. */
export function modelOf(header: Pick<HeaderSql, 'period_unit' | 'discount_rate_pct' | 'convention'>, lines: readonly AppraisalLineView[]): FinModelInput | null {
  if (lines.length === 0) return null;
  return {
    periodUnit: header.period_unit as FinModelInput['periodUnit'],
    discountRatePct: plainDecimal(header.discount_rate_pct),
    convention: header.convention as FinModelInput['convention'],
    lines: lines.map((line) => {
      const out: FinLineInput = { period: line.period };
      for (const kind of FIN_LINE_KINDS) if (line[kind] !== '0') out[kind] = line[kind];
      return out;
    }),
  };
}

/**
 * The investment appraisals (lane FIN-1, AI.06): the inputs that people answer for, the results that only the server computes (through the formula module of the kernel, never from a number of the client),
 * the life DRAFT, SUBMITTED, APPROVED with a maker who is not the checker, and the freezing of the results with their hash and formula version at approval. The weights of the non-financial criteria are
 * rules of the governance platform, read through `GovernancePolicyPort`; the appraisal keeps the set and the rule version it was scored with.
 */
export class FinAppraisalStore {
  private readonly policy: GovernancePolicyPort;

  constructor(policy: GovernancePolicyPort = new GovernancePolicyPort()) {
    this.policy = policy;
  }

  // ---- Commands ------------------------------------------------------------------------------------------------------------------------

  /** Opens a draft; with `reviseOf` it is the next version of an approved appraisal and starts from its inputs. */
  async create(tx: TenantTx, input: AppraisalCreate, actor: string, scope: ScopeBuilder, now: Date): Promise<AppraisalCommandResult> {
    if (!isFinKind(input.kind)) throw invalid('kind', 'UNKNOWN_KIND');
    const title = textOf(input.title, 'title', 300);
    if (input.periodUnit !== undefined) assertFinPeriodUnit(input.periodUnit);
    if (input.convention !== undefined && input.convention !== 'END' && input.convention !== 'MID') throw invalid('convention', 'UNKNOWN_CONVENTION');
    const rate = input.discountRatePct ?? '0';
    normalizeFinModel({ periodUnit: 'YEAR', discountRatePct: rate, convention: 'END', lines: [{ period: 0 }] });
    const year = Number(new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 4));
    const id = randomUUID();
    if (input.reviseOf !== undefined) return this.createRevision(tx, idOf(input.reviseOf, 'revise_of'), id, title, actor, scope);
    const links = await this.resolveLinks(tx, input);
    await this.assertUnitInScope(tx, links.ownerUnitId, scope);
    const [counter] = await tx.query<{ last_number: number }>(
      `insert into machvon.appraisal_code_counter (tenant_id, year, last_number) values (${TENANT}, $1::int, 1)
       on conflict (tenant_id, year) do update set last_number = machvon.appraisal_code_counter.last_number + 1 returning last_number`,
      [year],
    );
    const code = `FIN-${year}-${String(counter?.last_number ?? 1).padStart(4, '0')}`;
    await tx.query(
      `insert into machvon.investment_appraisal (tenant_id, id, code, title, kind, owner_unit_id, project_id, package_id, contract_id, period_unit, discount_rate_pct, convention, created_by, updated_by)
       values (${TENANT}, $1::uuid, $2, $3, $4, $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9, $10::numeric, $11, $12::uuid, $12::uuid)`,
      [id, code, title, input.kind, links.ownerUnitId, links.projectId, links.packageId, links.contractId, input.periodUnit ?? 'YEAR', rate, input.convention ?? 'END', actor],
    );
    return { id, code, revision: 1, kind: input.kind, version: 1, status: 'DRAFT', ownerUnitId: links.ownerUnitId, projectId: links.projectId, resultHash: null, formulaVersion: null };
  }

  private async createRevision(tx: TenantTx, sourceId: string, id: string, title: string, actor: string, scope: ScopeBuilder): Promise<AppraisalCommandResult> {
    const source = await this.lock(tx, sourceId, scope);
    if (source.status !== 'APPROVED') assertFinStatus(source.status, ['APPROVED']);
    const [next] = await tx.query<{ id: string }>('select id from machvon.investment_appraisal where code = $1 and revision = $2::int', [source.code, source.revision + 1]);
    if (next !== undefined) throw new DomainError('APPRAISAL_STATE_INVALID', 409, 'revise_of', { extensions: { appraisal_status: 'REVISED', next_id: next.id } });
    await tx.query(
      `insert into machvon.investment_appraisal (tenant_id, id, code, revision, supersedes_id, title, kind, owner_unit_id, project_id, package_id, contract_id, period_unit, discount_rate_pct, convention, sensitivity,
         criteria_category, created_by, updated_by)
       select tenant_id, $2::uuid, code, revision + 1, id, $3, kind, owner_unit_id, project_id, package_id, contract_id, period_unit, discount_rate_pct, convention, sensitivity, criteria_category, $4::uuid, $4::uuid
         from machvon.investment_appraisal where id = $1::uuid`,
      [sourceId, id, title, actor],
    );
    await tx.query(
      `insert into machvon.appraisal_cash_line (tenant_id, appraisal_id, period, benefit_vnd, capex_vnd, opex_vnd, maintenance_vnd, residual_vnd)
       select tenant_id, $2::uuid, period, benefit_vnd, capex_vnd, opex_vnd, maintenance_vnd, residual_vnd from machvon.appraisal_cash_line where appraisal_id = $1::uuid`,
      [sourceId, id],
    );
    await tx.query(
      `insert into machvon.appraisal_assumption (tenant_id, appraisal_id, input_key, value_text, unit, source_kind, source_text, owner_id)
       select tenant_id, $2::uuid, input_key, value_text, unit, source_kind, source_text, owner_id from machvon.appraisal_assumption where appraisal_id = $1::uuid`,
      [sourceId, id],
    );
    await tx.query(
      `insert into machvon.appraisal_scenario (tenant_id, appraisal_id, code, position, label, deltas)
       select tenant_id, $2::uuid, code, position, label, deltas from machvon.appraisal_scenario where appraisal_id = $1::uuid`,
      [sourceId, id],
    );
    await tx.query(
      `insert into machvon.appraisal_criteria_score (tenant_id, appraisal_id, criterion_key, score, evidence)
       select tenant_id, $2::uuid, criterion_key, score, evidence from machvon.appraisal_criteria_score where appraisal_id = $1::uuid`,
      [sourceId, id],
    );
    return { id, code: source.code, revision: source.revision + 1, kind: source.kind, version: 1, status: 'DRAFT', ownerUnitId: source.owner_unit_id, projectId: source.project_id, resultHash: null, formulaVersion: null };
  }

  /** Replaces the inputs of a draft: the parameters, the cash flow, who answers for each input, the scenarios, the scores. Nothing here is a result. */
  async updateInputs(tx: TenantTx, id: string, expectedVersion: number, input: AppraisalInputs, actor: string, scope: ScopeBuilder): Promise<AppraisalCommandResult> {
    const header = await this.lock(tx, idOf(id, 'id'), scope);
    if (Number(header.version) !== expectedVersion) throw versionConflict(Number(header.version));
    assertFinStatus(header.status, ['DRAFT']);
    const title = textOf(input.title, 'title', 300);
    assertFinPeriodUnit(input.periodUnit);
    if (input.convention !== 'END' && input.convention !== 'MID') throw invalid('convention', 'UNKNOWN_CONVENTION');
    // The rate and, when there are lines, the lines: the formula module judges them (a field named, never a value).
    normalizeFinModel({ periodUnit: input.periodUnit as 'YEAR', discountRatePct: input.discountRatePct, convention: input.convention, lines: input.lines.length === 0 ? [{ period: 0 }] : input.lines });
    assertScenarios(input.scenarios);
    assertAssumptionForm(input.assumptions);
    const category = input.criteriaCategory;
    if (category !== null && !isFinCriteriaCategory(category)) throw invalid('criteria_category', 'UNKNOWN_CATEGORY');
    if (category === null && input.scores.length > 0) throw invalid('scores', 'NO_CATEGORY');
    const seen = new Set<string>();
    input.scores.forEach((score, index) => {
      if (typeof score.key !== 'string' || !/^[a-z][a-z0-9_]{1,39}$/.test(score.key)) throw invalid(`scores[${index}].key`, 'NOT_A_KEY');
      if (seen.has(score.key)) throw invalid(`scores[${index}].key`, 'DUPLICATE_KEY');
      seen.add(score.key);
      if (!Number.isInteger(score.score) || score.score < 1 || score.score > 5) throw invalid(`scores[${index}].score`, 'OUT_OF_RANGE');
      textOf(score.evidence, `scores[${index}].evidence`, 1000);
    });
    const owners = [...new Set(input.assumptions.map((entry) => entry.ownerId.toLowerCase()))];
    if (owners.length > 0) {
      const known = await tx.query<{ id: string }>('select id from machvon.membership where id = any($1::uuid[])', [owners]);
      const have = new Set(known.map((row) => row.id));
      input.assumptions.forEach((entry, index) => {
        if (!have.has(entry.ownerId.toLowerCase())) throw invalid(`assumptions[${index}].owner_id`, 'NOT_A_MEMBER');
      });
    }
    const appraisalId = header.id;
    await tx.query('delete from machvon.appraisal_cash_line where appraisal_id = $1::uuid', [appraisalId]);
    await tx.query('delete from machvon.appraisal_assumption where appraisal_id = $1::uuid', [appraisalId]);
    await tx.query('delete from machvon.appraisal_scenario where appraisal_id = $1::uuid', [appraisalId]);
    await tx.query('delete from machvon.appraisal_criteria_score where appraisal_id = $1::uuid', [appraisalId]);
    for (const line of [...input.lines].sort((a, b) => a.period - b.period)) {
      await tx.query(
        `insert into machvon.appraisal_cash_line (tenant_id, appraisal_id, period, benefit_vnd, capex_vnd, opex_vnd, maintenance_vnd, residual_vnd)
         values (${TENANT}, $1::uuid, $2::int, $3::numeric, $4::numeric, $5::numeric, $6::numeric, $7::numeric)`,
        [appraisalId, line.period, line.benefit || '0', line.capex || '0', line.opex || '0', line.maintenance || '0', line.residual || '0'],
      );
    }
    for (const entry of input.assumptions) {
      await tx.query(
        `insert into machvon.appraisal_assumption (tenant_id, appraisal_id, input_key, value_text, unit, source_kind, source_text, owner_id)
         values (${TENANT}, $1::uuid, $2, $3, $4, $5, $6, $7::uuid)`,
        [appraisalId, entry.key, entry.value, entry.unit, entry.sourceKind, entry.source, entry.ownerId.toLowerCase()],
      );
    }
    for (const [position, scenario] of input.scenarios.entries()) {
      await tx.query(`insert into machvon.appraisal_scenario (tenant_id, appraisal_id, code, position, label, deltas) values (${TENANT}, $1::uuid, $2, $3::int, $4, $5::jsonb)`, [appraisalId, scenario.code, position, scenario.label, JSON.stringify(scenario.deltas)]);
    }
    for (const score of input.scores) {
      await tx.query(`insert into machvon.appraisal_criteria_score (tenant_id, appraisal_id, criterion_key, score, evidence) values (${TENANT}, $1::uuid, $2, $3::smallint, $4)`, [appraisalId, score.key, score.score, score.evidence.trim()]);
    }
    await tx.query(
      `update machvon.investment_appraisal set title = $2, period_unit = $3, discount_rate_pct = $4::numeric, convention = $5, sensitivity = $6::jsonb, criteria_category = $7,
              updated_by = $8::uuid, updated_at = now(), version = version + 1 where id = $1::uuid`,
      [appraisalId, title, input.periodUnit, input.discountRatePct, input.convention, input.sensitivity === null ? null : JSON.stringify(input.sensitivity), category, actor],
    );
    return this.resultOf(header, Number(header.version) + 1, 'DRAFT');
  }

  /** Computes the results of a draft with the formula module and keeps them with the hash of the inputs, the hash of the result and the formula version. */
  async run(tx: TenantTx, id: string, expectedVersion: number, actor: string, scope: ScopeBuilder, now: Date): Promise<AppraisalCommandResult> {
    const header = await this.lock(tx, idOf(id, 'id'), scope);
    if (Number(header.version) !== expectedVersion) throw versionConflict(Number(header.version));
    assertFinStatus(header.status, ['DRAFT']);
    const loaded = await this.loadRest(tx, header);
    const category = isFinCriteriaCategory(header.criteria_category) ? header.criteria_category : null;
    const criteria = category === null || loaded.scores.length === 0 ? null : await this.criteriaInForce(tx, category, now);
    const computed = computeAppraisal({
      kind: header.kind,
      model: modelOf(header, loaded.lines),
      scenarios: loaded.scenarios,
      sensitivity: header.sensitivity,
      criteria: criteria === null ? null : { set: { category: criteria.category, criteria: criteria.criteria }, scores: loaded.scores },
    });
    const inputsHash = this.inputsHashOf(loaded);
    const payload: StoredResults = { report: computed.report, criteria: computed.criteria };
    await tx.query(
      `update machvon.investment_appraisal set results = $2::jsonb, results_inputs_hash = $3, result_hash = $4, formula_version = $5, computed_at = $6::timestamptz, computed_by = $7::uuid,
              criteria_rule_version = $8, criteria_rule_source = $9, criteria_snapshot = $10::jsonb, criteria_result = $11::jsonb, version = version + 1 where id = $1::uuid`,
      [
        header.id,
        JSON.stringify(payload),
        inputsHash,
        computed.resultHash,
        computed.formulaVersion,
        now.toISOString(),
        actor,
        criteria === null ? null : criteria.version,
        criteria === null ? null : criteria.source,
        criteria === null ? null : JSON.stringify({ category: criteria.category, criteria: criteria.criteria }),
        computed.criteria === null ? null : JSON.stringify(computed.criteria),
      ],
    );
    return { ...this.resultOf(header, Number(header.version) + 1, 'DRAFT'), resultHash: computed.resultHash, formulaVersion: computed.formulaVersion };
  }

  /** Submits a draft for approval: every input answered for, and a result that the server computed from exactly these inputs under the formula in force. */
  async submit(tx: TenantTx, id: string, expectedVersion: number, actor: string, scope: ScopeBuilder, now: Date): Promise<AppraisalCommandResult> {
    const header = await this.lock(tx, idOf(id, 'id'), scope);
    if (Number(header.version) !== expectedVersion) throw versionConflict(Number(header.version));
    assertFinStatus(header.status, ['DRAFT']);
    const loaded = await this.loadRest(tx, header);
    const model = modelOf(header, loaded.lines);
    assertFinSubmittable({
      kind: header.kind,
      lineCount: loaded.lines.length,
      criteriaCategory: header.criteria_category,
      criteriaScored: loaded.scores.length > 0 && header.criteria_result !== null,
      resultInputsHash: header.results_inputs_hash,
      currentInputsHash: this.inputsHashOf(loaded),
      resultFormulaVersion: header.formula_version,
      currentFormulaVersion: FIN_FORMULA_VERSION,
    });
    const required = requiredAssumptionKeys(model ?? { periodUnit: 'YEAR', discountRatePct: '0', convention: 'END', lines: [] }, loaded.scenarios);
    assertAssumptionsComplete(required, loaded.assumptions.map((entry) => ({ key: entry.key, value: entry.value, unit: entry.unit, sourceKind: entry.sourceKind, source: entry.source, ownerId: entry.ownerId })));
    await tx.query("update machvon.investment_appraisal set status = 'SUBMITTED', submitted_by = $2::uuid, submitted_at = $3::timestamptz, decision_reason = null, version = version + 1 where id = $1::uuid", [header.id, actor, now.toISOString()]);
    return { ...this.resultOf(header, Number(header.version) + 1, 'SUBMITTED'), resultHash: header.result_hash, formulaVersion: header.formula_version };
  }

  /**
   * Approves a submitted appraisal: by someone other than whoever made, last edited or submitted it (403 SELF_APPROVAL_DENIED). The results are computed once more from the stored inputs, with the
   * criteria as they were scored (the stored set, not the rule of today), and must give the hash that was submitted; a formula that changed meanwhile is 409 APPRAISAL_RESULTS_STALE and the record goes back
   * to a draft to be computed again. What approval stores is frozen with its hash and formula version.
   */
  async approve(tx: TenantTx, id: string, expectedVersion: number, reason: string | undefined, actor: string, scope: ScopeBuilder, now: Date): Promise<AppraisalCommandResult> {
    const header = await this.lock(tx, idOf(id, 'id'), scope);
    if (Number(header.version) !== expectedVersion) throw versionConflict(Number(header.version));
    assertFinStatus(header.status, ['SUBMITTED']);
    assertFinApprover(actor, { createdBy: header.created_by, updatedBy: header.updated_by, submittedBy: header.submitted_by });
    const note = reason === undefined || reason.trim() === '' ? null : textOf(reason, 'reason');
    const loaded = await this.loadRest(tx, header);
    const again = this.recompute(header, loaded);
    if (again.resultHash !== header.result_hash || this.inputsHashOf(loaded) !== header.results_inputs_hash) {
      throw new DomainError('APPRAISAL_RESULTS_STALE', 409, 'results', { extensions: { computed: true, formula_version: FIN_FORMULA_VERSION, stored_formula_version: header.formula_version } });
    }
    const frozen: StoredResults = { report: again.report, criteria: again.criteria };
    await tx.query(
      `update machvon.investment_appraisal set status = 'APPROVED', approved_by = $2::uuid, approved_at = $3::timestamptz, frozen_results = $4::jsonb, frozen_result_hash = $5, frozen_formula_version = $6,
              decision_reason = $7, version = version + 1 where id = $1::uuid`,
      [header.id, actor, now.toISOString(), JSON.stringify(frozen), again.resultHash, again.formulaVersion, note],
    );
    return { ...this.resultOf(header, Number(header.version) + 1, 'APPROVED'), resultHash: again.resultHash, formulaVersion: again.formulaVersion };
  }

  /** Sends a submitted appraisal back to a draft with the reason; the results stay, and the inputs may be edited again. */
  async returnToDraft(tx: TenantTx, id: string, expectedVersion: number, reason: string, actor: string, scope: ScopeBuilder): Promise<AppraisalCommandResult> {
    const header = await this.lock(tx, idOf(id, 'id'), scope);
    if (Number(header.version) !== expectedVersion) throw versionConflict(Number(header.version));
    assertFinStatus(header.status, ['SUBMITTED']);
    const text = textOf(reason, 'reason');
    await tx.query("update machvon.investment_appraisal set status = 'DRAFT', decision_reason = $2, updated_by = $3::uuid, updated_at = now(), version = version + 1 where id = $1::uuid", [header.id, text, actor]);
    return { ...this.resultOf(header, Number(header.version) + 1, 'DRAFT'), resultHash: header.result_hash, formulaVersion: header.formula_version };
  }

  // ---- Reads ---------------------------------------------------------------------------------------------------------------------------

  /** One appraisal in the scope of the caller; undefined when it is not there for the caller (another tenant, outside the scope). */
  async view(tx: TenantTx, id: string, scope: ScopeBuilder, now: Date): Promise<AppraisalView | undefined> {
    if (!UUID.test(id)) return undefined;
    const predicate = scope(2);
    const [header] = await tx.query<HeaderSql>(`select ${HEADER_COLUMNS} from ${FROM} where a.id = $1::uuid and ${predicate.sql}`, [id.toLowerCase(), ...predicate.params]);
    if (header === undefined) return undefined;
    const loaded = await this.loadRest(tx, header);
    const model = modelOf(header, loaded.lines);
    const required = requiredAssumptionKeys(model ?? { periodUnit: 'YEAR', discountRatePct: '0', convention: 'END', lines: [] }, loaded.scenarios);
    const have = new Set(loaded.assumptions.map((entry) => entry.key));
    const frozen = header.status === 'APPROVED' && header.frozen_results !== null;
    const results = frozen ? header.frozen_results : header.results;
    const fresh = frozen || (header.results_inputs_hash !== null && header.results_inputs_hash === this.inputsHashOf(loaded) && header.formula_version === FIN_FORMULA_VERSION);
    const category = isFinCriteriaCategory(header.criteria_category) ? header.criteria_category : null;
    const [next] = await tx.query<{ id: string }>('select id from machvon.investment_appraisal where code = $1 and revision = $2::int', [header.code, header.revision + 1]);
    return {
      id: header.id,
      code: header.code,
      revision: header.revision,
      supersedesId: header.supersedes_id,
      title: header.title,
      kind: header.kind,
      status: header.status,
      version: Number(header.version),
      ownerUnit: { id: header.owner_unit_id, code: header.owner_unit_code, name: header.owner_unit_name, path: header.owner_unit_path },
      project: header.project_id === null ? null : { id: header.project_id, code: header.project_code ?? '' },
      package: header.package_id === null ? null : { id: header.package_id, code: header.package_code ?? '' },
      contract: header.contract_id === null ? null : { id: header.contract_id, code: header.contract_code ?? '' },
      nextRevisionId: next?.id ?? null,
      periodUnit: header.period_unit,
      discountRatePct: plainDecimal(header.discount_rate_pct),
      convention: header.convention,
      sensitivity: header.sensitivity,
      criteriaCategory: header.criteria_category,
      lines: loaded.lines,
      assumptions: loaded.assumptions,
      scenarios: loaded.scenarios,
      scores: loaded.scores,
      requiredAssumptions: required,
      missingAssumptions: required.filter((key) => !have.has(key)),
      results,
      resultHash: frozen ? header.frozen_result_hash : header.result_hash,
      formulaVersion: frozen ? header.frozen_formula_version : header.formula_version,
      computedAt: header.computed_at,
      computedBy: header.computed_by,
      resultsFresh: fresh,
      frozen,
      criteriaUsed: header.criteria_snapshot === null || header.criteria_rule_source === null ? null : { source: header.criteria_rule_source, version: header.criteria_rule_version ?? 0, criteria: header.criteria_snapshot.criteria },
      criteriaInForce: category === null ? null : await this.criteriaInForce(tx, category, now),
      createdBy: { id: header.created_by, name: header.created_by_name },
      updatedBy: { id: header.updated_by, name: header.updated_by_name },
      submittedBy: header.submitted_by === null ? null : { id: header.submitted_by, name: header.submitted_by_name },
      approvedBy: header.approved_by === null ? null : { id: header.approved_by, name: header.approved_by_name },
      createdAt: header.created_at,
      updatedAt: header.updated_at,
      submittedAt: header.submitted_at,
      approvedAt: header.approved_at,
      decisionReason: header.decision_reason,
      asOf: now.toISOString(),
    };
  }

  /** The appraisals in the scope of the caller, most recently changed first. */
  async list(tx: TenantTx, filter: AppraisalListFilter, scope: ScopeBuilder): Promise<{ items: AppraisalListItem[]; total: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const predicate = scope(1);
    params.push(...predicate.params);
    conditions.push(predicate.sql);
    const add = (sql: (n: number) => string, value: unknown): void => {
      params.push(value);
      conditions.push(sql(params.length));
    };
    if (filter.projectId !== undefined) add((n) => `a.project_id = $${n}::uuid`, idOf(filter.projectId, 'project_id'));
    if (filter.packageId !== undefined) add((n) => `a.package_id = $${n}::uuid`, idOf(filter.packageId, 'package_id'));
    if (filter.contractId !== undefined) add((n) => `a.contract_id = $${n}::uuid`, idOf(filter.contractId, 'contract_id'));
    if (filter.status !== undefined) {
      if (!['DRAFT', 'SUBMITTED', 'APPROVED'].includes(filter.status)) throw invalid('status', 'UNKNOWN_STATUS');
      add((n) => `a.status = $${n}`, filter.status);
    }
    if (filter.kind !== undefined) {
      if (!isFinKind(filter.kind)) throw invalid('kind', 'UNKNOWN_KIND');
      add((n) => `a.kind = $${n}`, filter.kind);
    }
    if (filter.q !== undefined && filter.q.trim() !== '') {
      add((n) => `(a.code ilike $${n} escape '\\' or a.title ilike $${n} escape '\\')`, `%${filter.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 100);
    const offset = Math.max(filter.offset ?? 0, 0);
    const where = conditions.join(' and ');
    const [count] = await tx.query<{ total: string }>(`select count(*)::text as total from ${FROM} where ${where}`, params);
    const rows = await tx.query<{
      id: string;
      code: string;
      revision: number;
      title: string;
      kind: FinKind;
      status: FinStatus;
      version: string;
      owner_unit_id: string;
      owner_unit_code: string;
      owner_unit_name: string;
      project_id: string | null;
      project_code: string | null;
      package_id: string | null;
      package_code: string | null;
      contract_id: string | null;
      contract_code: string | null;
      has_frozen: boolean;
      has_results: boolean;
      npv: string | null;
      irr: string | null;
      payback: string | null;
      index_pct: string | null;
      created_by_name: string | null;
      approved_by_name: string | null;
      updated_at: string;
    }>(
      `select a.id, a.code, a.revision, a.title, a.kind, a.status, a.version::text as version, a.owner_unit_id, u.code as owner_unit_code, u.name as owner_unit_name, a.project_id, p.code as project_code,
              a.package_id, pk.code as package_code, a.contract_id, c.code as contract_code, (a.frozen_results is not null) as has_frozen, (a.results is not null) as has_results,
              coalesce(a.frozen_results, a.results) #>> '{report,analysis,npv,value}' as npv, coalesce(a.frozen_results, a.results) #>> '{report,analysis,irr,value}' as irr,
              coalesce(a.frozen_results, a.results) #>> '{report,analysis,payback,value}' as payback, coalesce(a.frozen_results, a.results) #>> '{criteria,indexPct}' as index_pct,
              cd.display_name as created_by_name, ad.display_name as approved_by_name, ${ISO('a.updated_at')} as updated_at
         from ${FROM} where ${where} order by a.updated_at desc, a.id limit ${limit} offset ${offset}`,
      params,
    );
    return {
      total: Number(count?.total ?? 0),
      items: rows.map(
        (row): AppraisalListItem => ({
          id: row.id,
          code: row.code,
          revision: row.revision,
          title: row.title,
          kind: row.kind,
          status: row.status,
          version: Number(row.version),
          ownerUnit: { id: row.owner_unit_id, code: row.owner_unit_code, name: row.owner_unit_name },
          project: row.project_id === null ? null : { id: row.project_id, code: row.project_code ?? '' },
          package: row.package_id === null ? null : { id: row.package_id, code: row.package_code ?? '' },
          contract: row.contract_id === null ? null : { id: row.contract_id, code: row.contract_code ?? '' },
          resultState: row.has_frozen ? 'FROZEN' : row.has_results ? 'COMPUTED' : 'NONE',
          npv: row.npv,
          irrPct: row.irr,
          paybackPeriods: row.payback,
          indexPct: row.index_pct,
          createdByName: row.created_by_name,
          approvedByName: row.approved_by_name,
          updatedAt: row.updated_at,
        }),
      ),
    };
  }

  /** What the export needs, from the results that are current: those frozen at approval, or the computed ones of a draft that still match its inputs. */
  async exportData(tx: TenantTx, id: string, scope: ScopeBuilder, now: Date): Promise<{ input: FinExportInput; appraisal: AppraisalCommandResult }> {
    const view = await this.view(tx, id, scope, now);
    if (view === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (view.results === null || view.results.report === null || !view.resultsFresh || view.resultHash === null || view.formulaVersion === null) {
      throw new DomainError('APPRAISAL_RESULTS_STALE', 409, 'results', { extensions: { computed: view.results !== null } });
    }
    const [header] = await tx.query<{ inputs_hash: string | null }>('select results_inputs_hash as inputs_hash from machvon.investment_appraisal where id = $1::uuid', [view.id]);
    const links = [view.project === null ? null : `Dự án ${view.project.code}`, view.package === null ? null : `Gói ${view.package.code}`, view.contract === null ? null : `Hợp đồng ${view.contract.code}`].filter((part): part is string => part !== null);
    return {
      input: {
        code: view.code,
        revision: view.revision,
        title: view.title,
        status: view.status,
        kind: view.kind,
        ownerUnit: `${view.ownerUnit.name} (${view.ownerUnit.code})`,
        link: links.length === 0 ? null : links.join('; '),
        currencyUnit: 'VND',
        computedAt: view.computedAt ?? view.asOf,
        inputsHash: header?.inputs_hash ?? '',
        resultHash: view.resultHash,
        formulaVersion: view.formulaVersion,
        approvedBy: view.approvedBy?.name ?? null,
        approvedAt: view.approvedAt,
        assumptions: view.assumptions.map((entry) => ({ key: entry.key, value: entry.value, unit: entry.unit, sourceKind: entry.sourceKind, source: entry.source, owner: entry.ownerName ?? entry.ownerId })),
        report: view.results.report,
        criteria: view.results.criteria,
      },
      appraisal: { id: view.id, code: view.code, revision: view.revision, kind: view.kind, version: view.version, status: view.status, ownerUnitId: view.ownerUnit.id, projectId: view.project?.id ?? null, resultHash: view.resultHash, formulaVersion: view.formulaVersion },
    };
  }

  /** The set of criteria in force for a category today: the approved rule of the governance platform, else the built-in default. */
  async criteriaInForce(tx: TenantTx, category: FinCriteriaCategory, now: Date): Promise<CriteriaInForce> {
    const rule = await this.policy.require(tx, 'FIN_CRITERIA', category, now);
    const params = rule.params as { criteria: Array<{ key: string; label: string; weight_pct: string }> };
    return { category, source: rule.source, version: rule.version, unverified: rule.unverified, criteria: params.criteria.map((one) => ({ key: one.key, label: one.label, weightPct: one.weight_pct })) };
  }

  // ---- Helpers -------------------------------------------------------------------------------------------------------------------------

  private recompute(header: HeaderSql, loaded: Loaded): AppraisalComputed {
    const snapshot = header.criteria_snapshot;
    const set: FinCriteriaSet | null = snapshot !== null && isFinCriteriaCategory(snapshot.category) ? { category: snapshot.category, criteria: snapshot.criteria } : null;
    return computeAppraisal({
      kind: header.kind,
      model: modelOf(header, loaded.lines),
      scenarios: loaded.scenarios,
      sensitivity: header.sensitivity,
      criteria: set === null || loaded.scores.length === 0 ? null : { set, scores: loaded.scores },
    });
  }

  private inputsHashOf(loaded: Loaded): string {
    return appraisalInputsHash({
      model: modelOf(loaded.header, loaded.lines),
      scenarios: loaded.scenarios,
      sensitivity: loaded.header.sensitivity,
      category: loaded.header.criteria_category,
      scores: loaded.scores,
    });
  }

  private resultOf(header: HeaderSql, version: number, status: FinStatus): AppraisalCommandResult {
    return { id: header.id, code: header.code, revision: header.revision, kind: header.kind, version, status, ownerUnitId: header.owner_unit_id, projectId: header.project_id, resultHash: header.result_hash, formulaVersion: header.formula_version };
  }

  private async loadRest(tx: TenantTx, header: HeaderSql): Promise<Loaded> {
    const lines = await tx.query<LineSql>(
      `select period, benefit_vnd::text as benefit, capex_vnd::text as capex, opex_vnd::text as opex, maintenance_vnd::text as maintenance, residual_vnd::text as residual
         from machvon.appraisal_cash_line where appraisal_id = $1::uuid order by period`,
      [header.id],
    );
    const assumptions = await tx.query<AssumptionSql>(
      `select x.input_key, x.value_text, x.unit, x.source_kind, x.source_text, x.owner_id, d.display_name as owner_name
         from machvon.appraisal_assumption x left join machvon.tenant_user_directory d on d.tenant_id = x.tenant_id and d.membership_id = x.owner_id
        where x.appraisal_id = $1::uuid order by x.input_key`,
      [header.id],
    );
    const scenarios = await tx.query<{ code: string; label: string; deltas: FinScenarioInput['deltas'] }>('select code, label, deltas from machvon.appraisal_scenario where appraisal_id = $1::uuid order by position', [header.id]);
    const scores = await tx.query<{ criterion_key: string; score: number; evidence: string }>('select criterion_key, score, evidence from machvon.appraisal_criteria_score where appraisal_id = $1::uuid order by criterion_key', [header.id]);
    return {
      header,
      lines: lines.map((line) => ({ period: line.period, benefit: plainDecimal(line.benefit), capex: plainDecimal(line.capex), opex: plainDecimal(line.opex), maintenance: plainDecimal(line.maintenance), residual: plainDecimal(line.residual) })),
      assumptions: assumptions.map((row) => ({ key: row.input_key, value: row.value_text, unit: row.unit, sourceKind: row.source_kind, source: row.source_text, ownerId: row.owner_id, ownerName: row.owner_name })),
      scenarios: scenarios.map((row) => ({ code: row.code, label: row.label, deltas: row.deltas })),
      scores: scores.map((row) => ({ key: row.criterion_key, score: row.score, evidence: row.evidence })),
    };
  }

  /** The row locked inside the scope of the command; one the caller cannot reach does not exist. */
  private async lock(tx: TenantTx, id: string, scope: ScopeBuilder): Promise<HeaderSql> {
    const predicate = scope(2);
    const [row] = await tx.query<{ id: string }>(`select a.id from ${FROM} where a.id = $1::uuid and ${predicate.sql} for update of a`, [id, ...predicate.params]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const [header] = await tx.query<HeaderSql>(`select ${HEADER_COLUMNS} from ${FROM} where a.id = $1::uuid`, [id]);
    if (header === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return header;
  }

  /** The unit must be one the caller reaches: a unit outside the scope does not exist for them. */
  private async assertUnitInScope(tx: TenantTx, unitId: string, scope: ScopeBuilder): Promise<void> {
    const predicate = scope(2);
    // The scope is compiled over the aliases of FROM; a unit-only check needs the unit columns alone, so the appraisal columns are answered by a row that does not exist yet.
    const [row] = await tx.query<{ id: string }>(
      `select u.id from machvon.organization_unit u left join machvon.investment_appraisal a on false where u.id = $1::uuid and ${predicate.sql}`,
      [unitId, ...predicate.params],
    );
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
  }

  /** The unit that answers for the appraisal and the project, package and contract it is tied to, with the links that follow from each other (a contract names its package and project). */
  private async resolveLinks(tx: TenantTx, input: AppraisalCreate): Promise<{ ownerUnitId: string; projectId: string | null; packageId: string | null; contractId: string | null }> {
    let projectId = input.projectId === undefined ? null : idOf(input.projectId, 'project_id');
    let packageId = input.packageId === undefined ? null : idOf(input.packageId, 'package_id');
    const contractId = input.contractId === undefined ? null : idOf(input.contractId, 'contract_id');
    if (contractId !== null) {
      const [contract] = await tx.query<{ project_id: string; package_id: string }>('select project_id, package_id from machvon.contract where id = $1::uuid', [contractId]);
      if (contract === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'contract_id');
      if ((projectId !== null && projectId !== contract.project_id) || (packageId !== null && packageId !== contract.package_id)) throw invalid('contract_id', 'DIFFERS_FROM_PROJECT_OR_PACKAGE');
      projectId = contract.project_id;
      packageId = contract.package_id;
    }
    if (packageId !== null) {
      const [pack] = await tx.query<{ project_id: string }>('select project_id from machvon.procurement_package where id = $1::uuid', [packageId]);
      if (pack === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'package_id');
      if (projectId !== null && projectId !== pack.project_id) throw invalid('package_id', 'DIFFERS_FROM_PROJECT');
      projectId = pack.project_id;
    }
    if (projectId !== null) {
      const [project] = await tx.query<{ owner_unit_id: string }>('select owner_unit_id from machvon.project where id = $1::uuid', [projectId]);
      if (project === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'project_id');
      if (input.ownerUnitId !== undefined && idOf(input.ownerUnitId, 'owner_unit_id') !== project.owner_unit_id) throw invalid('owner_unit_id', 'DIFFERS_FROM_PROJECT_UNIT');
      return { ownerUnitId: project.owner_unit_id, projectId, packageId, contractId };
    }
    if (input.ownerUnitId === undefined) throw invalid('owner_unit_id', 'REQUIRED_WITHOUT_PROJECT');
    const ownerUnitId = idOf(input.ownerUnitId, 'owner_unit_id');
    const [unit] = await tx.query<{ id: string }>('select id from machvon.organization_unit where id = $1::uuid', [ownerUnitId]);
    if (unit === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'owner_unit_id');
    return { ownerUnitId, projectId: null, packageId: null, contractId: null };
  }
}
