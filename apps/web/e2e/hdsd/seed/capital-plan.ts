import { vnd } from './context.ts';
import type { Obj , SeedContext} from './context.ts';
import { PROJECTS, projectByCode } from './capital-projects.ts';
import { asObj } from './context.ts';
import TEXTS from './data/capital-plan.json' with { type: 'json' };
import { textsWithOverlay } from './overlay.ts';

const tx = textsWithOverlay('capital-plan', TEXTS);

/**
 * The capital of the year 2026 of the province: the decisions that assign it (appropriations of the central and the local budget, the carry-over of
 * 2025, the support of the centre), the capital plan of the year drafted by the project manager, submitted, decided by the leader and published
 * with the decision that assigns the plan. Publishing the plan is what makes the projects it funds BUDGETED (the platform answers the event).
 */

export interface AppropriationSpec {
  key: string;
  fund: string;
  /** The five origins of the public pack, then the two of the enterprise pack (ENT-3e); the register judges which of them the edition takes. */
  origin: 'PM_ASSIGNED' | 'LOCAL_ADDED' | 'CARRYOVER' | 'CENTRAL_SUPPORT' | 'REVENUE_INCREASE' | 'GROUP_ASSIGNED' | 'BOARD_APPROVED';
  level: 'CENTRAL' | 'LOCAL' | 'ALL';
  /** The kind of the decision document: required by the enterprise pack, never sent to the public one. */
  decisionKind?: string;
  program?: 'NTM' | 'DTTS' | 'GNBV';
  billions: number;
  authority: string;
  sourceYear: number;
  letter: { symbol: string; title: string; issuedOn: string; sender: string };
  extendedTo?: string;
  /** What the decision of the leader is: approve (published) or leave in the draft queue. */
  decide: 'approve' | 'pending';
}

const PRIME_MINISTER = tx('PRIME_MINISTER.001');
const PROVINCE = tx('PROVINCE.002');

export const APPROPRIATIONS: AppropriationSpec[] = [
  { key: 'NSTW', fund: 'NSTW-DTPT', origin: 'PM_ASSIGNED', level: 'CENTRAL', billions: 120, authority: PRIME_MINISTER, sourceYear: 2026, letter: { symbol: tx('symbol.003'), title: tx('title.004'), issuedOn: '2025-12-14', sender: tx('sender.005') }, decide: 'approve' },
  { key: 'NSDP', fund: 'NSDP-DTPT', origin: 'LOCAL_ADDED', level: 'LOCAL', billions: 180, authority: PROVINCE, sourceYear: 2026, letter: { symbol: tx('symbol.006'), title: tx('title.007'), issuedOn: '2025-12-28', sender: PROVINCE }, decide: 'approve' },
  { key: 'NTM', fund: 'NSTW-DTPT', origin: 'CENTRAL_SUPPORT', level: 'CENTRAL', program: 'NTM', billions: 60, authority: PRIME_MINISTER, sourceYear: 2026, letter: { symbol: tx('symbol.008'), title: tx('title.009'), issuedOn: '2025-12-14', sender: tx('sender.005') }, decide: 'approve' },
  { key: 'CARRY', fund: 'NSDP', origin: 'CARRYOVER', level: 'LOCAL', billions: 25, authority: PROVINCE, sourceYear: 2025, extendedTo: '2026-12-31', letter: { symbol: tx('symbol.010'), title: tx('title.011'), issuedOn: '2026-01-20', sender: PROVINCE }, decide: 'approve' },
  { key: 'SUPPORT', fund: 'ODA-NONLEND', origin: 'CENTRAL_SUPPORT', level: 'CENTRAL', billions: 30, authority: tx('authority.012'), sourceYear: 2026, letter: { symbol: tx('symbol.013'), title: tx('title.014'), issuedOn: '2026-03-18', sender: tx('authority.012') }, decide: 'approve' },
  { key: 'REVENUE', fund: 'NSDP', origin: 'REVENUE_INCREASE', level: 'LOCAL', billions: 20, authority: PROVINCE, sourceYear: 2026, letter: { symbol: tx('symbol.015'), title: tx('title.016'), issuedOn: ctxDate(-9), sender: PROVINCE }, decide: 'pending' },
];

