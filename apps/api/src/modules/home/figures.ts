import { AnalyticsGovernanceStore, DisSnapshotStore, HomeStore, projectScope } from '@machvon/db';
import type { CertificationView, PeriodSnapshotRow as SnapshotRow, ScopeBuilder, TenantDatabase } from '@machvon/db';
import { DomainError, addSums, displayKpiValue, figureFlags, homeTiles, kpiInfoOf, leaderGate, rateOfSums } from '@machvon/kernel';
import type { CertStatus, EffectiveAccess, FigureFlag, HomeTile, KpiDefinition, KpiInfo, RateFigures, TenantContext } from '@machvon/kernel';
import { workScopes } from './work-scope';
import { HOME_READ_PERMISSION } from './scope-hash';

/** The three counts of the command center that sit beside the rates, each a figure of the register (G0-4). */
export const COUNT_TILES = [
  { code: 'OPEN_WARNINGS', pick: (counts: { openWarnings: number; overdueExplanations: number; pendingReallocations: number }): number => counts.openWarnings },
  { code: 'OVERDUE_EXPLANATIONS', pick: (counts: { openWarnings: number; overdueExplanations: number; pendingReallocations: number }): number => counts.overdueExplanations },
  { code: 'PENDING_REALLOCATIONS', pick: (counts: { openWarnings: number; overdueExplanations: number; pendingReallocations: number }): number => counts.pendingReallocations },
] as const;

export interface FigureCertification {
  status: CertStatus;
  version: number;
  origin: 'PLATFORM' | 'TENANT';
  certified_by: string | null;
  at: string | null;
}

/** A figure as every channel gets it: the text, the register's own words behind the "i", the certification, the flags that sit on the number. A figure with no value says why and is never 0. */
export interface Figure {
  metric_code: string;
  value: string | null;
  display_value: string | null;
  numerator: string | null;
  denominator: string | null;
  null_reason: string | null;
  unit: string;
  formula: string;
  definition_status: string;
  kpi: KpiInfo | null;
  certification: FigureCertification | null;
  flags: FigureFlag[];
}

const DAY_MS = 86_400_000;
export const ageInDays = (asOf: string, today: string): number => Math.max(0, Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / DAY_MS));

const certificationView = (view: CertificationView): FigureCertification => ({ status: view.status, version: view.version, origin: view.origin, certified_by: view.status === 'CERTIFIED' ? (view.actor?.name ?? null) : null, at: view.at });

interface FigureSource {
  code: string;
  value: string | null;
  numerator: string | null;
  denominator: string | null;
  nullReason: string | null;
  unit: string;
  formula: string;
  definitionStatus: string;
}

/**
 * One figure of the command center from its source value and the register: the definition decides the text, the unit and the "i"; the certification decides whether a leader is given the value at all (a version that is
 * not certified, or was made obsolete, gives no value and says so: NOT_CERTIFIED, OBSOLETE); the flags say how far the number may be trusted. The flags are those of the figure itself, before the gate, so a figure that
 * has a value but is held back reads "not certified" and never "no data".
 */
export function figureOf(source: FigureSource, definition: KpiDefinition | undefined, certification: CertificationView | undefined, at: { asOf: string; snapshotId: string | null; today: string }): Figure {
  if (definition === undefined || certification === undefined) {
    return { metric_code: source.code, value: source.value, display_value: source.value, numerator: source.numerator, denominator: source.denominator, null_reason: source.nullReason, unit: source.unit, formula: source.formula, definition_status: source.definitionStatus, kpi: null, certification: null, flags: source.value === null ? ['NO_DATA'] : [] };
  }
  const gate = leaderGate(certification.status);
  const flags = figureFlags({ hasValue: source.value !== null, certification: certification.status, ageDays: ageInDays(at.asOf, at.today), allowedLagDays: definition.allowedLagDays, coveragePct: null, unverifiedDefinition: definition.unverified });
  const held = gate !== null && source.value !== null;
  const value = held ? null : source.value;
  return {
    metric_code: source.code,
    value,
    display_value: displayKpiValue(value, definition),
    numerator: held ? null : source.numerator,
    denominator: held ? null : source.denominator,
    null_reason: held ? gate : source.nullReason,
    unit: source.unit,
    formula: source.formula,
    definition_status: source.definitionStatus,
    kpi: kpiInfoOf(definition, { asOf: at.asOf, snapshotId: at.snapshotId }),
    certification: certificationView(certification),
    flags: flags.filter((flag) => !(held && flag === 'NO_DATA')),
  };
}

