import { vndMillions } from '../context.ts';
import type { Obj, SeedContext } from '../context.ts';
import { asObj } from '../context.ts';
import { clipPlan } from './plan.ts';
import type { ClipPlan } from './plan.ts';

/**
 * Group `clip-public-feed`: the feed of the Department of Finance (FEED-1) into the province. Two real channels are used: the file channel (the project, plan
 * and disbursement files of the feed layout, dry run first, applied once) and the generator of the whole province from a seed (started with its own command).
 * The projects of the feed are mapped to ours by the code in the file; the leader decides the mappings; the reconciliation then compares the figures of the feed
 * with ours and opens the differences that have an owner. The upload and the dry run belong to the leader (the permission ends in "preview").
 *
 * What the committee workspace reads is the frozen period snapshot (group `clip-public-disbursement`); the feed reaches the screens through its quality
 * figures, differences and alerts, which `verify` reads back.
 */

const MAKER = 'projectManager';
const LEADER = 'capApprover';
const OWNER = 'owner';

const SECTOR_CODE: Record<string, string> = { TRANSPORT: 'GT', AGRICULTURE: 'NN', EDUCATION: 'GD', HEALTH: 'YT', CULTURE_SPORT: 'VH', ENVIRONMENT: 'MT', ICT: 'HT', URBAN: 'QL' };

interface FeedProject {
  code: string;
  name: string;
  sector: string;
  area: string;
  planBillions?: number;
}

interface DisbursementRow {
  project: string;
  date: string;
  millions: number;
}

/** The three files of the feed layout for the projects that have payments in the plan of the dataset. Every fifth project is reported three per cent above ours. */
export function feedFiles(plan: ClipPlan, fiscalYear: number, rows: DisbursementRow[], today: string): { project: string; plan: string; disbursement: string } {
  const projects = (plan.projects as unknown as FeedProject[]).filter((project) => project.planBillions !== undefined && rows.some((row) => row.project === project.code));
  const areas = [...new Set(projects.map((project) => project.area))];
  const feedCode = (project: FeedProject): string => `F-${project.code.replace('DA-', '')}`;
  const projectLines = ['feed_project_code,as_of,project_name,sector_code,district_code,investor_code,our_project_code'];
  const planLines = ['feed_project_code,fiscal_year,fund_code,plan_amount,as_of'];
  const disbursementLines = ['feed_project_code,fiscal_year,month,fund_code,disbursed_month,disbursed_cumulative,reported_on,as_of'];
  for (const [index, project] of projects.entries()) {
    const district = `D${String((areas.indexOf(project.area) % 12) + 1).padStart(2, '0')}`;
    projectLines.push([feedCode(project), today, `"${project.name.replace(/"/gu, "'")}"`, SECTOR_CODE[project.sector] ?? 'QL', district, `CDT-${(index % 3) + 1}`, project.code].join(','));
    planLines.push([feedCode(project), String(fiscalYear), 'NSTW', vndMillions((project.planBillions ?? 0) * 1000), today].join(','));
    const byMonth = new Map<number, number>();
    for (const row of rows.filter((candidate) => candidate.project === project.code)) {
      const month = Number(row.date.slice(5, 7));
      byMonth.set(month, (byMonth.get(month) ?? 0) + row.millions);
    }
    let cumulative = 0;
    for (const month of [...byMonth.keys()].sort((a, b) => a - b)) {
      const reported = Math.round((byMonth.get(month) ?? 0) * (index % 5 === 4 ? 1.03 : 1));
      cumulative += reported;
      const reportedOn = `${fiscalYear}-${String(month).padStart(2, '0')}-28`;
      disbursementLines.push([feedCode(project), String(fiscalYear), String(month), 'NSTW', vndMillions(reported), vndMillions(cumulative), reportedOn, reportedOn].join(','));
    }
  }
  return { project: `${projectLines.join('\n')}\n`, plan: `${planLines.join('\n')}\n`, disbursement: `${disbursementLines.join('\n')}\n` };
}

async function importKind(ctx: SeedContext, kind: string, name: string, csv: string): Promise<void> {
  const file = await ctx.upload<{ file_object_key: string; file_sha256: string }>(LEADER, '/finance-feed/imports/files', { filename: name, mime: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
  if (!file.ok) {
    ctx.warn(`the feed file ${name} was refused (HTTP ${file.status})`);
    return;
  }
  const body = { kind, file_object_key: file.json.file_object_key, file_sha256: file.json.file_sha256 };
  const preview = await ctx.attempt<Obj>(LEADER, 'POST', '/finance-feed/imports/preview', body);
  if (preview.ok) ctx.log(`  [feed] ${kind} dry run ${JSON.stringify(asObj(preview.json.counts))}`);
  const applied = await ctx.attempt<Obj>(MAKER, 'POST', '/finance-feed/imports', body);
  if (applied.ok) ctx.log(`  [feed] ${kind} applied ${JSON.stringify(asObj(applied.json.counts))}`);
}

export async function seedClipFeed(ctx: SeedContext): Promise<void> {
  const plan = clipPlan();
  const block = plan?.disbursement as { fiscalYear: number; lastMonth: number; rows: DisbursementRow[] } | undefined;
  if (plan === undefined || block === undefined) {
    ctx.warn('no clip plan with a disbursement block: the feed group has nothing to do');
    return;
  }
  const files = feedFiles(plan, block.fiscalYear, block.rows, ctx.today);
  await ctx.step('FEED', 'project file', () => importKind(ctx, 'PROJECT', 'feed-projects.csv', files.project));
  await ctx.step('FEED', 'plan file', () => importKind(ctx, 'PLAN', 'feed-plan.csv', files.plan));
  await ctx.step('FEED', 'disbursement file', () => importKind(ctx, 'DISBURSEMENT', 'feed-disbursement.csv', files.disbursement));
  await ctx.step('FEED', 'mappings decided', async () => {
    const proposed = await ctx.list<Obj>(MAKER, '/finance-feed/mappings', { status: 'PROPOSED' });
    for (const [index, mapping] of proposed.entries()) {
      if (index % 5 === 4) continue;
      await ctx.attempt(LEADER, 'POST', `/finance-feed/mappings/${String(mapping.id)}/decision`, { decision: 'APPROVE', reason: 'Mapping checked by the leader against the feed file' }, { version: Number(mapping.version) });
    }
  });
  // The generator: the whole province from a seed through the same import path (the records carry the channel GENERATOR for the audit, nothing else).
  await ctx.step('FEED', 'generator of the province', async () => {
    const connection = await ctx.get<Obj>(MAKER, '/finance-feed/connection');
    if (String(asObj(connection.generator).state) === 'RUNNING') return;
    await ctx.attempt(MAKER, 'POST', '/finance-feed/generator', { action: 'START', reason: 'Generator started for the whole province from the seed of the dataset', seed: 57, fiscal_year: block.fiscalYear, current_month: block.lastMonth, project_count: 60 }, { version: Number(connection.version) });
  });
  await ctx.step('FEED', 'reconciliation with the disbursement figures', async () => {
    const ran = await ctx.attempt<Obj>(MAKER, 'POST', '/finance-feed/reconciliations', { fiscal_year: block.fiscalYear, owner_id: ctx.person(OWNER).membershipId });
    if (ran.ok) ctx.log(`  [feed] compared ${String(ran.json.projects_compared)} projects`);
  });
}
