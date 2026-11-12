import { asVersion, vnd, vndMillions } from '../context.ts';
import type { CommandReply, Obj, SeedContext } from '../context.ts';
import { registerPortfolioProject } from '../capital-projects.ts';
import type { ProjectSpec } from '../capital-projects.ts';
import { CHECKER, MAKER, OWNER, asString, paper, tolerate } from '../field-assurance/shared.ts';
import TEXTS from '../data/enterprise-lifecycle.json' with { type: 'json' };
import { clipPlan } from './plan.ts';

/**
 * Group `clip-ent-lifecycle`: the whole life of a project of the enterprise, from the proposal to the closing, and the governance around it, through the commands of the product only.
 *
 * Part 1, the working records around the projects that exist (PRJ-17 who answers for each, PRJ-05 the work breakdown, PRJ-07 and PRJ-26 the milestones, PRJ-16 and PRJ-28 the risk register,
 * PRJ-18 the task forces, PRJ-19 the explanations the leader asks for, PRJ-06 the changes proposed to a project, PRJ-11 a handover of equipment).
 *
 * Part 2, the other end of the life cycle: six small projects of their own (codes DA-PMDT901..904, DA-PMTB905..906), each at a different stage: a concept (PRJ-09), one under appraisal (PRJ-10 and PRJ-15),
 * one rejected, one suspended, one completed with its settlement sent and waiting (PRJ-12), one completed with its settlement closed and its lessons approved (PRJ-12, PRJ-29). The product has no consumer that moves a project from COMPLETED to SETTLED when its settlement closes (`settlement.closed.v1`), so the project stays COMPLETED and PRJ-12 reads it as "closed, waiting for the stage". A project cannot leave the pipeline without a line in a published
 * plan of capital, so the three that were built carry a line in the plan of 2024 (a plan of its own year): the plan of 2026, the funding figures and the frozen snapshots are not touched, and the
 * figures of the dashboards stay what they were.
 *
 * Idempotent: every step looks at what exists first; a step the rules of the product refuse is written in the warnings and the rest goes on.
 */

const T = TEXTS as unknown as Record<string, unknown>;
const text = (key: string, ...args: readonly unknown[]): string => {
  const found = T[key];
  if (typeof found !== 'string') throw new Error(`the text ${key} is not in enterprise-lifecycle.json`);
  return found.replace(/\{(\d+)\}/gu, (_m, index: string) => String(args[Number(index)] ?? ''));
};
const list = <Row>(key: string): Row[] => {
  const found = T[key];
  if (!Array.isArray(found)) throw new Error(`the list ${key} is not in enterprise-lifecycle.json`);
  return found as Row[];
};

const LEADER = 'capApprover';
const sevenDigits = (code: string): string => code.replace(/\D/gu, '');

interface EnterprisePlan {
  dataset: string;
  projects: Array<ProjectSpec & { kind: 'INVESTMENT' | 'EQUIPMENT'; leader?: string }>;
  capital: { appropriations: Array<{ key: 'VCSH' | 'VAY'; fund: string; origin: string; level: string; decisionKind?: string; authority: string; bucket: string }> };
}

interface Working {
  id: string;
  code: string;
  name: string;
  kind: 'INVESTMENT' | 'EQUIPMENT';
  totalBillions: number;
  startYear: number;
  status: string;
  leader?: string;
}

const projectNow = (ctx: SeedContext, id: string): Promise<Obj> => ctx.get(MAKER, `/resources/project/${id}`);

// ---- part 1: the working records around the projects ---------------------------------------------------------------------------------------

async function riskGroups(ctx: SeedContext): Promise<Map<string, string>> {
  const decision = await ctx.letter({ symbol: text('riskGroup.decision.symbol'), title: text('riskGroup.decision.title'), issuedOn: ctx.day(-100), sender: text('riskGroup.decision.sender') });
  for (const key of ['MAT-BANG', 'TIEN-DO', 'KY-THUAT', 'VON', 'PHAP-LY']) {
    const find = (): Promise<Obj | undefined> => ctx.find(MAKER, '/master-records', (row) => row.business_key === key, { master_type: 'RISK_CATEGORY' });
    let record = await find();
    if (record === undefined) {
      await ctx.command(MAKER, '/master-records', { namespace: 'TENANT', master_type: 'RISK_CATEGORY', business_key: key, label: text(`riskGroup.${key}`), attributes: {}, valid_from: '2026-01-01', reason: text('riskGroup.reason.propose') });
      record = await find();
    }
    if (record === undefined) throw new Error(`the risk group ${key} cannot be found after it was proposed`);
    const changeId = String(record.open_change_request_id);
    if (record.status === 'DRAFT') {
      const change = await ctx.get(MAKER, `/master-change-requests/${changeId}`);
      await ctx.command(MAKER, `/master-change-requests/${changeId}/submit`, {}, { version: asVersion(change.version) });
    }
    if (record.status === 'DRAFT' || record.status === 'IN_REVIEW') {
      const change = await ctx.get(LEADER, `/master-change-requests/${changeId}`);
      await ctx.command(LEADER, `/master-change-requests/${changeId}/decision`, { decision: 'approve', reason: text('riskGroup.reason.approve') }, { version: asVersion(change.version) });
      record = await find();
    }
    if (record?.status === 'APPROVED') await ctx.command(LEADER, `/master-records/${String(record.id)}/publish`, { decision_document_id: decision.documentId }, { version: Number(record.version) });
  }
  const published = await ctx.list(MAKER, '/master-records', { master_type: 'RISK_CATEGORY' });
  return new Map(published.filter((row) => row.version_id !== null && row.version_id !== undefined).map((row) => [String(row.business_key), String(row.version_id)]));
}

