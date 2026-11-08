import { DomainError, evaluateEntryRules, figureFitsUnit, indicatorImportFormat, isEnterable, mandatoryFieldsOf } from '@machvon/kernel';
import type { Difference, EntryRule, EntryVerdict, FileImportFormat, ImportContext, ImportMapping, ImportRecord, IndicatorEntry, Rejection, SourceRow } from '@machvon/kernel';
import { DisPeriodStore } from './dis-period-store.ts';
import type { ApplyContext, ImportEntry } from './file-import-store.ts';
import type { PreviewableAdapter } from './file-import-preview.ts';
import { IndFigureStore, figureFacts } from './ind-store.ts';
import type { FigureRow, IndProjectFacts } from './ind-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/** The difference an import opens when a file says another number than the one the register holds for a figure: the file never overwrites a number, a person settles it by a correction with a reason. */
export const IND_DIFFERENCE_CODES = { FIGURE_DIFFERS: 'IND_FIGURE_DIFFERS' } as const;

/** What the apply of a valid row does (the dry run says it). */
export type IndRowOutcome = 'CREATE' | 'CREATE_AND_DIFFERENCE' | 'DIFFERENCE' | 'UNCHANGED';

export interface IndImportDeps {
  mapping: ImportMapping;
  context: ImportContext;
  /** The dictionary in force: an indicator a row names must be there and be one that is entered. */
  indicators: readonly IndicatorEntry[];
  /** The approved rules of the surface, read once for the run. */
  rules: readonly EntryRule[];
  /** The projects the caller may load figures for. */
  scope: ScopeBuilder;
  actor: string;
  now: Date;
  /** The period of the request, when the request names it (a form that carries its own period code resolves it by code). */
  periodId?: string | undefined;
}

interface Resolved {
  project: IndProjectFacts;
  periodId: string;
  periodStatus: string;
  current: Map<string, FigureRow>;
}

/** What the apply wrote, for the audit row and the event of the command. */
export interface IndImportWritten {
  figures: number;
  unchanged: number;
  differences: number;
}

/**
 * The import of a form into figures of the dictionary, as an adapter of the file import framework: the layout and the judgement of a row are the pure format of the mapping in force (`indicatorImportFormat`);
 * this half asks the register. A row is refused (quarantined, with its line, field and code) when its project is not in the scope of the caller, its period is not there or is locked without an approved reopening,
 * an indicator it carries is not in the dictionary or is not one that is entered, a figure does not fit the unit of its indicator, or an approved entry rule blocks the figures together with those already held.
 * What the register holds is never overwritten: a figure that is new is written (revision 1, with the file, the line and the mapping version), one that is the same is skipped, one that differs becomes a difference
 * with an owner for a person to settle.
 */
export class IndImportAdapter implements PreviewableAdapter<ImportRecord> {
  readonly connectorCode: string;
  readonly formatVersion: string;
  /** The version of the mapping that reads the file, for the answer and the audit row of the command. */
  readonly mappingVersion: number;
  readonly written: IndImportWritten = { figures: 0, unchanged: 0, differences: 0 };

  private readonly deps: IndImportDeps;
  private readonly format: ReturnType<typeof indicatorImportFormat>;
  private readonly figures = new IndFigureStore();
  private readonly periods = new DisPeriodStore();
  private readonly byCode: Map<string, IndicatorEntry>;
  private projects: Map<string, IndProjectFacts> | undefined;
  private readonly periodCache = new Map<string, { id: string; status: string } | 'AMBIGUOUS' | undefined>();

  constructor(deps: IndImportDeps) {
    this.deps = deps;
    this.format = indicatorImportFormat(deps.mapping, deps.context);
    this.connectorCode = this.format.connectorCode;
    this.formatVersion = this.format.formatVersion;
    this.mappingVersion = deps.mapping.version;
    this.byCode = new Map(deps.indicators.map((indicator) => [indicator.code, indicator]));
  }

  parse = (bytes: Uint8Array): SourceRow[] => this.format.parse(bytes);
  judge: FileImportFormat<ImportRecord>['judge'] = (row) => this.format.judge(row);
  mask = (values: Readonly<Record<string, string>>): Record<string, string> => (this.format.mask === undefined ? {} : this.format.mask(values));

  private async project(tx: TenantTx, code: string): Promise<IndProjectFacts | undefined> {
    if (this.projects === undefined) this.projects = new Map();
    const known = this.projects.get(code);
    if (known !== undefined) return known;
    const found = (await this.figures.projectsByCode(tx, [code], this.deps.scope)).get(code);
    if (found !== undefined) this.projects.set(code, found);
    return found;
  }

  private async period(tx: TenantTx, code: string): Promise<{ id: string; status: string } | 'AMBIGUOUS' | undefined> {
    if (this.deps.periodId !== undefined) {
      const key = `id:${this.deps.periodId}`;
      if (!this.periodCache.has(key)) {
        const [row] = await tx.query<{ id: string; status: string }>('select id, status from machvon.reporting_period where id = $1::uuid', [this.deps.periodId]);
        this.periodCache.set(key, row);
      }
      return this.periodCache.get(key);
    }
    if (!this.periodCache.has(code)) {
      const found = await this.figures.periodsByCode(tx, code);
      this.periodCache.set(code, found.length > 1 ? 'AMBIGUOUS' : found[0]);
    }
    return this.periodCache.get(code);
  }

