import {
  DATA_ENTRY_RULE_TYPE,
  DomainError,
  INDICATOR_IMPORT_RULE_TYPE,
  INDICATOR_RULE_TYPE,
  builtInCodes,
  compareDecimal,
  entryRuleOf,
  evaluateEntryRules,
  filterDictionary,
  importMappingOf,
  indicatorOf,
  isEnterable,
  mandatoryFieldsOf,
  resolveGovernanceRule,
  vietnamDateOf,
} from '@machvon/kernel';
import type { DictionaryFilter, EntryFacts, EntryRule, EntrySurface, EntryVerdict, GovernanceRuleVersion, ImportMapping, IndicatorEntry, ResolvedGovernanceRule } from '@machvon/kernel';
import { RULE_COLUMNS, toRuleVersion } from './governance-policy-port.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/** The resource type of the audit rows of a figure. */
export const IND_FIGURE_RESOURCE = 'ind_figure';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const iso = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const dayOf = (at: string | Date): string => (typeof at === 'string' ? at : vietnamDateOf(at));
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

interface RuleSql {
  id: string;
  rule_type: string;
  code: string;
  version: number;
  status: GovernanceRuleVersion['status'];
  params: Record<string, unknown>;
  effective_from: string;
  effective_to: string | null;
  unit_id: string | null;
}

/** The approved versions of a type that are in force on a day (the whole-tenant ones: the units of the organisation do not own a dictionary). */
async function inForce(tx: TenantTx, type: string, day: string): Promise<GovernanceRuleVersion[]> {
  const rows = await tx.query<RuleSql>(
    `select ${RULE_COLUMNS}
       from machvon.governance_rule
      where rule_type = $1 and approved_at is not null and status in ('APPROVED', 'RETIRED') and unit_id is null
        and effective_from <= $2::date and (effective_to is null or effective_to > $2::date)`,
    [type, day],
  );
  return rows.map(toRuleVersion);
}

/** Every code of a type that has a version in force or a built-in default, each resolved on the day (a code with neither is not there). */
async function resolvedAll(tx: TenantTx, type: string, day: string): Promise<{ versions: GovernanceRuleVersion[]; resolved: ResolvedGovernanceRule[] }> {
  const versions = await inForce(tx, type, day);
  const codes = new Set<string>([...versions.map((version) => version.code), ...builtInCodes(type)]);
  const resolved: ResolvedGovernanceRule[] = [];
  for (const code of [...codes].sort()) {
    const one = resolveGovernanceRule(versions, type, code, day);
    if (one !== undefined) resolved.push(one);
  }
  return { versions, resolved };
}

/** One version of a rule as the history of a dictionary entry, an entry rule or a mapping shows it: who made, submitted and approved it, and from which day to which. */
export interface RuleVersionRow {
  id: string;
  version: number;
  status: GovernanceRuleVersion['status'];
  effectiveFrom: string;
  effectiveTo: string | null;
  reason: string;
  createdBy: string;
  createdAt: string;
  submittedBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  retiredAt: string | null;
  params: Record<string, unknown>;
}

interface VersionSql {
  id: string;
  version: number;
  status: GovernanceRuleVersion['status'];
  effective_from: string;
  effective_to: string | null;
  reason: string;
  created_by: string;
  created_at: string;
  submitted_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  retired_at: string | null;
  params: Record<string, unknown>;
}

async function versionsOf(tx: TenantTx, type: string, code: string): Promise<RuleVersionRow[]> {
  const rows = await tx.query<VersionSql>(
    `select id, version, status, effective_from::text as effective_from, effective_to::text as effective_to, reason, created_by, ${iso('created_at')} as created_at, submitted_by,
            approved_by, ${iso('approved_at')} as approved_at, ${iso('retired_at')} as retired_at, params
       from machvon.governance_rule where rule_type = $1 and code = $2 and unit_id is null order by version desc`,
    [type, code],
  );
  return rows.map((row) => ({
    id: row.id,
    version: row.version,
    status: row.status,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
    submittedBy: row.submitted_by,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    retiredAt: row.retired_at,
    params: row.params,
  }));
}

// ---- the dictionary --------------------------------------------------------------------------------------------------------------------------------------------------

export interface IndicatorUsage {
  /** The entry rules (of the catalogue, default or approved) whose fields name the entry field of the indicator. */
  rules: Array<{ code: string; check: string; active: boolean }>;
  /** The mappings that read the indicator from a column or a row of a form. */
  mappings: Array<{ code: string; source: string; active: boolean }>;
}

