import { AnalyticsGovernanceStore, AnalyticsRagStore, evaluateUnits } from '@machvon/db';
import type { PeriodSnapshotRow as SnapshotRow, ScopeBuilder, TenantTx, UnitEvaluation } from '@machvon/db';
import { shownBand } from '@machvon/kernel';
import type { ActiveOverride, RagBand, RagModel } from '@machvon/kernel';

export interface RagUnitReading extends UnitEvaluation {
  /** The colour a reader is shown: the override while it lasts, else the colour of the rules. */
  shown: { band: RagBand; overridden: boolean; ruleBand: RagBand };
  override: (ActiveOverride & { ruleBand: RagBand | null }) | null;
}

export interface RagReading {
  model: RagModel;
  units: RagUnitReading[];
}

/**
 * The reading of the units of a scope on the day of a snapshot, by the rules in force today: the model (the factors, the weights, the lines) is read through the governance store, each unit is judged by the
 * kernel, and the overrides in force are put beside the colour of the rules, never in place of it. The job writes these same readings once for a week, so the colour a leader sees is the colour that is stored.
 */
export async function readRag(tx: TenantTx, input: { snapshot: SnapshotRow; unitScope: ScopeBuilder; now: Date; today: string; unitId?: string | undefined }): Promise<RagReading> {
  const governance = new AnalyticsGovernanceStore();
  const store = new AnalyticsRagStore();
  const model = await governance.ragModel(tx, input.today);
  const all = await store.unitReadings(tx, input.snapshot.id, input.unitScope, input.now);
  const chosen = input.unitId === undefined ? all : all.filter((reading) => reading.unitId === input.unitId);
  const evaluated = evaluateUnits(model, chosen, input.snapshot.asOfDate);
  const overrides = await store.activeOverrides(tx, chosen.map((reading) => reading.unitId), input.today);
  return {
    model,
    units: evaluated.map((one) => {
      const override = overrides.get(one.input.unitId) ?? null;
      return { ...one, override, shown: shownBand(one.evaluation.band, override, input.today) };
    }),
  };
}
