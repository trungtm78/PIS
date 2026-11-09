import { Inject, Injectable, Optional } from '@nestjs/common';
import { FndFigureStore } from '@machvon/db';
import type { FinalCommand, FigureBatch, ScopeBuilder } from '@machvon/db';
import { FND_FIGURE_BUSINESS_TYPE, FND_FIGURE_RESOURCE, message } from '@machvon/kernel';
import { APPROVAL_PUSH_SOURCES } from '../adm/approval-hold.service';
import type { ApprovalPushSource, ApprovalPushSources } from '../adm/approval-hold.service';
import { APPROVAL_FINAL_COMMANDS } from '../adm/approval.service';
import type { FinalCommandRegistry } from '../adm/approval.service';
import { packCodeOf } from './figure.controller';
import { writeFigureTrail } from './figure-trail';
import { FUNDING_PACK_CODE } from './tokens';

const EVERYTHING: ScopeBuilder = () => ({ sql: 'true', params: [] });
const pad = (value: number): string => String(value).padStart(2, '0');

/** The report period a batch of figures is delivered under: the plan year for a batch of several periods (the four quarters of a phasing), the period itself for one. */
export function figurePeriodOf(batch: Pick<FigureBatch, 'grain' | 'planYear' | 'entries'>): string {
  const year = String(batch.planYear).padStart(4, '0');
  const only = batch.entries.length === 1 ? batch.entries[0] : undefined;
  if (only === undefined || batch.grain === 'YEAR') return year;
  if (batch.grain === 'QUARTER') return `${year}-Q${only.ordinal}`;
  if (batch.grain === 'MONTH') return `${year}-M${pad(only.ordinal)}`;
  return year;
}

/**
 * The final command of the business type `fnd.figures.accept` (R14): what the engine calls when the last step of an instance approves the batch (or an approver returns it). It is the acceptance (or the return) of the
 * batch itself, run in the transaction of the decision with the audit trail and the events of that transaction, by the person who decided: the maker is never the checker, and a batch that is not waiting for a decision
 * is left as it was (`GUARD_REJECTED`, BR-ADM-07). The checks of the identities and of the locked period are the store's own and run again here.
 */
export function fndFigureHandler(packCode: string, clock: () => Date): FinalCommand {
  const store = new FndFigureStore();
  return async ({ tx, instance, outcome, effects }) => {
    if (instance.resourceType !== FND_FIGURE_RESOURCE || outcome === 'REJECTED') return 'GUARD_REJECTED';
    const batch = await store.find(tx, instance.resourceId, EVERYTHING, true);
    if (batch === undefined || batch.status !== 'SUBMITTED' || batch.preparedBy === effects.actor) return 'GUARD_REJECTED';
    const [tenant] = await tx.query<{ tenant_id: string }>("select nullif(current_setting('app.tenant_id', true), '') as tenant_id");
    const tenantId = tenant?.tenant_id ?? '';
    const now = clock();
    if (outcome === 'APPROVED') {
      const done = await store.accept(tx, batch.batchId, batch.version, effects.actor, packCode, EVERYTHING, now);
      await writeFigureTrail(effects, tenantId, done, 'funding.figure_accepted', 'funding.figure_accepted.v1', now);
      if (done.conversions > 0) await writeFigureTrail(effects, tenantId, done, 'funding.estimate_converted', 'funding.estimate_converted.v1', now);
      return 'APPLIED';
    }
    const [decided] = await tx.query<{ reason: string | null }>("select reason from machvon.approval_task where workflow_instance_id = $1::uuid and decision_seq = $2::integer and status = 'Decided' limit 1", [instance.id, instance.decisionSeq]);
    const done = await store.sendBack(tx, batch.batchId, batch.version, effects.actor, EVERYTHING, now);
    await writeFigureTrail(effects, tenantId, done, 'funding.figure_returned', 'funding.figure_returned.v1', now, decided?.reason ?? message('fnd.workflow.default_return_reason'));
    return 'APPLIED';
  };
}

/** What the PUSH step hands over for a batch of figures (ENT-3c): the batch as it was approved, keyed by its project, its period and the newest revision of its figures. */
export function fndPushSource(): ApprovalPushSource {
  const store = new FndFigureStore();
  return {
    owner: 'FND_FIGURE',
    resourceType: FND_FIGURE_RESOURCE,
    layoutBase: 'FND_FIGURES',
    async describe(tx, instance) {
      const batch = await store.find(tx, instance.resourceId, EVERYTHING);
      if (batch === undefined) return undefined;
      const revision = Math.max(1, ...batch.entries.map((entry) => entry.revision));
      return {
        subjectCode: batch.projectCode,
        period: figurePeriodOf(batch),
        revision,
        headRevision: revision,
        facts: {
          project_code: batch.projectCode,
          taxonomy_pack: batch.taxonomyPack,
          class_code: batch.classCode,
          tier_code: batch.tierCode,
          measure: batch.measure,
          figure_kind: batch.kind,
          period_grain: batch.grain,
          plan_year: batch.planYear,
          as_of_date: batch.asOfDate,
          entries: batch.entries.map((entry) => ({ ordinal: entry.ordinal, revision: entry.revision, amount_vnd: entry.amountVnd })),
        },
      };
    },
  };
}

/** Binds the final command and the PUSH source of the funding figures into the registries of the approval engine when the application starts, so that the boot guard of ADM finds a real handler for the business type FND owns (R14). */
@Injectable()
export class FndFigureApprovalBinding {
  constructor(
    @Optional() @Inject(APPROVAL_FINAL_COMMANDS) commands?: FinalCommandRegistry,
    @Optional() @Inject(APPROVAL_PUSH_SOURCES) sources?: ApprovalPushSources,
    @Optional() @Inject(FUNDING_PACK_CODE) packCode?: string,
  ) {
    sources?.register(fndPushSource());
    commands?.register(FND_FIGURE_BUSINESS_TYPE, fndFigureHandler(packCodeOf(packCode), () => new Date()));
  }
}
