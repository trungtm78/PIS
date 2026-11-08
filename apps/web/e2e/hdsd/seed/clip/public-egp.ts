import { vndMillions } from '../context.ts';
import type { Obj, SeedContext } from '../context.ts';
import { asObj } from '../context.ts';
import { ensureWorkCalendar } from '../field-assurance/shared.ts';
import { clipPlan } from './plan.ts';

/**
 * Group `clip-public-egp`: the connection to the national procurement network (muasamcong) through the real import path. The files are the sample layouts of the
 * working assumption (the layout carries its own "pending" mark in the product); they are previewed (dry run, rows with errors named), applied, and the
 * mappings the import proposes are decided by a second person. Posting obligations are opened with trigger dates in the past so that some are overdue and some
 * are due soon; some are prepared, submitted by the owner and receipted. The reconciliation compares our figures with the file and its items are resolved
 * in the four ways. The upload and the dry run belong to the leader in the roles of the docs stack (the permission ends in "preview").
 */

const MAKER = 'projectManager';
const LEADER = 'capApprover';
const OWNER = 'owner';

interface PackageRow {
  code: string;
  title: string;
  project: string;
  millions: number;
  method: string;
}

interface EgpBlock {
  planPrefix: string;
  fileRows: number;
  badRows: number;
  decisionNo: string;
  noticePrefix: string;
  /** A reason of more than twenty characters for the decisions and resolutions (Vietnamese text of the dataset). */
  reason: string;
  /** The names of the three rows with an error on purpose (Vietnamese text of the dataset). */
  badPrice: string;
  badDay: string;
  repeated: string;
}

function packagesOf(): PackageRow[] {
  const procurement = clipPlan()?.procurement as { plans: Array<{ project: string; packages: Array<{ code: string; title: string; millions: number; method: string }> }> } | undefined;
  return (procurement?.plans ?? []).flatMap((plan) => plan.packages.map((item) => ({ code: item.code, title: item.title, project: plan.project, millions: item.millions, method: item.method })));
}

export function khlcntCsv(rows: PackageRow[], block: EgpBlock, day: (days: number) => string): string {
  const lines = ['plan_code,package_external_code,package_name,estimated_price,selection_method,approved_on,decision_no,project_code,package_code'];
  rows.forEach((row, index) => {
    // Every fifth package differs from ours by three per cent, so the reconciliation has something to say.
    const price = Number(vndMillions(row.millions)) * (index % 5 === 4 ? 1.03 : 1);
    lines.push([`${block.planPrefix}-${row.project.replace('DA-', '')}`, `PK-${row.code}`, `"${row.title.replace(/"/gu, "'")}"`, String(Math.round(price)), row.method, day(-40), block.decisionNo, row.project, row.code].join(','));
  });
  // Rows with an error on purpose: a price with dots, a day that does not exist, a repeated package.
  lines.push([`${block.planPrefix}-X1`, 'PK-BAD-1', block.badPrice, '1.200.000.000', 'OPEN_BIDDING', day(-40), block.decisionNo, '', ''].join(','));
  lines.push([`${block.planPrefix}-X2`, 'PK-BAD-2', block.badDay, '1200000000', 'OPEN_BIDDING', '2026-02-31', block.decisionNo, '', ''].join(','));
  if (rows[0] !== undefined) lines.push([`${block.planPrefix}-X3`, `PK-${rows[0].code}`, block.repeated, String(Number(vndMillions(rows[0].millions))), rows[0].method, day(-40), block.decisionNo, rows[0].project, rows[0].code].join(','));
  return `${lines.join('\n')}\n`;
}

export function tbmtCsv(rows: PackageRow[], block: EgpBlock, day: (days: number) => string): string {
  const lines = ['notice_code,notice_version,notice_kind,package_external_code,plan_code,published_at,bid_closing_at,bid_opening_at,estimated_price,bid_security_amount,project_code,package_code'];
  rows.forEach((row, index) => {
    const price = Number(vndMillions(row.millions));
    lines.push([`${block.noticePrefix}${String(2600000 + index)}`, '00', 'invitation', `PK-${row.code}`, `${block.planPrefix}-${row.project.replace('DA-', '')}`, `${day(-30)}T08:00:00+07:00`, `${day(-9)}T09:00:00+07:00`, `${day(-9)}T09:00:00+07:00`, String(price), String(Math.round(price * 0.02)), row.project, row.code].join(','));
  });
  return `${lines.join('\n')}\n`;
}

