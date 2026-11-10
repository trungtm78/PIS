import { vnd, vndMillions } from '../context.ts';
import type { CommandReply, Obj, SeedContext } from '../context.ts';
import { advanceToPipeline, projectByCode, registerPortfolioProject } from '../capital-projects.ts';
import type { PortfolioProject, ProjectSpec } from '../capital-projects.ts';
import { CHECKER, LEADER, MAKER } from '../procurement-finance/shared.ts';
import { clipPlan, clipText } from './plan.ts';
import { measuredAndAccepted, reportingPeriodId } from './public-payments.ts';

/**
 * Group `clip-ent-appraisal` (enterprise): what the appraisal and earned-value screens need and the base groups leave empty. Real commands only, every step skips what exists.
 *  - Projects at the APPRAISAL stage (PRJ-15 scores the first one, the appraisal gates read them): registered by the officer, sent to appraisal; one already holds the score sheet of the owner,
 *    the decision of the leader is left to the person who films.
 *  - Effectiveness appraisals of the finance desk (PRJ-23, PRJ-24: NPV, IRR, payback computed by the server): one computed and sent to the leader, one still a draft with its result, one approved.
 *  - The earned value of the first project under way (PRJ-26, PRJ-27): work breakdown of three packages, milestones (two done), baseline version 0, each package carried by a contract, a
 *    measured and accepted quantity on the construction contract (earned value). The actual cost comes from certified payments: the contracts of the enterprise dataset have no party for a payment (see docs/clip-data.md), so cost-based figures
 *    (CPI, EAC) are answered "not enough data" with the reason, never a zero.
 * The data is `appraisalPack` of the dataset (scripts/fixtures/clip-data/enterprise.json); the code holds keys.
 */

interface PackProject {
  code: string;
  name: string;
  area: string;
  sector: string;
  type: ProjectSpec['type'];
  totalBillions: number;
  startYear: number;
  endYear: number;
  group: ProjectSpec['group'];
  scored: boolean;
}

interface PackAppraisal {
  key: string;
  project: string;
  title: string;
  state: 'DRAFT' | 'SUBMITTED' | 'APPROVED';
  discountRatePct: string;
  lines: Array<{ period: number; capexMillions?: number; benefitMillions?: number; opexMillions?: number; residualMillions?: number }>;
}

interface PackEvm {
  project: string;
  /** The contract whose measured quantity is accepted (earned value). */
  acceptedContract: string;
  /** Each first-level package is carried by one contract (a contract carries one package). */
  links: Array<{ contract: string; component: string }>;
  components: Array<{ code: string; name: string; share: number }>;
  milestones: Array<{ code: string; name: string; component: string; baselineDays: number; doneAfterDays?: number }>;
}

export interface AppraisalPack {
  projects: PackProject[];
  appraisals: PackAppraisal[];
  assumptions: Record<string, { unit: string; source: string }>;
  evm: PackEvm;
  documents: Array<{ project: string; docClass: string; title: string; reference: string; contract?: string; lines: string[]; changes: string[] }>;
  comments: Array<{ document: string; body: string; resolved: boolean }>;
  narratives: Array<{ project: string; period: string; kind: 'previous' | 'inherited' | 'filled'; fields?: Record<string, string>; own?: Record<string, string> }>;
}

/** The pack of the enterprise plan, or undefined (with a warning) when the stack has no enterprise plan. */
export function appraisalPack(ctx: SeedContext): AppraisalPack | undefined {
  const plan = clipPlan() as unknown as { dataset?: string; appraisalPack?: AppraisalPack } | undefined;
  if (plan === undefined || plan.dataset !== 'enterprise' || plan.appraisalPack === undefined) {
    ctx.warn('no enterprise clip plan with an appraisal pack (CLIP_PLAN_FILE): the group has nothing to do');
    return undefined;
  }
  return plan.appraisalPack;
}

// ---- projects at the appraisal stage ------------------------------------------------------------------------------------------------------

async function recordScoreSheet(ctx: SeedContext, projectId: string): Promise<void> {
  const existing = await ctx.get<Obj>('owner', `/projects/${projectId}/appraisals`).catch(() => undefined);
  const sheets = (Array.isArray(existing) ? existing : (existing?.items ?? existing?.sheets ?? [])) as Obj[];
  if (sheets.length > 0) return;
  const criteria = (await ctx.list('owner', '/master-records', { master_type: 'APPRAISAL_CRITERIA' }))[0];
  if (criteria?.version_id === undefined) throw new Error('no appraisal criteria in force');
  const marks = { POLICY_ALIGNMENT: 5, FEASIBILITY: 4, EFFECTIVENESS: 4, CAPITAL_READINESS: 3, RISK: 3 };
  await ctx.command('owner', `/projects/${projectId}/appraisals`, {
    criteria_set_version_id: criteria.version_id,
    recommendation: 'ADMIT',
    note: clipText('appraisal.note'),
    scores: Object.entries(marks).map(([criterion_code, score]) => ({ criterion_code, score })),
  });
}