/** Who answers for the project before the leader (PRJ-17): the person the plan names, assigned by a decision of the board. */
async function assignLeader(ctx: SeedContext, project: Working): Promise<void> {
  if (project.leader === undefined) return;
  const existing = await ctx.list(MAKER, '/resources/project_accountability', { project_id: project.id });
  if (existing.length > 0) return;
  const decision = await ctx.letter({ symbol: text('leader.symbol', `${210 + Number(sevenDigits(project.code)) % 90}`), title: text('leader.title', project.name), issuedOn: ctx.day(-80), sender: text('leader.sender') });
  const body = { leader_membership_id: ctx.person(project.leader).membershipId, accountability_role: 'LEADER_IN_CHARGE', valid_from: ctx.day(-80), assignment_document_id: decision.documentId };
  const made = await ctx.attempt(LEADER, 'POST', `/projects/${project.id}/accountability-assignments`, body);
  if (!made.ok) await ctx.attempt(OWNER, 'POST', `/projects/${project.id}/accountability-assignments`, body);
  if (project.leader !== MAKER) await ctx.attempt(LEADER, 'POST', `/projects/${project.id}/accountability-assignments`, { leader_membership_id: ctx.person(MAKER).membershipId, accountability_role: 'FOCAL_OFFICER', valid_from: ctx.day(-80) });
}

async function components(ctx: SeedContext, project: Working): Promise<Map<string, string>> {
  const existing = await ctx.get<Obj>(MAKER, `/projects/${project.id}/components`);
  const rows = (Array.isArray(existing) ? existing : (existing.items ?? existing.components ?? [])) as Obj[];
  const ids = new Map<string, string>(rows.map((row) => [String(row.code), String(row.id)]));
  const parts = list<{ code: string; name: string; share: number }>(`wbs.${project.kind}`);
  for (const [index, part] of parts.entries()) {
    if (ids.has(part.code)) continue;
    const made = await ctx.command(MAKER, `/projects/${project.id}/components`, { code: part.code, name: part.name, planned_value_vnd: vnd(project.totalBillions * part.share), valid_from: `${project.startYear}-01-01`, sort_order: index + 1 });
    ids.set(part.code, made.resource_id);
  }
  return ids;
}

/** Milestones: one done, one late with its reason, the rest planned ahead (PRJ-07, PRJ-26). */
async function milestones(ctx: SeedContext, project: Working, componentIds: Map<string, string>): Promise<void> {
  const existing = await ctx.get<Obj>(MAKER, `/projects/${project.id}/milestones`);
  const rows = (Array.isArray(existing) ? existing : (existing.items ?? existing.milestones ?? [])) as Obj[];
  if (rows.length > 0) return;
  const planned = [ctx.day(-120), ctx.day(-60), ctx.day(45), ctx.day(240)];
  for (const [index, item] of list<{ code: string; name: string; component: string; state: string; reason?: string }>(`milestones.${project.kind}`).entries()) {
    const date = planned[index] ?? ctx.day(240);
    const made = await ctx.command(MAKER, `/projects/${project.id}/milestones`, { code: item.code, name: item.name, component_id: componentIds.get(item.component), baseline_date: date, planned_date: date });
    if (item.state === 'DONE') await ctx.command(MAKER, `/project-milestones/${made.resource_id}/progress`, { status: 'DONE', actual_date: ctx.day(-114) }, { version: made.resource_version });
    if (item.state === 'DELAYED') await ctx.command(MAKER, `/project-milestones/${made.resource_id}/progress`, { status: 'DELAYED', planned_date: ctx.day(25), reason: item.reason }, { version: made.resource_version });
  }
}

/** The risk register: one critical, one past its due date, one watched (PRJ-16, PRJ-28). */
async function risks(ctx: SeedContext, project: Working, groups: Map<string, string>): Promise<void> {
  const existing = await ctx.list(MAKER, `/projects/${project.id}/risks`);
  if (existing.length > 0) return;
  const owner = ctx.person(project.leader ?? MAKER).membershipId;
  for (const item of list<{ code: string; category: string; title: string; description: string; likelihood: number; impact: number; mitigation: string; dueIn: number; status: string }>(`risks.${project.kind}`)) {
    await ctx.command(MAKER, `/projects/${project.id}/risks`, {
      code: item.code,
      category_master_version_id: groups.get(item.category),
      title: item.title,
      description: item.description,
      likelihood: item.likelihood,
      impact: item.impact,
      owner_membership_id: owner,
      mitigation: item.mitigation,
      due_date: ctx.day(item.dueIn),
      status: item.status,
    });
  }
}