async function importFile(ctx: SeedContext, kind: string, name: string, csv: string): Promise<Obj | undefined> {
  const file = await ctx.upload<{ file_object_key: string; file_sha256: string }>(LEADER, '/egp/imports/files', { filename: name, mime: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
  if (!file.ok) {
    ctx.warn(`the file ${name} was refused (HTTP ${file.status})`);
    return undefined;
  }
  const body = { kind, file_object_key: file.json.file_object_key, file_sha256: file.json.file_sha256 };
  const preview = await ctx.must<Obj>(LEADER, 'POST', '/egp/imports/preview', body);
  ctx.log(`  [egp] ${kind} dry run ${JSON.stringify(asObj(preview.counts))}`);
  const applied = await ctx.attempt<Obj>(MAKER, 'POST', '/egp/imports', body);
  if (applied.ok) ctx.log(`  [egp] ${kind} applied ${JSON.stringify(asObj(applied.json.counts))} mappings proposed ${String(applied.json.mappings_proposed)}`);
  return applied.ok ? applied.json : undefined;
}

export async function seedClipEgp(ctx: SeedContext): Promise<void> {
  const plan = clipPlan();
  const block = plan?.egp as EgpBlock | undefined;
  const packages = packagesOf();
  if (block === undefined || packages.length === 0) {
    ctx.warn('no clip plan with packages: the e-GP group has nothing to do');
    return;
  }
  await ctx.step('ADM', 'working calendar', () => ensureWorkCalendar(ctx));
  const chosen = packages.slice(0, block.fileRows);
  const day = (days: number): string => ctx.day(days);
  await ctx.step('BID', 'plan file (dry run, then apply)', () => importFile(ctx, 'KHLCNT', 'khlcnt-sample.csv', khlcntCsv(chosen, block, day)));
  await ctx.step('BID', 'notice file (dry run, then apply)', () => importFile(ctx, 'TBMT', 'tbmt-sample.csv', tbmtCsv(chosen.slice(0, Math.ceil(chosen.length * 0.6)), block, day)));

  // The mappings the import proposed: the leader decides some, the rest wait; one is proposed by hand.
  await ctx.step('BID', 'mappings', async () => {
    const proposed = await ctx.list<Obj>(MAKER, '/egp/mappings', { status: 'PROPOSED' });
    for (const [index, mapping] of proposed.entries()) {
      if (index % 4 === 3) continue;
      await ctx.attempt(LEADER, 'POST', `/egp/mappings/${String(mapping.id)}/decision`, { decision: 'APPROVE', reason: block.reason }, { version: Number(mapping.version) });
    }
  });

  // Posting obligations: an old trigger date makes the clock run out (overdue), a recent one is due soon, the rest on time.
  await ctx.step('BID', 'posting obligations', async () => {
    const triggers = [-40, -30, -12, -6, -4, -1];
    const made: Obj[] = [];
    for (const [index, item] of chosen.slice(0, triggers.length).entries()) {
      const opened = await ctx.attempt<Obj>(MAKER, 'POST', '/egp/obligations', { kind: 'NOTICE', our_code: item.code, our_project_code: item.project, triggered_on: day(triggers[index] ?? -1) });
      if (opened.ok) made.push(opened.json);
    }
    // The last two are prepared by the officer, submitted by the owner (second person) and receipted: the obligation is met.
    for (const [index, item] of made.slice(-2).entries()) {
      const prepared = await ctx.attempt<Obj>(MAKER, 'POST', `/egp/obligations/${String(item.id)}/prepare`, { fields: { package_code: String(chosen[made.length - 2 + index]?.code ?? ''), published_at: day(-3), bid_closing_at: day(10) } }, { version: Number(item.version) });
      if (!prepared.ok) continue;
      const submitted = await ctx.attempt<Obj>(OWNER, 'POST', `/egp/obligations/${String(item.id)}/submit`, {}, { version: Number(asObj(prepared.json).resource_version ?? prepared.json.version) });
      if (!submitted.ok) continue;
      await ctx.attempt(OWNER, 'POST', `/egp/obligations/${String(item.id)}/receipt`, { receipt_ref: `RC-${ctx.today.replace(/-/gu, '')}-${index + 1}` }, { version: Number(asObj(submitted.json).resource_version ?? submitted.json.version) });
    }
  });

  // Reconciliation of the mapped records with our figures; the items are resolved in different ways by the owner (not a maker of the file).
  await ctx.step('BID', 'reconciliation', async () => {
    const ran = await ctx.attempt<Obj>(MAKER, 'POST', '/egp/reconciliation/run', { owner_id: ctx.person(OWNER).membershipId });
    if (ran.ok) ctx.log(`  [egp] reconciliation examined ${String(ran.json.examined)} differences ${String(ran.json.differences)} opened ${String(ran.json.opened)}`);
    const items = (await ctx.list<Obj>(OWNER, '/egp/reconciliation/items', { state: 'OPEN' })).slice(0, 3);
    const kinds = [
      { kind: 'ACCEPT_EXTERNAL', reason: block.reason },
      { kind: 'CORRECT_OURS', reason: block.reason },
      { kind: 'DISPUTE', reason: block.reason, evidence_ref: block.decisionNo },
    ];
    for (const [index, item] of items.entries()) {
      const resolution = kinds[index];
      if (resolution !== undefined) await ctx.attempt(OWNER, 'POST', `/egp/reconciliation/items/${String(item.id)}/resolution`, resolution, { version: Number(item.version) });
    }
  });
  ctx.record({ module: 'BID', screen: 'BID-24', kind: 'egp-import', id: 'egp', code: 'EGP', note: `${chosen.length} packages` });
}
