import { asObj, vnd } from '../context.ts';
import type { Obj, SeedContext } from '../context.ts';
import TEXTS from '../data/enterprise-capital.json' with { type: 'json' };

/**
 * The capital screens of the enterprise demo beyond the plan of the year: one adjustment of the plan (a revision created, drafted with a transfer between two projects that
 * draw on the same assignment, submitted, approved by the leader and published with its decision, so CAP-07 has a revision to compare with the one it replaces), and the
 * monthly registrations and estimates of disbursement of the projects the plan funds (CAP-12). Both use the commands of the product and skip what exists.
 */

const PLAN_CODE = 'KHV-2026';
const PLAN_YEAR = 2026;
/** How many of the funded projects get a monthly schedule. */
const SCHEDULED_PROJECTS = 8;
/** The estimates and registrations of a project: the share (percent) of what the plan gives it, by month counted from the month of the day the data is made. */
const FORECAST_SHARES: ReadonlyArray<{ monthsFromNow: number; percent: number }> = [
  { monthsFromNow: -1, percent: 10 },
  { monthsFromNow: 0, percent: 15 },
  { monthsFromNow: 1, percent: 25 },
];
const REGISTERED_SHARES: ReadonlyArray<{ monthsFromNow: number; percent: number }> = [
  { monthsFromNow: 0, percent: 14 },
  { monthsFromNow: 1, percent: 22 },
];

const tx = (key: keyof typeof TEXTS): string => TEXTS[key];

async function revisionsOf(ctx: SeedContext): Promise<Obj[]> {
  const plans = await ctx.list<Obj>('projectManager', '/resources/plan_version');
  return plans.filter((plan) => plan.plan_code === PLAN_CODE).sort((a, b) => Number(a.revision) - Number(b.revision));
}

/** The lines of a revision in the scope of the leader (the whole plan). */
async function linesOf(ctx: SeedContext, planId: string): Promise<Obj[]> {
  return ctx.list<Obj>('capApprover', `/capital-plans/${planId}/lines`);
}

/** The transfer: from the first line of an assignment to the second one of the same assignment, so no ceiling moves and the total of the plan is the same. */
function transferOf(lines: Obj[]): Array<Record<string, unknown>> {
  const byAppropriation = new Map<string, Obj[]>();
  for (const line of lines) {
    const key = String(asObj(line.appropriation).id ?? '');
    byAppropriation.set(key, [...(byAppropriation.get(key) ?? []), line]);
  }
  const moved: Array<Record<string, unknown>> = [];
  const shift = BigInt(vnd(10));
  for (const group of byAppropriation.values()) {
    const [from, to] = group.sort((a, b) => String(asObj(a.project).code).localeCompare(String(asObj(b.project).code)));
    if (from === undefined || to === undefined || BigInt(String(from.amount_vnd)) <= shift) continue;
    const body = (line: Obj, amount: bigint): Record<string, unknown> => ({
      project_id: asObj(line.project).id,
      appropriation_id: asObj(line.appropriation).id,
      bucket: line.bucket,
      source_year: line.source_year,
      amount_vnd: amount.toString(),
    });
    moved.push(body(from, BigInt(String(from.amount_vnd)) - shift), body(to, BigInt(String(to.amount_vnd)) + shift));
    if (moved.length >= 4) break;
  }
  return moved;
}

