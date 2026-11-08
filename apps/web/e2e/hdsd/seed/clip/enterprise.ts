import { vnd, vndMillions } from '../context.ts';
import type { Obj, SeedContext } from '../context.ts';
import { asObj } from '../context.ts';
import { masterRecord, publishArea } from '../base.ts';
import { projectByCode, registerPortfolioProject } from '../capital-projects.ts';
import type { ProjectSpec } from '../capital-projects.ts';
import { clipPlan } from './plan.ts';

/**
 * The groups of the enterprise dataset (clip B). The edition is served by the stack through MACHVON_EDITION; the groups use only commands of the product:
 * areas and projects of the group (investment and equipment purchase), the year plan of every project split into equity and loan (prepared by the
 * project manager, accepted by the leader), the directives of the steering meetings, and the file of the accounting system with its reconciliation.
 */

interface EnterpriseProject extends ProjectSpec {
  kind: 'INVESTMENT' | 'EQUIPMENT';
  planBillions: number;
  equityBillions: number;
  loanBillions: number;
}

interface EnterprisePlan {
  planYear: number;
  areas: Array<{ key: string; name: string }>;
  areaDecision: { symbol: string; title: string; sender: string };
  decisionType: { name: string; abbreviation: string; legalBasis: string };
  projects: EnterpriseProject[];
  funding: { note: string; explanation: string };
  meetings: Array<{ ago: number; type: string; title: string; directives: Array<{ text: string; dueIn: number }> }>;
  ebs: { note: string; rows: Array<{ project: string; period: string; disbursedMillions: number; committedMillions: number }> };
}

function enterprisePlan(ctx: SeedContext): EnterprisePlan | undefined {
  const plan = clipPlan() as unknown as (EnterprisePlan & { dataset: string }) | undefined;
  if (plan === undefined || plan.dataset !== 'enterprise') {
    ctx.warn('no enterprise clip plan (CLIP_PLAN_FILE): the group has nothing to do');
    return undefined;
  }
  return plan;
}

/** The decision type of the register (a type that exists answers with a conflict: that is the skip). */
async function ensureDecisionType(ctx: SeedContext, plan: EnterprisePlan): Promise<void> {
  const reply = await ctx.call('projectManager', 'POST', '/document-types', {
    code: 'QD',
    name: plan.decisionType.name,
    abbreviation: plan.decisionType.abbreviation,
    symbol_kind: 'DECISION',
    symbol_pattern: '{number}/{type}-{agency}',
    register_code: 'SO-QD',
    legal_basis: plan.decisionType.legalBasis,
    effective_from: '2026-01-01',
  });
  if (!reply.ok && reply.json.code !== 'DOC_TYPE_RANGE_OVERLAP') ctx.expectOk(reply, 'define the decision type');
}

export async function seedClipEnterpriseProjects(ctx: SeedContext): Promise<void> {
  const plan = enterprisePlan(ctx);
  if (plan === undefined) return;
  await ctx.step('DOC', 'decision type', () => ensureDecisionType(ctx, plan));
  const decision = await ctx.letter({ symbol: plan.areaDecision.symbol, title: plan.areaDecision.title, sender: plan.areaDecision.sender, issuedOn: ctx.day(-90) });
  const province = await ctx.step('MDM', 'find the root area', async () => {
    const found = (await masterRecord(ctx, 'AREA', 'CAO-BANG')) ?? (await ctx.list('projectManager', '/master-records', { master_type: 'AREA' }))[0];
    if (found === undefined) throw new Error('no area master record exists to hang the areas of the group on');
    return found;
  });
  for (const area of plan.areas) await ctx.step('MDM', `area ${area.key}`, () => publishArea(ctx, area, decision.documentId, province));
  for (const project of plan.projects) {
    const id = await ctx.step('PRJ', `register ${project.code}`, () => registerPortfolioProject(ctx, project));
    ctx.record({ module: 'PRJ', screen: 'PRJ-01', kind: 'project', id, code: project.code, note: project.kind });
  }
}

// ---- funding: equity and loan ------------------------------------------------------------------------------------------------------------

async function planYearFigure(ctx: SeedContext, plan: EnterprisePlan, project: EnterpriseProject, projectId: string, classCode: 'EQUITY' | 'LOAN', billions: number, known: Map<string, Obj>): Promise<void> {
  const existing = known.get(`${projectId}:${classCode}`);
  if (existing !== undefined && existing.status !== 'DRAFT' && existing.status !== 'SUBMITTED') return;
  // A batch an earlier run left half way is taken up where it stopped: submitted, then accepted.
  if (existing !== undefined) {
    let version = Number(existing.version);
    if (existing.status === 'DRAFT') version = (await ctx.command('projectManager', `/funding-figures/batches/${String(existing.id)}/submission`, {}, { version })).resource_version;
    await ctx.command('capApprover', `/funding-figures/batches/${String(existing.id)}/acceptance`, {}, { version });
    return;
  }
  const made = await ctx.command('projectManager', '/funding-figures/batches', {
    project_id: projectId,
    class_code: classCode,
    tier_code: 'ALL',
    measure: 'EXECUTED',
    figure_kind: 'PLAN_YEAR',
    period_grain: 'YEAR',
    plan_year: plan.planYear,
    as_of_date: ctx.day(-45),
    entries: [{ period_ordinal: 0, amount_vnd: vnd(billions) }],
    explanation: plan.funding.explanation,
  });
  const sent = await ctx.command('projectManager', `/funding-figures/batches/${made.resource_id}/submission`, {}, { version: made });
  await ctx.command('capApprover', `/funding-figures/batches/${made.resource_id}/acceptance`, {}, { version: sent });
  ctx.record({ module: 'FND', kind: 'funding-figure', id: made.resource_id, code: `${project.code}:${classCode}`, note: `${billions} billion` });
}

