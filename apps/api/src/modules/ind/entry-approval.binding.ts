import { Inject, Injectable, Optional } from '@nestjs/common';
import { DisPeriodStore, IND_ENTRY_BATCH_RESOURCE, IND_FIGURE_RESOURCE, IndDictionaryStore, IndEntryBatchStore, IndEntryRuleStore, IndFigureStore, figureFacts } from '@machvon/db';
import type { ApprovalEffects, EntryBatchRow, FinalCommand, ScopeBuilder, TenantTx } from '@machvon/db';
import { DomainError, IND_ENTRY_BUSINESS_TYPE, IND_ENTRY_RESOURCE, assertEntryAllowed, message, vietnamDateOf } from '@machvon/kernel';
import { APPROVAL_PUSH_SOURCES } from '../adm/approval-hold.service';
import type { ApprovalPushSource, ApprovalPushSources } from '../adm/approval-hold.service';
import { APPROVAL_FINAL_COMMANDS } from '../adm/approval.service';
import type { FinalCommandRegistry } from '../adm/approval.service';

const EVERYTHING: ScopeBuilder = () => ({ sql: 'true', params: [] });
const CLASSIFICATION = 'INTERNAL';

/** The warnings of a batch as a notification needs them: the rule, the check, the fields and what was found, never a figure. */
export const warningsOf = (batch: Pick<EntryBatchRow, 'warnings'>): Array<Record<string, unknown>> => batch.warnings.map((one) => ({ rule_code: one.rule_code, check: one.check, fields: one.fields, detail: one.detail }));

/**
 * Writes the figures of an accepted batch to the register (append-only, as an entry does) under the name of the person who entered them, after judging them again against what the register holds now: a period that was
 * locked meanwhile, or a rule that now blocks, refuses the acceptance (409 `PERIOD_LOCKED`, 422 `IND_ENTRY_RULE_VIOLATED`) and nothing changes. Returns how many figures were created or revised.
 */
