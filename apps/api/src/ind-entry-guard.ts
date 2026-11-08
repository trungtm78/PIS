import { IND_FIGURE_RESOURCE, IndEntryRuleStore, IndFigureStore } from '@machvon/db';
import { assertEntryAllowed, verdictTrail, vietnamDateOf } from '@machvon/kernel';
import type { EntrySurface, FundingTotals, ProgressInput } from '@machvon/kernel';
import type { CommandScope } from './command-scope';

/**
 * The one call the places where numbers are entered make before they write (IND-1, DL.02): the approved `DATA_ENTRY_RULE` rules of the surface hold the entry up to the identities of the data. A rule that
 * blocks stops the command with 422 `IND_ENTRY_RULE_VIOLATED` listing the rules; one that warns lets it through and leaves an audit row naming it. A tenant with no approved rule sees no change at all: the call
 * reads the rules once and finds none.
 */
const rules = new IndEntryRuleStore();
const figures = new IndFigureStore();

async function enforce(scope: CommandScope, surface: EntrySurface, values: Record<string, string>, periodStatus: string | undefined, resource: { type: string; id: string }, now: Date): Promise<void> {
  const verdict = await rules.check(scope.tx, { surface, facts: { values, periodStatus }, asOf: vietnamDateOf(now) });
  assertEntryAllowed(verdict);
  if (verdict.warnings.length > 0) {
    await scope.audit({ action: 'ind.entry_warned', resourceType: resource.type, resourceId: resource.id, classification: 'INTERNAL', diff: { surface, ...verdictTrail(verdict) } });
  }
}

/** The weekly or monthly report of DIS: the totals of the six cells, the volumes of the progress, the register's total investment of the project and the state of the period. */
export async function enforceReportEntry(
  scope: CommandScope,
  input: { projectId: string; totals: Pick<FundingTotals, 'cumulativeVnd' | 'ctmtqgVnd' | 'nextMonthVnd'>; progress: ProgressInput | null | undefined; periodStatus: string; now: Date },
): Promise<void> {
  const values: Record<string, string> = { CUMULATIVE: input.totals.cumulativeVnd, CTMTQG: input.totals.ctmtqgVnd, NEXT_MONTH: input.totals.nextMonthVnd };
  const total = await figures.totalInvestment(scope.tx, input.projectId);
  if (total !== undefined) values['TOTAL_INVESTMENT'] = total;
  const progress = input.progress;
  if (progress !== null && progress !== undefined) {
    values['CONSTRUCTION'] = progress.constructionVnd;
    values['ACCEPTANCE'] = progress.acceptanceVnd;
    values['TREASURY_SUBMITTED'] = progress.treasurySubmittedVnd;
    values['PREPARING_DOSSIER'] = progress.preparingDossierVnd;
    if (progress.physicalProgressPct !== null) values['PHYSICAL_PROGRESS'] = progress.physicalProgressPct;
  }
  await enforce(scope, 'DIS_REPORT', values, input.periodStatus, { type: IND_FIGURE_RESOURCE, id: input.projectId }, input.now);
}

/** The figures of a project of the register when it is created: its total investment. */
export async function enforceProjectEntry(scope: CommandScope, input: { totalInvestmentVnd: string; now: Date }): Promise<void> {
  await enforce(scope, 'PRJ_PROJECT', { TOTAL_INVESTMENT: input.totalInvestmentVnd }, undefined, { type: 'project', id: scope.tenant.tenantId }, input.now);
}