/** The dictionary of indicators: the `KPI_DEFINITION` rules in force, read as entries. It writes nothing; a definition is drafted, submitted and approved through the governance rules. */
export class IndDictionaryStore {
  async list(tx: TenantTx, asOf: string | Date, filter: DictionaryFilter = {}): Promise<IndicatorEntry[]> {
    const { versions, resolved } = await resolvedAll(tx, INDICATOR_RULE_TYPE, dayOf(asOf));
    return filterDictionary(
      resolved.map((one) => indicatorOf(one, versions)),
      filter,
    );
  }

  async find(tx: TenantTx, code: string, asOf: string | Date): Promise<IndicatorEntry | undefined> {
    const day = dayOf(asOf);
    const versions = await inForce(tx, INDICATOR_RULE_TYPE, day);
    const one = resolveGovernanceRule(versions, INDICATOR_RULE_TYPE, code, day);
    return one === undefined ? undefined : indicatorOf(one, versions);
  }

  versions(tx: TenantTx, code: string): Promise<RuleVersionRow[]> {
    return versionsOf(tx, INDICATOR_RULE_TYPE, code);
  }

  async usage(tx: TenantTx, indicator: IndicatorEntry, asOf: string | Date): Promise<IndicatorUsage> {
    const rules = await new IndEntryRuleStore().catalogue(tx, asOf);
    const mappings = await new IndMappingStore().catalogue(tx, asOf);
    const field = indicator.entryField;
    return {
      rules:
        field === null
          ? []
          : rules.filter((view) => view.rule.fields.includes(field) || view.rule.totalField === field).map((view) => ({ code: view.rule.code, check: view.rule.check, active: view.active })),
      mappings: mappings.flatMap((view) => view.mapping.lines.filter((line) => line.indicator === indicator.code).map((line) => ({ code: view.mapping.code, source: line.source, active: view.active }))),
    };
  }
}

// ---- the rules at entry ----------------------------------------------------------------------------------------------------------------------------------------

export interface EntryRuleView {
  rule: EntryRule;
  /** `RULE`: a version the tenant approved, which is in force. `DEFAULT`: the starting value of the platform, a template that no entry is held to until the tenant approves its own. */
  origin: 'RULE' | 'DEFAULT';
  active: boolean;
  unverified: boolean;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

export interface EntryCheckInput {
  surface: EntrySurface;
  facts: Omit<EntryFacts, 'surface' | 'mandatory'>;
  asOf: string | Date;
}

/**
 * The `DATA_ENTRY_RULE` rules of the tenant. Only a version the tenant approved is held against an entry: the built-in defaults are templates (`catalogue` lists them as inactive), so a tenant that configured
 * nothing sees no change in any command, and a command that asks costs one read that finds nothing.
 */
export class IndEntryRuleStore {
  async catalogue(tx: TenantTx, asOf: string | Date): Promise<EntryRuleView[]> {
    const day = dayOf(asOf);
    const { versions, resolved } = await resolvedAll(tx, DATA_ENTRY_RULE_TYPE, day);
    return resolved.map((one): EntryRuleView => {
      const version = one.ruleId === null ? undefined : versions.find((row) => row.id === one.ruleId);
      return { rule: entryRuleOf(one), origin: one.source, active: one.source === 'RULE', unverified: one.unverified, effectiveFrom: version?.effectiveFrom ?? null, effectiveTo: version?.effectiveTo ?? null };
    });
  }

  /** The approved rules in force that apply on a surface. */
  async inForce(tx: TenantTx, asOf: string | Date, surface?: EntrySurface): Promise<EntryRule[]> {
    const day = dayOf(asOf);
    const versions = await inForce(tx, DATA_ENTRY_RULE_TYPE, day);
    const rules: EntryRule[] = [];
    for (const code of [...new Set(versions.map((version) => version.code))].sort()) {
      const one = resolveGovernanceRule(versions, DATA_ENTRY_RULE_TYPE, code, day);
      if (one === undefined || one.source !== 'RULE') continue;
      const rule = entryRuleOf(one);
      if (surface === undefined || rule.surfaces === null || rule.surfaces.includes(surface)) rules.push(rule);
    }
    return rules;
  }

  versions(tx: TenantTx, code: string): Promise<RuleVersionRow[]> {
    return versionsOf(tx, DATA_ENTRY_RULE_TYPE, code);
  }

