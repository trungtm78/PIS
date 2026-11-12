import { vndMillions } from '../context.ts';
import type { CommandReply, Obj , SeedContext} from '../context.ts';
import { CHECKER, LEADER, MAKER, contractorsByNumber, decisionInForce, paper } from './shared.ts';
import { asObj } from '../context.ts';
import TEXTS from './data/bid.json' with { type: 'json' };
import { textsWithOverlay } from '../overlay.ts';

const tx = textsWithOverlay('bid', TEXTS);

/**
 * Module BID: the plans that choose the contractors of the funded projects, and what comes of them. The planner of the board drafts the plan of each
 * project, the leader approves it on a decision (a plan may first be given back with words); each package gets the criteria of its evaluation, the
 * milestones of its tender, and the proposals the contractors hand in, sealed until the opening of the bids; the evaluation team declares what it owes;
 * the proposer submits the result and the leader approves it, which awards the package. The tenders are at every stage on purpose: planned, invited,
 * sealed, being evaluated, waiting for the award, awarded.
 */

/** How far a package has got in the choice of its contractor. */
export type Fate = 'PLANNED' | 'INVITED' | 'SEALED' | 'EVALUATING' | 'RESULT_PENDING' | 'AWARDED';
/** How far the contract of an awarded package has got. */
export type ContractFate = 'DRAFT' | 'IN_REVIEW' | 'SIGNED' | 'ACTIVE';

export interface PackageSpec {
  code: string;
  title: string;
  /** Budget of the package, in millions of dong. */
  millions: number;
  method: 'OPEN_BIDDING' | 'LIMITED_BIDDING' | 'COMPETITIVE_QUOTATION' | 'DIRECT_APPOINTMENT';
  /** Which line of capital of the project pays (0 = the biggest). */
  line: number;
  period: string;
  days: number;
  category: 'CONSTRUCTION' | 'EQUIPMENT' | 'CONSULTING' | 'OTHER';
  fate: Fate;
  /** The contractors that bid (numbers of the table of contractors); the first of an awarded package wins. */
  bidders?: number[];
  /** Award price in millions of dong. */
  awardMillions?: number;
  contract?: ContractFate;
  /** Days before today: when the package was awarded (the contract follows). */
  awardedDaysAgo?: number;
}

export interface PlanSpec {
  project: string;
  title: string;
  /** APPROVED; RETURNED_THEN_IN_REVIEW was given back once, drawn up again and waits for the leader. */
  fate: 'APPROVED' | 'RETURNED_THEN_IN_REVIEW';
  packages: PackageSpec[];
}

const LAW = tx('LAW.001');

