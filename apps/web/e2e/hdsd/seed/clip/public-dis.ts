import { vndMillions, asVersion } from '../context.ts';
import type { Obj, SeedContext } from '../context.ts';
import { asObj } from '../context.ts';
import { masterRecord } from '../base.ts';
import { clipPlan } from './plan.ts';

/**
 * Group `clip-public-disbursement`: the money side of the province, through the real paths. The Treasury office is published as master data and its
 * code mapped (maker proposes, the leader approves and publishes on a decision); the statement file of the Treasury is imported (dry rows are judged,
 * the file is applied once); the monthly reporting periods of the year are generated and soft-closed; the snapshots of the last two closed months are
 * built and frozen. The command center, the disbursement rates and the province committee workspace read the latest frozen snapshot.
 */

const MAKER = 'projectManager';
const LEADER = 'capApprover';

interface DisbursementBlock {
  office: { key: string; name: string; externalCode: string; province: string };
  decision: { symbol: string; title: string; sender: string };
  reason: string;
  fiscalYear: number;
  lastMonth: number;
  rows: Array<{ project: string; no: string; date: string; millions: number }>;
}

/** A master entry put in force: proposed, sent, approved by the leader, published on a decision. Skips what is in force. */
export async function putMasterInForce(ctx: SeedContext, type: string, key: string, label: string, attributes: Obj, decisionDocumentId: string, reason: string): Promise<Obj> {
  let record = await masterRecord(ctx, type, key);
  if (record?.status === 'EFFECTIVE') return record;
  if (record === undefined) {
    await ctx.command(MAKER, '/master-records', { namespace: 'TENANT', master_type: type, business_key: key, label, attributes, valid_from: '2026-01-01', reason });
    record = await masterRecord(ctx, type, key);
  }
  if (record === undefined) throw new Error(`the master entry ${type} ${key} cannot be found after it was proposed`);
  const changeId = String(record.open_change_request_id);
  if (record.status === 'DRAFT') {
    const change = await ctx.get(MAKER, `/master-change-requests/${changeId}`);
    await ctx.command(MAKER, `/master-change-requests/${changeId}/submit`, {}, { version: asVersion(change.version) });
    record = await masterRecord(ctx, type, key);
  }
  if (record?.status === 'IN_REVIEW') {
    const change = await ctx.get(LEADER, `/master-change-requests/${changeId}`);
    await ctx.command(LEADER, `/master-change-requests/${changeId}/decision`, { decision: 'approve', reason }, { version: asVersion(change.version) });
    record = await masterRecord(ctx, type, key);
  }
  if (record?.status === 'APPROVED') {
    await ctx.command(LEADER, `/master-records/${String(record.id)}/publish`, { decision_document_id: decisionDocumentId }, { version: Number(record.version) });
    record = await masterRecord(ctx, type, key);
  }
  if (record === undefined) throw new Error(`the master entry ${type} ${key} vanished`);
  return record;
}

export function statementCsv(block: DisbursementBlock): string {
  const lines = ['document_no,document_date,project_code,treasury_office_code,amount_vnd,confirmed_at'];
  for (const row of block.rows) lines.push([row.no, row.date, row.project, block.office.externalCode, vndMillions(row.millions), row.date].join(','));
  return `${lines.join('\n')}\n`;
}

async function importStatement(ctx: SeedContext, block: DisbursementBlock): Promise<void> {
  const csv = Buffer.from(statementCsv(block), 'utf8');
  const file = await ctx.upload<Obj>(MAKER, '/treasury-imports/files', { filename: 'treasury-statement.csv', mime: 'text/csv', buffer: csv });
  if (!file.ok) {
    ctx.warn(`the Treasury statement was refused (HTTP ${file.status}) ${file.text.slice(0, 200)}`);
    return;
  }
  ctx.log(`  [dis] statement file ${JSON.stringify(file.json).slice(0, 300)}`);
  const applied = await ctx.attempt<Obj>(MAKER, 'POST', '/treasury-imports', {
    file_object_id: file.json.file_object_id ?? file.json.id ?? file.json.file_object_key,
    file_sha256: file.json.file_sha256 ?? ctx.sha256(csv),
    source_kind: 'STATEMENT_FILE',
    statement_date: ctx.day(-8),
    file_name: 'treasury-statement.csv',
  });
  ctx.log(`  [dis] statement import ${applied.ok ? JSON.stringify(applied.json).slice(0, 300) : String(applied.status)}`);
}

