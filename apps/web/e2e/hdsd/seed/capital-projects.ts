import { vnd } from './context.ts';
import type { Obj , SeedContext} from './context.ts';
import { AREAS, BASE_PROJECTS, DECISION, masterRecord, publishArea } from './base.ts';
import TEXTS from './data/capital-projects.json' with { type: 'json' };
import { textsOf } from '../../support/texts.ts';

const tx = textsOf(TEXTS);

/**
 * The portfolio of projects of the Department of Planning and Investment of Cao Bang, in every stage of the PIMA life cycle, made through the
 * commands of PRJ: registered by the project manager, appraised by the owner of the tenant (the proposer does not score) and decided by the leader,
 * given a national code, then (after the capital plan is published, capital-plan.ts) started, suspended or completed by decision of the people's committee.
 */

export type Target = 'CONCEPT' | 'APPRAISAL' | 'PIPELINE' | 'REJECTED' | 'BUDGETED' | 'IMPLEMENTATION' | 'SUSPENDED' | 'COMPLETED';

export interface ProjectSpec {
  code: string;
  name: string;
  area: string;
  sector: string;
  type: 'NEW_BUILD' | 'UPGRADE' | 'PREPARATION' | 'PROCUREMENT';
  program?: 'NTM' | 'DTTS' | 'GNBV';
  totalBillions: number;
  startYear: number;
  endYear: number;
  target: Target;
  /** The group of the appraisal decision (by the thresholds of the total investment). */
  group: 'A' | 'B' | 'C';
  /** National code on the public-investment system (seven digits) for the projects that reach the capital plan. */
  national?: string;
  /** Capital of the annual plan of the year, in billions, for the projects the plan funds. */
  planBillions?: number;
  /** The person in charge (accountability assignment). */
  leader?: string;
}

/** The wards and communes the portfolio needs besides the three of clip 02 (proposed, approved and published like them). */
export const MORE_AREAS = [
  { key: 'CB-HOP-GIANG', name: tx('name.001') },
  { key: 'CB-SONG-HIEN', name: tx('name.002') },
  { key: 'CB-QUANG-HOA', name: tx('name.003') },
  { key: 'CB-BAN-GIOC', name: tx('name.004') },
  { key: 'CB-TAM-KIM', name: tx('name.005') },
];

const BASE_BY_CODE = new Map(BASE_PROJECTS.map((project) => [project.code, project]));