/** The adjustment of the plan of the year: a second revision, published, that moves capital between projects. */
export async function seedEnterprisePlanRevision(ctx: SeedContext): Promise<void> {
  const revisions = await revisionsOf(ctx);
  const base = revisions.find((plan) => Number(plan.revision) === 1);
  if (base === undefined) {
    ctx.warn(`the plan ${PLAN_CODE} does not exist: its adjustment is left out`);
    return;
  }
  let current = revisions.find((plan) => Number(plan.revision) > 1);
  if (current === undefined) {
    if (base.status !== 'PUBLISHED') {
      ctx.warn(`the plan ${PLAN_CODE} is ${String(base.status)}, not published: its adjustment is left out`);
      return;
    }
    const created = await ctx.command('projectManager', `/capital-plans/${String(base.id)}/revisions`, { reason: tx('revision.reason') }, { version: Number(base.version) });
    current = { id: created.resource_id, status: created.status, version: created.resource_version, revision: 2 };
  }
  if (current.status === 'PUBLISHED' || current.status === 'SUPERSEDED') return;
  if (current.status === 'DRAFT') {
    const moved = transferOf(await linesOf(ctx, String(base.id)));
    if (moved.length === 0) throw new Error('no two lines of the plan draw on one assignment: there is nothing to transfer');
    // A draft the earlier run left half way carries its transfer already (the same lines change nothing); the version is read again for the command.
    const latest = (await revisionsOf(ctx)).find((plan) => plan.id === current?.id);
    const drafted = await ctx.command('projectManager', `/capital-plans/${String(current.id)}/allocations`, { lines: moved, note: tx('revision.note') }, { version: Number((latest ?? current).version) });
    current = { ...current, status: drafted.status, version: drafted.resource_version };
    const submitted = await ctx.command('projectManager', `/capital-plans/${String(current.id)}/submit`, {}, { version: Number(current.version) });
    current = { ...current, status: submitted.status, version: submitted.resource_version };
  }
  if (current.status === 'IN_REVIEW') {
    const decided = await ctx.command('capApprover', `/capital-plans/${String(current.id)}/decision`, { decision: 'approve', reason: tx('revision.decisionReason') }, { version: Number(current.version) });
    current = { ...current, status: decided.status, version: decided.resource_version };
  }
  if (current.status === 'APPROVED') {
    const decision = await ctx.letter({ symbol: tx('revision.letter.symbol'), title: tx('revision.letter.title'), sender: tx('revision.letter.sender'), issuedOn: ctx.day(-2), docType: 'QD' });
    await ctx.command('capApprover', `/plans/${String(current.id)}/publish`, { decision_document_id: decision.documentId }, { version: Number(current.version) });
  }
  ctx.record({ module: 'CAP', screen: 'CAP-07', kind: 'capital-plan-revision', id: String(current.id), code: PLAN_CODE, note: 'revision 2 published' });
}

function monthOf(ctx: SeedContext, monthsFromNow: number): number {
  return Number(ctx.today.slice(5, 7)) + monthsFromNow;
}

/** The monthly estimates and registrations of disbursement of the projects the plan funds. */
export async function seedEnterpriseSchedules(ctx: SeedContext): Promise<void> {
  const plan = (await revisionsOf(ctx)).filter((revision) => revision.status === 'PUBLISHED').pop();
  if (plan === undefined) {
    ctx.warn(`the plan ${PLAN_CODE} is not published: the monthly schedules are left out`);
    return;
  }
  const totals = new Map<string, { code: string; vnd: bigint }>();
  for (const line of await linesOf(ctx, String(plan.id))) {
    const project = asObj(line.project);
    const key = String(project.id);
    totals.set(key, { code: String(project.code), vnd: (totals.get(key)?.vnd ?? 0n) + BigInt(String(line.amount_vnd)) });
  }
  const projects = [...totals.entries()].sort((a, b) => a[1].code.localeCompare(b[1].code)).slice(0, SCHEDULED_PROJECTS);
  const have = new Set((await ctx.list<Obj>('projectManager', '/disbursement-schedules', { plan_year: PLAN_YEAR, granularity: 'MONTH' })).map((row) => `${String(row.project_id)}|${String(row.kind)}|${String(row.month)}`));
  for (const [projectId, project] of projects) {
    await ctx.step('CAP', `monthly schedule ${project.code}`, async () => {
      const register = async (kind: 'FORECAST' | 'REGISTERED', shares: ReadonlyArray<{ monthsFromNow: number; percent: number }>): Promise<void> => {
        for (const share of shares) {
          const month = monthOf(ctx, share.monthsFromNow);
          if (month < 1 || month > 12 || have.has(`${projectId}|${kind}|${month}`)) continue;
          // The schedule keeps the classes of the public pack (its store has no others): the screen sums the classes, so the month reads the same.
          await ctx.attempt('projectManager', 'POST', '/disbursement-schedules', {
            project_id: projectId,
            plan_year: PLAN_YEAR,
            granularity: 'MONTH',
            month,
            kind,
            bucket: 'CURRENT_YEAR',
            budget_level: 'CENTRAL',
            amount_vnd: ((project.vnd * BigInt(share.percent)) / 100n).toString(),
            ...(kind === 'FORECAST' ? { assumption: tx('schedule.assumption') } : {}),
          });
        }
      };
      await register('FORECAST', FORECAST_SHARES);
      await register('REGISTERED', REGISTERED_SHARES);
    });
  }
  ctx.record({ module: 'CAP', screen: 'CAP-12', kind: 'disbursement-schedule', id: String(plan.id), code: PLAN_CODE, note: `${projects.length} projects` });
}
