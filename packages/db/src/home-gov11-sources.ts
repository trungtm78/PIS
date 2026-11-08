import { message } from '@machvon/kernel';
import { DisMilestoneStore } from './dis-milestone-store.ts';
import { CONSEQUENCES, severityOf } from './home-work-rules.ts';
import { base, startOfDay } from './home-work-sources.ts';
import type { SourceContext, SourceRow } from './home-work-sources.ts';
import { PayClockStore } from './pay-clock-store.ts';

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
}
