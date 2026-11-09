import { cellFigures, figuresOfProject, ratioOf, sumKnown } from './fnd-figures.ts';
import type { CellFigures, FigureBook, FigureQuery, ProjectFigures } from './fnd-figures.ts';
import { indicatorsOf, moneyIndicatorsOf } from './fnd-indicators.ts';
import type { Indicator, MoneyIndicator } from './fnd-indicators.ts';
import { monthsOf, periodRange } from './fnd-period.ts';
import type { FigureGrain, PeriodRef } from './fnd-period.ts';
import { figureRowsOf, snapshotHashFor } from './fnd-snapshot.ts';
import type { SnapshotFigure, SnapshotHashHeader, SnapshotIndicator } from './fnd-snapshot.ts';
import type { FundingPack, Measure } from './fnd-taxonomy.ts';

/**
 * The enterprise period snapshot (ENT-3a, docs/ent-snapshot.md): what is frozen when an enterprise period closes and the one pure way to read it (review decision R21). Three parts, all pure:
 *
 * 1. the completeness rule: a snapshot is built only when every input point (the owner unit of a planned project) has submitted the actual of every planned cell for every month the period needs;
 * 2. the rows to freeze: the figure rows of the figure engine (`figureRowsOf`) plus the two kinds the reader needs for the phased and since-start rates (`PLAN_TO_DATE` of a cell, `TMDT_IN_FORCE` of a project);
 * 3. `EnterpriseFigureReader`: the frozen rows give back the cells of the figure engine, and from them the ratios of the pack (sum over sum, numerator and denominator kept) and the additive money figures of any
 *    scope (the tenant, a unit, a project, a class). Forms, HOME/BAN and the HPM push read a snapshot only through this reader, so one number never has two sources.
 */

/** The class code of the rows that belong to a project as a whole (the total investment): never part of a class sum. */
export const PROJECT_TOTAL_CLASS = 'TOTAL';
export const PLAN_TO_DATE_KIND = 'PLAN_TO_DATE';
export const TMDT_KIND = 'TMDT_IN_FORCE';
/** The snapshot kind a report reads; the others are previews. */
export const ENTERPRISE_OFFICIAL_KIND = 'PERIOD_CLOSE';

// -- completeness ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** One project at the moment a snapshot is wanted: its owner unit and its figures for each measure of the pack. */
export interface CompletenessProject {
  projectId: string;
  projectCode: string;
  unitId: string;
  unitCode: string;
  cells: readonly CellFigures[];
}

export interface MissingCell {
  classCode: string;
  tierCode: string;
  measure: Measure;
  /** The months of the plan year (up to the end of the period) that have no accepted actual. */
  months: number[];
}

export interface MissingProject {
  projectId: string;
  projectCode: string;
  cells: MissingCell[];
}

export interface MissingUnit {
  unitId: string;
  unitCode: string;
  projects: MissingProject[];
}

export interface Completeness {
  complete: boolean;
  /** How many projects and planned cells were judged. */
  projects: number;
  plannedCells: number;
  missingUnits: MissingUnit[];
}

/** A cell is planned when the year plan in force or the plan of the period says so; a cell nobody planned needs no actual and is not part of the snapshot's demand. */
export const isPlannedCell = (cell: CellFigures): boolean => cell.planInForce !== null || cell.planPeriod !== null;

/**
 * Which input points have not submitted. An actual that is absent is a gap, never zero: a project that really spent nothing in a month says so with an accepted zero. The units come in the order of their codes and the
 * projects in the order of theirs, so the same books always give the same list (a list a person reads and the API returns is stable).
 */
export function completenessOf(projects: readonly CompletenessProject[]): Completeness {
  let planned = 0;
  const byUnit = new Map<string, MissingUnit>();
  for (const project of projects) {
    const missing: MissingCell[] = [];
    for (const cell of project.cells) {
      if (!isPlannedCell(cell)) continue;
      planned += 1;
      if (cell.actual === null || cell.gapMonths.length > 0) missing.push({ classCode: cell.classCode, tierCode: cell.tierCode, measure: cell.measure, months: [...cell.gapMonths] });
    }
    if (missing.length === 0) continue;
    const unit = byUnit.get(project.unitId) ?? { unitId: project.unitId, unitCode: project.unitCode, projects: [] };
    unit.projects.push({ projectId: project.projectId, projectCode: project.projectCode, cells: missing });
    byUnit.set(project.unitId, unit);
  }
  const missingUnits = [...byUnit.values()].sort((left, right) => left.unitCode.localeCompare(right.unitCode) || left.unitId.localeCompare(right.unitId));
  for (const unit of missingUnits) unit.projects.sort((left, right) => left.projectCode.localeCompare(right.projectCode) || left.projectId.localeCompare(right.projectId));
  return { complete: missingUnits.length === 0, projects: projects.length, plannedCells: planned, missingUnits };
}