  /**
   * Holds the facts of an entry up to the approved rules of the surface. With no rule in force it returns an empty verdict without reading the dictionary; the mandatory fields of the dictionary are read only when
   * a rule asks for them.
   */
  async check(tx: TenantTx, input: EntryCheckInput): Promise<EntryVerdict> {
    const rules = await this.inForce(tx, input.asOf, input.surface);
    if (rules.length === 0) return { violations: [], blocking: [], warnings: [], evaluated: [], skipped: [] };
    const asksMandatory = rules.some((rule) => rule.check === 'FIELD_REQUIRED' && rule.fields.includes('MANDATORY_FIELDS'));
    const mandatory = asksMandatory ? mandatoryFieldsOf(await new IndDictionaryStore().list(tx, input.asOf), input.surface) : [];
    return evaluateEntryRules(rules, { ...input.facts, surface: input.surface, mandatory });
  }
}

// ---- the mappings ----------------------------------------------------------------------------------------------------------------------------------------------------

export interface MappingView {
  mapping: ImportMapping;
  /** True for a version the tenant approved: the only kind a file can be read through. A sample of the platform is a template. */
  active: boolean;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

export class IndMappingStore {
  async catalogue(tx: TenantTx, asOf: string | Date): Promise<MappingView[]> {
    const day = dayOf(asOf);
    const { versions, resolved } = await resolvedAll(tx, INDICATOR_IMPORT_RULE_TYPE, day);
    return resolved.map((one): MappingView => {
      const version = one.ruleId === null ? undefined : versions.find((row) => row.id === one.ruleId);
      return { mapping: importMappingOf(one), active: one.source === 'RULE', effectiveFrom: version?.effectiveFrom ?? null, effectiveTo: version?.effectiveTo ?? null };
    });
  }

  async find(tx: TenantTx, code: string, asOf: string | Date): Promise<MappingView | undefined> {
    return (await this.catalogue(tx, asOf)).find((view) => view.mapping.code === code);
  }

  /** The approved mapping a file is read through: one that is not there is 404, a sample or a code nobody approved is 409 IND_MAPPING_NOT_APPROVED. */
  async approved(tx: TenantTx, code: string, asOf: string | Date): Promise<ImportMapping> {
    const found = await this.find(tx, code, asOf);
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'mapping_code');
    if (!found.active) throw new DomainError('IND_MAPPING_NOT_APPROVED', 409, 'mapping_code');
    return found.mapping;
  }

  versions(tx: TenantTx, code: string): Promise<RuleVersionRow[]> {
    return versionsOf(tx, INDICATOR_IMPORT_RULE_TYPE, code);
  }
}

// ---- the figures -----------------------------------------------------------------------------------------------------------------------------------------------------

export interface FigureRow {
  id: string;
  projectId: string;
  projectCode: string;
  periodId: string;
  periodCode: string;
  indicatorCode: string;
  revision: number;
  /** The number as decimal text, as the register keeps it (whole for money and counts). */
  value: string;
  unit: string;
  definitionVersion: number;
  source: 'ENTRY' | 'IMPORT';
  importId: string | null;
  importLine: number | null;
  mappingCode: string | null;
  mappingVersion: number | null;
  reason: string | null;
  enteredBy: string;
  enteredAt: string;
}

interface FigureSql {
  id: string;
  project_id: string;
  project_code: string;
  period_id: string;
  period_code: string;
  indicator_code: string;
  revision: number;
  value: string;
  unit: string;
  definition_version: number;
  source: 'ENTRY' | 'IMPORT';
  import_id: string | null;
  import_line: number | null;
  mapping_code: string | null;
  mapping_version: number | null;
  reason: string | null;
  entered_by: string;
  entered_at: string;
}

const FIGURE_COLUMNS = `f.id, f.project_id, p.code as project_code, f.period_id, rp.code as period_code, f.indicator_code, f.revision, f.value::text as value, f.unit, f.definition_version, f.source,
  f.import_id, f.import_line, f.mapping_code, f.mapping_version, f.reason, f.entered_by, ${iso('f.entered_at')} as entered_at`;
const FIGURE_FROM = `machvon.ind_figure f
  join machvon.project p on p.tenant_id = f.tenant_id and p.id = f.project_id
  join machvon.reporting_period rp on rp.tenant_id = f.tenant_id and rp.id = f.period_id`;

/** The number as the register writes it: no trailing zero of the fraction (the column keeps six places). */
const plainValue = (value: string): string => (value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value);

const toFigure = (row: FigureSql): FigureRow => ({
  id: row.id,
  projectId: row.project_id,
  projectCode: row.project_code,
  periodId: row.period_id,
  periodCode: row.period_code,
  indicatorCode: row.indicator_code,
  revision: row.revision,
  value: plainValue(row.value),
  unit: row.unit,
  definitionVersion: row.definition_version,
  source: row.source,
  importId: row.import_id,
  importLine: row.import_line,
  mappingCode: row.mapping_code,
  mappingVersion: row.mapping_version,
  reason: row.reason,
  enteredBy: row.entered_by,
  enteredAt: row.entered_at,
});

export interface FigureSource {
  kind: 'ENTRY' | 'IMPORT';
  importId?: string;
  importLine?: number;
  mapping?: { code: string; version: number; ruleId: string };
}

export interface FigureWrite {
  projectId: string;
  periodId: string;
  indicator: Pick<IndicatorEntry, 'code' | 'unit' | 'version'>;
  value: string;
  reason?: string | undefined;
  source: FigureSource;
}

export type FigureOutcome = { kind: 'CREATED' | 'REVISED'; row: FigureRow } | { kind: 'UNCHANGED'; row: FigureRow };

export interface IndProjectFacts {
  id: string;
  code: string;
  status: string;
  totalInvestmentVnd: string;
}

export interface FigureFilter {
  projectId?: string | undefined;
  periodId?: string | undefined;
  indicatorCode?: string | undefined;
}

/** The figures of the dictionary: append-only, the figure in force is the greatest revision of a (project, period, indicator). */
export class IndFigureStore {
  /** The figures in force for a project and a period, by indicator code. */
  async current(tx: TenantTx, projectId: string, periodId: string): Promise<Map<string, FigureRow>> {
    const rows = await tx.query<FigureSql>(
      `select distinct on (f.indicator_code) ${FIGURE_COLUMNS} from ${FIGURE_FROM} where f.project_id = $1::uuid and f.period_id = $2::uuid order by f.indicator_code, f.revision desc`,
      [projectId, periodId],
    );
    return new Map(rows.map((row) => [row.indicator_code, toFigure(row)]));
  }

