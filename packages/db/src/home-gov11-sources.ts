import { message } from '@machvon/kernel';
import { CtrAdjustmentStore } from './ctr-adjustment-store.ts';
import { CtrSettlementClockStore } from './ctr-settlement-clock-store.ts';
import { DisMilestoneStore } from './dis-milestone-store.ts';
import { CONSEQUENCES, severityOf } from './home-work-rules.ts';
import { base, startOfDay } from './home-work-sources.ts';
import type { SourceContext, SourceRow } from './home-work-sources.ts';
import { PayClockStore } from './pay-clock-store.ts';
import { PrjLessonsStore } from './prj-lessons-store.ts';
import { PrjLookAheadStore } from './prj-look-ahead-store.ts';

const label = (...parts: Array<string | null | undefined>): string | null => {
  const text = parts.filter((part): part is string => part !== null && part !== undefined && part !== '').join(' · ');
  return text === '' ? null : text;
};

/**
 * The sources of the alert centre that GOV-11a adds: the projection to a directive milestone that is below its target (G1-16, `DIS_MILESTONE_AT_RISK`) and the Treasury clocks of payment and advance requests that
 * are near their end or past it (G1-17, `PAYMENT_CLOCK_NEAR`, `PAYMENT_CLOCK_BREACHED`). Both read what their module keeps (the vintage of the milestone, the clock rows) in the scope of the reader; nothing is
 * recomputed here beyond the judgement of the clock on the instant of the read.
 */
export class HomeGov11Sources {
  private readonly milestones = new DisMilestoneStore();
  private readonly paymentClocks = new PayClockStore();
  private readonly settlements = new CtrSettlementClockStore();
  private readonly adjustments = new CtrAdjustmentStore();
  private readonly lookAheads = new PrjLookAheadStore();
  private readonly lessons = new PrjLessonsStore();

  async disMilestones(context: SourceContext): Promise<SourceRow[]> {
    const rows = await this.milestones.atRisk(context.tx, context.projectScope);
    return rows.map(
      (row): SourceRow => ({
        ...base('DIS_MILESTONE_AT_RISK'),
        id: row.id,
        dueOn: row.date,
        originalDueOn: row.date,
        title: message('home.source.milestone.title', { code: row.code, date: row.date }),
        subtitle: label(message('home.source.milestone.detail', { unit: row.unitName, projected: row.projectedPct ?? '-', target: row.targetPct })),
        status: row.status,
        severity: severityOf('DISBURSEMENT_FORECAST', row.status, context.rules),
        consequence: CONSEQUENCES.DIS_MILESTONE_AT_RISK ?? null,
        causeKey: `dis-milestone:${row.unitId}:${row.code}`,
        startedAt: new Date(row.createdAt).toISOString(),
        target: { screen: 'DIS-24', id: row.snapshotId },
      }),
    );
  }

  async paymentClockItems(context: SourceContext): Promise<SourceRow[]> {
    const open = await this.paymentClocks.running(context.tx, context.projectScope, context.now);
    const items: SourceRow[] = [];
    for (const row of open) {
      if (row.state !== 'NEAR' && row.state !== 'BREACHED') continue;
      const breached = row.state === 'BREACHED';
      const request = row.requestNo ?? row.contract.code;
      items.push({
        ...base(breached ? 'PAYMENT_CLOCK_BREACHED' : 'PAYMENT_CLOCK_NEAR'),
        id: row.id,
        dueOn: row.dueAt === null ? null : row.dueAt.slice(0, 10),
        originalDueOn: row.dueAt === null ? null : row.dueAt.slice(0, 10),
        title: breached ? message('home.source.payment_clock.breached.title', { request }) : message('home.source.payment_clock.near.title', { request }),
        subtitle: label(row.project.code, row.contract.code, message('home.source.payment_clock.detail', { kind: row.clockKind, due: row.dueAt === null ? '-' : row.dueAt.slice(0, 10) })),
        status: row.state,
        severity: severityOf('PAYMENT_CLOCK', breached ? 'BREACHED' : 'NEAR', context.rules),
        consequence: (breached ? CONSEQUENCES.PAYMENT_CLOCK_BREACHED : CONSEQUENCES.PAYMENT_CLOCK_NEAR) ?? null,
        causeKey: `payment-clock:${row.paymentRequestId}`,
        startedAt: startOfDay(row.startedAt.slice(0, 10)),
        target: { screen: 'PAY-17', id: row.paymentRequestId },
      });
    }
    return items;
  }