async function taskForces(ctx: SeedContext, byCode: Map<string, Working>): Promise<void> {
  const known = await ctx.list<Obj>(MAKER, '/resources/task_force');
  const specs = [
    {
      code: 'TCT-2026-01',
      n: 1,
      lead: LEADER,
      issuedOn: ctx.day(-100),
      members: [
        { who: MAKER, role: 'MEMBER', project: 'DA-PMDT105' },
        { who: MAKER, role: 'MEMBER', project: 'DA-PMDT120' },
        { who: 'treasuryMaker', role: 'SECRETARY', project: undefined },
        { who: 'unitAdmin', role: 'MEMBER', project: 'DA-PMTB172' },
        { who: OWNER, role: 'MEMBER', project: 'DA-PMTB164' },
      ],
    },
    {
      code: 'TCT-2026-02',
      n: 2,
      lead: MAKER,
      issuedOn: ctx.day(-40),
      members: [
        { who: LEADER, role: 'MEMBER', project: 'DA-PMDT105' },
        { who: 'unitAdmin', role: 'MEMBER', project: 'DA-PMDT105' },
        { who: 'treasuryMaker', role: 'SECRETARY', project: undefined },
      ],
    },
  ];
  for (const spec of specs) {
    if (known.some((row) => row.code === spec.code)) continue;
    const decision = await ctx.letter({ symbol: text(`taskForce.${spec.n}.decision.symbol`), title: text(`taskForce.${spec.n}.decision.title`), issuedOn: spec.issuedOn, sender: text('taskForce.sender') });
    const created = await ctx.command(MAKER, '/task-forces', { code: spec.code, name: text(`taskForce.${spec.n}.name`), purpose: text(`taskForce.${spec.n}.purpose`), lead_membership_id: ctx.person(spec.lead).membershipId, scope_unit_id: ctx.unitId('CB-SKHDT'), valid_from: spec.issuedOn, establishment_document_id: decision.documentId });
    for (const member of spec.members) {
      const project = member.project === undefined ? undefined : byCode.get(member.project);
      await ctx.command(MAKER, `/task-forces/${created.resource_id}/members`, { membership_id: ctx.person(member.who).membershipId, member_role: member.role, ...(project === undefined ? {} : { project_id: project.id }), valid_from: spec.issuedOn });
    }
  }
}

/** The leader asks, the unit answers, the leader accepts or returns (PRJ-19). */
async function explanations(ctx: SeedContext, byCode: Map<string, Working>): Promise<void> {
  // The API refuses a due moment that is not after its own clock, whatever offset the stack clock has: every due date is counted from the day the stack believes it is, and always ahead.
  await ctx.syncClock();
  const existing = await ctx.list<Obj>(OWNER, '/explanation-requests');
  const known = (projectId: string, trigger: string): boolean => existing.some((row) => String(row.trigger_code) === trigger && String(row.project_id ?? (row.project as Obj | undefined)?.id) === projectId);
  const asks = [
    { code: 'DA-PMDT904', n: 1, trigger: 'SUSPENDED_PROJECT', due: ctx.day(10), decision: 'ACCEPTED' as const },
    { code: 'DA-PMDT137', n: 2, trigger: 'LOW_DISBURSEMENT', due: ctx.day(5), decision: 'RETURNED' as const },
    { code: 'DA-PMDT130', n: 3, trigger: 'MILESTONE_DELAYED', due: ctx.day(3), decision: undefined },
  ];
  for (const ask of asks) {
    const project = byCode.get(ask.code);
    if (project === undefined) {
      ctx.warn(`the project ${ask.code} is not there: its explanation request is left out`);
      continue;
    }
    if (known(project.id, ask.trigger)) continue;
    const made = await ctx.command(OWNER, '/explanation-requests', { subject_kind: 'PROJECT', project_id: project.id, trigger_code: ask.trigger, question: text(`explanation.${ask.n}.question`), requested_from_membership_id: ctx.person(MAKER).membershipId, due_at: `${ask.due}T10:00:00.000Z` });
    if (ask.decision === undefined) continue;
    const answered = await ctx.command(MAKER, `/explanation-requests/${made.resource_id}/response`, { response_text: text(`explanation.${ask.n}.response`) }, { version: made.resource_version });
    if (ask.decision === 'ACCEPTED') await ctx.command(LEADER, `/explanation-requests/${made.resource_id}/decision`, { decision: 'ACCEPTED', review_note: text('explanation.1.accept') }, { version: answered.resource_version });
    else await ctx.command(LEADER, `/explanation-requests/${made.resource_id}/decision`, { decision: 'RETURNED', review_note: text('explanation.2.return'), new_due_at: `${ctx.day(7)}T10:00:00.000Z` }, { version: answered.resource_version });
  }
}

/** Whether the project already has a change proposed after its registration (the first revision is the registration itself). */
async function proposedChanges(ctx: SeedContext, id: string): Promise<boolean> {
  return (await ctx.list<Obj>(MAKER, `/projects/${id}/revisions`)).some((row) => row.change_kind !== 'INITIAL');
}

/** Changes proposed to a project after its decision: one waits for the leader, one is approved (PRJ-06). */
async function revisions(ctx: SeedContext, byCode: Map<string, Working>): Promise<void> {
  const waiting = byCode.get('DA-PMDT130');
  const stretched = byCode.get('DA-PMTB172');
  if (waiting !== undefined && !(await proposedChanges(ctx, waiting.id))) {
    await ctx.attempt(MAKER, 'POST', `/projects/${waiting.id}/revisions`, { change_kind: 'ADJUST_INVESTMENT', after: { total_investment_vnd: vnd(waiting.totalBillions + 21) }, total_investment_vnd: vnd(waiting.totalBillions + 21), reason: text('revision.1.reason') }, { version: Number((await projectNow(ctx, waiting.id)).version) });
  }
  if (stretched !== undefined && !(await proposedChanges(ctx, stretched.id))) {
    const proposed = await ctx.attempt<CommandReply>(MAKER, 'POST', `/projects/${stretched.id}/revisions`, { change_kind: 'ADJUST_SCHEDULE', after: { end_year: stretched.startYear + 2 }, reason: text('revision.2.reason') }, { version: Number((await projectNow(ctx, stretched.id)).version) });
    if (proposed.ok) {
      const decision = await ctx.letter({ symbol: text('revision.2.decision.symbol'), title: text('revision.2.decision.title'), issuedOn: ctx.day(-15), sender: text('revision.sender') });
      await ctx.attempt(LEADER, 'POST', `/project-revisions/${proposed.json.resource_id}/decision`, { decision: 'approve', reason: text('revision.2.approve'), decision_document_id: decision.documentId, effective_from: ctx.day(-15) }, { version: proposed.json.resource_version });
    }
  }
}