/** A fixed date for the letters that arrived in the last weeks: relative to the fixed "as of" day the seed is run on. */
function ctxDate(offset: number): string {
  const day = new Date(Date.now() + offset * 86_400_000 + 7 * 3_600_000);
  return day.toISOString().slice(0, 10);
}

export interface LineSpec {
  project: string;
  appropriation: string;
  billions: number;
  /** The class of the line: the two buckets of the public pack, or a class of the enterprise pack (EQUITY, LOAN, OTHER). */
  bucket?: 'CURRENT_YEAR' | 'CARRYOVER' | 'EQUITY' | 'LOAN' | 'OTHER';
  sourceYear?: number;
  ctmtqg?: boolean;
}

/** Which appropriation each project is funded from (billions of dong): the shape of the plan of the year. */
export const LINES: LineSpec[] = [
  { project: 'DA-DT205', appropriation: 'NSTW', billions: 70 },
  { project: 'DA-DT205', appropriation: 'NSDP', billions: 20 },
  { project: 'DA-TH012', appropriation: 'NSDP', billions: 30 },
  { project: 'DA-YT007', appropriation: 'NSDP', billions: 8 },
  { project: 'DA-NN031', appropriation: 'NTM', billions: 40, ctmtqg: true },
  { project: 'DA-MT019', appropriation: 'CARRY', billions: 25, bucket: 'CARRYOVER', sourceYear: 2025 },
  { project: 'DA-CN026', appropriation: 'SUPPORT', billions: 30 },
  { project: 'DA-CN026', appropriation: 'NSDP', billions: 8 },
  { project: 'DA-VH044', appropriation: 'NSDP', billions: 20 },
];

/** The appropriation of a spec as the register has it now (by fund source, origin and year), or undefined. */
export async function appropriationOf(ctx: SeedContext, spec: AppropriationSpec): Promise<Obj | undefined> {
  return ctx.find('projectManager', '/appropriations', (row) => asObj(row.fund_source).business_key === spec.fund && row.origin === spec.origin && String(asObj(row.program).business_key ?? asObj(row.program).key ?? '') === (spec.program ?? '') && Number(row.source_year) === spec.sourceYear && Number(row.plan_year) === 2026);
}

/** Registers the assignments of capital: each cites the decision of the authority; the leader publishes them (or leaves the last one in the queue). */
export async function registerAppropriations(ctx: SeedContext): Promise<void> {
  const funds = new Map((await ctx.list('projectManager', '/master-records', { master_type: 'FUND_SOURCE' })).map((row) => [String(row.business_key), String(row.version_id)]));
  for (const spec of APPROPRIATIONS) {
    let row = await appropriationOf(ctx, spec);
    if (row === undefined) {
      const letter = await ctx.letter({ ...spec.letter, docType: 'QD' });
      const program = spec.program === undefined ? undefined : (await ctx.list('projectManager', '/master-records', { master_type: 'PROGRAM' })).find((record) => record.business_key === spec.program);
      const extension = spec.extendedTo === undefined ? undefined : await ctx.letter({ symbol: tx('symbol.017'), title: tx('title.018'), issuedOn: '2026-01-20', sender: PROVINCE });
      const created = await ctx.command('projectManager', '/appropriations', {
        fund_source_version_id: funds.get(spec.fund),
        plan_year: 2026,
        origin: spec.origin,
        budget_level: spec.level,
        ...(spec.decisionKind === undefined ? {} : { decision_kind: spec.decisionKind }),
        ...(program === undefined ? {} : { program_master_version_id: program.version_id }),
        amount_vnd: vnd(spec.billions),
        decision_document_id: letter.documentId,
        issuing_authority: spec.authority,
        source_year: spec.sourceYear,
        ...(spec.extendedTo === undefined || extension === undefined ? {} : { extended_to: spec.extendedTo, extension_document_id: extension.documentId }),
      });
      row = { id: created.resource_id, status: created.status, version: created.resource_version };
    }
    if (row.status === 'DRAFT' && spec.decide === 'approve') {
      await ctx.command('capApprover', `/appropriations/${String(row.id)}/decision`, { decision: 'approve', reason: tx('reason.019', spec.letter.symbol, spec.authority) }, { version: Number(row.version) });
    }
    ctx.record({ module: 'CAP', screen: 'CAP-16', kind: 'appropriation', id: String(row.id), code: spec.letter.symbol, note: tx('note.020', spec.origin, spec.billions) });
  }
}