  /** The project, the period and the figures held for a row; a refusal when the register cannot take it. */
  private async resolve(tx: TenantTx, record: ImportRecord): Promise<Resolved | Rejection> {
    const project = await this.project(tx, record.projectCode);
    if (project === undefined) return { code: 'PROJECT_UNKNOWN', field: 'project' };
    const period = await this.period(tx, record.periodCode);
    if (period === undefined) return { code: 'PERIOD_UNKNOWN', field: 'period' };
    if (period === 'AMBIGUOUS') return { code: 'PERIOD_AMBIGUOUS', field: 'period' };
    // A locked period takes nothing unless a reopening that was approved covers the project: the same discipline as the weekly report.
    const closed = await this.periods.closedFor(tx, period.id, project.id, this.deps.now);
    if (closed) return { code: 'PERIOD_LOCKED', field: 'period' };
    return { project, periodId: period.id, periodStatus: period.status === 'LOCKED' ? 'REOPENED' : period.status, current: await this.figures.current(tx, project.id, period.id) };
  }

  /** The refusal the indicators of a row give: unknown, not entered, or a number that does not fit the unit. */
  private indicatorRefusal(record: ImportRecord): Rejection | undefined {
    for (const figure of record.figures) {
      const indicator = this.byCode.get(figure.indicator);
      if (indicator === undefined) return { code: 'INDICATOR_UNKNOWN', field: figure.indicator };
      if (!isEnterable(indicator)) return { code: 'INDICATOR_NOT_ENTERABLE', field: figure.indicator };
      if (!figureFitsUnit(figure.value, indicator.unit)) return { code: 'NUMBER_NOT_WHOLE', field: figure.indicator };
    }
    return undefined;
  }

  /** What the approved rules say about the figures of the row together with the figures already held for the project and the period. */
  private verdictOf(record: ImportRecord, resolved: Resolved): EntryVerdict {
    if (this.deps.rules.length === 0) return { violations: [], blocking: [], warnings: [], evaluated: [], skipped: [] };
    const values: Record<string, string> = { ...figureFacts(resolved.current, this.deps.indicators) };
    const total = resolved.project.totalInvestmentVnd;
    if (values['TOTAL_INVESTMENT'] === undefined) values['TOTAL_INVESTMENT'] = total;
    for (const figure of record.figures) {
      const field = this.byCode.get(figure.indicator)?.entryField;
      if (field !== undefined && field !== null) values[field] = figure.value;
    }
    return evaluateEntryRules(this.deps.rules, { surface: 'INDICATOR_IMPORT', values, periodStatus: resolved.periodStatus, mandatory: mandatoryFieldsOf(this.deps.indicators, 'INDICATOR_IMPORT') });
  }

  async examine(tx: TenantTx, entry: ImportEntry<ImportRecord>): Promise<Rejection | undefined> {
    const early = this.indicatorRefusal(entry.record);
    if (early !== undefined) return early;
    const resolved = await this.resolve(tx, entry.record);
    if ('code' in resolved) return resolved;
    const verdict = this.verdictOf(entry.record, resolved);
    const first = verdict.blocking[0];
    return first === undefined ? undefined : { code: 'ENTRY_RULE_BLOCKED', field: first.ruleCode.slice(0, 80) };
  }

  /** What the apply would do with the row. */
  async outcomeOf(tx: TenantTx, entry: ImportEntry<ImportRecord>): Promise<IndRowOutcome> {
    const resolved = await this.resolve(tx, entry.record);
    if ('code' in resolved) return 'UNCHANGED';
    let created = 0;
    let differing = 0;
    for (const figure of entry.record.figures) {
      const held = resolved.current.get(figure.indicator);
      if (held === undefined) created += 1;
      else if (!sameNumber(held.value, figure.value)) differing += 1;
    }
    if (created > 0 && differing > 0) return 'CREATE_AND_DIFFERENCE';
    if (created > 0) return 'CREATE';
    return differing > 0 ? 'DIFFERENCE' : 'UNCHANGED';
  }

  async apply(tx: TenantTx, entry: ImportEntry<ImportRecord>, context: ApplyContext): Promise<readonly Difference[]> {
    const resolved = await this.resolve(tx, entry.record);
    if ('code' in resolved) throw new DomainError(resolved.code, 422, resolved.field);
    const differences: Difference[] = [];
    const mapping = this.deps.mapping;
    if (mapping.ruleId === null) throw new DomainError('IND_MAPPING_NOT_APPROVED', 409, 'mapping_code');
    for (const figure of entry.record.figures) {
      const indicator = this.byCode.get(figure.indicator);
      if (indicator === undefined) throw new Error(`the indicator ${figure.indicator} left the dictionary between the judgement and the apply`);
      const held = resolved.current.get(figure.indicator);
      if (held !== undefined) {
        if (sameNumber(held.value, figure.value)) this.written.unchanged += 1;
        else {
          this.written.differences += 1;
          differences.push({ code: IND_DIFFERENCE_CODES.FIGURE_DIFFERS, expected: held.value, actual: figure.value, detail: `${entry.record.projectCode} ${entry.record.periodCode} ${figure.indicator}`.slice(0, 500) });
        }
        continue;
      }
      await this.figures.write(
        tx,
        { projectId: resolved.project.id, periodId: resolved.periodId, indicator, value: figure.value, source: { kind: 'IMPORT', importId: context.importId, importLine: context.line, mapping: { code: mapping.code, version: mapping.version, ruleId: mapping.ruleId } } },
        this.deps.actor,
        this.deps.now,
      );
      this.written.figures += 1;
    }
    return differences;
  }

  /** The owner of a difference is the person who loaded the file (the fallback of the run). */
  async ownerFor(): Promise<string | undefined> {
    return undefined;
  }
}

const sameNumber = (a: string, b: string): boolean => {
  const norm = (value: string): string => (value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value);
  return norm(a) === norm(b);
};