/** A part of the compressor delivered and accepted on site, registered as an asset with its warranty (PRJ-11 reads the handovers of the project). */
async function equipmentHandover(ctx: SeedContext, byCode: Map<string, Working>): Promise<void> {
  const project = byCode.get('DA-PMTB164');
  if (project === undefined) return;
  const no = text('handover.no');
  const existing = await ctx.find(MAKER, '/resources/handover', (row) => row.handover_no === no);
  if (existing?.status === 'ACCEPTED' && (await ctx.list(MAKER, '/resources/asset_record')).some((row) => row.asset_code === 'TS-PMTB164-01')) return;
  const contract = (await ctx.list<Obj>(MAKER, '/resources/contract')).find((row) => String(row.project_id) === project.id && row.status === 'ACTIVE');
  if (contract === undefined) {
    ctx.warn('DA-PMTB164 has no active contract: the handover of its equipment is left out');
    return;
  }
  let handoverId = asString(existing?.id);
  if (existing === undefined) {
    const minutes = await paper(ctx, { symbol: `BB-${no}`, title: text('handover.minutes.title', project.name), type: 'BB', sender: text('handover.minutes.sender'), issuedOn: ctx.day(-5) });
    const created = await ctx.command(MAKER, '/handovers', { project_id: project.id, contract_id: asString(contract.id), recipient_unit_id: ctx.unitId('CB-SKHDT-VP'), handover_kind: 'PARTIAL', handover_no: no, planned_on: ctx.day(-3), document_version_id: minutes.versionId });
    handoverId = created.resource_id;
    ctx.record({ module: 'AST', screen: 'PRJ-11', kind: 'handover', id: handoverId, code: no, note: project.code });
  }
  const made = { resource_id: handoverId };
  let detail = await ctx.get<Obj>(MAKER, `/resources/handover/${made.resource_id}`);
  if (((detail.punch_items ?? detail.items ?? []) as Obj[]).length === 0 && detail.status !== 'ACCEPTED') {
    let version = Number(detail.version);
    for (const item of list<{ description: string; severity: string; location: string; dueIn: number }>('handover.punch')) {
      const added = await ctx.command(MAKER, `/handovers/${made.resource_id}/punch-items`, { description: item.description, severity: item.severity, location_text: item.location, responsible_contractor_id: asString(contract.contractor_id), due_on: ctx.day(item.dueIn) }, { version });
      version = added.resource_version;
    }
    detail = await ctx.get<Obj>(MAKER, `/resources/handover/${made.resource_id}`);
  }
  const items = (detail.punch_items ?? detail.items ?? []) as Obj[];
  for (const [index, item] of items.entries()) {
    if (asString(item.status) !== 'OPEN') continue;
    const proof = await paper(ctx, { symbol: `KP-${no}-${index + 1}`, title: text('handover.punch.proof.title', index + 1, no), type: 'BB', sender: text('handover.minutes.sender'), issuedOn: ctx.day(-1) });
    await tolerate(ctx, `fix punch item ${index + 1}`, () => ctx.command(MAKER, `/punch-items/${asString(item.id)}/fixed`, { evidence_document_version_id: proof.versionId, note: text('handover.punch.note') }));
    await tolerate(ctx, `verify punch item ${index + 1}`, () => ctx.command(CHECKER, `/punch-items/${asString(item.id)}/verify`, { outcome: 'VERIFIED', note: text('handover.punch.verify') }));
  }
  const fresh = await ctx.get<Obj>(MAKER, `/resources/handover/${made.resource_id}`);
  if (fresh.status !== 'ACCEPTED') {
  const asBuilt = await paper(ctx, { symbol: `HSHC-${no}`, title: text('handover.asbuilt.title', no), type: 'BC', sender: text('handover.minutes.sender'), issuedOn: ctx.day(-2) });
  const manual = await paper(ctx, { symbol: `HDVH-${no}`, title: text('handover.manual.title', no), type: 'BC', sender: text('handover.minutes.sender'), issuedOn: ctx.day(-2) });
  await tolerate(ctx, `accept ${no}`, () =>
    ctx.command(CHECKER, `/handovers/${made.resource_id}/decision`, { decision: 'approve', reason: text('handover.accept.reason'), evidence_ids: [], as_built_document_version_id: asBuilt.versionId, om_manual_document_version_id: manual.versionId }, { version: Number(fresh.version) }),
  );
  }
  const accepted = await ctx.get<Obj>(MAKER, `/resources/handover/${made.resource_id}`);
  if (accepted.status !== 'ACCEPTED') return;
  const values: Array<[string, string, number]> = [
    [`TS-PMTB164-01`, text('handover.asset.1'), 7.9],
    [`TS-PMTB164-02`, text('handover.asset.2'), 0.92],
  ];
  let first: string | undefined;
  for (const [code, name, billions] of values) {
    const asset = await tolerate(ctx, `asset ${code}`, () =>
      ctx.command(MAKER, '/asset-records', { project_id: project.id, handover_id: made.resource_id, asset_code: code, name, source_contract_id: asString(contract.id), recipient_unit_id: ctx.unitId('CB-SKHDT-VP'), value_vnd: vnd(billions), value_basis: 'CONTRACT_VALUE', funding_origin: text('handover.asset.fundingOrigin'), warranty_until: ctx.day(720) }),
    );
    if (asset !== undefined) {
      first ??= asset.resource_id;
      ctx.record({ module: 'AST', screen: 'AST-03', kind: 'asset', id: asset.resource_id, code, note: name });
    }
  }
  if (first !== undefined) {
    const record = await ctx.get<Obj>(MAKER, `/resources/asset_record/${first}`);
    const commissioning = await paper(ctx, { symbol: `BBDVSD-${no}`, title: text('handover.commission.title', no), type: 'BB', sender: text('handover.minutes.sender'), issuedOn: ctx.day(-1) });
    await tolerate(ctx, 'transfer the first asset', () => ctx.command(MAKER, `/asset-records/${first}/transfer`, { transferred_on: ctx.today, commissioning_document_version_id: commissioning.versionId }, { version: Number(record.version) }));
    const plan = await paper(ctx, { symbol: `KHBT-${no}`, title: text('handover.om.title', no), type: 'BC', sender: text('handover.minutes.sender'), issuedOn: ctx.day(-1) });
    await tolerate(ctx, 'maintenance plan of the first asset', () => ctx.command(MAKER, `/asset-records/${first}/om-link`, { operator_unit_id: ctx.unitId('CB-SKHDT-VP'), om_plan_document_version_id: plan.versionId, maintenance_cycle_months: 6, next_maintenance_due: ctx.day(120) }));
    await tolerate(ctx, 'warranty of the handover', () =>
      ctx.command(MAKER, '/warranty-obligations', { contract_id: asString(contract.id), handover_id: made.resource_id, asset_id: first, scope_description: text('handover.warranty.scope'), starts_on: ctx.today, period_months: 24, retention_amount_vnd: vndMillions(441), construction_grade: 'III' }),
    );
  }
}

