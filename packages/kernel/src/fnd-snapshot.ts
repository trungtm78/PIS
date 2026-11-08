import { canonicalJson, sha256Hex } from './canonical-json.ts';
import type { FigureBasis } from './fnd-actuals.ts';
import type { CellFigures, FigureQuery, ProjectFigures } from './fnd-figures.ts';

/**
 * What the snapshot of a closed period carries so that its figures keep their meaning for good (docs/fnd-funding-model.md section 6.5): the pack and the version of the rule it was built with, the hash schema, and the figures
 * of the long format (`period_snapshot_figure`). `hash_schema` 1 is the header hashed since DIS-1 (a PUBLIC snapshot of taxonomy version 1 keeps it, so its hash is byte-identical to what it always was); `hash_schema` 2 adds
 * the pack, the version, the precedence of the actuals and the figure kinds present, and covers the figures too. Verification of a stored hash recomputes it with the stored schema. Pure.
 */

export const HASH_SCHEMAS = [1, 2] as const;
export type HashSchema = (typeof HASH_SCHEMAS)[number];

/** The header the first schema hashes (the same fields, in the same names, as the header of `snapshotHash` in dis-snapshot.ts). */
export interface SnapshotHashHeader {
  periodId: string;
  snapshotKind: string;
  asOfDate: string;
  treasuryCutoffDate: string;
  metricSetVersion: string;
  definitionStatus: string;
}

export interface HashedFigureLine {
  projectId: string;
  unitId: string;
  bucket: string;
  budgetLevel: string;
  [member: string]: unknown;
}

/** One figure of a snapshot: the amount or the reason it is null, where it comes from and which stored figure it was read from. */
export interface SnapshotFigure {
  projectId: string;
  unitId: string;
  classCode: string;
  tierCode: string;
  measure: string;
  figureKind: string;
  grain: string;
  planYear: number;
  ordinal: number;
  amountVnd: string | null;
  nullReason: string | null;
  basis: FigureBasis | null;
  sourceFigureId: string | null;
}

export interface HashSchema2Extras {
  taxonomyPack: string;
  taxonomyVersion: number;
  actualsPrecedence: string;
  figures: readonly SnapshotFigure[];
}

const lineKey = (line: { projectId: string; bucket: string; budgetLevel: string }): string => line.projectId + `${line.bucket}/${line.budgetLevel}`;
const figureKey = (figure: SnapshotFigure): string => [figure.projectId, figure.classCode, figure.tierCode, figure.measure, figure.figureKind, figure.grain, String(figure.planYear), String(figure.ordinal)].join('|');
const byText = <T>(key: (value: T) => string) => (left: T, right: T): number => key(left).localeCompare(key(right));

/**
 * The SHA-256 of a snapshot under a hash schema. Schema 1: the header and every line in an order that does not depend on how they were read (identical to `snapshotHash`). Schema 2: the same, with the pack, the version, the
 * precedence and the figure kinds present in the header, and every figure after the lines. The same input gives the same hash and a changed figure does not; the two schemas never give the same hash for the same lines.
 */
export function snapshotHashFor(schema: HashSchema, header: SnapshotHashHeader, lines: readonly HashedFigureLine[], extras?: HashSchema2Extras): string {
  const ordered = [...lines].sort(byText(lineKey));
  if (schema === 1) return sha256Hex(canonicalJson({ header, lines: ordered }));
  if (extras === undefined) throw new Error('hash schema 2 needs the pack, the version and the figures');
  const figures = [...extras.figures].sort(byText(figureKey));
  const figureKinds = [...new Set(figures.map((figure) => figure.figureKind))].sort();
  return sha256Hex(canonicalJson({ header: { ...header, taxonomyPack: extras.taxonomyPack, taxonomyVersion: extras.taxonomyVersion, actualsPrecedence: extras.actualsPrecedence, figureKinds }, lines: ordered, figures }));
}

const MISSING = 'NO_DATA';

/**
 * The figures of a snapshot for one project, one row for each (class, tier, measure, figure kind, grain, ordinal) the query covers: the plan of the year (first, adjusted, in force), the phased plan of the period, the
 * estimate and the estimate as reported, the actual, the cumulative year to date and since the start, and the estimate of the year. A figure nobody has is a row with its reason, never zero.
 */
export function figureRowsOf(project: { projectId: string; unitId: string }, figures: ProjectFigures, query: FigureQuery): SnapshotFigure[] {
  const rows: SnapshotFigure[] = [];
  const { planYear } = query.period;
  const add = (cell: CellFigures, figureKind: string, grain: string, ordinal: number, amountVnd: string | null, basis: FigureBasis | null, sourceFigureId: string | undefined): void => {
    rows.push({ projectId: project.projectId, unitId: project.unitId, classCode: cell.classCode, tierCode: cell.tierCode, measure: cell.measure, figureKind, grain, planYear, ordinal, amountVnd, nullReason: amountVnd === null ? MISSING : null, basis, sourceFigureId: sourceFigureId ?? null });
  };
  const periodKind = query.period.grain === 'MONTH' ? 'PLAN_MONTH' : query.period.grain === 'QUARTER' ? 'PLAN_QUARTER' : 'PLAN_IN_FORCE';
  for (const cell of figures.cells) {
    add(cell, 'PLAN_YEAR', 'YEAR', 0, cell.planYear, 'PLAN_DECISION', cell.sourceIds.PLAN_YEAR);
    add(cell, 'PLAN_ADJUSTED', 'YEAR', 0, cell.planAdjusted, 'PLAN_DECISION', cell.sourceIds.PLAN_ADJUSTED);
    add(cell, 'PLAN_IN_FORCE', 'YEAR', 0, cell.planInForce, 'PLAN_DECISION', cell.sourceIds.PLAN_ADJUSTED ?? cell.sourceIds.PLAN_YEAR);
    if (query.period.grain !== 'YEAR') add(cell, periodKind, query.period.grain, query.period.ordinal, cell.planPeriod, 'PLAN_DECISION', cell.sourceIds.PLAN_PERIOD);
    add(cell, 'ESTIMATE', query.period.grain, query.period.ordinal, cell.estimate, 'OWNER_ESTIMATE', cell.sourceIds.ESTIMATE);
    add(cell, 'ESTIMATE_AS_REPORTED', query.period.grain, query.period.ordinal, cell.estimateAsReported, 'OWNER_ESTIMATE', cell.sourceIds.ESTIMATE_AS_REPORTED);
    add(cell, 'ACTUAL', query.period.grain, query.period.ordinal, cell.actual, cell.actualBases[0] ?? null, cell.sourceIds.ACTUAL);
    add(cell, 'CUMULATIVE_YTD', query.period.grain, query.period.ordinal, cell.cumulativeYtd, cell.actualBases[0] ?? null, undefined);
    add(cell, 'CUMULATIVE_SINCE_START', query.period.grain, query.period.ordinal, cell.cumulativeSinceStart, cell.actualBases[0] ?? null, undefined);
    add(cell, 'ESTIMATE_YEAR', 'YEAR', 0, cell.estimateYear, null, undefined);
  }
  return rows;
}