// -- the rows to freeze -------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const hasValue = (cell: CellFigures): boolean =>
  [cell.planYear, cell.planAdjusted, cell.planInForce, cell.planPeriod, cell.planToDate, cell.estimate, cell.estimateAsReported, cell.actual, cell.cumulativeYtd, cell.cumulativeSinceStart, cell.estimateYear].some((value) => value !== null);

/**
 * The rows of one project to freeze: for every measure the figure rows of the engine, the `PLAN_TO_DATE` of each cell, and once the `TMDT_IN_FORCE` of the project. A cell with no figure at all is left out (the reader
 * reads an absent row as an absent figure). Deterministic: the same books always give the same rows.
 */
export function enterpriseRowsOf(project: { projectId: string; unitId: string }, perMeasure: ReadonlyArray<{ measure: Measure; figures: ProjectFigures }>, period: PeriodRef): SnapshotFigure[] {
  const rows: SnapshotFigure[] = [];
  const grain: FigureGrain = period.grain;
  for (const { measure, figures } of perMeasure) {
    const kept: ProjectFigures = { ...figures, cells: figures.cells.filter(hasValue) };
    rows.push(...figureRowsOf(project, kept, { period, asOf: '', measure, view: 'AS_REPORTED' }));
    for (const cell of kept.cells) {
      rows.push({ projectId: project.projectId, unitId: project.unitId, classCode: cell.classCode, tierCode: cell.tierCode, measure: cell.measure, figureKind: PLAN_TO_DATE_KIND, grain, planYear: period.planYear, ordinal: period.ordinal, amountVnd: cell.planToDate, nullReason: cell.planToDate === null ? 'NO_DATA' : null, basis: 'PLAN_DECISION', sourceFigureId: null });
    }
  }
  const tmdt = perMeasure[0]?.figures.tmdtInForce ?? null;
  rows.push({ projectId: project.projectId, unitId: project.unitId, classCode: PROJECT_TOTAL_CLASS, tierCode: 'ALL', measure: 'DISBURSED', figureKind: TMDT_KIND, grain: 'YEAR', planYear: period.planYear, ordinal: 0, amountVnd: tmdt, nullReason: tmdt === null ? 'NO_DATA' : null, basis: 'PLAN_DECISION', sourceFigureId: null });
  return rows;
}

/** The figures of one project of a book for every measure the pack counts, as the builder freezes them. */
export function projectRowsFromBook(book: FigureBook, project: { projectId: string; unitId: string }, query: Omit<FigureQuery, 'measure'>): SnapshotFigure[] {
  const perMeasure = book.pack.measures.map((measure) => ({ measure, figures: figuresOfProject(book, project.projectId, { ...query, measure }) }));
  return enterpriseRowsOf(project, perMeasure, query.period);
}

/** The cells of one project for completeness, over every measure of the pack. */
export function completenessProjectOf(book: FigureBook, project: { projectId: string; projectCode: string; unitId: string; unitCode: string }, query: Omit<FigureQuery, 'measure'>): CompletenessProject {
  const cells = book.pack.measures.flatMap((measure) => book.pack.classes.flatMap((one) => book.pack.tiers.map((tier) => cellFigures(book, one.code, tier.code, { ...query, measure }))));
  return { ...project, cells };
}

// -- the hash ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface EnterpriseHashInput {
  periodId: string;
  snapshotKind: string;
  asOfDate: string;
  metricSetVersion: string;
  definitionStatus: string;
  taxonomyPack: string;
  taxonomyVersion: number;
  actualsPrecedence: string;
  figures: readonly SnapshotFigure[];
  indicators: readonly SnapshotIndicator[];
}

/**
 * The SHA-256 of an enterprise snapshot (hash schema 2): the header, the pack and its version, every figure and every indicator figure, in an order that does not depend on how they were read. An enterprise snapshot has no
 * public lines; its treasury cutoff is its as-of date.
 */
export function enterpriseSnapshotHash(input: EnterpriseHashInput): string {
  const header: SnapshotHashHeader = { periodId: input.periodId, snapshotKind: input.snapshotKind, asOfDate: input.asOfDate, treasuryCutoffDate: input.asOfDate, metricSetVersion: input.metricSetVersion, definitionStatus: input.definitionStatus };
  return snapshotHashFor(2, header, [], { taxonomyPack: input.taxonomyPack, taxonomyVersion: input.taxonomyVersion, actualsPrecedence: input.actualsPrecedence, figures: input.figures, indicators: input.indicators });
}

