import { shiftDate, vnd } from './context.ts';
import type { Obj , SeedContext} from './context.ts';
import type { PortfolioProject } from './capital-projects.ts';
import { asVersion } from './context.ts';
import TEXTS from './data/capital-prj.json' with { type: 'json' };
import { textsOf } from '../../support/texts.ts';

const tx = textsOf(TEXTS);

/**
 * The working records around the projects of the portfolio (PRJ): who answers for each project, its work breakdown, milestones and risks, the task
 * force that urges disbursement, the explanations the leader asked for, and the changes proposed to a project. All of it through the commands of PRJ,
 * as the project manager (who proposes) and the leader (who decides).
 */

const RISK_CATEGORIES = [
  { key: 'GPMB', label: tx('label.001') },
  { key: 'TIEN-DO', label: tx('label.002') },
  { key: 'KY-THUAT', label: tx('label.003') },
  { key: 'VON', label: tx('label.004') },
  { key: 'PHAP-LY', label: tx('label.005') },
];

/** The groups of risk the register uses: proposed by the project manager, approved and published by the leader, like any catalogue of the tenant. */
async function riskCategories(ctx: SeedContext): Promise<Map<string, string>> {
  const decision = await ctx.letter({ symbol: tx('symbol.006'), title: tx('title.007'), issuedOn: '2026-10-22' });
  for (const category of RISK_CATEGORIES) {
    let record = await ctx.find('projectManager', '/master-records', (row) => row.business_key === category.key, { master_type: 'RISK_CATEGORY' });
    if (record === undefined) {
      await ctx.command('projectManager', '/master-records', { namespace: 'TENANT', master_type: 'RISK_CATEGORY', business_key: category.key, label: category.label, attributes: {}, valid_from: '2026-01-01', reason: tx('reason.008') });
      record = await ctx.find('projectManager', '/master-records', (row) => row.business_key === category.key, { master_type: 'RISK_CATEGORY' });
    }
    if (record === undefined) throw new Error(`the risk group ${category.key} cannot be found after it was proposed`);
    const changeId = String(record.open_change_request_id);
    if (record.status === 'DRAFT') {
      const change = await ctx.get('projectManager', `/master-change-requests/${changeId}`);
      await ctx.command('projectManager', `/master-change-requests/${changeId}/submit`, {}, { version: asVersion(change.version) });
    }
    if (record.status === 'DRAFT' || record.status === 'IN_REVIEW') {
      const change = await ctx.get('capApprover', `/master-change-requests/${changeId}`);
      await ctx.command('capApprover', `/master-change-requests/${changeId}/decision`, { decision: 'approve', reason: tx('reason.009') }, { version: asVersion(change.version) });
      record = await ctx.find('projectManager', '/master-records', (row) => row.business_key === category.key, { master_type: 'RISK_CATEGORY' });
    }
    if (record?.status === 'APPROVED') await ctx.command('capApprover', `/master-records/${String(record.id)}/publish`, { decision_document_id: decision.documentId }, { version: Number(record.version) });
  }
  const published = await ctx.list('projectManager', '/master-records', { master_type: 'RISK_CATEGORY' });
  return new Map(published.map((row) => [String(row.business_key), String(row.version_id)]));
}

/** The person in charge of a project answers for it before the leader (PRJ-17). */
async function assignLeader(ctx: SeedContext, project: PortfolioProject): Promise<void> {
  if (project.leader === undefined) return;
  const existing = await ctx.list('projectManager', '/resources/project_accountability', { project_id: project.id });
  if (existing.length > 0) return;
  const decision = await ctx.letter({ symbol: tx('symbol.010', project.code.replace(/\D/gu, '')), title: tx('title.011', project.name), issuedOn: ctx.day(-80), sender: tx('sender.012') });
  await ctx.command('projectManager', `/projects/${project.id}/accountability-assignments`, {
    leader_membership_id: ctx.person(project.leader).membershipId,
    accountability_role: 'LEADER_IN_CHARGE',
    valid_from: ctx.day(-80),
    assignment_document_id: decision.documentId,
  });
  if (project.leader !== 'projectManager') {
    await ctx.attempt('projectManager', 'POST', `/projects/${project.id}/accountability-assignments`, { leader_membership_id: ctx.person('projectManager').membershipId, accountability_role: 'FOCAL_OFFICER', valid_from: ctx.day(-80) });
  }
}

/** The work breakdown of a project: the main components of the construction and their planned values (PRJ-05). */
async function components(ctx: SeedContext, project: PortfolioProject): Promise<Map<string, string>> {
  const existing = await ctx.get<Obj>('projectManager', `/projects/${project.id}/components`);
  const rows = (Array.isArray(existing) ? existing : (existing.items ?? existing.components ?? [])) as Obj[];
  const ids = new Map<string, string>(rows.map((row) => [String(row.code), String(row.id)]));
  const parts = [
    { code: 'CP1', name: tx('name.013'), share: 0.68 },
    { code: 'CP2', name: tx('name.014'), share: 0.14 },
    { code: 'CP3', name: tx('name.015'), share: 0.08 },
    { code: 'CP4', name: tx('name.016'), share: 0.1 },
  ];
  for (const part of parts) {
    if (ids.has(part.code)) continue;
    const made = await ctx.command('projectManager', `/projects/${project.id}/components`, { code: part.code, name: part.name, planned_value_vnd: vnd(project.totalBillions * part.share), valid_from: `${project.startYear}-01-01`, sort_order: parts.indexOf(part) + 1 });
    ids.set(part.code, made.resource_id);
  }
  return ids;
}