// ---- part 2: the other end of the life cycle ----------------------------------------------------------------------------------------------

type Target = 'CONCEPT' | 'APPRAISAL' | 'REJECTED' | 'SUSPENDED' | 'COMPLETED' | 'SETTLED';
interface NewProject extends ProjectSpec {
  lifecycleTarget: Target;
  national?: string;
  /** Capital of the plan of 2024 in billions: equity and loan. */
  funded?: [number, number];
}

const NEW_PROJECTS: NewProject[] = [
  { code: 'DA-PMDT901', name: text('newProject.DA-PMDT901'), area: 'PM-NHA-MAY-DAM', sector: 'ENVIRONMENT', type: 'NEW_BUILD', totalBillions: 48, startYear: 2027, endYear: 2028, target: 'IMPLEMENTATION', lifecycleTarget: 'CONCEPT', group: 'C' },
  { code: 'DA-PMDT902', name: text('newProject.DA-PMDT902'), area: 'PM-KHO-CANG', sector: 'ENVIRONMENT', type: 'NEW_BUILD', totalBillions: 62, startYear: 2027, endYear: 2028, target: 'IMPLEMENTATION', lifecycleTarget: 'APPRAISAL', group: 'C' },
  { code: 'DA-PMDT903', name: text('newProject.DA-PMDT903'), area: 'PM-KCN-PHU-MY', sector: 'ENVIRONMENT', type: 'NEW_BUILD', totalBillions: 29, startYear: 2027, endYear: 2028, target: 'IMPLEMENTATION', lifecycleTarget: 'REJECTED', group: 'C' },
  { code: 'DA-PMDT904', name: text('newProject.DA-PMDT904'), area: 'PM-KCN-PHU-MY', sector: 'ENVIRONMENT', type: 'UPGRADE', totalBillions: 36, startYear: 2024, endYear: 2026, target: 'IMPLEMENTATION', lifecycleTarget: 'SUSPENDED', group: 'C', national: '7893901', funded: [9, 6], leader: 'capApprover' },
  { code: 'DA-PMTB905', name: text('newProject.DA-PMTB905'), area: 'PM-NHA-MAY-DAM', sector: 'ICT', type: 'PROCUREMENT', totalBillions: 14, startYear: 2024, endYear: 2025, target: 'IMPLEMENTATION', lifecycleTarget: 'COMPLETED', group: 'C', national: '7893902', funded: [8, 4], leader: 'projectManager' },
  { code: 'DA-PMTB906', name: text('newProject.DA-PMTB906'), area: 'PM-KCN-PHU-MY', sector: 'ICT', type: 'PROCUREMENT', totalBillions: 8, startYear: 2024, endYear: 2025, target: 'IMPLEMENTATION', lifecycleTarget: 'SETTLED', group: 'C', national: '7893903', funded: [5, 2], leader: 'projectManager' },
];

/** Whether a project is at or past a stage of the line CONCEPT, APPRAISAL, PIPELINE, BUDGETED, IMPLEMENTATION, SUSPENDED, COMPLETED, SETTLED, CLOSED. */
const LINE = ['CONCEPT', 'APPRAISAL', 'PIPELINE', 'BUDGETED', 'IMPLEMENTATION', 'SUSPENDED', 'COMPLETED', 'SETTLED', 'CLOSED'];
const reached = (status: string, stage: string): boolean => LINE.indexOf(status) >= LINE.indexOf(stage);

async function submitForAppraisal(ctx: SeedContext, id: string, project: NewProject): Promise<void> {
  const now = await projectNow(ctx, id);
  if (now.status !== 'CONCEPT') return;
  const proposal = await ctx.letter({ symbol: text('stage.proposal.symbol', `${sevenDigits(project.code)}`), title: text('stage.proposal.title', project.name), issuedOn: ctx.day(-70), sender: text('stage.proposal.sender') });
  await ctx.command(MAKER, `/projects/${id}/appraisal-submissions`, { reason: text('stage.proposal.reason'), policy_proposal_document_id: proposal.documentId }, { version: Number(now.version) });
}