async function planByCode(ctx: SeedContext, code: string): Promise<Obj | undefined> {
  return ctx.find('projectManager', '/resources/plan_version', (row) => row.plan_code === code);
}

/** Creates the plan (skips one that exists). */
export async function createPlan(ctx: SeedContext, body: { plan_code: string; plan_kind: 'MEDIUM_TERM' | 'ANNUAL'; plan_year?: number; period_from_year: number; period_to_year: number }): Promise<Obj> {
  const existing = await planByCode(ctx, body.plan_code);
  if (existing !== undefined) return existing;
  await ctx.command('projectManager', '/capital-plans', { ...body, scope_unit_id: ctx.unitId('CB-SKHDT') });
  const created = await planByCode(ctx, body.plan_code);
  if (created === undefined) throw new Error(`the plan ${body.plan_code} cannot be found after it was created`);
  return created;
}

/** Drafts the lines of the plan of the year, submits it, the leader decides, and publishes it with the decision that assigns the plan. */
export async function planOfTheYear(ctx: SeedContext): Promise<void> {
  const plan = await createPlan(ctx, { plan_code: 'KHV-2026', plan_kind: 'ANNUAL', plan_year: 2026, period_from_year: 2026, period_to_year: 2026 });
  if (plan.status === 'PUBLISHED') return;
  const projects = new Map<string, string>();
  for (const spec of PROJECTS) {
    const row = await projectByCode(ctx, spec.code);
    if (row !== undefined) projects.set(spec.code, String(row.id));
  }
  const appropriations = new Map<string, string>();
  const programs = new Map((await ctx.list('projectManager', '/master-records', { master_type: 'PROGRAM' })).map((row) => [String(row.business_key), String(row.version_id)]));
  for (const spec of APPROPRIATIONS) {
    const row = await appropriationOf(ctx, spec);
    if (row !== undefined) appropriations.set(spec.key, String(row.id));
  }
  let current = plan;
  if (current.status === 'DRAFT' && Number(asObj(current.totals).line_count ?? 0) === 0) {
    const reply = await ctx.command(
      'projectManager',
      `/capital-plans/${String(current.id)}/allocations`,
      {
        lines: LINES.map((line) => ({
          project_id: projects.get(line.project),
          appropriation_id: appropriations.get(line.appropriation),
          bucket: line.bucket ?? 'CURRENT_YEAR',
          source_year: line.sourceYear ?? 2026,
          amount_vnd: vnd(line.billions),
          ...(line.ctmtqg === true ? { ctmtqg_subset_vnd: vnd(line.billions), program_master_version_id: programs.get('NTM') } : {}),
        })),
        note: tx('note.021'),
      },
      { version: Number(current.version) },
    );
    current = { ...current, version: reply.resource_version };
  }
  if (current.status === 'DRAFT') {
    const submitted = await ctx.command('projectManager', `/capital-plans/${String(current.id)}/submit`, {}, { version: Number(current.version) });
    current = { ...current, status: submitted.status, version: submitted.resource_version };
  }
  if (current.status === 'IN_REVIEW') {
    const decided = await ctx.command('capApprover', `/capital-plans/${String(current.id)}/decision`, { decision: 'approve', reason: tx('reason.022') }, { version: Number(current.version) });
    current = { ...current, status: decided.status, version: decided.resource_version };
  }
  if (current.status === 'APPROVED') {
    const decision = await ctx.letter({ symbol: tx('symbol.023'), title: tx('title.024'), issuedOn: '2026-01-12', sender: PROVINCE });
    await ctx.command('capApprover', `/plans/${String(current.id)}/publish`, { decision_document_id: decision.documentId }, { version: Number(current.version) });
  }
  ctx.record({ module: 'CAP', screen: 'CAP-03', kind: 'capital-plan', id: String(current.id), code: 'KHV-2026', note: 'published' });
}