/** Milestones: one done, one late with its reason, the rest planned ahead (PRJ-07, and the milestones of the phone). */
async function milestones(ctx: SeedContext, project: PortfolioProject, componentIds: Map<string, string>): Promise<void> {
  const existing = await ctx.get<Obj>('projectManager', `/projects/${project.id}/milestones`);
  const rows = (Array.isArray(existing) ? existing : (existing.items ?? existing.milestones ?? [])) as Obj[];
  if (rows.length > 0) return;
  const spec = [
    { code: 'GD1', name: tx('name.017'), component: 'CP3', planned: ctx.day(-120), progress: 'DONE' as const },
    { code: 'GD2', name: tx('name.018'), component: 'CP4', planned: ctx.day(-60), progress: 'DELAYED' as const },
    { code: 'GD3', name: tx('name.019'), component: 'CP1', planned: ctx.day(45), progress: undefined },
    { code: 'GD4', name: tx('name.020'), component: 'CP1', planned: ctx.day(240), progress: undefined },
  ];
  for (const item of spec) {
    const made = await ctx.command('projectManager', `/projects/${project.id}/milestones`, { code: item.code, name: item.name, component_id: componentIds.get(item.component), baseline_date: item.planned, planned_date: item.planned });
    if (item.progress === 'DONE') await ctx.command('projectManager', `/project-milestones/${made.resource_id}/progress`, { status: 'DONE', actual_date: shiftDate(item.planned, 6) }, { version: made.resource_version });
    if (item.progress === 'DELAYED') await ctx.command('projectManager', `/project-milestones/${made.resource_id}/progress`, { status: 'DELAYED', planned_date: ctx.day(25), reason: tx('reason.021') }, { version: made.resource_version });
  }
}

/** Risks: one critical, one past its due date, one watched (PRJ-16). */
async function risks(ctx: SeedContext, project: PortfolioProject, categories: Map<string, string>): Promise<void> {
  const existing = await ctx.list('projectManager', `/projects/${project.id}/risks`);
  if (existing.length > 0) return;
  const owner = ctx.person(project.leader ?? 'projectManager').membershipId;
  const spec = [
    { code: 'R01', category: 'GPMB', title: tx('title.022'), description: tx('description.023'), likelihood: 5, impact: 5, mitigation: tx('mitigation.024'), due: ctx.day(21), status: 'ESCALATED' as const },
    { code: 'R02', category: 'TIEN-DO', title: tx('title.025'), description: tx('description.026'), likelihood: 4, impact: 3, mitigation: tx('mitigation.027'), due: ctx.day(-12), status: 'MITIGATING' as const },
    { code: 'R03', category: 'VON', title: tx('title.028'), description: tx('description.029'), likelihood: 3, impact: 4, mitigation: tx('mitigation.030'), due: ctx.day(40), status: 'OPEN' as const },
  ];
  for (const item of spec) {
    await ctx.command('projectManager', `/projects/${project.id}/risks`, {
      code: item.code,
      category_master_version_id: categories.get(item.category),
      title: item.title,
      description: item.description,
      likelihood: item.likelihood,
      impact: item.impact,
      owner_membership_id: owner,
      mitigation: item.mitigation,
      due_date: item.due,
      status: item.status,
    });
  }
}

async function taskForce(ctx: SeedContext, portfolio: PortfolioProject[]): Promise<void> {
  const existing = await ctx.list('projectManager', '/resources/task_force');
  if (existing.length > 0) return;
  const decision = await ctx.letter({ symbol: tx('symbol.031'), title: tx('title.032'), issuedOn: '2026-02-03' });
  const created = await ctx.command('projectManager', '/task-forces', {
    code: 'TCT-2026-01',
    name: tx('name.033'),
    purpose: tx('purpose.034'),
    lead_membership_id: ctx.person('capApprover').membershipId,
    scope_unit_id: ctx.unitId('CB-SKHDT'),
    valid_from: '2026-02-03',
    establishment_document_id: decision.documentId,
  });
  const members = [
    { who: 'projectManager', role: 'MEMBER', project: 'DA-DT205' },
    { who: 'projectManager', role: 'MEMBER', project: 'DA-NN031' },
    { who: 'treasuryMaker', role: 'SECRETARY', project: undefined },
    { who: 'unitAdmin', role: 'MEMBER', project: 'DA-MT019' },
  ];
  for (const member of members) {
    const project = member.project === undefined ? undefined : portfolio.find((candidate) => candidate.code === member.project);
    await ctx.command('projectManager', `/task-forces/${created.resource_id}/members`, { membership_id: ctx.person(member.who).membershipId, member_role: member.role, ...(project === undefined ? {} : { project_id: project.id }), valid_from: '2026-02-03' });
  }
}