  async settlementClocks(context: SourceContext): Promise<SourceRow[]> {
    const rows = await this.settlements.attention(context.tx, context.projectScope, context.now);
    return rows.map((row): SourceRow => {
      const overdue = row.state === 'OVERDUE';
      return {
        ...base(overdue ? 'CONTRACT_SETTLEMENT_OVERDUE' : 'CONTRACT_SETTLEMENT_NEAR'),
        id: row.id,
        dueOn: row.dueOn,
        originalDueOn: row.dueOn,
        title: message(overdue ? 'home.source.settlement_clock.overdue.title' : 'home.source.settlement_clock.near.title', { contract: row.contract.code }),
        subtitle: label(row.project.code, message('home.source.settlement_clock.detail', { group: row.projectGroup ?? '-', due: row.dueOn })),
        status: row.state,
        severity: severityOf('SETTLEMENT_CLOCK', overdue ? 'OVERDUE' : 'NEAR', context.rules),
        consequence: (overdue ? CONSEQUENCES.CONTRACT_SETTLEMENT_OVERDUE : CONSEQUENCES.CONTRACT_SETTLEMENT_NEAR) ?? null,
        causeKey: `settlement-clock:${row.contract.id}`,
        startedAt: startOfDay(row.startedOn),
        target: { screen: 'CTR-31', id: row.contract.id },
      };
    });
  }

  async adjustmentReviews(context: SourceContext): Promise<SourceRow[]> {
    const rows = await this.adjustments.pending(context.tx, context.projectScope);
    return rows.map(
      (row): SourceRow => ({
        ...base('CONTRACT_BASELINE_REVIEW'),
        id: row.id,
        dueOn: null,
        originalDueOn: null,
        title: message('home.source.contract_adjustment.title', { revision: row.revision, contract: row.contract.code }),
        subtitle: label(row.project.code, message('home.source.contract_adjustment.detail', { delta: row.deltaVnd, share: row.shareOfBaselinePct ?? '-' })),
        status: row.classification,
        severity: severityOf('CONTRACT_ADJUSTMENT', 'PENDING', context.rules),
        consequence: CONSEQUENCES.CONTRACT_BASELINE_REVIEW ?? null,
        causeKey: `contract-adjustment:${row.contract.id}`,
        startedAt: new Date(row.createdAt).toISOString(),
        target: { screen: 'CTR-32', id: row.contract.id },
      }),
    );
  }

  async lookAhead(context: SourceContext): Promise<SourceRow[]> {
    const [notReady, missing] = await Promise.all([this.lookAheads.notReady(context.tx, context.projectScope, context.now), this.lookAheads.missing(context.tx, context.projectScope, context.now)]);
    const rows: SourceRow[] = notReady.map(
      (row): SourceRow => ({
        ...base('LOOK_AHEAD_NOT_READY'),
        id: row.itemId,
        dueOn: row.plannedStart,
        originalDueOn: row.plannedStart,
        title: message('home.source.look_ahead.not_ready.title', { item: row.description, project: row.projectCode }),
        subtitle: label(row.projectCode, message('home.source.look_ahead.not_ready.detail', { start: row.plannedStart, open: row.openConstraints })),
        status: 'NOT_READY',
        severity: severityOf('LOOK_AHEAD', 'NOT_READY', context.rules),
        consequence: CONSEQUENCES.LOOK_AHEAD_NOT_READY ?? null,
        causeKey: `look-ahead:${row.itemId}`,
        startedAt: startOfDay(row.plannedStart),
        target: { screen: 'PRJ-30', id: row.projectId },
      }),
    );
    for (const row of missing) {
      rows.push({
        ...base('LOOK_AHEAD_MISSING'),
        id: row.projectId,
        dueOn: null,
        originalDueOn: null,
        title: message('home.source.look_ahead.missing.title', { project: row.projectCode }),
        subtitle: row.since === null ? null : message('home.source.look_ahead.missing.detail', { since: row.since }),
        status: 'MISSING',
        severity: severityOf('LOOK_AHEAD', 'MISSING', context.rules),
        consequence: CONSEQUENCES.LOOK_AHEAD_MISSING ?? null,
        causeKey: `look-ahead-missing:${row.projectId}`,
        startedAt: row.since === null ? null : startOfDay(row.since),
        target: { screen: 'PRJ-30', id: row.projectId },
      });
    }
    return rows;
  }

  async lessonsMissing(context: SourceContext): Promise<SourceRow[]> {
    const rows = await this.lessons.missingAtClose(context.tx, context.projectScope, context.now);
    return rows.map(
      (row): SourceRow => ({
        ...base('LESSONS_LEARNED_MISSING'),
        id: row.projectId,
        dueOn: null,
        originalDueOn: null,
        title: message('home.source.lessons.missing.title', { project: row.projectCode }),
        subtitle: message('home.source.lessons.missing.detail', { required: row.required, approved: row.approved }),
        status: 'MISSING',
        severity: severityOf('LESSONS_LEARNED', 'MISSING', context.rules),
        consequence: CONSEQUENCES.LESSONS_LEARNED_MISSING ?? null,
        causeKey: `lessons:${row.projectId}`,
        startedAt: null,
        target: { screen: 'PRJ-31', id: row.projectId },
      }),
    );
  }
}