/** The three projects of clip 03 first (same code, name, ward, sector, total), then the rest of the portfolio. */
export const PROJECTS: ProjectSpec[] = [
  { code: 'DA-DT205', name: BASE_BY_CODE.get('DA-DT205')?.name ?? '', area: 'CB-THUC-PHAN', sector: 'TRANSPORT', type: 'UPGRADE', totalBillions: 150, startYear: 2026, endYear: 2028, target: 'IMPLEMENTATION', group: 'B', national: '7891234', planBillions: 90, leader: 'capApprover' },
  { code: 'DA-TH012', name: BASE_BY_CODE.get('DA-TH012')?.name ?? '', area: 'CB-NUNG-TRI-CAO', sector: 'EDUCATION', type: 'NEW_BUILD', totalBillions: 45, startYear: 2026, endYear: 2027, target: 'IMPLEMENTATION', group: 'C', national: '7891235', planBillions: 30, leader: 'projectManager' },
  { code: 'DA-YT007', name: BASE_BY_CODE.get('DA-YT007')?.name ?? '', area: 'CB-TAN-GIANG', sector: 'HEALTH', type: 'UPGRADE', totalBillions: 12, startYear: 2026, endYear: 2027, target: 'BUDGETED', group: 'C', national: '7891236', planBillions: 8, leader: 'projectManager' },
  { code: 'DA-NN031', name: tx('name.006'), area: 'CB-QUANG-HOA', sector: 'AGRICULTURE', type: 'UPGRADE', program: 'NTM', totalBillions: 78, startYear: 2026, endYear: 2028, target: 'IMPLEMENTATION', group: 'C', national: '7891237', planBillions: 40, leader: 'projectManager' },
  { code: 'DA-MT019', name: tx('name.007'), area: 'CB-SONG-HIEN', sector: 'ENVIRONMENT', type: 'NEW_BUILD', totalBillions: 96, startYear: 2025, endYear: 2027, target: 'SUSPENDED', group: 'C', national: '7891238', planBillions: 25, leader: 'capApprover' },
  { code: 'DA-CN026', name: tx('name.008'), area: 'CB-HOP-GIANG', sector: 'URBAN', type: 'NEW_BUILD', totalBillions: 38, startYear: 2025, endYear: 2026, target: 'COMPLETED', group: 'C', national: '7891239', planBillions: 38, leader: 'projectManager' },
  { code: 'DA-VH044', name: tx('name.009'), area: 'CB-TAM-KIM', sector: 'CULTURE_SPORT', type: 'UPGRADE', totalBillions: 64, startYear: 2026, endYear: 2028, target: 'BUDGETED', group: 'C', national: '7891240', planBillions: 20, leader: 'capApprover' },
  { code: 'DA-GT118', name: tx('name.010'), area: 'CB-BAN-GIOC', sector: 'TRANSPORT', type: 'NEW_BUILD', totalBillions: 480, startYear: 2027, endYear: 2030, target: 'APPRAISAL', group: 'B' },
  { code: 'DA-GD022', name: tx('name.011'), area: 'CB-SONG-HIEN', sector: 'EDUCATION', type: 'NEW_BUILD', totalBillions: 62, startYear: 2027, endYear: 2029, target: 'APPRAISAL', group: 'C' },
  { code: 'DA-ICT03', name: tx('name.012'), area: 'CB-THUC-PHAN', sector: 'ICT', type: 'NEW_BUILD', totalBillions: 55, startYear: 2027, endYear: 2028, target: 'PIPELINE', group: 'C' },
  { code: 'DA-TL001', name: tx('name.013'), area: 'CB-BAN-GIOC', sector: 'AGRICULTURE', type: 'NEW_BUILD', totalBillions: 2450, startYear: 2027, endYear: 2032, target: 'PIPELINE', group: 'A' },
  { code: 'DA-DC071', name: tx('name.014'), area: 'CB-TAN-GIANG', sector: 'URBAN', type: 'NEW_BUILD', totalBillions: 29, startYear: 2027, endYear: 2028, target: 'REJECTED', group: 'C' },
  { code: 'DA-TT015', name: tx('name.015'), area: 'CB-TAM-KIM', sector: 'CULTURE_SPORT', type: 'NEW_BUILD', totalBillions: 22, startYear: 2027, endYear: 2028, target: 'CONCEPT', group: 'C' },
];

const STAGE_ORDER = ['CONCEPT', 'APPRAISAL', 'PIPELINE', 'BUDGETED', 'IMPLEMENTATION', 'SUSPENDED', 'COMPLETED'];

export interface PortfolioProject extends ProjectSpec {
  id: string;
}

export async function projectByCode(ctx: SeedContext, code: string): Promise<Obj | undefined> {
  return ctx.find('projectManager', '/resources/project', (row) => row.code === code);
}

/** A fresh read of one project (its status and version change with every command). */
export function projectNow(ctx: SeedContext, id: string): Promise<Obj> {
  return ctx.get('projectManager', `/resources/project/${id}`);
}

export async function publishMoreAreas(ctx: SeedContext): Promise<void> {
  const decision = await ctx.letter({ symbol: tx('symbol.016'), title: tx('title.017'), issuedOn: '2026-06-20', sender: DECISION.sender });
  const province = await masterRecord(ctx, 'AREA', 'CAO-BANG');
  if (province === undefined) throw new Error(tx('publishMoreAreas.018'));
  for (const area of [...AREAS, ...MORE_AREAS]) await publishArea(ctx, area, decision.documentId, province);
}

