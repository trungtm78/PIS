import { Body, Controller, HttpCode, Inject, Optional, Post } from '@nestjs/common';
import { BidWorkflowReads, DisPeriodStore, IND_ENTRY_BATCH_RESOURCE, IND_FIGURE_RESOURCE, IndDictionaryStore, IndEntryBatchStore, IndEntryRuleStore, IndFigureStore } from '@machvon/db';
import type { IndFigureRow as FigureRow } from '@machvon/db';
import { DomainError, stagedApprovalOf, vietnamDateOf, verdictTrail } from '@machvon/kernel';
import type { EffectiveAccess, EntryFacts, EntryVerdict } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { APPROVAL_FINAL_COMMANDS, effectsOf } from '../adm/approval.service';
import type { FinalCommandRegistry } from '../adm/approval.service';
import { StagedApprovalFlow } from '../adm/staged-approval.flow';
import { judgeEntry } from './entry-judge';
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
  private readonly batches = new IndEntryBatchStore();
  private readonly flow: StagedApprovalFlow;
  private readonly clock: () => Date;

  constructor(
    @Optional() @Inject(IND_CLOCK) clock?: () => Date,
    @Optional() @Inject(APPROVAL_FINAL_COMMANDS) commands?: FinalCommandRegistry,
  ) {
    this.clock = clock ?? ((): Date => new Date());
    this.flow = new StagedApprovalFlow(stagedApprovalOf('IND_ENTRY'), commands);
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
    const { project, period, planned, verdict } = await judgeEntry({ dictionary: this.dictionary, entryRules: this.entryRules, figures: this.figures, periods: this.periods }, scope, access, body, now);
    // A tenant that approved the staged rule has its entries handed in as a batch and decided by the steps; the figures reach the register when the last step approves (ENT-3c).
    if (await this.flow.isStaged(scope.tx, now)) return this.handIn(scope, project.id, period.id, project.code, period.code, body, verdict, now);
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

  /**
   * The entry of a tenant that runs the staged approval: the figures were judged like any entry, and are kept as a batch with the warnings the rules gave (they do not block, BBH 43) while the steps decide it. The answer
   * is the entry's own shape with nothing written yet (`SUBMITTED`); the register gets the figures, under the name of the person who entered them, when the last step approves.
   */
  private async handIn(scope: CommandScope, projectId: string, periodId: string, projectCode: string, periodCode: string, body: Schemas['IndFigureEntry'], verdict: EntryVerdict, now: Date): Promise<Record<string, unknown>> {
    const warnings = verdict.warnings.map(violationDto);
    const batch = await this.batches.submit(scope.tx, { projectId, periodId, figures: body.figures.map((figure) => ({ indicator_code: figure.indicator_code, value: figure.value, ...(figure.reason === undefined ? {} : { reason: figure.reason }) })), warnings }, scope.tenant.membershipId, now);
    const [owner] = await scope.tx.query<{ owner_unit_id: string }>('select owner_unit_id from machvon.project where id = $1::uuid', [projectId]);
    if (owner === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.flow.startIfStaged(scope.tx, effectsOf(scope), { id: batch.id, version: batch.version, unitId: owner.owner_unit_id, amountVnd: null, initiator: scope.tenant.membershipId }, now);
    await scope.audit({ action: 'ind.entry_batch_submitted', resourceType: IND_ENTRY_BATCH_RESOURCE, resourceId: batch.id, classification: CLASSIFICATION, diff: { project_code: projectCode, period_code: periodCode, revision: batch.revision, figures: batch.figureCount, warnings: warnings.length } });
    await scope.emit({
      aggregateType: IND_ENTRY_BATCH_RESOURCE,
      aggregateId: batch.id,
      aggregateVersion: batch.version,
      type: 'ind.entry_batch.submitted.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, batch_id: batch.id, project_id: projectId, period_id: periodId, revision: batch.revision, figures: batch.figureCount, warnings: warnings.length, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${IND_ENTRY_BATCH_RESOURCE}:${batch.id}:submitted`,
    });
    return { operation_id: scope.requestId, status: 'SUBMITTED', resource_version: batch.version, created: 0, revised: 0, unchanged: 0, warnings, figures: [] };
  }
}