export async function seedClipEnterpriseFunding(ctx: SeedContext): Promise<void> {
  const plan = enterprisePlan(ctx);
  if (plan === undefined) return;
  const batches = await ctx.list<Obj>('projectManager', '/funding-figures/batches', { plan_year: plan.planYear });
  // Only the year plan of the class counts (another kind of figure of the same project is not the plan).
  const known = new Map(batches.filter((row) => row.figure_kind === 'PLAN_YEAR' && row.status !== 'WITHDRAWN' && row.status !== 'RETURNED').map((row) => [`${String(row.project_id)}:${String(row.class_code)}`, row] as const));
  for (const project of plan.projects) {
    const row = await projectByCode(ctx, project.code);
    if (row === undefined) {
      ctx.warn(`the project ${project.code} does not exist: its funding is left out`);
      continue;
    }
    await ctx.step('FND', `plan ${project.code} equity ${project.equityBillions} loan ${project.loanBillions}`, async () => {
      await planYearFigure(ctx, plan, project, String(row.id), 'EQUITY', project.equityBillions, known);
      await planYearFigure(ctx, plan, project, String(row.id), 'LOAN', project.loanBillions, known);
    });
  }
}

// ---- directives of the steering meetings --------------------------------------------------------------------------------------------------

export async function seedClipEnterpriseDirectives(ctx: SeedContext): Promise<void> {
  const plan = enterprisePlan(ctx);
  if (plan === undefined) return;
  const existing = new Set((await ctx.list<Obj>('projectManager', '/directives')).map((row) => String(row.text)));
  let cursor = 0;
  for (const meeting of plan.meetings) {
    if (meeting.directives.every((directive) => existing.has(directive.text))) continue;
    const created = await ctx.command('projectManager', '/steering-meetings', { meeting_date: ctx.day(-meeting.ago), meeting_type: meeting.type, title: meeting.title, unit_id: ctx.unitId('CB-SKHDT') });
    for (const directive of meeting.directives) {
      const project = plan.projects[cursor % plan.projects.length];
      cursor += 1;
      const row = project === undefined ? undefined : await projectByCode(ctx, project.code);
      if (row === undefined) continue;
      await ctx.command('projectManager', `/steering-meetings/${created.resource_id}/directives`, {
        scope_kind: 'PROJECT',
        project_id: String(row.id),
        text: directive.text,
        assignee_unit_id: ctx.unitId('CB-SKHDT-QLDA'),
        due_on: ctx.day(directive.dueIn),
      });
    }
    ctx.record({ module: 'DIR', kind: 'steering-meeting', id: created.resource_id, code: meeting.title, note: `${meeting.directives.length} directives` });
  }
}

// ---- the accounting system file and its reconciliation ----------------------------------------------------------------------------------

export function ebsCsv(plan: EnterprisePlan, extractDate: string): string {
  const lines = ['project_code,period,extract_date,disbursed_vnd,committed_vnd'];
  for (const row of plan.ebs.rows) lines.push([row.project, row.period, extractDate, vndMillions(row.disbursedMillions), vndMillions(row.committedMillions)].join(','));
  return `${lines.join('\n')}\n`;
}

export async function seedClipEnterpriseEbs(ctx: SeedContext): Promise<void> {
  const plan = enterprisePlan(ctx);
  if (plan === undefined) return;
  const person = 'projectManager';
  const buffer = Buffer.from(ebsCsv(plan, ctx.day(-3)), 'utf8');
  const file = await ctx.upload<{ file_object_key: string; file_sha256: string }>(person, '/ebs/imports/files', { filename: 'ebs-extract.csv', mime: 'text/csv', buffer });
  if (!file.ok) {
    ctx.warn(`the accounting file was refused (HTTP ${file.status}): is the stack serving the enterprise edition?`);
    return;
  }
  const body = { file_object_key: file.json.file_object_key, file_sha256: file.json.file_sha256 };
  const preview = await ctx.must<Obj>(person, 'POST', '/ebs/imports/preview', body);
  ctx.log(`  [ebs] preview counts ${JSON.stringify(asObj(preview.counts))}`);
  const applied = await ctx.attempt<Obj>(person, 'POST', '/ebs/imports', body);
  if (applied.ok) ctx.log(`  [ebs] import counts ${JSON.stringify(asObj(applied.json.counts))}`);
  const reconciled = await ctx.attempt<Obj>(person, 'POST', '/ebs/reconciliations', {});
  if (reconciled.ok) ctx.log(`  [ebs] reconciliation examined ${String(reconciled.json.examined)} differences ${String(reconciled.json.differences)}`);
  ctx.record({ module: 'EBS', kind: 'ebs-import', id: String(applied.json.resource_id ?? ''), code: 'EBS', note: plan.ebs.note });
}
