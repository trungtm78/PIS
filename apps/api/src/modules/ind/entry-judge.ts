import { PERMISSIONS } from '@machvon/contracts';
import { DisPeriodStore, IndDictionaryStore, IndEntryRuleStore, IndFigureStore, figureFacts, projectScope } from '@machvon/db';
import type { IndProjectFacts } from '@machvon/db';
import { DomainError, assertEntryAllowed, figureFitsUnit, isEnterable, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, EntryVerdict, IndicatorEntry } from '@machvon/kernel';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';

export interface PlannedFigure {
  indicator: IndicatorEntry;
  value: string;
  reason: string | undefined;
}

export interface JudgedEntry {
  project: IndProjectFacts;
  period: NonNullable<Awaited<ReturnType<DisPeriodStore['find']>>>;
  planned: PlannedFigure[];
  verdict: EntryVerdict;
}

export interface EntryStores {
  dictionary: IndDictionaryStore;
  entryRules: IndEntryRuleStore;
  figures: IndFigureStore;
  periods: DisPeriodStore;
}

/**
 * Judges the figures a person typed the way every place of entry does (IND-1): the project is in the scope of the caller, the period takes entries (a locked period takes none unless an approved reopening names the
 * project), each indicator is one of the dictionary that is entered and the number fits its unit, and the approved entry rules of the surface hold the figures together with those already held. A rule that blocks refuses
 * (422 `IND_ENTRY_RULE_VIOLATED`); the warnings come back in the verdict. The direct entry writes the figures after this, and the batch of the staged approval (ENT-3c) keeps them with the warnings and writes them at the end.
 */
export async function judgeEntry(stores: EntryStores, scope: CommandScope, access: EffectiveAccess, body: Schemas['IndFigureEntry'], now: Date): Promise<JudgedEntry> {
  const day = vietnamDateOf(now);
  const project = await stores.figures.project(scope.tx, body.project_id, projectScope(access, PERMISSIONS.listIndicatorFigures, now), projectScope(access, PERMISSIONS.enterIndicatorFigures, now));
  // A locked period takes nothing unless an approved reopening covers the project.
  const period = await stores.periods.find(scope.tx, body.period_id, 'share');
  if (period === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
  if (await stores.periods.closedFor(scope.tx, period.id, project.id, now)) throw new DomainError('PERIOD_LOCKED', 409);
  const dictionary = await stores.dictionary.list(scope.tx, day);
  const byCode = new Map(dictionary.map((entry) => [entry.code, entry]));
  const seen = new Set<string>();
  const planned: PlannedFigure[] = [];
  for (const [index, figure] of body.figures.entries()) {
    const indicator = byCode.get(figure.indicator_code);
    if (indicator === undefined || !isEnterable(indicator) || seen.has(figure.indicator_code)) throw new DomainError('VALIDATION_FAILED', 422, `figures[${index}].indicator_code`);
    if (!figureFitsUnit(figure.value, indicator.unit)) throw new DomainError('VALIDATION_FAILED', 422, `figures[${index}].value`);
    seen.add(figure.indicator_code);
    planned.push({ indicator, value: figure.value, reason: figure.reason });
  }
  // The rules read several figures together: nobody else judges or writes this set until this command ends.
  await stores.figures.lockSet(scope.tx, project.id, period.id);
  const held = await stores.figures.current(scope.tx, project.id, period.id);
  const values: Record<string, string> = { ...figureFacts(held, dictionary) };
  if (values['TOTAL_INVESTMENT'] === undefined) values['TOTAL_INVESTMENT'] = project.totalInvestmentVnd;
  for (const one of planned) if (one.indicator.entryField !== null) values[one.indicator.entryField] = one.value;
  const periodStatus = period.status === 'LOCKED' ? 'REOPENED' : period.status;
  const verdict = await stores.entryRules.check(scope.tx, { surface: 'INDICATOR_ENTRY', facts: { values, periodStatus }, asOf: day });
  assertEntryAllowed(verdict);
  return { project, period, planned, verdict };
}