function monthEnd(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

async function closeAndFreeze(ctx: SeedContext, block: DisbursementBlock): Promise<void> {
  await ctx.attempt(MAKER, 'POST', '/reporting-periods/generate', { calendar_code: 'DEFAULT', fiscal_year: block.fiscalYear, period_type: 'MONTH' });
  const periods = await ctx.list<Obj>(MAKER, '/resources/reporting_period');
  const months = periods.filter((row) => row.period_type === 'MONTH' && Number(row.fiscal_year) === block.fiscalYear).sort((a, b) => String(a.starts_on ?? a.start_date).localeCompare(String(b.starts_on ?? b.start_date)));
  ctx.log(`  [dis] ${months.length} monthly periods, first ${JSON.stringify(months[0] ?? {}).slice(0, 240)}`);
  for (const [index, period] of months.entries()) {
    if (index + 1 > block.lastMonth) break;
    if (String(period.status) === 'OPEN') await ctx.attempt(MAKER, 'POST', `/reporting-periods/${String(period.id)}/soft-close`, { reason: block.reason }, { version: Number(period.version) });
  }
  for (const month of [block.lastMonth - 1, block.lastMonth]) {
    const period = months[month - 1];
    if (period === undefined) continue;
    const built = await ctx.attempt<Obj>(MAKER, 'POST', '/period-snapshots', { period_id: String(period.id), snapshot_kind: 'PERIOD_CLOSE', treasury_cutoff_date: monthEnd(block.fiscalYear, month) });
    if (!built.ok) continue;
    await ctx.attempt(MAKER, 'POST', `/period-snapshots/${String(built.json.resource_id)}/freeze`, {}, { version: Number(built.json.resource_version) });
    ctx.record({ module: 'DIS', screen: 'DIS-21', kind: 'period-snapshot', id: String(built.json.resource_id), code: `${block.fiscalYear}-${month}`, note: 'frozen' });
  }
}

/**
 * The early warnings are evaluated over the WEEKLY close snapshots only (a monthly period neither opens nor clears them), by the event of the freeze. So the weeks of the year
 * are generated, the ones whose deadline has passed are soft-closed, and the snapshots of the last two closed weeks are built and frozen, the older one first.
 */
async function closeWeeksAndFreeze(ctx: SeedContext, block: DisbursementBlock): Promise<void> {
  await ctx.attempt(MAKER, 'POST', '/reporting-periods/generate', { calendar_code: 'DEFAULT', fiscal_year: block.fiscalYear, period_type: 'WEEK' });
  const periods = await ctx.list<Obj>(MAKER, '/resources/reporting_period');
  const startOf = (row: Obj): string => String(row.starts_on ?? row.start_date);
  const endOf = (row: Obj): string => String(row.ends_on ?? row.end_date);
  const weeks = periods.filter((row) => row.period_type === 'WEEK' && Number(row.fiscal_year) === block.fiscalYear).sort((a, b) => startOf(a).localeCompare(startOf(b)));
  const due = weeks.filter((row) => endOf(row) < ctx.today && Date.parse(String(row.deadline_at)) < ctx.asOf.getTime());
  ctx.log(`  [dis] ${weeks.length} weekly periods, ${due.length} past their deadline`);
  for (const period of due) {
    if (String(period.status) === 'OPEN') await ctx.attempt(MAKER, 'POST', `/reporting-periods/${String(period.id)}/soft-close`, { reason: block.reason }, { version: Number(period.version) });
  }
  for (const period of due.slice(-2)) {
    const built = await ctx.attempt<Obj>(MAKER, 'POST', '/period-snapshots', { period_id: String(period.id), snapshot_kind: 'PERIOD_CLOSE', treasury_cutoff_date: endOf(period) });
    if (!built.ok) continue;
    await ctx.attempt(MAKER, 'POST', `/period-snapshots/${String(built.json.resource_id)}/freeze`, {}, { version: Number(built.json.resource_version) });
    ctx.record({ module: 'DIS', screen: 'DIS-21', kind: 'period-snapshot', id: String(built.json.resource_id), code: String(period.code), note: 'frozen, weekly close' });
  }
}

export async function seedClipDisbursement(ctx: SeedContext): Promise<void> {
  const block = clipPlan()?.disbursement as DisbursementBlock | undefined;
  if (block === undefined) {
    ctx.warn('no clip plan with a disbursement block: nothing to do');
    return;
  }
  const letter = await ctx.letter({ symbol: block.decision.symbol, title: block.decision.title, sender: block.decision.sender, issuedOn: ctx.day(-100) });
  const office = await ctx.step('MDM', 'Treasury office in force', () => putMasterInForce(ctx, 'TREASURY_OFFICE', block.office.key, block.office.name, { level: 'PROVINCE', province: block.office.province }, letter.documentId, block.reason));
  await ctx.step('MDM', 'Treasury code mapping', async () => {
    const known = await ctx.list<Obj>(MAKER, '/master-crosswalks');
    if (known.some((row) => row.external_code === block.office.externalCode && row.source_system === 'TREASURY')) return;
    await ctx.command(MAKER, '/master-crosswalks', { master_record_id: String(office.id), source_system: 'TREASURY', external_type: 'AGENCY_CODE', external_code: block.office.externalCode, valid_from: '2024-01-01', match_method: 'MANUAL' });
  });
  await ctx.step('PAY', 'Treasury statement', () => importStatement(ctx, block));
  await ctx.step('DIS', 'periods and snapshots', () => closeAndFreeze(ctx, block));
  await ctx.step('DIS', 'weekly periods and snapshots', () => closeWeeksAndFreeze(ctx, block));
  void asObj;
}
