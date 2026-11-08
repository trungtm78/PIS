import {
  FRESHNESS_DEFAULT_CODE,
  FRESHNESS_RULE_TYPE,
  KPI_SOURCE_TABLES,
  SCORECARD_MODULE_RULE_TYPE,
  SCORECARD_RULE_CODE,
  SCORECARD_UNIT_RULE_TYPE,
  buildLineage,
  datasetAdapters,
  fieldsOfTree,
  freshnessRuleCodeOf,
  freshnessSlaOf,
  judgeFreshness,
  moduleScorecard,
  moduleScorecardPolicyOf,
  unitScorecard,
  unitScorecardPolicyOf,
  weekStartOf,
} from '@machvon/kernel';
import type { CertStatus, DeclaredLineage, FreshnessReading, LineageDataset, LineageKpi, LineageMetric, QualityBadge, ScorecardRow } from '@machvon/kernel';
import { AnalyticsGovernanceStore } from './analytics-governance-store.ts';
import { AnalyticsRagStore } from './analytics-rag-store.ts';
import { BiDatasetStore, CONTRACT_JOIN_PATHS, DISBURSEMENT_JOIN_PATHS, datasetProducerModuleOf } from './bi-dataset-store.ts';
import { BiMetricStore } from './bi-metric-store.ts';
import { DisSnapshotStore } from './dis-snapshot-store.ts';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import { policyVersionOf } from './home-work-policy.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export interface DatasetTrust {
  code: string;
  title: string;
  module: string;
  datasetId: string | null;
  builtAt: string | null;
  asOfPeriod: string | null;
  qualityBadge: QualityBadge | null;
  certification: CertStatus | null;
  freshness: FreshnessReading;
  slaVersion: string;
  unverified: boolean;
}

export interface ModuleScore {
  module: string;
  datasets: string[];
  row: ScorecardRow;
}
export interface UnitScore {
  unitId: string;
  code: string;
  name: string;
  row: ScorecardRow;
}

export interface TrustPolicyInfo {
  version: string;
  unverified: boolean;
}

/** The base tables a dataset is read from (its source kind) and the tables of its approved joins. */
const BASE_TABLES: Readonly<Record<string, readonly string[]>> = {
  PERIOD_SNAPSHOT: ['period_snapshot', 'period_snapshot_line'],
  CONTRACT_FACT: ['contract_fact_snapshot', 'contract_fact_snapshot_line'],
};
const tablesOfJoins = (joins: ReadonlyArray<{ from: string; to: string }>): string[] => joins.flatMap((join) => [join.to.split('.')[0] as string]);
const JOIN_TABLES: Readonly<Record<string, readonly string[]>> = {
  'DS-DISB': tablesOfJoins(DISBURSEMENT_JOIN_PATHS.joins),
  'DS-CTR': tablesOfJoins(CONTRACT_JOIN_PATHS.joins),
};

/**
 * What the leader can trust (G3-7, G3-11): the freshness of every registered dataset against its SLA (a dataset that was never built is shown as such), the quality scorecards of the modules and of the units in the scope
 * of the reader, and the declared lineage of the metrics. It reads what the platform already keeps (the dataset catalogue and its versions, the certifications, the weekly scores, the snapshot lines, the metric
 * registry) and writes nothing; every threshold is a governance rule read through the port.
 */
export class AnaTrustStore {
  private readonly datasets = new BiDatasetStore();
  private readonly certifications = new AnalyticsGovernanceStore();
  private readonly rag = new AnalyticsRagStore();
  private readonly snapshots = new DisSnapshotStore();
  private readonly metrics = new BiMetricStore();

  private readonly port: GovernancePolicyPort;

  constructor(port: GovernancePolicyPort = new GovernancePolicyPort()) {
    this.port = port;
  }

  /** The freshness of every registered dataset on a day; one with no catalogue row or no build has no data, said so. */
  async freshness(tx: TenantTx, now: Date, today: string): Promise<DatasetTrust[]> {
    const rows = new Map((await this.datasets.list(tx, { limit: 200 })).map((row) => [row.datasetCode, row]));
    const certified = new Map((await this.certifications.datasetCertifications(tx)).map((row) => [row.code, row.status]));
    const result: DatasetTrust[] = [];
    for (const adapter of datasetAdapters()) {
      const rule = (await this.port.get(tx, FRESHNESS_RULE_TYPE, freshnessRuleCodeOf(adapter.code), today)) ?? (await this.port.require(tx, FRESHNESS_RULE_TYPE, FRESHNESS_DEFAULT_CODE, today));
      const row = rows.get(adapter.code);
      const latest = row?.latest ?? null;
      const builtAt = latest === null ? null : String(latest.builtAt);
      result.push({
        code: adapter.code,
        title: row?.title ?? adapter.code,
        module: datasetProducerModuleOf(adapter.code) ?? 'BI',
        datasetId: row?.id ?? null,
        builtAt,
        asOfPeriod: latest?.asOfPeriod ?? null,
        qualityBadge: latest?.qualityBadge ?? null,
        certification: certified.get(adapter.code) ?? null,
        freshness: judgeFreshness(builtAt, now, freshnessSlaOf(rule.params)),
        slaVersion: policyVersionOf(rule),
        unverified: rule.unverified,
      });
    }
    return result;
  }