  /** The figures in force that the caller may read (the scope of the project), newest period first. */
  async list(tx: TenantTx, filter: FigureFilter, scope: ScopeBuilder, limit: number): Promise<FigureRow[]> {
    const visible = scope(1);
    const params: unknown[] = [...visible.params];
    const where: string[] = [visible.sql];
    const add = (sql: string, value: unknown): void => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (filter.projectId !== undefined) add('f.project_id = ?::uuid', filter.projectId);
    if (filter.periodId !== undefined) add('f.period_id = ?::uuid', filter.periodId);
    if (filter.indicatorCode !== undefined) add('f.indicator_code = ?', filter.indicatorCode);
    params.push(limit);
    const rows = await tx.query<FigureSql>(
      `select ${FIGURE_COLUMNS} from (
         select distinct on (f.project_id, f.period_id, f.indicator_code) f.* from machvon.ind_figure f
           join machvon.project p on p.tenant_id = f.tenant_id and p.id = f.project_id
           join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
           left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id
          where ${where.join(' and ')}
          order by f.project_id, f.period_id, f.indicator_code, f.revision desc
       ) f
       join machvon.project p on p.tenant_id = f.tenant_id and p.id = f.project_id
       join machvon.reporting_period rp on rp.tenant_id = f.tenant_id and rp.id = f.period_id
       order by rp.start_date desc, p.code, f.indicator_code limit $${params.length}`,
      params,
    );
    return rows.map(toFigure);
  }

  /** Every revision of one figure, newest first. */
  async history(tx: TenantTx, projectId: string, periodId: string, indicatorCode: string): Promise<FigureRow[]> {
    const rows = await tx.query<FigureSql>(`select ${FIGURE_COLUMNS} from ${FIGURE_FROM} where f.project_id = $1::uuid and f.period_id = $2::uuid and f.indicator_code = $3 order by f.revision desc`, [projectId, periodId, indicatorCode]);
    return rows.map(toFigure);
  }