/** Registers a project (skips one that exists) with the whole profile: investor unit, years, type and programme, so no field of its record is empty. */
export async function registerPortfolioProject(ctx: SeedContext, spec: ProjectSpec): Promise<string> {
  const existing = await projectByCode(ctx, spec.code);
  const area = await masterRecord(ctx, 'AREA', spec.area);
  const sector = await masterRecord(ctx, 'SECTOR', spec.sector);
  const type = await masterRecord(ctx, 'PROJECT_TYPE', spec.type);
  const program = spec.program === undefined ? undefined : await masterRecord(ctx, 'PROGRAM', spec.program);
  if (area?.version_id === undefined || area.version_id === null || sector?.version_id === undefined || type?.version_id === undefined) throw new Error(`the ward ${spec.area}, the sector ${spec.sector} or the type ${spec.type} has no version in force`);
  const profile = {
    investor_unit_id: ctx.unitId('CB-SKHDT-QLDA'),
    sector_master_version_id: sector.version_id,
    project_type_master_version_id: type.version_id,
    ...(program?.version_id === undefined ? {} : { program_master_version_id: program.version_id }),
    start_year: spec.startYear,
    end_year: spec.endYear,
  };
  if (existing === undefined) {
    const created = await ctx.command('projectManager', '/projects', {
      code: spec.code,
      name: spec.name,
      owner_unit_id: ctx.unitId('CB-SKHDT-QLDA'),
      area_master_version_id: area.version_id,
      total_investment_vnd: vnd(spec.totalBillions),
      ...profile,
    });
    ctx.record({ module: 'PRJ', screen: 'PRJ-01', kind: 'project', id: created.resource_id, code: spec.code, note: 'registered' });
    return created.resource_id;
  }
  // The projects of clip 03 carry only what the form asked: the profile is completed by the command that is meant for it.
  if (existing.investor_unit_id === null || existing.investor_unit_id === undefined) {
    await ctx.command('projectManager', `/projects/${String(existing.id)}/profile`, profile, { version: Number(existing.version) });
  }
  ctx.record({ module: 'PRJ', screen: 'PRJ-01', kind: 'project', id: String(existing.id), code: spec.code, note: 'profile completed' });
  return String(existing.id);
}

const reached = (status: string, stage: string): boolean => STAGE_ORDER.indexOf(status) >= STAGE_ORDER.indexOf(stage);

/** The appraisal of a project in the stage APPRAISAL: scored by the owner, decided by the leader of the department. */
async function appraise(ctx: SeedContext, spec: PortfolioProject, outcome: 'ADMIT' | 'REJECT'): Promise<void> {
  const criteria = (await ctx.list('owner', '/master-records', { master_type: 'APPRAISAL_CRITERIA' }))[0];
  if (criteria?.version_id === undefined) throw new Error('no appraisal criteria in force');
  const marks = outcome === 'ADMIT' ? { POLICY_ALIGNMENT: 5, FEASIBILITY: 4, EFFECTIVENESS: 4, CAPITAL_READINESS: 4, RISK: 3 } : { POLICY_ALIGNMENT: 2, FEASIBILITY: 2, EFFECTIVENESS: 1, CAPITAL_READINESS: 1, RISK: 2 };
  const sheet = await ctx.must<{ resource_id: string; resource_version: number }>('owner', 'POST', `/projects/${spec.id}/appraisals`, {
    criteria_set_version_id: criteria.version_id,
    recommendation: outcome,
    note: outcome === 'ADMIT' ? tx('note.019') : tx('note.020'),
    scores: Object.entries(marks).map(([criterion_code, score]) => ({ criterion_code, score })),
  });
  const letter = await ctx.letter({
    symbol: tx('symbol.021', spec.code.replace(/\D/gu, '').padStart(3, '0')),
    title: tx('title.022', spec.name),
    issuedOn: ctx.day(-40),
    sender: tx('sender.023'),
  });
  await ctx.command(
    'capApprover',
    `/project-appraisals/${sheet.resource_id}/decision`,
    {
      decision: outcome,
      reason: outcome === 'ADMIT' ? tx('reason.024') : tx('reason.025'),
      decision_document_id: letter.documentId,
      ...(outcome === 'ADMIT' ? { project_group: spec.group } : {}),
    },
    { version: 1 },
  );
}