export const PLANS: PlanSpec[] = [
  {
    project: 'DA-DT205',
    title: tx('title.002'),
    fate: 'APPROVED',
    packages: [
      { code: 'DT205-XL01', title: tx('title.003'), millions: 38500, method: 'OPEN_BIDDING', line: 0, period: '2026-Q3', days: 540, category: 'CONSTRUCTION', fate: 'AWARDED', bidders: [3, 2, 4, 8], awardMillions: 38120, contract: 'ACTIVE', awardedDaysAgo: 70 },
      { code: 'DT205-XL02', title: tx('title.004'), millions: 26200, method: 'OPEN_BIDDING', line: 0, period: '2026-Q3', days: 540, category: 'CONSTRUCTION', fate: 'AWARDED', bidders: [2, 9, 3], awardMillions: 25940, contract: 'ACTIVE', awardedDaysAgo: 68 },
      { code: 'DT205-TV01', title: tx('title.005'), millions: 2400, method: 'LIMITED_BIDDING', line: 1, period: '2026-Q3', days: 570, category: 'CONSULTING', fate: 'AWARDED', bidders: [5, 15, 16], awardMillions: 2352, contract: 'ACTIVE', awardedDaysAgo: 66 },
      { code: 'DT205-TB01', title: tx('title.006'), millions: 7900, method: 'OPEN_BIDDING', line: 1, period: '2026-Q4', days: 150, category: 'EQUIPMENT', fate: 'RESULT_PENDING', bidders: [8, 4, 11], awardMillions: 7780 },
      { code: 'DT205-KS01', title: tx('title.007'), millions: 950, method: 'COMPETITIVE_QUOTATION', line: 1, period: '2026-Q4', days: 60, category: 'CONSULTING', fate: 'AWARDED', bidders: [15, 16], awardMillions: 936, contract: 'DRAFT', awardedDaysAgo: 12 },
    ],
  },
  {
    project: 'DA-TH012',
    title: tx('title.008'),
    fate: 'APPROVED',
    packages: [
      { code: 'TH012-XL01', title: tx('title.009'), millions: 21600, method: 'OPEN_BIDDING', line: 0, period: '2026-Q3', days: 420, category: 'CONSTRUCTION', fate: 'AWARDED', bidders: [1, 9, 4], awardMillions: 21150, contract: 'ACTIVE', awardedDaysAgo: 52 },
      { code: 'TH012-TB01', title: tx('title.010'), millions: 5200, method: 'OPEN_BIDDING', line: 0, period: '2026-Q4', days: 120, category: 'EQUIPMENT', fate: 'AWARDED', bidders: [7, 4], awardMillions: 5090, contract: 'SIGNED', awardedDaysAgo: 25 },
      { code: 'TH012-TV01', title: tx('title.011'), millions: 580, method: 'COMPETITIVE_QUOTATION', line: 0, period: '2026-Q3', days: 450, category: 'CONSULTING', fate: 'AWARDED', bidders: [15, 16], awardMillions: 565, contract: 'IN_REVIEW', awardedDaysAgo: 20 },
    ],
  },
  {
    project: 'DA-NN031',
    title: tx('title.012'),
    fate: 'APPROVED',
    packages: [
      { code: 'NN031-XL01', title: tx('title.013'), millions: 27400, method: 'OPEN_BIDDING', line: 0, period: '2026-Q3', days: 480, category: 'CONSTRUCTION', fate: 'AWARDED', bidders: [10, 3, 11], awardMillions: 26880, contract: 'ACTIVE', awardedDaysAgo: 48 },
      { code: 'NN031-XL02', title: tx('title.014'), millions: 6100, method: 'OPEN_BIDDING', line: 0, period: '2026-Q4', days: 240, category: 'CONSTRUCTION', fate: 'EVALUATING', bidders: [11, 8, 9] },
      { code: 'NN031-TV01', title: tx('title.011'), millions: 880, method: 'LIMITED_BIDDING', line: 0, period: '2026-Q4', days: 500, category: 'CONSULTING', fate: 'SEALED', bidders: [5, 16] },
    ],
  },
  {
    project: 'DA-YT007',
    title: tx('title.015'),
    fate: 'APPROVED',
    packages: [
      { code: 'YT007-XL01', title: tx('title.016'), millions: 5600, method: 'OPEN_BIDDING', line: 0, period: '2026-Q4', days: 300, category: 'CONSTRUCTION', fate: 'SEALED', bidders: [1, 9, 4] },
      { code: 'YT007-TB01', title: tx('title.017'), millions: 1700, method: 'OPEN_BIDDING', line: 0, period: '2026-Q4', days: 90, category: 'EQUIPMENT', fate: 'INVITED' },
      { code: 'YT007-TV01', title: tx('title.011'), millions: 260, method: 'DIRECT_APPOINTMENT', line: 0, period: '2027-Q1', days: 330, category: 'CONSULTING', fate: 'PLANNED' },
    ],
  },
  {
    project: 'DA-VH044',
    title: tx('title.018'),
    fate: 'RETURNED_THEN_IN_REVIEW',
    packages: [
      { code: 'VH044-XL01', title: tx('title.019'), millions: 14200, method: 'OPEN_BIDDING', line: 0, period: '2027-Q1', days: 450, category: 'CONSTRUCTION', fate: 'PLANNED' },
      { code: 'VH044-TV01', title: tx('title.020'), millions: 550, method: 'LIMITED_BIDDING', line: 0, period: '2027-Q1', days: 480, category: 'CONSULTING', fate: 'PLANNED' },
    ],
  },
];

