import {
  DomainError,
  assertRulePeriod,
  builtInDefault,
  describeRuleType,
  diffRuleParams,
  isRuleCode,
  isRuleDay,
  isRuleTypeName,
  nextRuleStatus,
  registeredRuleTypes,
  ruleTypeOf,
  validateRuleParams,
  versionConflict,
} from '@machvon/kernel';
import type { GovernanceRuleStatus, Provenance, ResolvedGovernanceRule, RuleParams, RuleTypeDescription } from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import type { TenantTx } from './tenant-database.ts';

/** Where a stored version stands on a business day: never written, waiting for its first day, governing, or past its last day. A draft or a submitted version governs nothing. */
export type GovernanceRulePhase = 'DRAFT' | 'SUBMITTED' | 'SCHEDULED' | 'IN_FORCE' | 'ENDED' | 'NEVER_IN_FORCE';

export interface GovernanceRuleRow {
  id: string;
  type: string;
  code: string;
  version: number;
  unitId: string | null;
  status: GovernanceRuleStatus;
  params: RuleParams;
  effectiveFrom: string;
  effectiveTo: string | null;
  reason: string;
  createdBy: string;
  createdAt: string;
  submittedBy: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  retiredBy: string | null;
  retiredAt: string | null;
  retireReason: string | null;
  /** The number the commands send back in If-Match. */
  rowVersion: number;
}

export interface GovernanceRuleDraft {
  type: string;
  code: string;
  unitId: string | null;
  params: unknown;
  effectiveFrom: string;
  effectiveTo: string | null;
  reason: string;
}

export interface GovernanceRuleFilter {
  type?: string | undefined;
  code?: string | undefined;
  status?: GovernanceRuleStatus | undefined;
  unitId?: string | undefined;
  limit: number;
  after: { code: string; id: string } | undefined;
}

export interface ApprovalOutcome {
  row: GovernanceRuleRow;
  /** The version in force that this one took over from: its period now ends the day this one begins. */
  supersededId: string | null;
}

export interface GovernanceRuleDiff {
  from: { id: string | null; version: number; source: 'RULE' | 'DEFAULT' | 'NONE'; type: string; code: string };
  to: { id: string; version: number; type: string; code: string };
  changes: Array<{ path: string; before: unknown; after: unknown }>;
}

export interface CatalogCode {
  code: string;
  hasDefault: boolean;
  /** The provenance of the built-in default (formula, source, as-of, legal status); null for a code that only a tenant approved. */
  provenance: Provenance | null;
  unverified: boolean;
  storedVersions: number;
  /** What governs today: an approved version of the tenant, or the built-in default, or nothing. */
  inForce: 'RULE' | 'DEFAULT' | 'NONE';
  inForceVersion: number;
}

export interface CatalogType {
  type: string;
  registered: boolean;
  description: RuleTypeDescription | null;
  codes: CatalogCode[];
}

interface RuleSql {
  id: string;
  rule_type: string;
  code: string;
  version: number;
  unit_id: string | null;
  status: GovernanceRuleStatus;
  params: RuleParams;
  effective_from: string;
  effective_to: string | null;
  reason: string;
  created_by: string;
  created_at: string;
  submitted_by: string | null;
  submitted_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  retired_by: string | null;
  retired_at: string | null;
  retire_reason: string | null;
  row_version: number;
}

const COLUMNS = `id, rule_type, code, version, unit_id, status, params, effective_from::text as effective_from, effective_to::text as effective_to, reason, created_by, created_at::text as created_at,
  submitted_by, submitted_at::text as submitted_at, approved_by, approved_at::text as approved_at, retired_by, retired_at::text as retired_at, retire_reason, row_version`;

const NO_UNIT = '00000000-0000-0000-0000-000000000000';
const TODAY_SQL = `(now() at time zone 'Asia/Ho_Chi_Minh')::date::text`;

const toRow = (row: RuleSql): GovernanceRuleRow => ({
  id: row.id,
  type: row.rule_type,
  code: row.code,
  version: row.version,
  unitId: row.unit_id,
  status: row.status,
  params: row.params,
  effectiveFrom: row.effective_from,
  effectiveTo: row.effective_to,
  reason: row.reason,
  createdBy: row.created_by,
  createdAt: row.created_at,
  submittedBy: row.submitted_by,
  submittedAt: row.submitted_at,
  approvedBy: row.approved_by,
  approvedAt: row.approved_at,
  retiredBy: row.retired_by,
  retiredAt: row.retired_at,
  retireReason: row.retire_reason,
  rowVersion: row.row_version,
});

