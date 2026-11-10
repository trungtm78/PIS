import type { Obj, SeedContext } from '../context.ts';
import { vnd } from '../context.ts';
import { projectByCode } from '../capital-projects.ts';
import { clipPlan } from './plan.ts';
import { chosenPeriod, ensurePeriods, freezeMonth, monthOf } from './enterprise-snapshot.ts';
import type { ActualPace } from './enterprise-snapshot.ts';

/**
 * Group `clip-ent-snapshot-prior`: the enterprise period snapshot (ENT-3a) of the SAME month one year before, so that the leader panel (HOME-09) has a figure of the same period last year to put beside the current one (the
 * column "cung ky nam truoc", the delta in points, the trend arrow). Made with the commands of the product only, as the group `clip-ent-snapshot` does for the current month:
 *
 *   1. the year plan of the previous year of every project (equity and loan) is proposed by the officer and accepted by the leader (a smaller plan: the company grew);
 *   2. the months of the previous year of the enterprise calendar are generated, the actuals up to the same month are handed in and accepted, the month is soft closed and locked;
 *   3. the snapshot is built by the officer and frozen by the owner.
 *
 * The current snapshot is not touched: the leader store reads the latest frozen snapshot as the current one, and a snapshot one year older is only ever the "same period last year". Idempotent.
 */

const PREPARER = 'projectManager';
const APPROVER = 'capApprover';
/** The plan of the previous year as a share of the plan of the year (percent), and the pace of its actuals: a little slower than this year, so the delta of the board reads in points. */
const PLAN_PERCENT = 85;
const PACE: ActualPace = { salt: ':prior', percent: 90 };

interface FundedProject {
  code: string;
  equityBillions: number;
  loanBillions: number;
}

const portion = (billions: number): number => Math.max(1, Math.round((billions * PLAN_PERCENT) / 100));

/** The year plan of the previous year of every funded project, in the two classes; what exists is left alone, a batch left half way is taken up. */
async function planOfPriorYear(ctx: SeedContext, projects: readonly FundedProject[], priorYear: number, note: string): Promise<void> {
  const batches = await ctx.list<Obj>(PREPARER, '/funding-figures/batches', { plan_year: priorYear });
  const known = new Map(batches.filter((row) => row.figure_kind === 'PLAN_YEAR' && row.status !== 'WITHDRAWN' && row.status !== 'RETURNED').map((row) => [`${String(row.project_id)}:${String(row.class_code)}`, row] as const));
  for (const project of projects) {
    const row = await projectByCode(ctx, project.code);
    if (row === undefined) {
      ctx.warn(`the project ${project.code} does not exist: its plan of ${priorYear} is left out`);
      continue;
    }
    for (const [classCode, billions] of [['EQUITY', project.equityBillions], ['LOAN', project.loanBillions]] as const) {
      const existing = known.get(`${String(row.id)}:${classCode}`);
      if (existing !== undefined && existing.status !== 'DRAFT' && existing.status !== 'SUBMITTED') continue;
      let batchId = existing === undefined ? undefined : String(existing.id);
      let version = existing === undefined ? 0 : Number(existing.version);
      let status = existing === undefined ? 'NEW' : String(existing.status);
      if (batchId === undefined) {
        const made = await ctx.attempt<Obj>(PREPARER, 'POST', '/funding-figures/batches', {
          project_id: String(row.id),
          class_code: classCode,
          tier_code: 'ALL',
          measure: 'EXECUTED',
          figure_kind: 'PLAN_YEAR',
          period_grain: 'YEAR',
          plan_year: priorYear,
          as_of_date: `${priorYear}-01-15`,
          entries: [{ period_ordinal: 0, amount_vnd: vnd(portion(billions)) }],
          explanation: note,
        });
        if (!made.ok) {
          ctx.warn(`the plan of ${priorYear} of ${project.code} (${classCode}) was refused: ${JSON.stringify(made.json.code ?? made.status)}`);
          continue;
        }
        batchId = String(made.json.resource_id);
        version = Number(made.json.resource_version);
        status = 'DRAFT';
      }
      if (status === 'DRAFT') {
        const sent = await ctx.attempt<Obj>(PREPARER, 'POST', `/funding-figures/batches/${batchId}/submission`, {}, { version });
        if (!sent.ok) continue;
        version = Number(sent.json.resource_version);
      }
      await ctx.attempt(APPROVER, 'POST', `/funding-figures/batches/${batchId}/acceptance`, {}, { version });
    }
  }
}

export async function seedClipEnterpriseSnapshotPrior(ctx: SeedContext): Promise<void> {
  const plan = clipPlan() as unknown as { dataset?: string; planYear: number; projects: FundedProject[]; funding: { explanation: string } } | undefined;
  if (plan === undefined || plan.dataset !== 'enterprise') {
    ctx.warn('no enterprise clip plan (CLIP_PLAN_FILE): the group has nothing to do');
    return;
  }
  const planYear = Number(plan.planYear);
  const priorYear = planYear - 1;
  const current = chosenPeriod(await ctx.step('DIS', `months of the enterprise calendar ${planYear}`, () => ensurePeriods(ctx, planYear)), new Date());
  if (current === undefined) {
    ctx.warn(`no month of the enterprise calendar ${planYear} is past its deadline: no snapshot of last year to match`);
    return;
  }
  const prior = (await ctx.step('DIS', `months of the enterprise calendar ${priorYear}`, () => ensurePeriods(ctx, priorYear))).find((period) => monthOf(period) === monthOf(current));
  if (prior === undefined) {
    ctx.warn(`the enterprise calendar ${priorYear} has no month ${monthOf(current)}: no snapshot of last year`);
    return;
  }
  await ctx.step('FND', `plan of ${priorYear}`, () => planOfPriorYear(ctx, plan.projects, priorYear, plan.funding.explanation));
  const frozen = await ctx.step('DIS', `snapshot of ${String(prior.code)}`, () => freezeMonth(ctx, prior, priorYear, PACE));
  if (!frozen) ctx.warn(`the snapshot of ${String(prior.code)} is not frozen: the leader panel has no figure of the same period last year`);
}