/** The leader asks, the unit answers, the leader accepts or returns (PRJ-19). */
async function explanations(ctx: SeedContext, portfolio: PortfolioProject[]): Promise<void> {
  const existing = await ctx.list('capApprover', '/explanation-requests');
  if (existing.length > 0) return;
  const byCode = (code: string): PortfolioProject => {
    const found = portfolio.find((project) => project.code === code);
    if (found === undefined) throw new Error(`project ${code} is not in the portfolio`);
    return found;
  };
  const asks = [
    { code: 'DA-MT019', trigger: 'SUSPENDED_PROJECT', question: tx('question.035'), due: ctx.day(10), response: tx('response.036'), decision: 'ACCEPTED' as const },
    { code: 'DA-DT205', trigger: 'LOW_DISBURSEMENT', question: tx('question.037'), due: ctx.day(5), response: tx('response.038'), decision: 'RETURNED' as const },
    { code: 'DA-NN031', trigger: 'MILESTONE_DELAYED', question: tx('question.039'), due: ctx.day(-4), response: undefined, decision: undefined },
  ];
  for (const ask of asks) {
    const project = byCode(ask.code);
    const made = await ctx.command('capApprover', '/explanation-requests', {
      subject_kind: 'PROJECT',
      project_id: project.id,
      trigger_code: ask.trigger,
      question: ask.question,
      requested_from_membership_id: ctx.person('projectManager').membershipId,
      due_at: `${ask.due}T10:00:00.000Z`,
    });
    if (ask.response === undefined) continue;
    const answered = await ctx.command('projectManager', `/explanation-requests/${made.resource_id}/response`, { response_text: ask.response }, { version: made.resource_version });
    if (ask.decision === 'ACCEPTED') await ctx.command('capApprover', `/explanation-requests/${made.resource_id}/decision`, { decision: 'ACCEPTED', review_note: tx('review_note.040') }, { version: answered.resource_version });
    if (ask.decision === 'RETURNED') await ctx.command('capApprover', `/explanation-requests/${made.resource_id}/decision`, { decision: 'RETURNED', review_note: tx('review_note.041'), new_due_at: `${ctx.day(7)}T10:00:00.000Z` }, { version: answered.resource_version });
  }
}

/** Changes proposed to a project after its decision: one waits for the leader, one is approved (PRJ-06). */
async function revisions(ctx: SeedContext, portfolio: PortfolioProject[]): Promise<void> {
  const dt = portfolio.find((project) => project.code === 'DA-DT205');
  const th = portfolio.find((project) => project.code === 'DA-TH012');
  if (dt === undefined || th === undefined) return;
  if ((await ctx.list('projectManager', `/projects/${dt.id}/revisions`)).length === 0) {
    await ctx.attempt('projectManager', 'POST', `/projects/${dt.id}/revisions`, { change_kind: 'ADJUST_INVESTMENT', after: { note: tx('note.042') }, total_investment_vnd: vnd(158), reason: tx('reason.043') });
  }
  if ((await ctx.list('projectManager', `/projects/${th.id}/revisions`)).length === 0) {
    const proposed = await ctx.attempt<{ resource_id: string; resource_version: number }>('projectManager', 'POST', `/projects/${th.id}/revisions`, { change_kind: 'ADJUST_SCHEDULE', after: { end_year: 2028 }, reason: tx('reason.044') });
    if (proposed.ok) {
      const decision = await ctx.letter({ symbol: tx('symbol.045'), title: tx('title.046'), issuedOn: ctx.day(-15) });
      await ctx.attempt('capApprover', 'POST', `/project-revisions/${proposed.json.resource_id}/decision`, { decision: 'approve', reason: tx('reason.047'), decision_document_id: decision.documentId, effective_from: ctx.day(-15) }, { version: proposed.json.resource_version });
    }
  }
}

export async function seedProjectExtras(ctx: SeedContext, portfolio: PortfolioProject[]): Promise<void> {
  const categories = await ctx.step('PRJ', 'risk groups of the register', () => riskCategories(ctx));
  const working = portfolio.filter((project) => ['BUDGETED', 'IMPLEMENTATION', 'SUSPENDED', 'COMPLETED'].includes(project.target));
  for (const project of working) {
    await ctx.step('PRJ', `leader of ${project.code}`, () => assignLeader(ctx, project));
    const parts = await ctx.step('PRJ', `work breakdown of ${project.code}`, () => components(ctx, project));
    await ctx.step('PRJ', `milestones of ${project.code}`, () => milestones(ctx, project, parts));
    await ctx.step('PRJ', `risks of ${project.code}`, () => risks(ctx, project, categories));
  }
  await ctx.step('PRJ', 'task force for the disbursement', () => taskForce(ctx, portfolio));
  await ctx.step('PRJ', 'explanations asked by the leader', () => explanations(ctx, portfolio));
  await ctx.step('PRJ', 'changes proposed to projects', () => revisions(ctx, portfolio));
}