/** The phase of a version on a business day (`YYYY-MM-DD`). */
export function phaseOf(row: Pick<GovernanceRuleRow, 'status' | 'effectiveFrom' | 'effectiveTo'>, today: string): GovernanceRulePhase {
  if (row.status === 'DRAFT' || row.status === 'SUBMITTED') return row.status;
  if (row.effectiveTo !== null && row.effectiveTo <= row.effectiveFrom) return 'NEVER_IN_FORCE';
  if (today < row.effectiveFrom) return 'SCHEDULED';
  return row.effectiveTo === null || today < row.effectiveTo ? 'IN_FORCE' : 'ENDED';
}

const lock = (tx: TenantTx, purpose: string): Promise<unknown> =>
  tx.query(`select pg_advisory_xact_lock(hashtextextended($1::text || ':' || coalesce(current_setting('app.tenant_id', true), ''), 0))`, [purpose]);

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const REASON = /^\S(?:[\s\S]{3,498})\S$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CREATED_AT_CURSOR = /^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:.]+[+-][0-9]{2}(:[0-9]{2})?$/;

/** A reason is trimmed text of 5 to 500 characters (the same rule as the CHECK of the table). */
function assertReason(value: unknown, field: string): string {
  if (typeof value !== 'string' || !REASON.test(value)) throw invalid(field);
  return value;
}

/**
 * The versions of the governance rules (G0-1): a draft written by one person, submitted, and approved by a third pair of eyes (neither the maker nor the submitter); an approval takes over from the version in force
 * of the same code and unit (its period ends the day the new one begins) and is refused when it would overlap one that it cannot take over from; a version never changes after it is written (a change is a new
 * version, the guard of the table says so too). Every query runs inside the caller's tenant transaction, so row-level security keeps tenants apart.
 */
export class GovernanceRuleStore {
  private readonly port = new GovernancePolicyPort();

  /** The business day in Vietnam, as the database sees it. */
  async today(tx: TenantTx): Promise<string> {
    const rows = await tx.query<{ today: string }>(`select ${TODAY_SQL} as today`);
    return (rows[0] as { today: string }).today;
  }

