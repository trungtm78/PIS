import { vndMillions } from '../context.ts';
import type { CommandReply, Obj, SeedContext } from '../context.ts';
import { asObj } from '../context.ts';
import { linesOf, packageOf, projectOf } from '../procurement-finance/bid.ts';
import { CHECKER, LEADER, MAKER, defineDocumentTypes, registerContractors } from '../procurement-finance/shared.ts';
import { clipPlan } from './plan.ts';
import type { ClipPlan } from './plan.ts';

/**
 * Group `clip-public-procurement`: the procurement plans of the first funded projects of the clip province, approved by the leader on a decision, and the
 * package workflow ("Cay tien do") of every package moved to the step the plan names, so the process tree shows a spread of states: running at many steps,
 * one on hold, one given back, some not started. Everything goes through the commands of the product; the maker of an item is never the one who advances
 * a step that needs two people (the owner advances those).
 *
 * Limit (docs/clip-data.md): the product reads the clock of the server, so no step is late; the tree shows ON_TRACK, ON_HOLD and RETURNED substates.
 */

interface PlanBlock {
  legalBasis: string;
  note: string;
  decisionLetter: { symbol: string; title: string; sender: string };
  plans: Array<{
    project: string;
    title: string;
    packages: Array<{ code: string; title: string; millions: number; method: string; category: string; period: string; days: number; target: string }>;
  }>;
}

const CONTRACT_TYPE_OF: Record<string, string> = { CONSTRUCTION: 'FIXED_UNIT_PRICE', EQUIPMENT: 'LUMP_SUM', CONSULTING: 'TIME_BASED', OTHER: 'LUMP_SUM' };

function blockOf(plan: ClipPlan | undefined): PlanBlock | undefined {
  return plan?.procurement as PlanBlock | undefined;
}

async function approvedPlanOf(ctx: SeedContext, block: PlanBlock, spec: PlanBlock['plans'][number], index: number): Promise<void> {
  const project = await projectOf(ctx, spec.project);
  if (project === undefined) {
    ctx.warn(`the project ${spec.project} does not exist: its plan is left out`);
    return;
  }
  const projectId = String(project.id);
  const existing = (await ctx.list<Obj>(MAKER, '/procurement-plans', { project_id: projectId })).find((row) => row.status !== 'CANCELLED');
  if (existing !== undefined) {
    ctx.record({ module: 'BID', screen: 'BID-15', kind: 'procurement-plan', id: String(existing.id), code: spec.project, note: `existing ${String(existing.status)}` });
    return;
  }
  const lines = await linesOf(ctx, projectId);
  const line = lines[0];
  if (line === undefined) {
    ctx.warn(`the project ${spec.project} has no line of capital: its plan is left out`);
    return;
  }
  const made = await ctx.command(MAKER, '/procurement-plans', {
    project_id: projectId,
    title: spec.title,
    legal_basis: block.legalBasis,
    packages: spec.packages.map((item) => ({
      code: item.code,
      title: item.title,
      budget_vnd: vndMillions(item.millions),
      method: item.method,
      contract_type: CONTRACT_TYPE_OF[item.category] ?? 'LUMP_SUM',
      bidding_form: 'ONLINE',
      allocation_line_id: String(line.id),
      planned_start_period: item.period,
      duration_days: item.days,
    })),
  });
  const sent = await ctx.command(MAKER, `/procurement-plans/${made.resource_id}/submit`, {}, { version: made });
  const letter = await ctx.letter({ symbol: block.decisionLetter.symbol.replace('{n}', String(300 + index)), title: block.decisionLetter.title, sender: block.decisionLetter.sender, issuedOn: ctx.day(-30), person: MAKER });
  await ctx.command(LEADER, `/procurement-plans/${made.resource_id}/decision`, { decision: 'APPROVE', decision_document_id: letter.documentId, comment: block.note }, { version: sent });
  ctx.record({ module: 'BID', screen: 'BID-15', kind: 'procurement-plan', id: made.resource_id, code: spec.project, note: 'APPROVED' });
}

// ---- the package workflow ----------------------------------------------------------------------------------------------------------------

interface WorkflowView {
  id: string;
  version: number;
  step: string;
  status: string;
  items: Array<{ id: string; step: string; status: string }>;
}

async function viewOf(ctx: SeedContext, packageId: string): Promise<WorkflowView> {
  const answer = await ctx.get<Obj>(MAKER, `/procurement-packages/${packageId}/workflow`);
  const workflow = asObj(answer.workflow);
  const items = (Array.isArray(workflow.checklist) ? (workflow.checklist as Obj[]) : []).map((item) => ({ id: String(item.id), step: String(item.step_code ?? item.step ?? ''), status: String(item.status) }));
  return { id: String(workflow.id), version: Number(workflow.version), step: String(asObj(workflow.step).code), status: String(workflow.status), items };
}