  /** The scorecard of each module that produces a registered dataset: its datasets' freshness, quality badge and certification, the worst of them standing for the module. */
  async moduleScores(tx: TenantTx, now: Date, today: string): Promise<{ modules: ModuleScore[]; policy: TrustPolicyInfo }> {
    const rule = await this.port.require(tx, SCORECARD_MODULE_RULE_TYPE, SCORECARD_RULE_CODE, today);
    const policy = moduleScorecardPolicyOf(rule.params);
    const trust = await this.freshness(tx, now, today);
    const byModule = new Map<string, DatasetTrust[]>();
    for (const one of trust) byModule.set(one.module, [...(byModule.get(one.module) ?? []), one]);
    const modules: ModuleScore[] = [];
    for (const [module, sets] of [...byModule.entries()].sort(([left], [right]) => (left < right ? -1 : 1))) {
      // A module with several datasets is as good as its worst one on each signal (a figure is only as trustworthy as the weakest dataset under it).
      const rank = { FRESH: 0, DUE: 1, STALE: 2, NO_DATA: 3 } as const;
      const worstFreshness = sets.map((one) => one.freshness.status).sort((left, right) => rank[right] - rank[left])[0] ?? 'NO_DATA';
      const qualityRank = { PASSED: 0, WARNING: 1, STALE: 2, FAILED: 3 } as const;
      const assessed = sets.flatMap((one) => (one.qualityBadge === null || one.qualityBadge === 'NOT_ASSESSED' ? [] : [one.qualityBadge]));
      const quality: QualityBadge | null = assessed.length < sets.length ? null : (assessed.sort((left, right) => qualityRank[right] - qualityRank[left])[0] ?? null);
      const certRank = { CERTIFIED: 0, CONFIRMED: 1, DRAFT: 2, OBSOLETE: 3 } as const;
      const certs = sets.flatMap((one) => (one.certification === null ? [] : [one.certification]));
      const certification: CertStatus | null = certs.length < sets.length ? null : (certs.sort((left, right) => certRank[right] - certRank[left])[0] ?? null);
      modules.push({ module, datasets: sets.map((one) => one.code), row: moduleScorecard({ freshness: worstFreshness, quality, certification }, policy) });
    }
    return { modules, policy: { version: policyVersionOf(rule), unverified: rule.unverified } };
  }

  /** The scorecard of each unit the reader may read, from the latest frozen snapshot and the weekly scores; no snapshot gives no unit (nothing is made up). */
  async unitScores(tx: TenantTx, unitScope: ScopeBuilder, now: Date, today: string): Promise<{ snapshotId: string | null; asOfDate: string | null; units: UnitScore[]; policy: TrustPolicyInfo }> {
    const rule = await this.port.require(tx, SCORECARD_UNIT_RULE_TYPE, SCORECARD_RULE_CODE, today);
    const policy = unitScorecardPolicyOf(rule.params);
    const info = { version: policyVersionOf(rule), unverified: rule.unverified };
    const snapshot = await this.snapshots.latestFrozen(tx);
    if (snapshot === undefined) return { snapshotId: null, asOfDate: null, units: [], policy: info };
    const readings = await this.rag.unitReadings(tx, snapshot.id, unitScope, now);
    const stored = new Map((await this.rag.scoresOfWeek(tx, weekStartOf(snapshot.asOfDate), unitScope)).map((row) => [row.unitId, row]));
    const units = readings.map((reading) => ({
      unitId: reading.unitId,
      code: reading.code,
      name: reading.name,
      row: unitScorecard({ projects: reading.facts.projects, projectsWithoutData: reading.facts.projectsWithoutData, coveragePct: stored.get(reading.unitId)?.coveragePct ?? null, overdueExplanations: reading.facts.overdueExplanations }, policy),
    }));
    return { snapshotId: snapshot.id, asOfDate: snapshot.asOfDate, units, policy: info };
  }

  /** The declared lineage of the tenant: the current revision of each metric, the registered datasets and the indicators of the command center. */
  async lineage(tx: TenantTx): Promise<DeclaredLineage> {
    const rows = await this.metrics.list(tx, {}, { limit: 1000 });
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) if (row.effectiveUntil === null && (latest.get(row.code)?.revision ?? -1) < row.revision) latest.set(row.code, row);
    const metrics: LineageMetric[] = [...latest.values()].map((row) => ({
      code: row.code,
      label: row.code,
      fields: [...new Set([...fieldsOfTree(row.expressionAst), ...fieldsOfTree(row.numeratorAst), ...fieldsOfTree(row.denominatorAst)])].sort(),
    }));
    const datasets: LineageDataset[] = datasetAdapters().map((adapter) => ({
      code: adapter.code,
      label: adapter.code,
      producerModule: datasetProducerModuleOf(adapter.code) ?? 'BI',
      fields: Object.keys(adapter.fields),
      tables: [...(BASE_TABLES[adapter.sourceKind] ?? []), ...(JOIN_TABLES[adapter.code] ?? [])],
    }));
    const kpis: LineageKpi[] = Object.entries(KPI_SOURCE_TABLES).map(([code, tables]) => ({ code, label: code, tables }));
    return buildLineage({ metrics, datasets, kpis });
  }
}
