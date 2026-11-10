import { asObj, vnd } from '../context.ts';
import type { Obj, SeedContext } from '../context.ts';
import { projectByCode } from '../capital-projects.ts';
import { clipPlan } from './plan.ts';
import TEXTS from '../data/enterprise-prior.json' with { type: 'json' };

/**
 * Group `clip-ent-capital-prior`: the capital plan of the PREVIOUS year (KHV-2025) of the enterprise, through the commands of the product: the two assignments of capital (equity and loan) of the board, the lines of every
 * project, the plan submitted, approved by the leader and published with its decision. The disbursement plan in force of a year comes from the capital plan (the funding model takes no plan of disbursement of its own), so
 * the frozen snapshot of the same month last year (group `clip-ent-snapshot-prior`) has a plan to measure the disbursement of last year against. A plan of 85 percent of this year: the company grew.
 */

const PLAN_CODE = 'KHV-2025';
const PERCENT = 85;
/** The room an assignment keeps above the lines drawn on it (billions). */
const MARGIN = 12;
const PREPARER = 'projectManager';
const LEADER = 'capApprover';

type Key = 'VCSH' | 'VAY';
const text = (key: keyof typeof TEXTS): string => TEXTS[key];
const fill = (template: string, ...args: readonly string[]): string => template.replace(/\{(\d+)\}/gu, (_m, index: string) => args[Number(index)] ?? '');
const scaled = (billions: number): number => Math.max(1, Math.round((billions * PERCENT) / 100));

interface CapitalBlock {
  appropriations: Array<{ key: Key; fund: string; origin: string; level: string; decisionKind?: string; authority: string; bucket: string }>;
  lines: Array<{ project: string; appropriation: Key; billions: number; bucket: string }>;
}

async function planOf(ctx: SeedContext): Promise<Obj | undefined> {
  return ctx.find(PREPARER, '/resources/plan_version', (row) => row.plan_code === PLAN_CODE);
}

async function appropriationsOf(ctx: SeedContext, block: CapitalBlock, totals: Map<Key, number>): Promise<Map<Key, string>> {
  const funds = new Map((await ctx.list(PREPARER, '/master-records', { master_type: 'FUND_SOURCE' })).map((row) => [String(row.business_key), String(row.version_id)]));
  const known = await ctx.list<Obj>(PREPARER, '/appropriations');
  const ids = new Map<Key, string>();
  for (const spec of block.appropriations) {
    const symbol = text(`appropriation.${spec.key}.symbol`);
    let row = known.find((one) => asObj(one.fund_source).business_key === spec.fund && Number(one.plan_year) === 2025 && Number(one.source_year) === 2025);
    if (row === undefined) {
      const letter = await ctx.letter({ symbol, title: text(`appropriation.${spec.key}.title`), issuedOn: text(`appropriation.${spec.key}.issuedOn`), sender: spec.authority, docType: 'QD' });
      const created = await ctx.command(PREPARER, '/appropriations', {
        fund_source_version_id: funds.get(spec.fund),
        plan_year: 2025,
        origin: spec.origin,
        budget_level: spec.level,
        ...(spec.decisionKind === undefined ? {} : { decision_kind: spec.decisionKind }),
        amount_vnd: vnd((totals.get(spec.key) ?? 0) + MARGIN),
        decision_document_id: letter.documentId,
        issuing_authority: spec.authority,
        source_year: 2025,
      });
      row = { id: created.resource_id, status: created.status, version: created.resource_version };
    }
    if (row.status === 'DRAFT') await ctx.command(LEADER, `/appropriations/${String(row.id)}/decision`, { decision: 'approve', reason: fill(text('appropriation.reason'), symbol, spec.authority) }, { version: Number(row.version) });
    ids.set(spec.key, String(row.id));
  }
  return ids;
}

export async function seedClipEnterpriseCapitalPrior(ctx: SeedContext): Promise<void> {
  const plan = clipPlan() as unknown as { dataset?: string; capital?: CapitalBlock } | undefined;
  if (plan === undefined || plan.dataset !== 'enterprise' || plan.capital === undefined) {
    ctx.warn('no enterprise clip plan (CLIP_PLAN_FILE): the group has nothing to do');
    return;
  }
  const block = plan.capital;
  let current = await planOf(ctx);
  if (current?.status === 'PUBLISHED') return;
  const lines = block.lines.map((line) => ({ ...line, billions: scaled(line.billions) }));
  const totals = new Map<Key, number>();
  for (const line of lines) totals.set(line.appropriation, (totals.get(line.appropriation) ?? 0) + line.billions);
  const appropriations = await ctx.step('CAP', 'assignments of capital of 2025', () => appropriationsOf(ctx, block, totals));
  if (current === undefined) {
    await ctx.command(PREPARER, '/capital-plans', { plan_code: PLAN_CODE, plan_kind: 'ANNUAL', plan_year: 2025, period_from_year: 2025, period_to_year: 2025, scope_unit_id: ctx.unitId('CB-SKHDT') });
    current = await planOf(ctx);
  }
  if (current === undefined) throw new Error(`the plan ${PLAN_CODE} cannot be found after it was created`);
  if (current.status === 'DRAFT' && Number(asObj(current.totals).line_count ?? 0) === 0) {
    const projects = new Map<string, string>();
    for (const line of lines) {
      const row = await projectByCode(ctx, line.project);
      if (row !== undefined) projects.set(line.project, String(row.id));
    }
    const reply = await ctx.command(
      PREPARER,
      `/capital-plans/${String(current.id)}/allocations`,
      {
        lines: lines.map((line) => ({ project_id: projects.get(line.project), appropriation_id: appropriations.get(line.appropriation), bucket: line.bucket, source_year: 2025, amount_vnd: vnd(line.billions) })),
        note: text('plan.note'),
      },
      { version: Number(current.version) },
    );
    current = { ...current, version: reply.resource_version };
  }
  if (current.status === 'DRAFT') {
    const submitted = await ctx.command(PREPARER, `/capital-plans/${String(current.id)}/submit`, {}, { version: Number(current.version) });
    current = { ...current, status: submitted.status, version: submitted.resource_version };
  }
  if (current.status === 'IN_REVIEW') {
    const decided = await ctx.command(LEADER, `/capital-plans/${String(current.id)}/decision`, { decision: 'approve', reason: text('plan.decisionReason') }, { version: Number(current.version) });
    current = { ...current, status: decided.status, version: decided.resource_version };
  }
  if (current.status === 'APPROVED') {
    const decision = await ctx.letter({ symbol: text('plan.decision.symbol'), title: text('plan.decision.title'), issuedOn: text('plan.decision.issuedOn'), sender: text('plan.decision.sender'), docType: 'QD' });
    await ctx.command(LEADER, `/plans/${String(current.id)}/publish`, { decision_document_id: decision.documentId }, { version: Number(current.version) });
  }
  ctx.record({ module: 'CAP', screen: 'CAP-03', kind: 'capital-plan', id: String(current.id), code: PLAN_CODE, note: 'published' });
}
