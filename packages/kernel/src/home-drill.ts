import { DomainError } from './errors.ts';
import { rateOfSums } from './dis-rates.ts';
import type { RateSums } from './dis-rates.ts';
import { homeTiles } from './home.ts';
import type { HomeTile } from './home.ts';

/**
 * The drill of a figure (ST-HOME-002, HOME 3 F2, BR-HOME-03): from the tile to the units, the projects, the cells of the snapshot and the sources, each step of the same snapshot and with the scope judged again. The rules of
 * the steps are here; the reads and the checks of the right are in the store and the controller.
 */
export type DrillLevel = 'SCOPE' | 'UNIT' | 'PROJECT' | 'CELL';
export type DrillDimension = 'unit' | 'project' | 'cell';

/** Where a token stands: nothing narrowed, a unit, a project of it, or one cell (one line of the snapshot) of the project. */
export function drillLevelOf(context: { unitId: string | null; projectId: string | null; lineId: string | null }): DrillLevel {
  if (context.lineId !== null) return 'CELL';
  if (context.projectId !== null) return 'PROJECT';
  if (context.unitId !== null) return 'UNIT';
  return 'SCOPE';
}

/**
 * What a level can be broken into. A cell is the last step of the snapshot; from it the way goes to the sources (the report revision and the Treasury transactions). A unit that is the unit alone (a child of a
 * breakdown by unit) has no units under it to break into: it goes down to its projects.
 */
export function drillDimensions(level: DrillLevel, unitExact = false): readonly DrillDimension[] {
  switch (level) {
    case 'SCOPE':
      return ['unit', 'project'];
    case 'UNIT':
      return unitExact ? ['project'] : ['unit', 'project'];
    case 'PROJECT':
      return ['cell'];
    case 'CELL':
      return [];
  }
}

/** The figure of a metric over the sums of a child, as the tile of the center gives it (the same rules, so that a child and its parent are the same kind of figure). */
export function drillChildTile(metricCode: string, sums: RateSums, definitionStatus: string): HomeTile {
  const tile = homeTiles(rateOfSums(sums, 'CURRENT_YEAR'), definitionStatus).find((candidate) => candidate.metricCode === metricCode);
  if (tile === undefined) throw new DomainError('INVALID_REQUEST', 400);
  return tile;
}

export interface Reconciliation {
  reconcilesToParent: boolean;
  /** Why the children are not added up: a ratio is made from the sums of its parts, never from their rates. */
  nonAdditiveReason: 'RATIO' | null;
}

/**
 * Whether the children add up to the parent, to the dong. Money is added exactly (whole dong, as big integers); a child that has no figure adds nothing, and a parent that has none is the sum of nothing. A ratio is not
 * additive: it says so, and the numerator and the denominator of each child are what the reader adds.
 */
export function reconcileChildren(unit: 'VND' | 'PERCENT', parent: string | null, children: ReadonlyArray<string | null>): Reconciliation {
  if (unit === 'PERCENT') return { reconcilesToParent: false, nonAdditiveReason: 'RATIO' };
  const known = children.filter((value): value is string => value !== null);
  if (parent === null) return { reconcilesToParent: known.length === 0, nonAdditiveReason: null };
  const total = known.reduce((sum, value) => sum + BigInt(value), 0n);
  return { reconcilesToParent: total === BigInt(parent), nonAdditiveReason: null };
}