async function appraise(ctx: SeedContext, id: string, project: NewProject, outcome: 'ADMIT' | 'REJECT'): Promise<void> {
  const now = await projectNow(ctx, id);
  if (now.status !== 'APPRAISAL') return;
  const criteria = (await ctx.list(OWNER, '/master-records', { master_type: 'APPRAISAL_CRITERIA' }))[0];
  if (criteria?.version_id === undefined) throw new Error('no appraisal criteria in force');
  const marks = outcome === 'ADMIT' ? { POLICY_ALIGNMENT: 4, FEASIBILITY: 4, EFFECTIVENESS: 4, CAPITAL_READINESS: 4, RISK: 3 } : { POLICY_ALIGNMENT: 2, FEASIBILITY: 2, EFFECTIVENESS: 1, CAPITAL_READINESS: 1, RISK: 2 };
  const sheet = await ctx.command(OWNER, `/projects/${id}/appraisals`, {
    criteria_set_version_id: criteria.version_id,
    recommendation: outcome,
    note: outcome === 'ADMIT' ? text('stage.appraisal.admit.note') : text('stage.appraisal.note.reject'),
    scores: Object.entries(marks).map(([criterion_code, score]) => ({ criterion_code, score })),
  });
  const letter = await ctx.letter({ symbol: text('stage.appraisal.symbol', `${sevenDigits(project.code)}`), title: text('stage.appraisal.title', project.name), issuedOn: ctx.day(-40), sender: text('stage.appraisal.sender') });
  await ctx.command(LEADER, `/project-appraisals/${sheet.resource_id}/decision`, { decision: outcome, reason: outcome === 'ADMIT' ? text('stage.appraisal.admit.reason') : text('stage.appraisal.reject.reason'), decision_document_id: letter.documentId, ...(outcome === 'ADMIT' ? { project_group: project.group } : {}) }, { version: sheet.resource_version });
}

/** The plan of 2024: the only capital line the built projects have. A plan of its own year, apart from the plans of 2025 and 2026. */
async function plan2024(ctx: SeedContext, plan: EnterprisePlan, ids: Map<string, string>): Promise<void> {
  const code = 'KHV-2024';
  const funded = NEW_PROJECTS.filter((project) => project.funded !== undefined);
  const find = (): Promise<Obj | undefined> => ctx.find(MAKER, '/resources/plan_version', (row) => row.plan_code === code);
  let current = await find();
  if (current?.status === 'PUBLISHED') return;
  const totals = { VCSH: 0, VAY: 0 };
  for (const project of funded) {
    totals.VCSH += project.funded?.[0] ?? 0;
    totals.VAY += project.funded?.[1] ?? 0;
  }
  const funds = new Map((await ctx.list(MAKER, '/master-records', { master_type: 'FUND_SOURCE' })).map((row) => [String(row.business_key), String(row.version_id)]));
  const known = await ctx.list<Obj>(MAKER, '/appropriations');
  const appropriationIds = new Map<string, string>();
  for (const spec of plan.capital.appropriations) {
    const symbol = text(`capital2024.${spec.key}.symbol`);
    let row = known.find((one) => String((one.fund_source as Obj | undefined)?.business_key) === spec.fund && Number(one.plan_year) === 2024 && Number(one.source_year) === 2024);
    if (row === undefined) {
      const letter = await ctx.letter({ symbol, title: text(`capital2024.${spec.key}.title`), issuedOn: text(`capital2024.${spec.key}.issuedOn`), sender: spec.authority, docType: 'QD' });
      const created = await ctx.command(MAKER, '/appropriations', {
        fund_source_version_id: funds.get(spec.fund),
        plan_year: 2024,
        origin: spec.origin,
        budget_level: spec.level,
        ...(spec.decisionKind === undefined ? {} : { decision_kind: spec.decisionKind }),
        amount_vnd: vnd(totals[spec.key] + 12),
        decision_document_id: letter.documentId,
        issuing_authority: spec.authority,
        source_year: 2024,
      });
      row = { id: created.resource_id, status: created.status, version: created.resource_version };
    }
    if (row.status === 'DRAFT') await ctx.command(LEADER, `/appropriations/${String(row.id)}/decision`, { decision: 'approve', reason: text('capital2024.reason', symbol) }, { version: Number(row.version) });
    appropriationIds.set(spec.key, String(row.id));
  }
  if (current === undefined) {
    await ctx.command(MAKER, '/capital-plans', { plan_code: code, plan_kind: 'ANNUAL', plan_year: 2024, period_from_year: 2024, period_to_year: 2024, scope_unit_id: ctx.unitId('CB-SKHDT') });
    current = await find();
  }
  if (current === undefined) throw new Error(`the plan ${code} cannot be found after it was created`);
  if (current.status === 'DRAFT' && Number((current.totals as Obj | undefined)?.line_count ?? 0) === 0) {
    const lines = funded.flatMap((project) => [
      { project_id: ids.get(project.code), appropriation_id: appropriationIds.get('VCSH'), bucket: 'EQUITY', source_year: 2024, amount_vnd: vnd(project.funded?.[0] ?? 0) },
      { project_id: ids.get(project.code), appropriation_id: appropriationIds.get('VAY'), bucket: 'LOAN', source_year: 2024, amount_vnd: vnd(project.funded?.[1] ?? 0) },
    ]);
    const reply = await ctx.command(MAKER, `/capital-plans/${String(current.id)}/allocations`, { lines, note: text('capital2024.plan.note') }, { version: Number(current.version) });
    current = { ...current, version: reply.resource_version };
  }
  if (current.status === 'DRAFT') {
    const submitted = await ctx.command(MAKER, `/capital-plans/${String(current.id)}/submit`, {}, { version: Number(current.version) });
    current = { ...current, status: submitted.status, version: submitted.resource_version };
  }
  if (current.status === 'IN_REVIEW') {
    const decided = await ctx.command(LEADER, `/capital-plans/${String(current.id)}/decision`, { decision: 'approve', reason: text('capital2024.plan.reason') }, { version: Number(current.version) });
    current = { ...current, status: decided.status, version: decided.resource_version };
  }
  if (current.status === 'APPROVED') {
    const decision = await ctx.letter({ symbol: text('capital2024.plan.decision.symbol'), title: text('capital2024.plan.decision.title'), issuedOn: text('capital2024.plan.decision.issuedOn'), sender: text('capital2024.plan.decision.sender'), docType: 'QD' });
    await ctx.command(LEADER, `/plans/${String(current.id)}/publish`, { decision_document_id: decision.documentId }, { version: Number(current.version) });
  }
  ctx.record({ module: 'CAP', screen: 'CAP-03', kind: 'capital-plan', id: String(current.id), code, note: 'published (projects of the end of the life cycle)' });
}