// -- the reader ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** What the reader needs of a frozen snapshot: the identity (which snapshot, which revision, which hash), the period, the pack, the figures and the indicator figures. */
export interface EnterpriseSnapshotView {
  snapshotId: string;
  revision: number;
  payloadSha256: string | null;
  periodId: string;
  period: PeriodRef;
  asOfDate: string;
  pack: FundingPack;
  taxonomyVersion: number;
  figures: readonly SnapshotFigure[];
  indicators: readonly SnapshotIndicator[];
}

/** Which projects a read is over: all (the tenant), the projects of a unit, or named projects. */
export interface ReaderScope {
  unitId?: string | undefined;
  projectIds?: readonly string[] | undefined;
}

const cellKey = (projectId: string, classCode: string, tierCode: string, measure: string): string => `${projectId}|${classCode}|${tierCode}|${measure}`;

/**
 * The only reader of a frozen enterprise snapshot. It rebuilds the cells of the figure engine from the frozen rows, so the ratios (`rates`) and the money figures (`money`) are exactly those of `indicatorsOf` and
 * `moneyIndicatorsOf` over the same books, and a group's rate is the sum of its numerators over the sum of its denominators. An absent figure stays absent (null with a reason), never zero.
 */
export class EnterpriseFigureReader {
  private readonly byCell = new Map<string, Map<string, SnapshotFigure>>();
  private readonly tmdt = new Map<string, string | null>();
  private readonly unitOf = new Map<string, string>();

  constructor(readonly view: EnterpriseSnapshotView) {
    for (const row of view.figures) {
      this.unitOf.set(row.projectId, row.unitId);
      if (row.figureKind === TMDT_KIND) {
        this.tmdt.set(row.projectId, row.amountVnd);
        continue;
      }
      const key = cellKey(row.projectId, row.classCode, row.tierCode, row.measure);
      const held = this.byCell.get(key) ?? new Map<string, SnapshotFigure>();
      held.set(`${row.figureKind}|${row.grain}|${row.ordinal}`, row);
      this.byCell.set(key, held);
    }
    for (const row of view.indicators) this.unitOf.set(row.projectId, row.unitId);
  }

  get hash(): string | null {
    return this.view.payloadSha256;
  }

  /** The projects the snapshot holds, by id. */
  projectIds(): string[] {
    return [...this.unitOf.keys()].sort();
  }

  unitIds(): string[] {
    return [...new Set(this.unitOf.values())].sort();
  }

  unitOfProject(projectId: string): string | undefined {
    return this.unitOf.get(projectId);
  }

  private projectsIn(scope: ReaderScope): string[] {
    const named = scope.projectIds === undefined ? undefined : new Set(scope.projectIds);
    return this.projectIds().filter((id) => (scope.unitId === undefined || this.unitOf.get(id) === scope.unitId) && (named === undefined || named.has(id)));
  }

  private amount(held: Map<string, SnapshotFigure> | undefined, kind: string, grain: string, ordinal: number): string | null {
    return held?.get(`${kind}|${grain}|${ordinal}`)?.amountVnd ?? null;
  }

  private sourceOf(held: Map<string, SnapshotFigure> | undefined, kind: string, grain: string, ordinal: number): string | undefined {
    return held?.get(`${kind}|${grain}|${ordinal}`)?.sourceFigureId ?? undefined;
  }

  private cellOf(projectId: string, classCode: string, tierCode: string, measure: Measure): CellFigures {
    const held = this.byCell.get(cellKey(projectId, classCode, tierCode, measure));
    const { grain, ordinal } = this.view.period;
    const periodPlanKind = grain === 'MONTH' ? 'PLAN_MONTH' : grain === 'QUARTER' ? 'PLAN_QUARTER' : 'PLAN_IN_FORCE';
    const planInForce = this.amount(held, 'PLAN_IN_FORCE', 'YEAR', 0);
    const estimateYear = this.amount(held, 'ESTIMATE_YEAR', 'YEAR', 0);
    const actualRow = held?.get(`ACTUAL|${grain}|${ordinal}`);
    const sourceIds: CellFigures['sourceIds'] = {};
    const remember = (key: keyof CellFigures['sourceIds'], id: string | undefined): void => {
      if (id !== undefined) sourceIds[key] = id;
    };
    remember('PLAN_YEAR', this.sourceOf(held, 'PLAN_YEAR', 'YEAR', 0));
    remember('PLAN_ADJUSTED', this.sourceOf(held, 'PLAN_ADJUSTED', 'YEAR', 0));
    remember('PLAN_PERIOD', this.sourceOf(held, periodPlanKind, grain, ordinal));
    remember('ESTIMATE', this.sourceOf(held, 'ESTIMATE', grain, ordinal));
    remember('ESTIMATE_AS_REPORTED', this.sourceOf(held, 'ESTIMATE_AS_REPORTED', grain, ordinal));
    remember('ACTUAL', this.sourceOf(held, 'ACTUAL', grain, ordinal));
    return {
      classCode,
      tierCode,
      measure,
      planYear: this.amount(held, 'PLAN_YEAR', 'YEAR', 0),
      planAdjusted: this.amount(held, 'PLAN_ADJUSTED', 'YEAR', 0),
      planInForce,
      planPeriod: grain === 'YEAR' ? planInForce : this.amount(held, periodPlanKind, grain, ordinal),
      planToDate: this.amount(held, PLAN_TO_DATE_KIND, grain, ordinal),
      estimate: this.amount(held, 'ESTIMATE', grain, ordinal),
      estimateAsReported: this.amount(held, 'ESTIMATE_AS_REPORTED', grain, ordinal),
      actual: actualRow?.amountVnd ?? null,
      cumulativeYtd: this.amount(held, 'CUMULATIVE_YTD', grain, ordinal),
      cumulativeSinceStart: this.amount(held, 'CUMULATIVE_SINCE_START', grain, ordinal),
      estimateYear,
      estimateYearReason: estimateYear === null ? 'ESTIMATE_GAP' : null,
      gapMonths: [],
      actualBases: actualRow?.basis === null || actualRow?.basis === undefined ? [] : [actualRow.basis],
      actualFlash: false,
      sourceIds,
    };
  }