const CONTRACT_TYPE_OF: Record<PackageSpec['category'], 'FIXED_UNIT_PRICE' | 'LUMP_SUM' | 'TIME_BASED'> = {
  CONSTRUCTION: 'FIXED_UNIT_PRICE',
  EQUIPMENT: 'LUMP_SUM',
  CONSULTING: 'TIME_BASED',
  OTHER: 'LUMP_SUM',
};

export async function projectOf(ctx: SeedContext, code: string): Promise<Obj | undefined> {
  return ctx.find(MAKER, '/resources/project', (row) => row.code === code);
}

/** The lines of capital of a project in the published plan of the year, the biggest first. */
export async function linesOf(ctx: SeedContext, projectId: string): Promise<Obj[]> {
  const rows = await ctx.list<Obj>(MAKER, '/resources/allocation_line');
  return rows.filter((row) => String(row.project_id ?? asObj(row.project).id) === projectId).sort((a, b) => Number(b.amount_vnd) - Number(a.amount_vnd));
}

export async function packageOf(ctx: SeedContext, code: string): Promise<Obj | undefined> {
  return ctx.find(MAKER, '/resources/procurement_package', (row) => row.code === code);
}

// ---- procurement plans (BID-15, BID-16, BID-03) -------------------------------------------------------------------------------------------

/** The planner of the board drafts the plan with its packages. */
async function draftPlan(ctx: SeedContext, plan: PlanSpec, projectId: string, lines: Obj[]): Promise<CommandReply> {
  return ctx.command(MAKER, '/procurement-plans', {
    project_id: projectId,
    title: plan.title,
    legal_basis: LAW,
    packages: plan.packages.map((item) => {
      const line = lines[Math.min(item.line, lines.length - 1)];
      if (line === undefined) throw new Error(`the project ${plan.project} has no line of capital`);
      return {
        code: item.code,
        title: item.title,
        budget_vnd: vndMillions(item.millions),
        method: item.method,
        contract_type: CONTRACT_TYPE_OF[item.category],
        bidding_form: 'ONLINE',
        allocation_line_id: String(line.id),
        planned_start_period: item.period,
        duration_days: item.days,
      };
    }),
  });
}

async function seedPlan(ctx: SeedContext, plan: PlanSpec, index: number): Promise<void> {
  const project = await projectOf(ctx, plan.project);
  if (project === undefined) {
    ctx.warn(`the project ${plan.project} does not exist: its plan is left out`);
    return;
  }
  const projectId = String(project.id);
  const existing = (await ctx.list<Obj>(MAKER, '/procurement-plans', { project_id: projectId })).find((row) => row.status !== 'CANCELLED');
  if (existing !== undefined) {
    ctx.record({ module: 'BID', screen: 'BID-15', kind: 'procurement-plan', id: String(existing.id), code: plan.project, note: `existing ${String(existing.status)}` });
    return;
  }
  const lines = await linesOf(ctx, projectId);
  if (lines.length === 0) {
    ctx.warn(`the project ${plan.project} has no line of capital yet: its plan is left out`);
    return;
  }
  if (plan.fate === 'RETURNED_THEN_IN_REVIEW') {
    // The first draft is given back by the leader with the words; the planner draws it up again and sends it.
    const first = await draftPlan(ctx, plan, projectId, lines);
    const sentFirst = await ctx.command(MAKER, `/procurement-plans/${first.resource_id}/submit`, {}, { version: first });
    await ctx.command(LEADER, `/procurement-plans/${first.resource_id}/decision`, { decision: 'RETURN', comment: tx('comment.021') }, { version: sentFirst });
  }
  const made = await draftPlan(ctx, plan, projectId, lines);
  const sent = await ctx.command(MAKER, `/procurement-plans/${made.resource_id}/submit`, {}, { version: made });
  if (plan.fate === 'APPROVED') {
    const decision = await decisionInForce(ctx, index);
    if (decision === undefined) {
      ctx.warn('no decision is in force yet (DOC has issued none): the plan stays in review');
    } else {
      await ctx.command(LEADER, `/procurement-plans/${made.resource_id}/decision`, { decision: 'APPROVE', decision_document_id: decision, comment: tx('comment.022') }, { version: sent });
    }
  }
  ctx.record({ module: 'BID', screen: 'BID-15', kind: 'procurement-plan', id: made.resource_id, code: plan.project, note: plan.fate });
}