/** The system moves the projects of a published plan to BUDGETED a moment after the event: wait for it. */
async function untilBudgeted(ctx: SeedContext, ids: Map<string, string>): Promise<void> {
  const waiting = NEW_PROJECTS.filter((project) => project.funded !== undefined);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const states = await Promise.all(waiting.map(async (project) => String((await projectNow(ctx, String(ids.get(project.code)))).status)));
    if (states.every((state) => reached(state, 'BUDGETED'))) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
  }
  ctx.warn('the projects of the plan of 2024 did not reach BUDGETED in time');
}

async function startAndStop(ctx: SeedContext, id: string, project: NewProject): Promise<void> {
  let now = await projectNow(ctx, id);
  const stage = async (path: string, body: Obj): Promise<void> => {
    await ctx.command(MAKER, `/projects/${id}/${path}`, body, { version: Number(now.version) });
    now = await projectNow(ctx, id);
  };
  const letter = (symbol: string, title: string): Promise<{ documentId: string }> => ctx.letter({ symbol, title, issuedOn: ctx.day(-60), sender: text('stage.start.sender') });
  if (now.status === 'BUDGETED') {
    const decision = await letter(text('stage.start.symbol', `${sevenDigits(project.code)}`), text('stage.start.title', project.name));
    await stage('implementation-start', { reason: text('stage.start.reason'), investment_decision_document_id: decision.documentId, effective_date: ctx.day(-300) });
  }
  if (now.status === 'IMPLEMENTATION' && project.lifecycleTarget === 'SUSPENDED') {
    const decision = await letter(text('stage.suspend.symbol'), text('stage.suspend.title'));
    await stage('suspension', { reason: text('stage.suspend.reason'), decision_document_id: decision.documentId, effective_date: ctx.day(-20) });
  }
  if (now.status === 'IMPLEMENTATION' && (project.lifecycleTarget === 'COMPLETED' || project.lifecycleTarget === 'SETTLED')) {
    const decision = await letter(text('stage.complete.symbol', `${220 + Number(sevenDigits(project.code)) % 70}`), text('stage.complete.title', project.name));
    await stage('completion', { reason: text('stage.complete.reason'), decision_document_id: decision.documentId, effective_date: ctx.day(-90) });
  }
}

/** Settlement of the whole project (PRJ-12): opened and sent by the officer, taken up and verified by the owner, closed by the owner on a decision (the person who opened it does not close it). */
async function settle(ctx: SeedContext, id: string, project: NewProject, toClose: boolean): Promise<void> {
  const read = async (): Promise<Obj | undefined> => (await ctx.list<Obj>(MAKER, '/resources/settlement_revision')).find((row) => String((row.project as Obj | undefined)?.id ?? row.project_id) === id && row.status !== 'SUPERSEDED');
  let settlement = await read();
  if (settlement === undefined) {
    const opened = await tolerate(ctx, `open the settlement of ${project.code}`, () => ctx.command(MAKER, '/settlements', { project_id: id, settlement_scope: 'PROJECT' }));
    if (opened === undefined) return;
    settlement = await read();
  }
  if (settlement === undefined) return;
  const sid = String(settlement.id);
  const step = async (person: string, action: string, body: Obj): Promise<boolean> => {
    const current = (await ctx.get<Obj>(person, `/resources/settlement_revision/${sid}`));
    const done = await tolerate(ctx, `settlement ${action} of ${project.code}`, () => ctx.command(person, `/settlements/${sid}/${action}`, body, { version: Number(current.version) }));
    return done !== undefined;
  };
  if (settlement.status === 'DRAFT') await step(MAKER, 'submit', { submitted_on: ctx.day(-30) });
  if (!toClose) return;
  let status = String((await ctx.get<Obj>(OWNER, `/resources/settlement_revision/${sid}`)).status);
  if (status === 'SUBMITTED' && (await step(OWNER, 'verification', { outcome: 'VERIFYING', findings: text('settlement.verify.take') }))) status = 'VERIFYING';
  if (status === 'VERIFYING' && (await step(OWNER, 'verification', { outcome: 'VERIFIED', findings: text('settlement.verify.ok') }))) status = 'VERIFIED';
  if (status === 'VERIFIED') {
    const decision = await paper(ctx, { symbol: text('settlement.close.symbol', `${240 + Number(sevenDigits(project.code)) % 50}`), title: text('settlement.close.title', project.name), type: 'QD', sender: text('settlement.close.sender'), issuedOn: ctx.day(-20) });
    await step(OWNER, 'close', { decision: 'approve', reason: text('settlement.close.reason'), evidence_ids: [], decision_document_version_id: decision.versionId });
  }
}