  async find(tx: TenantTx, id: string): Promise<GovernanceRuleRow | undefined> {
    if (!UUID.test(id)) return undefined;
    const rows = await tx.query<RuleSql>(`select ${COLUMNS} from machvon.governance_rule where id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  private async lockRow(tx: TenantTx, id: string, expectedVersion: number): Promise<GovernanceRuleRow> {
    const rows = await tx.query<RuleSql>(`select ${COLUMNS} from machvon.governance_rule where id = $1::uuid for update`, [id]);
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const row = toRow(rows[0]);
    if (row.rowVersion !== expectedVersion) throw versionConflict(row.rowVersion);
    return row;
  }

  /** Writes a draft: the type is registered, the code well formed, the params pass the schema of the type, the period is ordered, the unit (when given) exists. Version numbers run 1, 2, 3 for one code and one unit. */
  async create(tx: TenantTx, input: GovernanceRuleDraft, actor: string): Promise<GovernanceRuleRow> {
    if (!isRuleTypeName(input.type)) throw invalid('rule_type');
    ruleTypeOf(input.type);
    if (!isRuleCode(input.code)) throw invalid('code');
    const codePattern = ruleTypeOf(input.type).codePattern;
    if (codePattern !== undefined && !new RegExp(codePattern).test(input.code)) throw invalid('code');
    const reason = assertReason(input.reason, 'reason');
    const params = validateRuleParams(input.type, input.params);
    assertRulePeriod(input.effectiveFrom, input.effectiveTo);
    if (input.unitId !== null) {
      if (!UUID.test(input.unitId)) throw invalid('unit_id');
      const units = await tx.query<{ id: string }>(`select id from machvon.organization_unit where id = $1::uuid and status not in ('Superseded', 'Dissolved')`, [input.unitId]);
      if (units[0] === undefined) throw invalid('unit_id');
    }
    await lock(tx, `governance_rule:${input.type}:${input.code}:${input.unitId ?? NO_UNIT}`);
    const next = await tx.query<{ next: number }>(
      `select coalesce(max(version), 0) + 1 as next from machvon.governance_rule where rule_type = $1 and code = $2 and coalesce(unit_id, $3::uuid) = coalesce($4::uuid, $3::uuid)`,
      [input.type, input.code, NO_UNIT, input.unitId],
    );
    const rows = await tx.query<RuleSql>(
      `insert into machvon.governance_rule (tenant_id, rule_type, code, version, unit_id, status, params, effective_from, effective_to, reason, created_by)
       values (current_setting('app.tenant_id', true)::uuid, $1, $2, $3, $4::uuid, 'DRAFT', $5::jsonb, $6::date, $7::date, $8, $9::uuid)
       returning ${COLUMNS}`,
      [input.type, input.code, (next[0] as { next: number }).next, input.unitId, JSON.stringify(params), input.effectiveFrom, input.effectiveTo, reason, actor],
    );
    return toRow(rows[0] as RuleSql);
  }

  /** The versions that match, newest written first. */
  async list(tx: TenantTx, filter: GovernanceRuleFilter): Promise<GovernanceRuleRow[]> {
    const { after } = filter;
    if (after !== undefined && !CREATED_AT_CURSOR.test(after.code)) throw invalid('cursor');
    const rows = await tx.query<RuleSql>(
      `select ${COLUMNS} from machvon.governance_rule
        where ($1::text is null or rule_type = $1) and ($2::text is null or code = $2) and ($3::text is null or status = $3) and ($4::uuid is null or unit_id = $4::uuid)
          and ($5::timestamptz is null or (created_at, id) < ($5::timestamptz, $6::uuid))
        order by created_at desc, id desc
        limit $7`,
      [filter.type ?? null, filter.code ?? null, filter.status ?? null, filter.unitId ?? null, after?.code ?? null, after?.id ?? null, filter.limit],
    );
    return rows.map(toRow);
  }

  /** Every version of one code (and one unit, or the whole tenant when `unitId` is null), newest version first. */
  async versions(tx: TenantTx, type: string, code: string, unitId: string | null): Promise<GovernanceRuleRow[]> {
    const rows = await tx.query<RuleSql>(
      `select ${COLUMNS} from machvon.governance_rule
        where rule_type = $1 and code = $2 and coalesce(unit_id, $3::uuid) = coalesce($4::uuid, $3::uuid)
        order by version desc`,
      [type, code, NO_UNIT, unitId],
    );
    return rows.map(toRow);
  }

  /** The organization units above `unitId` and the unit itself, nearest first: the chain an override is looked up along. */
  async unitChain(tx: TenantTx, unitId: string): Promise<string[]> {
    if (!UUID.test(unitId)) throw invalid('unit_id');
    const rows = await tx.query<{ id: string }>(
      `select a.id from machvon.organization_unit u join machvon.organization_unit a on starts_with(u.path, a.path) where u.id = $1::uuid order by length(a.path) desc`,
      [unitId],
    );
    if (rows.length === 0) throw invalid('unit_id');
    return rows.map((row) => row.id);
  }

  /** The rule that governs `code` of `type` on a day for a unit (or for the whole tenant): the approved version or the built-in default, with where it came from. */
  async effective(tx: TenantTx, type: string, code: string, asOf: string, unitId: string | null): Promise<ResolvedGovernanceRule | undefined> {
    if (!isRuleDay(asOf)) throw invalid('as_of');
    ruleTypeOf(type);
    const unitChain = unitId === null ? [] : await this.unitChain(tx, unitId);
    return this.port.get(tx, type, code, asOf, { unitChain });
  }

  /** What changed in a version: against another version (`againstId`), else against the version before it, else against the built-in default, else against nothing. */
  async diff(tx: TenantTx, id: string, againstId: string | undefined): Promise<GovernanceRuleDiff | undefined> {
    const to = await this.find(tx, id);
    if (to === undefined) return undefined;
    let before: { id: string | null; version: number; source: 'RULE' | 'DEFAULT' | 'NONE'; params: RuleParams; type: string; code: string };
    if (againstId !== undefined) {
      const other = await this.find(tx, againstId);
      if (other === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      before = { id: other.id, version: other.version, source: 'RULE', params: other.params, type: other.type, code: other.code };
    } else {
      const previous = (
        await tx.query<RuleSql>(
          `select ${COLUMNS} from machvon.governance_rule
            where rule_type = $1 and code = $2 and coalesce(unit_id, $3::uuid) = coalesce($4::uuid, $3::uuid) and version < $5
            order by version desc limit 1`,
          [to.type, to.code, NO_UNIT, to.unitId, to.version],
        )
      )[0];
      const fallback = registeredRuleTypes().includes(to.type) ? builtInDefault(to.type, to.code) : undefined;
      if (previous !== undefined) before = { id: previous.id, version: previous.version, source: 'RULE', params: previous.params, type: previous.rule_type, code: previous.code };
      else if (fallback !== undefined) before = { id: null, version: 0, source: 'DEFAULT', params: fallback.params, type: to.type, code: to.code };
      else before = { id: null, version: 0, source: 'NONE', params: {}, type: to.type, code: to.code };
    }
    return {
      from: { id: before.id, version: before.version, source: before.source, type: before.type, code: before.code },
      to: { id: to.id, version: to.version, type: to.type, code: to.code },
      changes: diffRuleParams(before.params, to.params),
    };
  }

  /** The types the platform knows with their codes (the built-in ones and the ones a tenant wrote), how many versions each has and what governs today; plus any stored type nobody registers (listed, never hidden). */
  async catalog(tx: TenantTx): Promise<CatalogType[]> {
    const today = await this.today(tx);
    const stored = await tx.query<{ rule_type: string; code: string; versions: string; in_force: string | null }>(
      `select rule_type, code, count(*)::text as versions,
              max(version) filter (where approved_at is not null and effective_from <= $1::date and (effective_to is null or effective_to > $1::date) and unit_id is null)::text as in_force
         from machvon.governance_rule group by rule_type, code`,
      [today],
    );
    const types = [...new Set([...registeredRuleTypes(), ...stored.map((row) => row.rule_type)])];
    return types.map((type) => {
      const registered = registeredRuleTypes().includes(type);
      const description = registered ? describeRuleType(type) : null;
      const defaults = new Map((description?.codes ?? []).map((entry) => [entry.code, entry]));
      const mine = stored.filter((row) => row.rule_type === type);
      const codes = [...new Set([...defaults.keys(), ...mine.map((row) => row.code)])].sort().map((code): CatalogCode => {
        const one = defaults.get(code);
        const row = mine.find((candidate) => candidate.code === code);
        const inForceVersion = row?.in_force === null || row?.in_force === undefined ? 0 : Number(row.in_force);
        return {
          code,
          hasDefault: one !== undefined,
          provenance: one === undefined ? null : { formula: one.formula, source: one.source, asOf: one.asOf, legalStatus: one.legalStatus },
          unverified: one?.unverified ?? false,
          storedVersions: row === undefined ? 0 : Number(row.versions),
          inForce: inForceVersion > 0 ? 'RULE' : one !== undefined ? 'DEFAULT' : 'NONE',
          inForceVersion,
        };
      });
      return { type, registered, description, codes };
    });
  }

  /** DRAFT to SUBMITTED. The params are judged again (the schema of a type may have moved since the draft was written). */
  async submit(tx: TenantTx, id: string, expectedVersion: number, actor: string): Promise<GovernanceRuleRow> {
    const row = await this.lockRow(tx, id, expectedVersion);
    nextRuleStatus(row.status, 'SUBMIT', { actor, maker: row.createdBy, submitter: row.submittedBy });
    validateRuleParams(row.type, row.params);
    return this.update(tx, id, `status = 'SUBMITTED', submitted_by = $2::uuid, submitted_at = now()`, [actor]);
  }

  /** SUBMITTED back to DRAFT: the submission is cleared and the version can be changed by writing another. */
  async withdraw(tx: TenantTx, id: string, expectedVersion: number, actor: string): Promise<GovernanceRuleRow> {
    const row = await this.lockRow(tx, id, expectedVersion);
    nextRuleStatus(row.status, 'WITHDRAW', { actor, maker: row.createdBy, submitter: row.submittedBy });
    return this.update(tx, id, `status = 'DRAFT', submitted_by = null, submitted_at = null`, []);
  }

  /**
   * SUBMITTED to APPROVED by a person who is neither the maker nor the submitter (403 SELF_APPROVAL_DENIED). The version must start today or later (a rule is never made to have governed a day that is past) and
   * takes over from the version in force of the same code and unit: that version's period ends the day this one begins. An overlap that cannot be a takeover (a rule that begins before the one in force, or
   * that ends before it does) is 409 GOVERNANCE_RULE_PERIOD_OVERLAP.
   */
  async approve(tx: TenantTx, id: string, expectedVersion: number, actor: string): Promise<ApprovalOutcome> {
    const row = await this.lockRow(tx, id, expectedVersion);
    nextRuleStatus(row.status, 'APPROVE', { actor, maker: row.createdBy, submitter: row.submittedBy });
    validateRuleParams(row.type, row.params);
    const today = await this.today(tx);
    if (row.effectiveFrom < today) throw invalid('effective_from');
    await lock(tx, `governance_rule:${row.type}:${row.code}:${row.unitId ?? NO_UNIT}`);
    const others = await tx.query<RuleSql>(
      `select ${COLUMNS} from machvon.governance_rule
        where rule_type = $1 and code = $2 and coalesce(unit_id, $3::uuid) = coalesce($4::uuid, $3::uuid) and approved_at is not null and id <> $5::uuid
          and (effective_to is null or effective_to > effective_from) and daterange(effective_from, effective_to, '[)') && daterange($6::date, $7::date, '[)')
        for update`,
      [row.type, row.code, NO_UNIT, row.unitId, row.id, row.effectiveFrom, row.effectiveTo],
    );
    let supersededId: string | null = null;
    for (const other of others) {
      const startsBefore = other.effective_from < row.effectiveFrom;
      const covered = row.effectiveTo === null || (other.effective_to !== null && other.effective_to <= row.effectiveTo);
      if (!startsBefore || !covered) throw new DomainError('GOVERNANCE_RULE_PERIOD_OVERLAP', 409, 'effective_from');
      await tx.query(`update machvon.governance_rule set effective_to = $2::date, row_version = row_version + 1 where id = $1::uuid`, [other.id, row.effectiveFrom]);
      supersededId = other.id;
    }
    try {
      const approved = await this.update(tx, id, `status = 'APPROVED', approved_by = $2::uuid, approved_at = now()`, [actor]);
      return { row: approved, supersededId };
    } catch (error) {
      if ((error as { code?: string }).code === '23P01') throw new DomainError('GOVERNANCE_RULE_PERIOD_OVERLAP', 409, 'effective_from');
      throw error;
    }
  }

  /**
   * Ends a version. One that was never approved is discarded and has an empty period (it governed nothing). An approved one stops governing on `effectiveTo` (default: today, or its first day when that has not come
   * yet); the day is not in the past (a decision already made is not reopened) and not after the day it would have ended anyway. From then on the version before it, or the built-in default, answers again.
   */
  async retire(tx: TenantTx, id: string, expectedVersion: number, actor: string, reason: string, effectiveTo: string | undefined): Promise<GovernanceRuleRow> {
    const row = await this.lockRow(tx, id, expectedVersion);
    nextRuleStatus(row.status, 'RETIRE', { actor, maker: row.createdBy, submitter: row.submittedBy });
    const why = assertReason(reason, 'reason');
    let ends = row.effectiveFrom;
    if (row.status === 'APPROVED') {
      const today = await this.today(tx);
      if (effectiveTo !== undefined && !isRuleDay(effectiveTo)) throw invalid('effective_to');
      // A version that began is never made to have ended before today (a decision already made is not reopened); one that has not begun may be made empty.
      const earliest = today > row.effectiveFrom ? today : row.effectiveFrom;
      ends = effectiveTo ?? earliest;
      if (ends < earliest) throw invalid('effective_to');
      if (row.effectiveTo !== null && ends > row.effectiveTo) throw invalid('effective_to');
    } else if (effectiveTo !== undefined) {
      throw invalid('effective_to');
    }
    return this.update(tx, id, `status = 'RETIRED', effective_to = $2::date, retired_by = $3::uuid, retired_at = now(), retire_reason = $4`, [ends, actor, why]);
  }

  /** Runs one UPDATE of the move; `set` uses $2 and on for its own values ($1 is the id). */
  private async update(tx: TenantTx, id: string, set: string, params: unknown[]): Promise<GovernanceRuleRow> {
    const rows = await tx.query<RuleSql>(`update machvon.governance_rule set ${set}, row_version = row_version + 1 where id = $1::uuid returning ${COLUMNS}`, [id, ...params]);
    return toRow(rows[0] as RuleSql);
  }
}

