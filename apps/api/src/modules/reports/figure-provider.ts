import { AnalyticsGovernanceStore, ReportStore } from '@machvon/db';
import type { TenantDatabase } from '@machvon/db';
import { DIS_WEEKLY_INDICATORS, DomainError, defaultBasisOf, weeklySnapshotLine, WEEKLY_ORG_FALLBACK } from '@machvon/kernel';
import type { EffectiveAccess, FormPeriod, KpiDefinition, ReportFigure, ReportFillData, ReportIndicatorDefinition, ReportLayout, SnapshotRevisionRef, TenantContext } from '@machvon/kernel';
import { HomeFigureReader } from '../home/figures';

/**
 * Where the figures of a form with live data come from (RPT-1 part 2). A provider reads the indicators of the KPI register for one period and returns the fill data of the engine (definitions, figures with their flags,
 * the facts of the title block) and the snapshot the figures were taken from with its revision (R17), so a copy can say which snapshot it stands on and be called stale when that snapshot is corrected.
 * A provider is registered by id in the registry of the process; the weekly report of the public edition uses `DIS_HOME`, and the funding model of FND-1 adds its own when it lands (the enterprise forms already bind to
 * the KPI codes it will give: until then they run on illustrative data and say so).
 */
export interface ProviderContext {
  database: TenantDatabase;
  tenant: TenantContext;
  access: EffectiveAccess;
  now: Date;
  /** The Vietnam day of `now`. */
  today: string;
  period: FormPeriod;
  layout: ReportLayout;
}

export interface ProviderResult {
  data: ReportFillData;
  snapshot: SnapshotRevisionRef | null;
}

export interface ReportFigureProvider {
  id: string;
  /** Whether the figures are those of the whole tenant, so that only someone with authority over the whole tenant may issue them. */
  wholeTenant: boolean;
  load(context: ProviderContext): Promise<ProviderResult>;
}

export const DIS_HOME_PROVIDER = 'DIS_HOME';

const definitionOf = (definition: KpiDefinition): ReportIndicatorDefinition => ({
  code: definition.code,
  name: definition.name,
  unit: definition.unit,
  decimals: definition.decimals,
  period: definition.period,
  version: definition.version,
  formula: definition.formula,
  source: definition.source,
  unverified: definition.unverified,
});

/**
 * The weekly disbursement report: the tiles of the command center from the latest frozen snapshot (the two rates, the Treasury amount, the two plans) and its three counts, through the same reader as the screen of the
 * leader, so the file and the screen give one number. A tenant with no frozen snapshot gets the form with empty cells and the line "no snapshot", never zeros.
 */
export class DisHomeProvider implements ReportFigureProvider {
  readonly id = DIS_HOME_PROVIDER;
  readonly wholeTenant = true;
  private readonly register = new AnalyticsGovernanceStore();
  private readonly store = new ReportStore();

  async load(context: ProviderContext): Promise<ProviderResult> {
    const reader = new HomeFigureReader(context.database);
    let read: Awaited<ReturnType<HomeFigureReader['read']>> | null = null;
    try {
      read = await reader.read(context.tenant, context.access, { snapshotId: undefined, unitId: undefined }, context.now, context.today);
    } catch (error) {
      // No frozen snapshot yet is a report with empty cells; every other refusal (scope, permission) stands.
      if (!(error instanceof DomainError) || error.code !== 'RESOURCE_NOT_FOUND') throw error;
    }
    const around = await context.database.withTenant(context.tenant, async (tx) => ({
      definitions: await this.register.kpiDefinitions(tx, context.today),
      org: (await tx.query<{ name: string }>('select name from machvon.organization_unit where parent_id is null and valid_until is null order by valid_from, id limit 1'))[0]?.name ?? WEEKLY_ORG_FALLBACK,
      revision: read === null ? 0 : await this.store.snapshotRevision(tx, read.snapshot.id),
    }));
    const wanted = new Set<string>(DIS_WEEKLY_INDICATORS.map((one) => one.code));
    const definitions: Record<string, ReportIndicatorDefinition> = {};
    for (const [code, definition] of around.definitions) if (wanted.has(code)) definitions[code] = definitionOf(definition);
    const figures: ReportFigure[] = [];
    if (read !== null) {
      for (const tile of [...read.tiles, ...read.countTiles]) {
        const definition = definitions[tile.metric_code];
        if (definition === undefined) continue;
        figures.push({ code: tile.metric_code, basis: defaultBasisOf(definition.period), value: tile.value, flags: tile.flags, asOf: read.snapshot.asOfDate });
      }
    }
    const snapshot: SnapshotRevisionRef | null = read === null ? null : { snapshotId: read.snapshot.id, revision: around.revision, cutoff: read.snapshot.asOfDate };
    const data: ReportFillData = {
      period: context.period,
      locale: 'vi',
      meta: { ORG_NAME: around.org, SNAPSHOT_LINE: weeklySnapshotLine(read === null ? null : read.snapshot.asOfDate) },
      definitions,
      figures,
      datasets: {},
    };
    return { data, snapshot };
  }
}