/** The lessons learned of a finished project (PRJ-29): proposed by the officer, approved by the leader. */
async function lessons(ctx: SeedContext, id: string): Promise<void> {
  const view = await ctx.get<Obj>(MAKER, `/projects/${id}/lessons`);
  if (((view.lessons ?? []) as Obj[]).length > 0) return;
  for (const lesson of list<{ category: string; title: string; situation: string; recommendation: string }>('lessons')) {
    const proposed = await ctx.command(MAKER, `/projects/${id}/lessons`, lesson);
    await ctx.command(LEADER, `/lessons/${proposed.resource_id}/decision`, { decision: 'APPROVE', note: text('lessons.approve') }, { version: proposed.resource_version });
  }
}

async function endOfLifeCycle(ctx: SeedContext, plan: EnterprisePlan): Promise<void> {
  const ids = new Map<string, string>();
  for (const project of NEW_PROJECTS) {
    const id = await ctx.step('PRJ', `register ${project.code}`, () => registerPortfolioProject(ctx, project));
    ids.set(project.code, id);
    ctx.record({ module: 'PRJ', screen: 'PRJ-01', kind: 'project', id, code: project.code, note: project.lifecycleTarget });
  }
  for (const project of NEW_PROJECTS) {
    const id = String(ids.get(project.code));
    if (project.lifecycleTarget === 'CONCEPT') continue;
    await ctx.step('PRJ', `appraisal of ${project.code}`, async () => {
      await submitForAppraisal(ctx, id, project);
      if (project.lifecycleTarget === 'APPRAISAL') return;
      await appraise(ctx, id, project, project.lifecycleTarget === 'REJECTED' ? 'REJECT' : 'ADMIT');
      const now = await projectNow(ctx, id);
      if (project.national !== undefined && reached(String(now.status), 'PIPELINE') && (now.national_project_code === null || now.national_project_code === undefined)) {
        await ctx.command(MAKER, `/projects/${id}/national-code`, { national_project_code: project.national }, { version: Number(now.version) });
      }
    });
  }
  await ctx.step('CAP', 'plan of 2024 for the projects that were built', () => plan2024(ctx, plan, ids));
  await ctx.step('PRJ', 'projects of the plan of 2024 are budgeted', () => untilBudgeted(ctx, ids));
  for (const project of NEW_PROJECTS.filter((one) => one.funded !== undefined)) {
    const id = String(ids.get(project.code));
    await ctx.step('PRJ', `start, suspend or complete ${project.code}`, () => startAndStop(ctx, id, project));
    if (project.lifecycleTarget === 'COMPLETED') await ctx.step('PAY', `settlement of ${project.code} (sent, waiting)`, () => settle(ctx, id, project, false));
    if (project.lifecycleTarget === 'SETTLED') {
      await ctx.step('PAY', `settlement of ${project.code} (closed)`, () => settle(ctx, id, project, true));
      await ctx.step('PRJ', `lessons learned of ${project.code}`, () => lessons(ctx, id));
    }
  }
}

// ---- the group ------------------------------------------------------------------------------------------------------------------------------

export async function seedClipEnterpriseLifecycle(ctx: SeedContext): Promise<void> {
  const plan = clipPlan() as unknown as EnterprisePlan | undefined;
  if (plan === undefined || plan.dataset !== 'enterprise') {
    ctx.warn('no enterprise clip plan (CLIP_PLAN_FILE): the group has nothing to do');
    return;
  }
  await ctx.step('PRJ', 'projects of the end of the life cycle', () => endOfLifeCycle(ctx, plan));

  const rows = await ctx.list<Obj>(MAKER, '/resources/project');
  const byCode = new Map<string, Working>();
  const kinds = new Map(plan.projects.map((project) => [project.code, project] as const));
  for (const row of rows) {
    const code = String(row.code);
    const planned = kinds.get(code);
    const added = NEW_PROJECTS.find((project) => project.code === code);
    const spec = planned ?? added;
    if (spec === undefined) continue;
    byCode.set(code, {
      id: String(row.id),
      code,
      name: String(row.name),
      kind: planned?.kind ?? (spec.type === 'PROCUREMENT' ? 'EQUIPMENT' : 'INVESTMENT'),
      totalBillions: spec.totalBillions,
      startYear: spec.startYear,
      status: String(row.status),
      ...(spec.leader === undefined ? {} : { leader: spec.leader }),
    });
  }
  const groups = await ctx.step('PRJ', 'risk groups of the register', () => riskGroups(ctx));
  const working = [...byCode.values()].filter((project) => ['BUDGETED', 'IMPLEMENTATION', 'SUSPENDED', 'COMPLETED', 'SETTLED', 'CLOSED'].includes(project.status));
  for (const project of working) {
    await ctx.step('PRJ', `who answers for ${project.code}`, () => assignLeader(ctx, project));
  }
  for (const project of working.filter((one) => ['BUDGETED', 'IMPLEMENTATION'].includes(one.status))) {
    const parts = await ctx.step('PRJ', `work breakdown of ${project.code}`, () => components(ctx, project));
    await ctx.step('PRJ', `milestones of ${project.code}`, () => milestones(ctx, project, parts));
    await ctx.step('PRJ', `risks of ${project.code}`, () => risks(ctx, project, groups));
  }
  await ctx.step('PRJ', 'task forces', () => taskForces(ctx, byCode));
  await ctx.step('PRJ', 'explanations asked by the leader', () => explanations(ctx, byCode));
  await ctx.step('PRJ', 'changes proposed to projects', () => revisions(ctx, byCode));
  await ctx.step('AST', 'handover of the compressor', () => equipmentHandover(ctx, byCode));
}