/** Moves a project along CONCEPT, APPRAISAL, PIPELINE (or REJECTED) as far as its target needs before the plan is published. */
export async function advanceToPipeline(ctx: SeedContext, spec: PortfolioProject): Promise<void> {
  let project = await projectNow(ctx, spec.id);
  if (project.status === 'CONCEPT' && spec.target !== 'CONCEPT') {
    const proposal = await ctx.letter({
      symbol: `${spec.code.replace(/\D/gu, '').padStart(3, '0')}/TTr-BQLDA`,
      title: tx('title.026', spec.name),
      issuedOn: ctx.day(-70),
      sender: tx('sender.027'),
    });
    await ctx.command('projectManager', `/projects/${spec.id}/appraisal-submissions`, { reason: tx('reason.028'), policy_proposal_document_id: proposal.documentId }, { version: Number(project.version) });
    project = await projectNow(ctx, spec.id);
  }
  if (project.status === 'APPRAISAL' && spec.target !== 'APPRAISAL') {
    await appraise(ctx, spec, spec.target === 'REJECTED' ? 'REJECT' : 'ADMIT');
    project = await projectNow(ctx, spec.id);
  }
  // The national code is what lets a project take capital (rule CXN-01 blocks the plan without it).
  if (spec.national !== undefined && reached(String(project.status), 'PIPELINE') && (project.national_project_code === null || project.national_project_code === undefined)) {
    await ctx.command('projectManager', `/projects/${spec.id}/national-code`, { national_project_code: spec.national }, { version: Number(project.version) });
  }
}

/** After the plan is published: the projects it funds are BUDGETED; the ones the story says are being built, stopped or finished move on by decision. */
export async function advanceAfterPlan(ctx: SeedContext, spec: PortfolioProject): Promise<void> {
  let project = await projectNow(ctx, spec.id);
  const wants = (stage: string): boolean => reached(spec.target, stage);
  if (project.status === 'BUDGETED' && wants('IMPLEMENTATION')) {
    const decision = await ctx.letter({
      symbol: tx('symbol.029', spec.code.replace(/\D/gu, '').padStart(3, '0')),
      title: tx('title.030', spec.name),
      issuedOn: ctx.day(-60),
    });
    await ctx.command('projectManager', `/projects/${spec.id}/implementation-start`, { reason: tx('reason.031'), investment_decision_document_id: decision.documentId, effective_date: ctx.day(-45) }, { version: Number(project.version) });
    project = await projectNow(ctx, spec.id);
  }
  if (project.status === 'IMPLEMENTATION' && spec.target === 'SUSPENDED') {
    const decision = await ctx.letter({ symbol: tx('symbol.032'), title: tx('title.033'), issuedOn: ctx.day(-20) });
    await ctx.command('projectManager', `/projects/${spec.id}/suspension`, { reason: tx('reason.034'), decision_document_id: decision.documentId, effective_date: ctx.day(-20) }, { version: Number(project.version) });
  }
  if (project.status === 'IMPLEMENTATION' && spec.target === 'COMPLETED') {
    const decision = await ctx.letter({ symbol: tx('symbol.035'), title: tx('title.036'), issuedOn: ctx.day(-12) });
    await ctx.command('projectManager', `/projects/${spec.id}/completion`, { reason: tx('reason.037'), decision_document_id: decision.documentId, effective_date: ctx.day(-12) }, { version: Number(project.version) });
  }
}