  /** The figures of the projects in a scope for one measure, in the shape of the figure engine. */
  figures(scope: ReaderScope, measure: Measure): ProjectFigures[] {
    return this.projectsIn(scope).map((projectId) => ({
      projectId,
      cells: this.view.pack.classes.flatMap((one) => this.view.pack.tiers.map((tier) => this.cellOf(projectId, one.code, tier.code, measure))),
      tmdtInForce: this.tmdt.get(projectId) ?? null,
    }));
  }

  private query(measure: Measure): FigureQuery {
    return { period: this.view.period, asOf: this.view.asOfDate, measure, view: 'AS_REPORTED' };
  }

  /** The ratios of the pack over a scope: sums of numerators over sums of denominators, each with both terms. */
  rates(scope: ReaderScope, measure: Measure): Indicator[] {
    return indicatorsOf(this.view.pack, this.figures(scope, measure), this.query(measure));
  }

  /** One ratio by code (`RATE_YEAR_IN_FORCE`...), or the share of one class for `STRUCTURE_SHARE`. */
  rate(scope: ReaderScope, measure: Measure, code: string, classCode: string | null = null): Indicator | undefined {
    return this.rates(scope, measure).find((one) => one.code === code && one.classCode === classCode);
  }

  /** The additive money figures over a scope, in total or of one class. */
  money(scope: ReaderScope, measure: Measure, classCode: string | null = null): MoneyIndicator[] {
    return moneyIndicatorsOf(this.view.pack, this.figures(scope, measure), this.query(measure), classCode);
  }

  /** One money figure by code, as whole dong text, or null when nobody has it. */
  amountOf(scope: ReaderScope, measure: Measure, code: MoneyIndicator['code'], classCode: string | null = null): string | null {
    return this.money(scope, measure, classCode).find((one) => one.code === code)?.valueVnd ?? null;
  }

  /** The total investment in force over a scope (the denominator of the since-start rate), or null when no project of the scope has an approved one. */
  totalInvestment(scope: ReaderScope): string | null {
    return sumKnown(this.projectsIn(scope).map((id) => this.tmdt.get(id) ?? null));
  }

  /** The cumulative since the start over the total investment, as the engine writes a rate. */
  rateSinceStart(scope: ReaderScope, measure: Measure): { ratePct: string | null; nullReason: 'ZERO_DENOMINATOR' | 'NO_DATA' | null } {
    return ratioOf(this.amountOf(scope, measure, 'CUMULATIVE_SINCE_START'), this.totalInvestment(scope));
  }

  /** The indicator figures of the dictionary carried by the snapshot, in a scope (a figure in force at the freeze). */
  indicatorFigures(scope: ReaderScope, indicatorCode?: string): SnapshotIndicator[] {
    const projects = new Set(this.projectsIn(scope));
    return this.view.indicators.filter((row) => projects.has(row.projectId) && (indicatorCode === undefined || row.indicatorCode === indicatorCode));
  }

  /** The sum of one whole-number indicator over a scope (a count or an amount); null when no project has it. */
  indicatorSum(scope: ReaderScope, indicatorCode: string): string | null {
    const rows = this.indicatorFigures(scope, indicatorCode);
    return rows.length === 0 ? null : rows.reduce((total, row) => total + BigInt(row.value.includes('.') ? row.value.slice(0, row.value.indexOf('.')) : row.value), 0n).toString();
  }

  /** The months the period covers: the months a form lists for it. */
  months(): Array<{ planYear: number; ordinal: number }> {
    return monthsOf(this.view.period);
  }

  /** The first and last day of the period. */
  range(): { start: string; end: string } {
    return periodRange(this.view.period);
  }
}