  /**
   * Writes one figure: the first revision when there is none, the next when the value differs (a correction needs its reason), nothing when the value is the one in force. Two writers of one figure are
   * serialised by a lock on its key, so revisions come one after the other without a gap.
   */
  async write(tx: TenantTx, input: FigureWrite, actor: string, now: Date): Promise<FigureOutcome> {
    await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`ind_figure|${input.projectId}|${input.periodId}|${input.indicator.code}`]);
    const [held] = await tx.query<FigureSql>(
      `select ${FIGURE_COLUMNS} from ${FIGURE_FROM} where f.project_id = $1::uuid and f.period_id = $2::uuid and f.indicator_code = $3 order by f.revision desc limit 1`,
      [input.projectId, input.periodId, input.indicator.code],
    );
    const earlier = held === undefined ? undefined : toFigure(held);
    if (earlier !== undefined && compareDecimal(earlier.value, input.value) === 0) return { kind: 'UNCHANGED', row: earlier };
    const reason = input.reason?.trim().normalize('NFC');
    if (earlier !== undefined && (reason === undefined || reason.length < 5 || reason.length > 1000)) throw invalid('reason');
    const revision = (earlier?.revision ?? 0) + 1;
    const mapping = input.source.mapping;
    const [inserted] = await tx.query<{ id: string }>(
      `insert into machvon.ind_figure (tenant_id, id, project_id, period_id, indicator_code, revision, value, unit, definition_version, source, import_id, import_line, mapping_code, mapping_version, mapping_rule_id, reason, entered_by, entered_at)
       values (${TENANT}, gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5::numeric, $6, $7, $8, $9::uuid, $10, $11, $12, $13::uuid, $14, $15::uuid, $16::timestamptz)
       returning id`,
      [
        input.projectId,
        input.periodId,
        input.indicator.code,
        revision,
        input.value,
        input.indicator.unit,
        input.indicator.version,
        input.source.kind,
        input.source.importId ?? null,
        input.source.importLine ?? null,
        mapping?.code ?? null,
        mapping?.version ?? null,
        mapping?.ruleId ?? null,
        reason ?? null,
        actor,
        now.toISOString(),
      ],
    );
    if (inserted === undefined) throw new Error('the figure was not written');
    const [row] = await tx.query<FigureSql>(`select ${FIGURE_COLUMNS} from ${FIGURE_FROM} where f.id = $1::uuid`, [inserted.id]);
    if (row === undefined) throw new Error('the figure vanished after it was written');
    return { kind: earlier === undefined ? 'CREATED' : 'REVISED', row: toFigure(row) };
  }

  /** A project of the register in the scope of the caller, by id, with the number the register holds for its total investment. */
  async project(tx: TenantTx, projectId: string, seen: ScopeBuilder, acts: ScopeBuilder): Promise<IndProjectFacts> {
    const visible = seen(2);
    const [row] = await tx.query<{ id: string; code: string; status: string; total: string }>(
      `select p.id, p.code, p.status, p.total_investment_vnd::text as total from ${SCOPE_FROM} where p.id = $1::uuid and ${visible.sql}`,
      [projectId, ...visible.params],
    );
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const own = acts(2);
    const [allowed] = await tx.query<{ id: string }>(`select p.id from ${SCOPE_FROM} where p.id = $1::uuid and ${own.sql}`, [projectId, ...own.params]);
    if (allowed === undefined) throw new DomainError('SCOPE_DENIED', 403);
    return { id: row.id, code: row.code, status: row.status, totalInvestmentVnd: row.total };
  }

  /** The total investment the register holds for a project (no scope: for the facts of an entry that the command already judged). */
  async totalInvestment(tx: TenantTx, projectId: string): Promise<string | undefined> {
    const [row] = await tx.query<{ total: string }>('select total_investment_vnd::text as total from machvon.project where id = $1::uuid', [projectId]);
    return row === undefined ? undefined : row.total;
  }

  /** The projects of the register by code, within a scope (a code outside the scope is not there). */
  async projectsByCode(tx: TenantTx, codes: readonly string[], scope: ScopeBuilder): Promise<Map<string, IndProjectFacts>> {
    if (codes.length === 0) return new Map();
    const visible = scope(2);
    const rows = await tx.query<{ id: string; code: string; status: string; total: string }>(
      `select p.id, p.code, p.status, p.total_investment_vnd::text as total from ${SCOPE_FROM} where p.code = any($1::text[]) and ${visible.sql}`,
      [[...codes], ...visible.params],
    );
    return new Map(rows.map((row) => [row.code, { id: row.id, code: row.code, status: row.status, totalInvestmentVnd: row.total }]));
  }

  /** The periods of the register by code: more than one means the code is ambiguous (it is unique per calendar, not per tenant). */
  async periodsByCode(tx: TenantTx, code: string): Promise<Array<{ id: string; code: string; status: string }>> {
    return tx.query<{ id: string; code: string; status: string }>('select id, code, status from machvon.reporting_period where code = $1 order by start_date desc limit 3', [code]);
  }
}

/** The facts of the figures in force of a project and a period, by the entry field of their indicators (what an entry rule reads). */
export function figureFacts(current: ReadonlyMap<string, FigureRow>, indicators: readonly IndicatorEntry[]): Record<string, string> {
  const facts: Record<string, string> = {};
  for (const indicator of indicators) {
    if (!isEnterable(indicator) || indicator.entryField === null) continue;
    const held = current.get(indicator.code);
    if (held !== undefined) facts[indicator.entryField] = held.value;
  }
  return facts;
}
