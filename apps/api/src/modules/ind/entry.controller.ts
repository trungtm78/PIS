import { Body, Controller, HttpCode, Inject, Optional, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidWorkflowReads, DisPeriodStore, IND_FIGURE_RESOURCE, IndDictionaryStore, IndEntryRuleStore, IndFigureStore, figureFacts, projectScope } from '@machvon/db';
import type { FigureRow } from '@machvon/db';
import { DomainError, assertEntryAllowed, figureFitsUnit, isEnterable, vietnamDateOf, verdictTrail } from '@machvon/kernel';
import type { EffectiveAccess, EntryFacts, IndicatorEntry } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { figureDto, violationDto } from './ind-view';
import { IND_CLOCK } from './tokens';

const CLASSIFICATION = 'INTERNAL';
const MAX_FACTS = 60;

/**
 * The commands where a person types figures against the dictionary (IND-1). The entry judges its figures the way every other place of entry does: the project is in the scope of the caller, the period takes
 * entries (a locked period takes none unless an approved reopening names the project: the same discipline as the weekly report), each indicator is one of the dictionary that is entered and the number fits
 * its unit, and the approved entry rules of the surface hold the figures together with those already held. A figure is never edited: the first one is revision 1, a different number is the next revision with
 * its reason, the same number changes nothing. The trail keeps ids, codes and numbers, never the words of a reason.
 */
@Controller()
export class IndEntryController {
  private readonly dictionary = new IndDictionaryStore();
  private readonly entryRules = new IndEntryRuleStore();
  private readonly figures = new IndFigureStore();
  private readonly periods = new DisPeriodStore();
  private readonly people = new BidWorkflowReads();
  private readonly clock: () => Date;

  constructor(@Optional() @Inject(IND_CLOCK) clock?: () => Date) {
    this.clock = clock ?? ((): Date => new Date());
  }

  @Post('indicator-entry-rules/evaluate')
  @HttpCode(200)
  @OperationId('evaluateIndicatorEntry')
  @Command({ operation: 'evaluateIndicatorEntry' })
  async evaluate(@Scope() scope: CommandScope, @Body() body: Schemas['IndEntryEvaluate']): Promise<Record<string, unknown>> {
    const now = this.clock();
    const values = Object.entries(body.values);
    if (values.length > MAX_FACTS) throw new DomainError('VALIDATION_FAILED', 422, 'values');
    const facts: Omit<EntryFacts, 'surface' | 'mandatory'> = { values: Object.fromEntries(values), periodStatus: body.period_status };
    const verdict = await this.entryRules.check(scope.tx, { surface: body.surface, facts, asOf: vietnamDateOf(now), includeTemplates: body.include_templates === true });
    await scope.audit({ action: 'ind.entry_evaluated', resourceType: IND_FIGURE_RESOURCE, resourceId: scope.tenant.tenantId, classification: CLASSIFICATION, diff: { surface: body.surface, templates: body.include_templates === true, ...verdictTrail(verdict) } });
    return {
      operation_id: scope.requestId,
      status: 'EVALUATED',
      resource_version: 0,
      allowed: verdict.blocking.length === 0,
      violations: verdict.violations.map(violationDto),
      evaluated: verdict.evaluated,
      skipped: verdict.skipped.map((one) => ({ rule_code: one.ruleCode, reason: one.reason })),
    };
  }