// ---- the tender of a package -----------------------------------------------------------------------------------------------------------------

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function at(ctx: SeedContext, daysAgo: number, hour = 9): string {
  return new Date(Date.parse(`${ctx.day(-daysAgo)}T${String(hour).padStart(2, '0')}:00:00+07:00`)).toISOString();
}

async function packageVersion(ctx: SeedContext, id: string): Promise<number> {
  return Number((await ctx.get<Obj>(MAKER, `/resources/procurement_package/${id}`)).version);
}

async function milestonesOf(ctx: SeedContext, packageId: string): Promise<Obj[]> {
  return ctx.list<Obj>(MAKER, '/procurement-milestones', { package_id: packageId });
}

/** Records one date of a milestone under the version of the package the planner sees. */
async function milestone(ctx: SeedContext, packageId: string, kind: string, dates: { plannedAt?: string; actualAt?: string }): Promise<void> {
  const version = await packageVersion(ctx, packageId);
  await ctx.command(MAKER, `/procurement-packages/${packageId}/milestones`, { milestone_kind: kind, ...(dates.plannedAt === undefined ? {} : { planned_at: dates.plannedAt }), ...(dates.actualAt === undefined ? {} : { actual_at: dates.actualAt }) }, { version });
}

const CRITERIA: Record<PackageSpec['category'], Array<Record<string, unknown>>> = {
  CONSTRUCTION: [
    { code: 'HL', name: tx('name.023'), kind: 'PASS_FAIL', mandatory: true, required_evidence: [tx('required_evidence.024'), tx('required_evidence.025')] },
    { code: 'KN', name: tx('name.026'), kind: 'SCORED', weight: 25, max_score: 10, threshold: 5, mandatory: true, required_evidence: [tx('required_evidence.027'), tx('required_evidence.028')] },
    { code: 'TC', name: tx('name.029'), kind: 'SCORED', weight: 20, max_score: 10, threshold: 5, mandatory: false, required_evidence: [tx('required_evidence.030')] },
    { code: 'BP', name: tx('name.031'), kind: 'SCORED', weight: 35, max_score: 10, threshold: 6, mandatory: false, required_evidence: [tx('required_evidence.032')] },
    { code: 'TD', name: tx('name.033'), kind: 'SCORED', weight: 20, max_score: 10, threshold: null, mandatory: false, required_evidence: [tx('required_evidence.034')] },
  ],
  EQUIPMENT: [
    { code: 'HL', name: tx('name.023'), kind: 'PASS_FAIL', mandatory: true, required_evidence: [tx('required_evidence.024')] },
    { code: 'KT', name: tx('name.035'), kind: 'SCORED', weight: 50, max_score: 10, threshold: 6, mandatory: true, required_evidence: ['Catalogue', tx('required_evidence.036')] },
    { code: 'BH', name: tx('name.037'), kind: 'SCORED', weight: 30, max_score: 10, threshold: 5, mandatory: false, required_evidence: [tx('required_evidence.038')] },
    { code: 'TD', name: tx('name.039'), kind: 'SCORED', weight: 20, max_score: 10, threshold: null, mandatory: false, required_evidence: [] },
  ],
  CONSULTING: [
    { code: 'HL', name: tx('name.040'), kind: 'PASS_FAIL', mandatory: true, required_evidence: [tx('required_evidence.041')] },
    { code: 'KN', name: tx('name.042'), kind: 'SCORED', weight: 30, max_score: 10, threshold: 6, mandatory: true, required_evidence: [tx('required_evidence.043')] },
    { code: 'NS', name: tx('name.044'), kind: 'SCORED', weight: 50, max_score: 10, threshold: 6, mandatory: true, required_evidence: [tx('required_evidence.045'), tx('required_evidence.046')] },
    { code: 'PA', name: tx('name.047'), kind: 'SCORED', weight: 20, max_score: 10, threshold: null, mandatory: false, required_evidence: [] },
  ],
  OTHER: [{ code: 'HL', name: tx('name.048'), kind: 'PASS_FAIL', mandatory: true, required_evidence: [] }, { code: 'KN', name: tx('name.049'), kind: 'SCORED', weight: 100, max_score: 10, threshold: null, mandatory: false, required_evidence: [] }],
};