async function appraisalProjects(ctx: SeedContext, pack: AppraisalPack): Promise<void> {
  for (const spec of pack.projects) {
    const project: ProjectSpec = { code: spec.code, name: spec.name, area: spec.area, sector: spec.sector, type: spec.type, totalBillions: spec.totalBillions, startYear: spec.startYear, endYear: spec.endYear, target: 'APPRAISAL', group: spec.group };
    const id = await ctx.step('PRJ', `register ${spec.code}`, () => registerPortfolioProject(ctx, project));
    const portfolio: PortfolioProject = { ...project, id };
    await ctx.step('PRJ', `send ${spec.code} to appraisal`, () => advanceToPipeline(ctx, portfolio));
    if (spec.scored) await ctx.step('PRJ', `score sheet of ${spec.code}`, () => recordScoreSheet(ctx, id));
    ctx.record({ module: 'PRJ', screen: 'PRJ-15', kind: 'project-stage', id, code: spec.code, note: spec.scored ? 'appraisal, score sheet recorded' : 'appraisal' });
  }
}

// ---- effectiveness appraisals (NPV, IRR) ---------------------------------------------------------------------------------------------

function assumptionRows(ctx: SeedContext, pack: AppraisalPack, spec: PackAppraisal): Obj[] {
  const owner = ctx.person(MAKER).membershipId;
  const sum = (pick: (line: PackAppraisal['lines'][number]) => number | undefined): number => spec.lines.reduce((total, line) => total + (pick(line) ?? 0), 0);
  const values: Record<string, string> = {
    HORIZON: String(spec.lines.length),
    DISCOUNT_RATE: spec.discountRatePct,
    CAPEX: vndMillions(sum((line) => line.capexMillions)),
    BENEFIT: vndMillions(sum((line) => line.benefitMillions)),
    OPEX: vndMillions(sum((line) => line.opexMillions)),
    RESIDUAL: vndMillions(sum((line) => line.residualMillions)),
  };
  const used = (key: string): boolean => key === 'HORIZON' || key === 'DISCOUNT_RATE' || Number(values[key]) > 0;
  return Object.entries(pack.assumptions)
    .filter(([key]) => used(key))
    .map(([key, entry]) => ({ key, value: values[key] ?? '', unit: entry.unit, source_kind: 'DOCUMENT', source: entry.source, owner_id: owner }));
}

async function financeAppraisal(ctx: SeedContext, pack: AppraisalPack, spec: PackAppraisal, known: Obj[]): Promise<void> {
  if (known.some((row) => row.title === spec.title)) return;
  const project = await projectByCode(ctx, spec.project);
  if (project === undefined) {
    ctx.warn(`the project ${spec.project} does not exist: its appraisal is left out`);
    return;
  }
  const opened = await ctx.command(MAKER, '/investment-appraisals', { title: spec.title, kind: 'FINANCIAL', project_id: String(project.id) });
  const lines = spec.lines.map((line) => ({
    period: line.period,
    ...(line.capexMillions === undefined ? {} : { capex: vndMillions(line.capexMillions) }),
    ...(line.benefitMillions === undefined ? {} : { benefit: vndMillions(line.benefitMillions) }),
    ...(line.opexMillions === undefined ? {} : { opex: vndMillions(line.opexMillions) }),
    ...(line.residualMillions === undefined ? {} : { residual: vndMillions(line.residualMillions) }),
  }));
  const edited = await ctx.command(MAKER, `/investment-appraisals/${opened.resource_id}/inputs`, { title: spec.title, period_unit: 'YEAR', discount_rate_pct: spec.discountRatePct, convention: 'END', lines, assumptions: assumptionRows(ctx, pack, spec), scenarios: [], scores: [] }, { version: opened.resource_version });
  const computed = await ctx.command(MAKER, `/investment-appraisals/${opened.resource_id}/runs`, {}, { version: edited.resource_version });
  const sent: CommandReply = spec.state === 'DRAFT' ? computed : await ctx.command(MAKER, `/investment-appraisals/${opened.resource_id}/submission`, {}, { version: computed.resource_version });
  if (spec.state === 'APPROVED') await ctx.command(LEADER, `/investment-appraisals/${opened.resource_id}/approval`, { reason: clipText('appraisal.cause') }, { version: sent.resource_version });
  ctx.record({ module: 'PRJ', screen: 'PRJ-24', kind: 'investment-appraisal', id: opened.resource_id, code: spec.key, note: spec.state });
}

async function financeAppraisals(ctx: SeedContext, pack: AppraisalPack): Promise<void> {
  const known = await ctx.list<Obj>(MAKER, '/investment-appraisals', { limit: 50 });
  for (const spec of pack.appraisals) await ctx.step('PRJ', `effectiveness appraisal ${spec.key} (${spec.state})`, () => financeAppraisal(ctx, pack, spec, known));
}

// ---- earned value ------------------------------------------------------------------------------------------------------------------------