  @Post('indicator-figures')
  @HttpCode(200)
  @OperationId('enterIndicatorFigures')
  @Command({ operation: 'enterIndicatorFigures' })
  async enter(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['IndFigureEntry']): Promise<Record<string, unknown>> {
    const now = this.clock();
    const day = vietnamDateOf(now);
    const project = await this.figures.project(scope.tx, body.project_id, projectScope(access, PERMISSIONS.listIndicatorFigures, now), projectScope(access, PERMISSIONS.enterIndicatorFigures, now));
    // A locked period takes nothing unless an approved reopening covers the project.
    const period = await this.periods.find(scope.tx, body.period_id, 'share');
    if (period === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (await this.periods.closedFor(scope.tx, period.id, project.id, now)) throw new DomainError('PERIOD_LOCKED', 409);
    const dictionary = await this.dictionary.list(scope.tx, day);
    const byCode = new Map(dictionary.map((entry) => [entry.code, entry]));
    const seen = new Set<string>();
    const planned: Array<{ indicator: IndicatorEntry; value: string; reason: string | undefined }> = [];
    for (const [index, figure] of body.figures.entries()) {
      const indicator = byCode.get(figure.indicator_code);
      if (indicator === undefined || !isEnterable(indicator) || seen.has(figure.indicator_code)) throw new DomainError('VALIDATION_FAILED', 422, `figures[${index}].indicator_code`);
      if (!figureFitsUnit(figure.value, indicator.unit)) throw new DomainError('VALIDATION_FAILED', 422, `figures[${index}].value`);
      seen.add(figure.indicator_code);
      planned.push({ indicator, value: figure.value, reason: figure.reason });
    }
    const held = await this.figures.current(scope.tx, project.id, period.id);
    const values: Record<string, string> = { ...figureFacts(held, dictionary) };
    if (values['TOTAL_INVESTMENT'] === undefined) values['TOTAL_INVESTMENT'] = project.totalInvestmentVnd;
    for (const one of planned) if (one.indicator.entryField !== null) values[one.indicator.entryField] = one.value;
    const periodStatus = period.status === 'LOCKED' ? 'REOPENED' : period.status;
    const verdict = await this.entryRules.check(scope.tx, { surface: 'INDICATOR_ENTRY', facts: { values, periodStatus }, asOf: day });
    assertEntryAllowed(verdict);
    const written: FigureRow[] = [];
    let created = 0;
    let revised = 0;
    let unchanged = 0;
    for (const one of planned) {
      const outcome = await this.figures.write(scope.tx, { projectId: project.id, periodId: period.id, indicator: one.indicator, value: one.value, reason: one.reason, source: { kind: 'ENTRY' } }, scope.tenant.membershipId, now);
      written.push(outcome.row);
      if (outcome.kind === 'UNCHANGED') {
        unchanged += 1;
        continue;
      }
      if (outcome.kind === 'CREATED') created += 1;
      else revised += 1;
      const row = outcome.row;
      await scope.audit({
        action: outcome.kind === 'CREATED' ? 'ind.figure_entered' : 'ind.figure_revised',
        resourceType: IND_FIGURE_RESOURCE,
        resourceId: row.id,
        classification: CLASSIFICATION,
        diff: { project_code: project.code, period_code: period.code, indicator_code: row.indicatorCode, revision: row.revision, value: row.value, unit: row.unit, definition_version: row.definitionVersion, with_reason: row.reason !== null },
      });
      await scope.emit({
        aggregateType: IND_FIGURE_RESOURCE,
        aggregateId: row.id,
        aggregateVersion: row.revision,
        type: 'ind.figure.entered.v1',
        schemaVersion: 1,
        payload: { tenant_id: scope.tenant.tenantId, figure_id: row.id, project_id: project.id, period_id: period.id, indicator_code: row.indicatorCode, revision: row.revision, value: row.value, unit: row.unit, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
        eventKey: `${IND_FIGURE_RESOURCE}:${row.id}`,
      });
    }
    // An entry that changes nothing is still an act of a person, so it leaves its row.
    if (created + revised === 0) {
      await scope.audit({ action: 'ind.entry_unchanged', resourceType: IND_FIGURE_RESOURCE, resourceId: project.id, classification: CLASSIFICATION, diff: { project_code: project.code, period_code: period.code, figures: written.length } });
    }
    if (verdict.warnings.length > 0) {
      await scope.audit({ action: 'ind.entry_warned', resourceType: IND_FIGURE_RESOURCE, resourceId: project.id, classification: CLASSIFICATION, diff: { surface: 'INDICATOR_ENTRY', project_code: project.code, period_code: period.code, ...verdictTrail(verdict) } });
    }
    const names = await this.people.names(scope.tx, written.map((row) => row.enteredBy));
    return { operation_id: scope.requestId, status: 'ENTERED', resource_version: 1, created, revised, unchanged, warnings: verdict.warnings.map(violationDto), figures: written.map((row) => figureDto(row, names)) };
  }
}