/** Completes the open items of the current step with the evidence they ask for, trying the kinds in turn (the step says which one it needs). */
async function completeStep(ctx: SeedContext, view: WorkflowView, documentId: string, note: string): Promise<void> {
  for (const item of view.items.filter((candidate) => candidate.step === view.step && candidate.status !== 'DONE')) {
    const kinds: Array<Array<Record<string, string>>> = [
      [{ kind: 'DOCUMENT', document_id: documentId }],
      [{ kind: 'DECISION_DOCUMENT', document_id: documentId }],
      [{ kind: 'ATTESTATION', note }],
      [],
    ];
    let done = false;
    for (const evidence of kinds) {
      const reply = await ctx.call(MAKER, 'POST', `/package-checklist-items/${item.id}/completion`, { evidence, note });
      if (reply.ok) {
        done = true;
        break;
      }
    }
    if (!done) ctx.warn(`the item ${item.id} of the step ${view.step} could not be completed`);
  }
}

/** Moves the workflow of a package to the step it should stand at (the maker completes, the owner advances when two people are needed). */
async function driveTo(ctx: SeedContext, packageId: string, code: string, target: string, documentId: string, note: string): Promise<void> {
  const [mode, step] = target.includes(':') ? (target.split(':') as [string, string]) : ['AT', target];
  if (target === 'NOT_STARTED') return;
  let view: WorkflowView;
  const started = await ctx.attempt(MAKER, 'POST', `/procurement-packages/${packageId}/workflow`, { owner_id: ctx.person(MAKER).membershipId });
  if (!started.ok && started.status !== 409) return;
  view = await viewOf(ctx, packageId);
  for (let guard = 0; guard < 24 && view.step !== step && view.status === 'IN_PROGRESS'; guard += 1) {
    await completeStep(ctx, view, documentId, note);
    view = await viewOf(ctx, packageId);
    let moved = await ctx.call(MAKER, 'POST', `/package-workflows/${view.id}/advance`, { note }, { version: view.version });
    if (!moved.ok) moved = await ctx.call(CHECKER, 'POST', `/package-workflows/${view.id}/advance`, { note }, { version: view.version });
    if (!moved.ok) {
      ctx.warn(`${code}: cannot leave the step ${view.step}: HTTP ${moved.status} ${moved.text.slice(0, 160)}`);
      break;
    }
    view = await viewOf(ctx, packageId);
  }
  if (mode === 'HOLD') await ctx.attempt(MAKER, 'POST', `/package-workflows/${view.id}/hold`, { reason: note }, { version: view.version });
  if (mode === 'RETURN') {
    const earlier = (await viewOf(ctx, packageId)).items.map((item) => item.step).find((candidate) => candidate !== view.step);
    if (earlier !== undefined) await ctx.attempt(MAKER, 'POST', `/package-workflows/${view.id}/return`, { to_step: earlier, reason: note }, { version: view.version });
  }
  ctx.record({ module: 'BID', screen: 'BID-27', kind: 'package-workflow', id: view.id, code, note: `${mode} ${step}` });
}

export async function seedClipProcurement(ctx: SeedContext): Promise<void> {
  const block = blockOf(clipPlan());
  if (block === undefined) {
    ctx.warn('no clip plan (CLIP_PLAN_FILE): the procurement group has nothing to do');
    return;
  }
  await ctx.step('DOC', 'document types of the papers', () => defineDocumentTypes(ctx));
  await ctx.step('BID', 'contractors', () => registerContractors(ctx));
  for (const [index, spec] of block.plans.entries()) await ctx.step('BID', `procurement plan of ${spec.project}`, () => approvedPlanOf(ctx, block, spec, index));
  const evidence = await ctx.letter({ symbol: block.decisionLetter.symbol.replace('{n}', '999'), title: block.decisionLetter.title, sender: block.decisionLetter.sender, issuedOn: ctx.day(-20), person: MAKER });
  for (const spec of block.plans) {
    for (const item of spec.packages) {
      const pack = await packageOf(ctx, item.code);
      if (pack === undefined) {
        ctx.warn(`the package ${item.code} does not exist`);
        continue;
      }
      await ctx.step('BID', `workflow of ${item.code} to ${item.target}`, () => driveTo(ctx, String(pack.id), item.code, item.target, evidence.documentId, block.note));
    }
  }
}

export type { CommandReply };