async function writeBatch(tx: TenantTx, effects: ApprovalEffects, batch: EntryBatchRow, now: Date): Promise<number> {
  const dictionary = new IndDictionaryStore();
  const figures = new IndFigureStore();
  const periods = new DisPeriodStore();
  const day = vietnamDateOf(now);
  const period = await periods.find(tx, batch.periodId, 'share');
  if (period === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
  if (await periods.closedFor(tx, period.id, batch.projectId, now)) throw new DomainError('PERIOD_LOCKED', 409);
  const entries = await dictionary.list(tx, day);
  const byCode = new Map(entries.map((entry) => [entry.code, entry]));
  await figures.lockSet(tx, batch.projectId, batch.periodId);
  const held = await figures.current(tx, batch.projectId, batch.periodId);
  const values: Record<string, string> = { ...figureFacts(held, entries) };
  if (values['TOTAL_INVESTMENT'] === undefined) {
    const total = await figures.totalInvestment(tx, batch.projectId);
    if (total !== undefined) values['TOTAL_INVESTMENT'] = total;
  }
  const planned = batch.figures.map((figure) => {
    const indicator = byCode.get(figure.indicator_code);
    if (indicator === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'indicator_code');
    if (indicator.entryField !== null) values[indicator.entryField] = figure.value;
    return { indicator, value: figure.value, reason: figure.reason };
  });
  const verdict = await new IndEntryRuleStore().check(tx, { surface: 'INDICATOR_ENTRY', facts: { values, periodStatus: period.status === 'LOCKED' ? 'REOPENED' : period.status }, asOf: day });
  assertEntryAllowed(verdict);
  let written = 0;
  for (const one of planned) {
    const outcome = await figures.write(tx, { projectId: batch.projectId, periodId: batch.periodId, indicator: one.indicator, value: one.value, reason: one.reason, source: { kind: 'ENTRY' } }, batch.enteredBy, now);
    if (outcome.kind === 'UNCHANGED') continue;
    written += 1;
    const row = outcome.row;
    await effects.audit({
      action: outcome.kind === 'CREATED' ? 'ind.figure_entered' : 'ind.figure_revised',
      resourceType: IND_FIGURE_RESOURCE,
      resourceId: row.id,
      classification: CLASSIFICATION,
      diff: { project_code: row.projectCode, period_code: row.periodCode, indicator_code: row.indicatorCode, revision: row.revision, value: row.value, unit: row.unit, definition_version: row.definitionVersion, with_reason: row.reason !== null, batch_id: batch.id },
    });
  }
  return written;
}

/**
 * The final command of the business type `ind.entry.accept` (R14): what the engine calls when the last step of an instance approves a batch of indicator entries (the figures are written to the register under the name of
 * the person who entered them) or an approver returns it (the batch goes back with its warnings to the person who entered it and to the approver, BBH 43). A batch that is not waiting, or one decided by the person who
 * entered it, is left as it was (`GUARD_REJECTED`, BR-ADM-07).
 */
export function indEntryHandler(clock: () => Date): FinalCommand {
  const batches = new IndEntryBatchStore();
  return async ({ tx, instance, outcome, effects }) => {
    if (instance.resourceType !== IND_ENTRY_RESOURCE || outcome === 'REJECTED') return 'GUARD_REJECTED';
    const batch = await batches.find(tx, instance.resourceId, EVERYTHING, true);
    if (batch === undefined || batch.status !== 'SUBMITTED' || batch.enteredBy === effects.actor) return 'GUARD_REJECTED';
    const [tenant] = await tx.query<{ tenant_id: string }>("select nullif(current_setting('app.tenant_id', true), '') as tenant_id");
    const now = clock();
    if (outcome === 'APPROVED') {
      const written = await writeBatch(tx, effects, batch, now);
      const { row } = await batches.decide(tx, batch.id, { kind: 'ACCEPTED', written }, effects.actor, EVERYTHING, now);
      await effects.audit({ action: 'ind.entry_batch_accepted', resourceType: IND_ENTRY_BATCH_RESOURCE, resourceId: row.id, classification: CLASSIFICATION, diff: { project_code: row.projectCode, period_code: row.periodCode, revision: row.revision, figures: row.figureCount, written, warnings: row.warnings.length } });
      await effects.emit({
        aggregateType: IND_ENTRY_BATCH_RESOURCE,
        aggregateId: row.id,
        aggregateVersion: row.version,
        type: 'ind.entry_batch.accepted.v1',
        schemaVersion: 1,
        payload: { tenant_id: tenant?.tenant_id ?? '', batch_id: row.id, project_id: row.projectId, period_id: row.periodId, revision: row.revision, written, entered_by: row.enteredBy, decided_by: effects.actor, occurred_at: now.toISOString() },
        eventKey: `${IND_ENTRY_BATCH_RESOURCE}:${row.id}:accepted`,
      });
      return 'APPLIED';
    }
    const [decided] = await tx.query<{ reason: string | null }>("select reason from machvon.approval_task where workflow_instance_id = $1::uuid and decision_seq = $2::integer and status = 'Decided' limit 1", [instance.id, instance.decisionSeq]);
    const reason = decided?.reason ?? message('ind.workflow.default_return_reason');
    const { row } = await batches.decide(tx, batch.id, { kind: 'RETURNED', reason }, effects.actor, EVERYTHING, now);
    // The return goes to both people with the warnings the entry rules gave at the hand-in: the one who entered (to correct) and the one who returned (who saw them in front of the decision).
    const warnings = warningsOf(row);
    await effects.audit({ action: 'ind.entry_batch_returned', resourceType: IND_ENTRY_BATCH_RESOURCE, resourceId: row.id, classification: CLASSIFICATION, reason, diff: { project_code: row.projectCode, period_code: row.periodCode, revision: row.revision, figures: row.figureCount, warnings: warnings.length } });
    await effects.emit({
      aggregateType: IND_ENTRY_BATCH_RESOURCE,
      aggregateId: row.id,
      aggregateVersion: row.version,
      type: 'ind.entry_batch.returned.v1',
      schemaVersion: 1,
      payload: { tenant_id: tenant?.tenant_id ?? '', batch_id: row.id, project_id: row.projectId, period_id: row.periodId, revision: row.revision, entered_by: row.enteredBy, decided_by: effects.actor, warnings, occurred_at: now.toISOString() },
      eventKey: `${IND_ENTRY_BATCH_RESOURCE}:${row.id}:returned`,
    });
    return 'APPLIED';
  };
}

/** What the PUSH step hands over for a batch of indicator entries (ENT-3c): the figures of the batch keyed by project, period end and batch revision. */
export function indPushSource(): ApprovalPushSource {
  const batches = new IndEntryBatchStore();
  return {
    owner: 'IND_ENTRY',
    resourceType: IND_ENTRY_RESOURCE,
    layoutBase: 'IND_ENTRIES',
    async describe(tx, instance) {
      const batch = await batches.find(tx, instance.resourceId, EVERYTHING);
      if (batch === undefined) return undefined;
      const [period] = await tx.query<{ end_date: string }>('select end_date::text as end_date from machvon.reporting_period where id = $1::uuid', [batch.periodId]);
      const [newest] = await tx.query<{ revision: number }>('select max(revision) as revision from machvon.ind_entry_batch where project_id = $1::uuid and period_id = $2::uuid', [batch.projectId, batch.periodId]);
      return {
        subjectCode: batch.projectCode,
        period: period?.end_date ?? batch.periodCode,
        revision: batch.revision,
        headRevision: Math.max(batch.revision, newest?.revision ?? 0),
        facts: { project_code: batch.projectCode, period_code: batch.periodCode, revision: batch.revision, figures: batch.figures.map((figure) => ({ indicator_code: figure.indicator_code, value: figure.value })) },
      };
    },
  };
}

/** Binds the final command and the PUSH source of the indicator entry batches into the registries of the approval engine when the application starts, so that the boot guard of ADM finds a real handler for the business type IND owns (R14). */
@Injectable()
export class IndEntryApprovalBinding {
  constructor(
    @Optional() @Inject(APPROVAL_FINAL_COMMANDS) commands?: FinalCommandRegistry,
    @Optional() @Inject(APPROVAL_PUSH_SOURCES) sources?: ApprovalPushSources,
  ) {
    sources?.register(indPushSource());
    commands?.register(IND_ENTRY_BUSINESS_TYPE, indEntryHandler(() => new Date()));
  }
}