async function componentIds(ctx: SeedContext, projectId: string): Promise<Map<string, string>> {
  const existing = await ctx.get<Obj>(MAKER, `/projects/${projectId}/components`);
  const rows = (Array.isArray(existing) ? existing : (existing.items ?? existing.components ?? [])) as Obj[];
  return new Map(rows.map((row) => [String(row.code), String(row.id)]));
}

async function earnedValue(ctx: SeedContext, pack: AppraisalPack): Promise<void> {
  const evm = pack.evm;
  const plan = clipPlan() as unknown as { projects: Array<{ code: string; totalBillions: number; startYear: number }> };
  const spec = plan.projects.find((project) => project.code === evm.project);
  const project = await projectByCode(ctx, evm.project);
  if (spec === undefined || project === undefined) {
    ctx.warn(`the project ${evm.project} does not exist: no earned value`);
    return;
  }
  const projectId = String(project.id);
  const ids = await ctx.step('PRJ', `work breakdown of ${evm.project}`, async () => {
    const known = await componentIds(ctx, projectId);
    for (const [index, part] of evm.components.entries()) {
      if (known.has(part.code)) continue;
      const made = await ctx.command(MAKER, `/projects/${projectId}/components`, { code: part.code, name: part.name, planned_value_vnd: vnd(Math.floor(spec.totalBillions * part.share)), valid_from: `${spec.startYear}-01-01`, sort_order: index + 1 });
      known.set(part.code, made.resource_id);
    }
    return known;
  });
  await ctx.step('PRJ', `milestones of ${evm.project}`, async () => {
    const existing = await ctx.get<Obj>(MAKER, `/projects/${projectId}/milestones`);
    const rows = (Array.isArray(existing) ? existing : (existing.items ?? existing.milestones ?? [])) as Obj[];
    if (rows.length > 0) return;
    for (const item of evm.milestones) {
      const day = ctx.day(item.baselineDays);
      const made = await ctx.command(MAKER, `/projects/${projectId}/milestones`, { code: item.code, name: item.name, component_id: ids.get(item.component), baseline_date: day, planned_date: day });
      if (item.doneAfterDays !== undefined) await ctx.command(MAKER, `/project-milestones/${made.resource_id}/progress`, { status: 'DONE', actual_date: ctx.day(item.baselineDays + item.doneAfterDays) }, { version: made.resource_version });
    }
  });
  await ctx.step('PRJ', `baseline version 0 of ${evm.project}`, async () => {
    const taken = await ctx.call(MAKER, 'POST', `/projects/${projectId}/baseline`, {});
    if (!taken.ok && taken.json.code !== 'BASELINE_ALREADY_TAKEN') ctx.expectOk(taken, 'take the baseline');
  });
  const contracts = await ctx.list<Obj>(MAKER, '/resources/contract');
  const contractOf = (code: string): Obj | undefined => contracts.find((row) => row.code === code);
  await ctx.step('PRJ', `each package of ${evm.project} is carried by a contract`, async () => {
    for (const link of evm.links) {
      const carrier = contractOf(link.contract);
      if (carrier === undefined || carrier.status !== 'ACTIVE') {
        ctx.warn(`the contract ${link.contract} is not active: package ${link.component} has no contract`);
        continue;
      }
      const linked = await ctx.call(MAKER, 'POST', `/projects/${projectId}/component-contracts`, { contract_id: String(carrier.id), component_id: ids.get(link.component) });
      if (!linked.ok && linked.json.code !== 'COMPONENT_CONTRACT_UNCHANGED') ctx.warn(`link of the contract ${link.contract}: HTTP ${linked.status} ${linked.text.slice(0, 200)}`);
    }
  });
  const contract = contractOf(evm.acceptedContract);
  if (contract === undefined || contract.status !== 'ACTIVE') {
    ctx.warn(`the contract ${evm.acceptedContract} is not active: earned value has no accepted quantity`);
    return;
  }
  const tag = evm.acceptedContract.replace('HD-', '');
  const approved = (await ctx.list<Obj>(CHECKER, '/resources/acceptance', { contract_id: String(contract.id) })).find((row) => row.status === 'APPROVED');
  const acceptance = await ctx.step('CTR', `measurement and acceptance of ${evm.acceptedContract}`, async () => {
    if (approved !== undefined) return String(approved.id);
    const periodId = await reportingPeriodId(ctx, ctx.year);
    if (periodId === undefined) {
      ctx.warn('no reporting period for the measurement');
      return undefined;
    }
    return measuredAndAccepted(ctx, contract, periodId, tag);
  });
  ctx.record({ module: 'PRJ', screen: 'PRJ-27', kind: 'earned-value', id: String(contract.id), code: evm.project, note: acceptance === undefined ? 'baseline only' : 'baseline, accepted quantity' });
}

export async function seedClipEnterpriseAppraisal(ctx: SeedContext): Promise<void> {
  const pack = appraisalPack(ctx);
  if (pack === undefined) return;
  await appraisalProjects(ctx, pack);
  await financeAppraisals(ctx, pack);
  await earnedValue(ctx, pack);
}