export interface HomeFilter {
  snapshotId: string | undefined;
  unitId: string | undefined;
}

export interface HomeFigures {
  snapshot: SnapshotRow;
  today: string;
  sums: ReturnType<typeof addSums>;
  withoutData: number;
  counts: { openWarnings: number; overdueExplanations: number; pendingReallocations: number };
  figures: RateFigures;
  tiles: Figure[];
  countTiles: Figure[];
}

/**
 * Reads the figures of the command center for a reader, once, for every channel that gives them (the screen, the phone's reading of the same API, the file): the latest frozen snapshot, or the one named, in the scope of the
 * reader, made into figures through the register. The tiles of the center, the lines of the file and the figures the phone shows are this one result, so they cannot differ.
 */
export class HomeFigureReader {
  private readonly snapshots = new DisSnapshotStore();
  private readonly home = new HomeStore();
  private readonly register = new AnalyticsGovernanceStore();

  constructor(private readonly database: TenantDatabase) {}

  async read(tenant: TenantContext, access: EffectiveAccess, filter: HomeFilter, now: Date, today: string): Promise<HomeFigures> {
    const projects = projectScope(access, HOME_READ_PERMISSION, now);
    const units: ScopeBuilder = workScopes(access, now).unitScope;
    const read = await this.database.withTenant(tenant, async (tx) => {
      if (filter.unitId !== undefined && !(await this.home.unitReadable(tx, units, filter.unitId))) throw new DomainError('SCOPE_DENIED', 403);
      const snapshot = filter.snapshotId === undefined ? await this.snapshots.latestFrozen(tx) : await this.snapshots.find(tx, filter.snapshotId);
      if (snapshot === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'snapshot_id');
      if (snapshot.status !== 'FROZEN' && snapshot.status !== 'SUPERSEDED') throw new DomainError('SNAPSHOT_NOT_FROZEN', 422, 'snapshot_id');
      const query = { basis: 'CURRENT_YEAR' as const, underUnitId: filter.unitId };
      const whole = await this.snapshots.rateSums(tx, snapshot.id, projects, { ...query, groupBy: 'NONE' });
      const perProject = await this.snapshots.rateSums(tx, snapshot.id, projects, { ...query, groupBy: 'PROJECT' });
      const counts = await this.home.counts(tx, { projectScope: projects, unitScope: units, unitId: filter.unitId, now });
      const definitions = await this.register.kpiDefinitions(tx, today);
      const certifications = await this.register.kpiCertifications(tx, definitions.values());
      return { snapshot, sums: addSums(whole.map((row) => row.sums)), withoutData: perProject.filter((row) => row.sums.allNone).length, counts, definitions, certifications };
    });
    // BR-HOME-01: a figure is given with its scope, day, snapshot, unit and formula, or it is not given.
    if (read.snapshot.asOfDate === '') throw new DomainError('METRIC_UNAVAILABLE', 422, 'snapshot_id');
    const figures = rateOfSums(read.sums, 'CURRENT_YEAR');
    const base: HomeTile[] = homeTiles(figures, read.snapshot.definitionStatus);
    const at = { asOf: read.snapshot.asOfDate, snapshotId: read.snapshot.id, today };
    const tiles = base.map((tile) => figureOf({ code: tile.metricCode, value: tile.value, numerator: tile.numerator, denominator: tile.denominator, nullReason: tile.nullReason, unit: tile.unit, formula: tile.formula, definitionStatus: tile.definitionStatus }, read.definitions.get(tile.metricCode), read.certifications.get(tile.metricCode), at));
    // The counts are of the moment they are read: their day is today.
    const nowAt = { asOf: today, snapshotId: null, today };
    const countTiles = COUNT_TILES.map((count) => {
      const value = String(count.pick(read.counts));
      return figureOf({ code: count.code, value, numerator: value, denominator: null, nullReason: null, unit: 'COUNT', formula: read.definitions.get(count.code)?.formula ?? '', definitionStatus: read.snapshot.definitionStatus }, read.definitions.get(count.code), read.certifications.get(count.code), nowAt);
    });
    return { snapshot: read.snapshot, today, sums: read.sums, withoutData: read.withoutData, counts: read.counts, figures, tiles, countTiles };
  }
}