/** The criteria of the evaluation: drafted by the planner, approved (and so locked) by the leader. */
async function approveCriteria(ctx: SeedContext, spec: PackageSpec, pack: Obj): Promise<void> {
  const existing = (await ctx.list<Obj>(MAKER, '/resources/criteria_version')).find((row) => String(row.package_id ?? asObj(row.package).id) === String(pack.id));
  if (existing !== undefined) return;
  const made = await ctx.command(MAKER, '/criteria-versions', { package_id: pack.id, criteria_json: { criteria: CRITERIA[spec.category] }, legal_basis: tx('legal_basis.050') });
  await ctx.command(LEADER, `/criteria-versions/${made.resource_id}/approval`, {}, { version: made });
  ctx.record({ module: 'BID', screen: 'BID-04', kind: 'criteria-version', id: made.resource_id, code: spec.code, note: 'approved' });
}

/** A short PDF of a bid volume: the words are plain (the file is read by the upload door, not by a person). */
function volume(ctx: SeedContext, spec: PackageSpec, bidder: string, part: string): Buffer {
  return ctx.pdf(`HO SO DU THAU ${spec.code}`, bidder.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').replace(/[\u0111\u0110]/gu, 'd').toUpperCase(), part);
}

interface Handed {
  proposalId: string;
  contractorNumber: number;
  contractorId: string;
}

/** The clerk logs the files each contractor handed in before the closing; every proposal is sealed until the opening. */
async function receiveProposals(ctx: SeedContext, spec: PackageSpec, pack: Obj, daysAgo: number): Promise<Handed[]> {
  const contractors = await contractorsByNumber(ctx);
  const have = await ctx.list<Obj>(MAKER, '/resources/proposal', { package_id: String(pack.id) });
  const out: Handed[] = [];
  for (const [rank, number] of (spec.bidders ?? []).entries()) {
    const contractor = contractors.get(number);
    if (contractor === undefined) throw new Error(`contractor ${number} is not registered`);
    const done = have.find((row) => String(row.contractor_id ?? asObj(row.contractor).id) === String(contractor.id));
    if (done !== undefined) {
      out.push({ proposalId: String(done.id), contractorNumber: number, contractorId: String(contractor.id) });
      continue;
    }
    const name = String(contractor.legal_name);
    const documents: Obj[] = [];
    for (const [part, title] of [['TECHNICAL', tx('receiveProposals.051')], ['FINANCIAL', tx('receiveProposals.052')]] as const) {
      const uploaded = ctx.expectOk(await ctx.upload<{ file_object_key: string; file_sha256: string }>(MAKER, '/proposals/files', { filename: `${spec.code}-${number}-${part.toLowerCase()}.pdf`, buffer: volume(ctx, spec, name, `${title} ${spec.code}`) }), `upload the ${part} volume`).json;
      documents.push({ part, title: `${title} - ${name}`, file_object_key: uploaded.file_object_key, file_sha256: uploaded.file_sha256 });
    }
    const award = spec.awardMillions ?? spec.millions;
    // The winner bids the lowest price; the others a little more, never above the budget of the package.
    const price = Math.min(spec.millions, rank === 0 ? award : Math.round(award * (1 + 0.006 * rank + 0.004 * (number % 3))));
    const proposal = await ctx.command(MAKER, '/proposals', {
      package_id: pack.id,
      contractor_id: contractor.id,
      submitted_at: at(ctx, daysAgo, 8 + (rank % 3)),
      documents,
      bid_price_vnd: vndMillions(price),
    });
    out.push({ proposalId: proposal.resource_id, contractorNumber: number, contractorId: String(contractor.id) });
    ctx.record({ module: 'BID', screen: 'BID-05', kind: 'proposal', id: proposal.resource_id, code: spec.code, note: name });
  }
  return out;
}

/**
 * Takes a package through its tender as far as its fate says. The tender runs on dates of its own: the invitation, the clarification deadline, the closing and the opening
 * (planned in the future while the proposals come in, and recorded as having happened once the bids are opened), the evaluation and the result.
 */
async function runTender(ctx: SeedContext, spec: PackageSpec): Promise<void> {
  if (spec.fate === 'PLANNED') return;
  const pack = await packageOf(ctx, spec.code);
  if (pack === undefined) return;
  const asked = await milestonesOf(ctx, String(pack.id));
  const has = (kind: string): boolean => asked.some((row) => row.milestone_kind === kind);
  // The invitation comes before the clarification deadline (nine days before the opening): a tender whose opening is long past was invited earlier still.
  const base = spec.awardedDaysAgo === undefined ? (spec.fate === 'RESULT_PENDING' ? 14 + 20 : 14) : spec.awardedDaysAgo + 38;
  const opened = spec.fate === 'EVALUATING' || spec.fate === 'RESULT_PENDING' || spec.fate === 'AWARDED';
  const openingAgo = spec.fate === 'AWARDED' ? (spec.awardedDaysAgo ?? 30) + 12 : spec.fate === 'RESULT_PENDING' ? 14 : spec.fate === 'EVALUATING' ? 3 : -4;

  if (spec.bidders !== undefined) await approveCriteria(ctx, spec, pack);
  if (!has('INVITATION_PUBLISHED')) await milestone(ctx, String(pack.id), 'INVITATION_PUBLISHED', { actualAt: at(ctx, spec.fate === 'INVITED' || spec.fate === 'SEALED' ? 12 : base) });
  if (!has('CLARIFICATION_DEADLINE')) {
    await milestone(ctx, String(pack.id), 'CLARIFICATION_DEADLINE', spec.fate === 'INVITED' ? { plannedAt: at(ctx, -6) } : { actualAt: at(ctx, spec.fate === 'SEALED' ? 5 : openingAgo + 9) });
  }
  if (spec.fate === 'INVITED' || spec.bidders === undefined) {
    if (!has('BID_CLOSING')) await milestone(ctx, String(pack.id), 'BID_CLOSING', { plannedAt: at(ctx, -14) });
    if (!has('BID_OPENING')) await milestone(ctx, String(pack.id), 'BID_OPENING', { plannedAt: at(ctx, -14, 14) });
    return;
  }
  if (!has('BID_CLOSING')) {
    // While the proposals come in the closing and the opening are still ahead (they are sealed until the opening).
    const closing = opened ? new Date(Date.now() + 2 * HOUR).toISOString() : at(ctx, -(openingAgo * -1 - 0), 9);
    await milestone(ctx, String(pack.id), 'BID_CLOSING', { plannedAt: spec.fate === 'SEALED' ? at(ctx, openingAgo, 9) : closing });
  }
  if (!has('BID_OPENING')) {
    const opening = opened ? new Date(Date.now() + 3 * HOUR).toISOString() : at(ctx, openingAgo, 14);
    await milestone(ctx, String(pack.id), 'BID_OPENING', { plannedAt: opening });
  }
  const handed = await receiveProposals(ctx, spec, pack, opened ? openingAgo + 1 : 6);
  if (!opened) return;

  // The bids are opened: the dates become what happened, and the proposals are released to the team that evaluates them.
  const now = await milestonesOf(ctx, String(pack.id));
  if (now.find((row) => row.milestone_kind === 'BID_CLOSING')?.actual_at == null) await milestone(ctx, String(pack.id), 'BID_CLOSING', { actualAt: at(ctx, openingAgo + 1, 17) });
  if (now.find((row) => row.milestone_kind === 'BID_OPENING')?.actual_at == null) await milestone(ctx, String(pack.id), 'BID_OPENING', { actualAt: at(ctx, openingAgo, 9) });
  await declareConflicts(ctx, spec, pack, handed);
  if (spec.fate === 'EVALUATING') return;
  await decideResult(ctx, spec, pack, handed, openingAgo);
}

// ---- the evaluation team and the result (BID-20, BID-18) --------------------------------------------------------------------------------

/** Each member of the team declares what they owe; one declares a relation with a bidder and the leader recuses them from that bid. */
async function declareConflicts(ctx: SeedContext, spec: PackageSpec, pack: Obj, handed: Handed[]): Promise<void> {
  const mine = await ctx.list<Obj>(MAKER, `/procurement-packages/${String(pack.id)}/conflict-declarations`);
  if (mine.length > 0) return;
  await ctx.command(MAKER, `/procurement-packages/${String(pack.id)}/conflict-declarations`, { has_conflict: false });
  const rival = handed[1] ?? handed[0];
  if (spec.code === 'NN031-XL02' && rival !== undefined) {
    const declared = await ctx.command(CHECKER, `/procurement-packages/${String(pack.id)}/conflict-declarations`, {
      has_conflict: true,
      relation_text: tx('relation_text.053'),
      contractor_id: rival.contractorId,
    });
    await ctx.command(LEADER, `/bid-conflict-declarations/${declared.resource_id}/decision`, { decision: 'RECUSED', decision_reason: tx('decision_reason.054') }, { version: declared });
  } else {
    await ctx.command(CHECKER, `/procurement-packages/${String(pack.id)}/conflict-declarations`, { has_conflict: false });
  }
}

/** The proposer submits the result with the minutes of the evaluation; the leader approves it on a decision and the package is awarded (or the first result is turned down). */
async function decideResult(ctx: SeedContext, spec: PackageSpec, pack: Obj, handed: Handed[], openingAgo: number): Promise<void> {
  const winner = handed[0];
  if (winner === undefined) return;
  const results = await ctx.list<Obj>(MAKER, '/procurement-results', { package_id: String(pack.id) });
  if (results.some((row) => String(row.package_id ?? asObj(row.package).id) === String(pack.id) && row.status !== 'REJECTED')) return;
  const minutes = await decisionInForce(ctx, 7);
  if (minutes === undefined) {
    ctx.warn('no document is in force yet (DOC has issued none): the result of the package is not submitted');
    return;
  }
  const submit = (): Promise<CommandReply> =>
    ctx.command(MAKER, '/procurement-results', { package_id: pack.id, outcome: 'AWARDED', winner_contractor_id: winner.contractorId, award_price_vnd: vndMillions(spec.awardMillions ?? spec.millions), evaluation_report_id: minutes });
  if (spec.code === 'DT205-TB01') {
    // The first result is turned down with the reason; the proposer submits it again after the clarification.
    const first = await submit();
    await ctx.command(LEADER, `/procurement-results/${first.resource_id}/decision`, { decision: 'REJECT', comment: tx('comment.055') }, { version: first });
  }
  const result = await submit();
  await milestone(ctx, String(pack.id), 'EVALUATION_DONE', { actualAt: at(ctx, Math.max(openingAgo - 6, 1), 16) });
  if (spec.fate === 'RESULT_PENDING') {
    ctx.record({ module: 'BID', screen: 'BID-18', kind: 'procurement-result', id: result.resource_id, code: spec.code, note: 'submitted, waits for the leader' });
    return;
  }
  const decision = await decisionInForce(ctx, 11);
  await ctx.command(LEADER, `/procurement-results/${result.resource_id}/decision`, { decision: 'APPROVE', decision_document_id: decision, comment: tx('comment.056') }, { version: result });
  const ago = spec.awardedDaysAgo ?? 30;
  await milestone(ctx, String(pack.id), 'RESULT_APPROVED', { actualAt: at(ctx, ago, 10) });
  await milestone(ctx, String(pack.id), 'RESULT_PUBLISHED', { actualAt: at(ctx, ago - 1, 10) });
  ctx.record({ module: 'BID', screen: 'BID-18', kind: 'procurement-result', id: result.resource_id, code: spec.code, note: 'awarded' });
}

// ---- entry of the module -----------------------------------------------------------------------------------------------------------------------

export async function seedPlans(ctx: SeedContext): Promise<void> {
  for (const [index, plan] of PLANS.entries()) await ctx.step('BID', `procurement plan of ${plan.project}`, () => seedPlan(ctx, plan, index));
}

export async function seedTenders(ctx: SeedContext): Promise<void> {
  for (const plan of PLANS) for (const spec of plan.packages) await ctx.step('BID', `tender of ${spec.code} (${spec.fate})`, () => runTender(ctx, spec));
}

export { paper, DAY };
