import { randomUUID } from 'node:crypto';
import { DomainError, NOOP_METRICS, TREASURY_RECON_FALLBACK, UNMATCHED_FUND, canonicalJson, classifyLine, differenceOf, dueOn, isWeekday, isWorkingDay, opensItem, parseReconPolicy, reconAddDays, runStatusOf, sha256Hex, vietnamDateOf, versionConflict } from '@machvon/kernel';
import type { MetricsSink, ReconLine, ReconLineKind, ReconPartialReason, ReconPolicy, ReconRunStatus, WorkCalendarSource } from '@machvon/kernel';
import { normalizeUuid } from './file-import-item-store.ts';
import { resolveGovD } from './gov-d-policy.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';
import { WorkCalendarStore } from './work-calendar-store.ts';

/** The items of the daily reconciliation that still wait, and the ones past their day (gauges; the alert `TREASURY_RECON_ITEM_OVERDUE` watches the second). */
export const TREASURY_DAILY_RECON_OPEN_METRIC = 'pay_treasury_daily_recon_open';
export const TREASURY_DAILY_RECON_OVERDUE_METRIC = 'pay_treasury_daily_recon_overdue';
export const TREASURY_DAILY_RECON_PARTIAL_METRIC = 'pay_treasury_daily_recon_partial_total';
/** The event of a pass that was written, and the one that asks ISS for an issue about an item past its day (the common contract of the issue intake, ISS-11). */
export const TREASURY_DAILY_RECON_RUN_EVENT = 'pay.treasury_daily_recon.run.v1';
export const TREASURY_DAILY_RECON_OVERDUE_EVENT = 'pay.treasury_daily_recon.item_overdue.v1';
export const TREASURY_RECON_ITEM_RESOURCE = 'treasury_daily_recon_item';
export const TREASURY_RECON_RUN_RESOURCE = 'treasury_daily_recon_run';
/** The code of the alert type of an item past its day, and the rule that holds the thresholds. */
export const TREASURY_RECON_ALERT_TYPE = 'TREASURY_RECON_ITEM_OVERDUE';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const DEFAULT_CALENDAR = 'DEFAULT';
const MAX_PAGE = 200;
const CHECK_VIOLATION = '23514';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const LIVE = "('OPEN', 'EXPLAINED')";
const LIVE_STATUSES: readonly string[] = ['OPEN', 'EXPLAINED'];
/** How far back a manual run may go: the books of the year before are closed by the period, not by this control. */
const MAX_AGE_DAYS = 400;

const invalid = (field: string, reason?: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, reason === undefined ? undefined : { extensions: { reason } });
const isRealDay = (value: string): boolean => DAY.test(value) && new Date(Date.parse(`${value}T00:00:00Z`)).toISOString().slice(0, 10) === value;

const FALLBACK_PARAMS = { threshold_vnd: TREASURY_RECON_FALLBACK.thresholdVnd, due_days: TREASURY_RECON_FALLBACK.dueDays, partial_after_days: TREASURY_RECON_FALLBACK.partialAfterDays };

/** The thresholds as the pass read them: the policy, the version of the rule that decided and whether the numbers are a starting value nobody confirmed. */
export interface ReconRule {
  policy: ReconPolicy;
  version: number;
  source: 'RULE' | 'DEFAULT';
  unverified: boolean;
}

export interface ReconRunView {
  id: string;
  reconDate: string;
  runNo: number;
  status: ReconRunStatus;
  partialReason: ReconPartialReason | null;
  statementImports: number;
  transactionCount: number;
  lineCount: number;
  differenceLineCount: number;
  openedItems: number;
  clearedItems: number;
  /** Null for a reader who sees only part of the projects: a total of the tenant is not theirs. */
  booksTotalVnd: string | null;
  treasuryTotalVnd: string | null;
  ruleVersion: number;
  ruleSource: 'RULE' | 'DEFAULT';
  ruleUnverified: boolean;
  thresholdVnd: string;
  thresholdPct: string | null;
  dueDays: number;
  partialAfterDays: number;
  calendarBasis: 'WORK_CALENDAR' | 'WEEKDAYS_ASSUMED';
  origin: 'JOB' | 'MANUAL';
  createdBy: string;
  createdAt: string;
  /** The ordering key of the list and its cursor: the day and the number of the pass. */
  orderKey: string;
}

export interface ReconLineView {
  id: string;
  projectId: string;
  projectCode: string;
  fundKey: string;
  fundLabel: string | null;
  booksVnd: string;
  treasuryVnd: string;
  differenceVnd: string;
  booksCount: number;
  treasuryCount: number;
  kind: ReconLineKind | null;
  opensItem: boolean;
}

export interface ReconItemView {
  id: string;
  projectId: string;
  projectCode: string;
  fundKey: string;
  fundLabel: string | null;
  reconDate: string;
  kind: string;
  status: string;
  booksVnd: string;
  treasuryVnd: string;
  differenceVnd: string;
  latestDifferenceVnd: string;
  ownerMembershipId: string;
  ownerName: string | null;
  dueOn: string;
  overdue: boolean;
  openedRunId: string;
  lastRunId: string;
  clearedRunId: string | null;
  explainedBy: string | null;
  resolutionNote: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  approvalDocumentVersionId: string | null;
  issueId: string | null;
  createdAt: string;
  version: number;
}

export interface RunOutcome {
  /** The pass; null when the day was not judged (a statement that is not due yet). */
  run: ReconRunView | null;
  lines: ReconLineView[];
  /** True when the pass found the very lines of the latest pass of the day: nothing was written. */
  reused: boolean;
  /** True when the day was not judged (a statement that is not due yet): nothing was written and there is no run. */
  notDue: boolean;
  openedItemIds: string[];
  clearedItemIds: string[];
}

interface RunSql {
  id: string;
  recon_date: string;
  run_no: number;
  status: ReconRunStatus;
  partial_reason: ReconPartialReason | null;
  statement_imports: number;
  transaction_count: number;
  line_count: number;
  difference_line_count: number;
  opened_items: number;
  cleared_items: number;
  books_total_vnd: string;
  treasury_total_vnd: string;
  rule_version: number;
  rule_source: 'RULE' | 'DEFAULT';
  rule_unverified: boolean;
  threshold_vnd: string;
  threshold_pct: string | null;
  due_days: number;
  partial_after_days: number;
  calendar_basis: 'WORK_CALENDAR' | 'WEEKDAYS_ASSUMED';
  origin: 'JOB' | 'MANUAL';
  created_by: string;
  created_at: string;
  order_key: string;
}

const RUN_COLUMNS = `r.id, r.recon_date::text as recon_date, r.run_no, r.status, r.partial_reason, r.statement_imports, r.transaction_count, r.line_count, r.difference_line_count, r.opened_items, r.cleared_items,
  r.books_total_vnd::text as books_total_vnd, r.treasury_total_vnd::text as treasury_total_vnd, r.rule_version, r.rule_source, r.rule_unverified, r.threshold_vnd::text as threshold_vnd,
  r.threshold_pct::text as threshold_pct, r.due_days, r.partial_after_days, r.calendar_basis, r.origin, r.created_by, to_char(r.created_at at time zone 'UTC', ${ISO}) as created_at,
  (to_char(r.recon_date, 'YYYY-MM-DD') || '#' || lpad(r.run_no::text, 6, '0')) as order_key`;

const toRun = (row: RunSql, whole: boolean): ReconRunView => ({
  id: row.id,
  reconDate: row.recon_date,
  runNo: row.run_no,
  status: row.status,
  partialReason: row.partial_reason,
  statementImports: row.statement_imports,
  transactionCount: row.transaction_count,
  lineCount: row.line_count,
  differenceLineCount: row.difference_line_count,
  openedItems: row.opened_items,
  clearedItems: row.cleared_items,
  booksTotalVnd: whole ? row.books_total_vnd : null,
  treasuryTotalVnd: whole ? row.treasury_total_vnd : null,
  ruleVersion: row.rule_version,
  ruleSource: row.rule_source,
  ruleUnverified: row.rule_unverified,
  thresholdVnd: row.threshold_vnd,
  thresholdPct: row.threshold_pct,
  dueDays: row.due_days,
  partialAfterDays: row.partial_after_days,
  calendarBasis: row.calendar_basis,
  origin: row.origin,
  createdBy: row.created_by,
  createdAt: row.created_at,
  orderKey: row.order_key,
});

interface LineSql {
  id: string;
  project_id: string;
  project_code: string;
  fund_key: string;
  fund_label: string | null;
  books_vnd: string;
  treasury_vnd: string;
  difference_vnd: string;
  books_count: number;
  treasury_count: number;
  kind: ReconLineKind | null;
  opens_item: boolean;
}

const toLine = (row: LineSql): ReconLineView => ({
  id: row.id,
  projectId: row.project_id,
  projectCode: row.project_code,
  fundKey: row.fund_key,
  fundLabel: row.fund_label,
  booksVnd: row.books_vnd,
  treasuryVnd: row.treasury_vnd,
  differenceVnd: row.difference_vnd,
  booksCount: row.books_count,
  treasuryCount: row.treasury_count,
  kind: row.kind,
  opensItem: row.opens_item,
});

interface ItemSql {
  id: string;
  project_id: string;
  project_code: string;
  fund_key: string;
  fund_label: string | null;
  recon_date: string;
  kind: string;
  status: string;
  books_vnd: string;
  treasury_vnd: string;
  difference_vnd: string;
  latest_difference_vnd: string;
  owner_membership_id: string;
  owner_name: string | null;
  due_on: string;
  overdue: boolean;
  opened_run_id: string;
  last_run_id: string;
  cleared_run_id: string | null;
  explained_by: string | null;
  resolution_note: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  approval_document_version_id: string | null;
  issue_id: string | null;
  created_at: string;
  version: string;
}

const ITEM_COLUMNS = `i.id, i.project_id, p.code as project_code, i.fund_key, i.fund_label, i.recon_date::text as recon_date, i.kind, i.status, i.books_vnd::text as books_vnd, i.treasury_vnd::text as treasury_vnd,
  i.difference_vnd::text as difference_vnd, i.latest_difference_vnd::text as latest_difference_vnd, i.owner_membership_id, d.display_name as owner_name, i.due_on::text as due_on,
  (i.status in ${LIVE} and i.due_on < $1::date) as overdue, i.opened_run_id, i.last_run_id, i.cleared_run_id, i.explained_by, i.resolution_note, i.resolved_by, to_char(i.resolved_at at time zone 'UTC', ${ISO}) as resolved_at,
  i.approval_document_version_id, i.issue_id, to_char(i.created_at at time zone 'UTC', ${ISO}) as created_at, i.version::text as version`;

const ITEM_FROM = `from ${SCOPE_FROM}
  join machvon.treasury_daily_recon_item i on i.tenant_id = p.tenant_id and i.project_id = p.id
  left join machvon.tenant_user_directory d on d.tenant_id = i.tenant_id and d.membership_id = i.owner_membership_id`;

const toItem = (row: ItemSql): ReconItemView => ({
  id: row.id,
  projectId: row.project_id,
  projectCode: row.project_code,
  fundKey: row.fund_key,
  fundLabel: row.fund_label,
  reconDate: row.recon_date,
  kind: row.kind,
  status: row.status,
  booksVnd: row.books_vnd,
  treasuryVnd: row.treasury_vnd,
  differenceVnd: row.difference_vnd,
  latestDifferenceVnd: row.latest_difference_vnd,
  ownerMembershipId: row.owner_membership_id,
  ownerName: row.owner_name,
  dueOn: row.due_on,
  overdue: row.overdue,
  openedRunId: row.opened_run_id,
  lastRunId: row.last_run_id,
  clearedRunId: row.cleared_run_id,
  explainedBy: row.explained_by,
  resolutionNote: row.resolution_note,
  resolvedBy: row.resolved_by,
  resolvedAt: row.resolved_at,
  approvalDocumentVersionId: row.approval_document_version_id,
  issueId: row.issue_id,
  createdAt: row.created_at,
  version: Number(row.version),
});

export interface ItemFilter {
  status?: string | undefined;
  ownerMembershipId?: string | undefined;
  projectId?: string | undefined;
  reconDate?: string | undefined;
  limit: number;
  after: { code: string; id: string } | undefined;
}

export interface ItemChange {
  view: ReconItemView;
  fromStatus: string;
  fromOwnerMembershipId: string;
}

const ITEM_STATUSES = ['OPEN', 'EXPLAINED', 'RESOLVED', 'WRITTEN_OFF_APPROVED', 'AUTO_CLEARED'] as const;
export const DAILY_RECON_RESOLUTIONS = ['EXPLAINED', 'RESOLVED', 'WRITTEN_OFF'] as const;
export type DailyReconResolution = (typeof DAILY_RECON_RESOLUTIONS)[number];

/** What each side says for a day: the lines by project and fund, and what was found out about the day (the statements, the transactions). */
export interface DaySides {
  lines: ReconLine[];
  statementImports: number;
  transactionCount: number;
}

/**
 * The daily reconciliation with the Treasury (G4-4). For one business day (Vietnam time) it compares, for each project code and fund, what the books say was paid (the payment requests settled that day, less the refunds booked that
 * day) with what the Treasury says (the transactions confirmed that day, a refund taking off). A difference strictly above the threshold of the rule `RECONCILIATION_POLICY` opens an item for an owner with a due day in working days;
 * a difference that is gone when the day is run again clears its item with the pass that proves it; the lines and the passes are never changed. A day whose statement is not in, or whose sources cannot be read, is PARTIAL with the
 * reason, never "no difference". It builds on the Treasury import, the match and the per-transaction reconciliation items and changes none of them.
 */
export class TreasuryDailyReconStore {
  private readonly metrics: MetricsSink;
  private readonly calendars = new WorkCalendarStore();

  constructor(metrics: MetricsSink = NOOP_METRICS) {
    this.metrics = metrics;
  }

  /** The thresholds in force on a day: an approved version of `RECONCILIATION_POLICY`, else the built-in default; a rule whose params do not read is refused, never replaced by a guess. */
  async rule(tx: TenantTx, asOf: string): Promise<ReconRule> {
    const found = await resolveGovD(tx, 'RECONCILIATION_POLICY', 'DEFAULT', asOf, { params: FALLBACK_PARAMS, unverified: true });
    return { policy: parseReconPolicy(found.params), version: found.version, source: found.source, unverified: found.unverified };
  }

  /**
   * What the books and the Treasury say for a day, by project and fund. A fund is the code of the fund source of the allocation line that the transaction (or the payment it is matched to) names; money with no fund is
   * `UNMATCHED`. Signed whole dong: a refund (a transaction that takes another back) and a reversed payment's refund take off. Overridable by a test that proves a source that cannot be read.
   */
  protected async readSides(tx: TenantTx, day: string): Promise<DaySides> {
    const treasury = await tx.query<{ project_id: string; project_code: string; fund_key: string; fund_label: string | null; vnd: string; n: number }>(
      `select t.project_id, p.code as project_code, coalesce(fv.code, '${UNMATCHED_FUND}') as fund_key, max(fv.label) as fund_label,
              sum(case when t.reversal_of_id is not null or t.direction = 'REFUND' then -t.amount_vnd else t.amount_vnd end)::text as vnd, count(*)::int as n
         from machvon.treasury_transaction t
         join machvon.project p on p.tenant_id = t.tenant_id and p.id = t.project_id
         left join machvon.payment_request pr on pr.tenant_id = t.tenant_id and pr.id = t.payment_request_id
         left join machvon.allocation_line al on al.tenant_id = t.tenant_id and al.id = coalesce(t.allocation_line_id, pr.allocation_line_id)
         left join machvon.master_record_version fv on fv.tenant_id = al.tenant_id and fv.id = al.fund_source_version_id
        where (t.confirmed_at at time zone 'Asia/Ho_Chi_Minh')::date = $1::date
        group by t.project_id, p.code, coalesce(fv.code, '${UNMATCHED_FUND}')`,
      [day],
    );
    const books = await tx.query<{ project_id: string; project_code: string; fund_key: string; fund_label: string | null; vnd: string; n: number }>(
      `select x.project_id, x.project_code, x.fund_key, max(x.fund_label) as fund_label, sum(x.vnd)::text as vnd, sum(x.n)::int as n
         from (
           select pr.project_id, p.code as project_code, coalesce(fv.code, '${UNMATCHED_FUND}') as fund_key, fv.label as fund_label, pr.net_vnd as vnd, 1 as n
             from machvon.payment_request pr
             join machvon.project p on p.tenant_id = pr.tenant_id and p.id = pr.project_id
             left join machvon.allocation_line al on al.tenant_id = pr.tenant_id and al.id = pr.allocation_line_id
             left join machvon.master_record_version fv on fv.tenant_id = al.tenant_id and fv.id = al.fund_source_version_id
            where pr.status in ('SETTLED', 'REVERSED') and pr.treasury_paid_on = $1::date
           union all
           select pr.project_id, p.code, coalesce(fv.code, '${UNMATCHED_FUND}'), fv.label, -pr.net_vnd, 1
             from machvon.payment_request pr
             join machvon.project p on p.tenant_id = pr.tenant_id and p.id = pr.project_id
             join machvon.treasury_transaction rt on rt.tenant_id = pr.tenant_id and rt.id = pr.refund_transaction_id
             left join machvon.allocation_line al on al.tenant_id = pr.tenant_id and al.id = pr.allocation_line_id
             left join machvon.master_record_version fv on fv.tenant_id = al.tenant_id and fv.id = al.fund_source_version_id
            where pr.status = 'REVERSED' and (rt.confirmed_at at time zone 'Asia/Ho_Chi_Minh')::date = $1::date
         ) x
        group by x.project_id, x.project_code, x.fund_key`,
      [day],
    );
    const [statements] = await tx.query<{ n: number }>("select count(*)::int as n from machvon.treasury_import where statement_date = $1::date and status in ('APPLIED', 'PARTIALLY_APPLIED')", [day]);
    const byKey = new Map<string, ReconLine>();
    const keyOf = (projectId: string, fundKey: string): string => `${projectId}|${fundKey}`;
    for (const row of treasury) {
      byKey.set(keyOf(row.project_id, row.fund_key), { projectId: row.project_id, projectCode: row.project_code, fundKey: row.fund_key, fundLabel: row.fund_label, booksVnd: '0', treasuryVnd: row.vnd, booksCount: 0, treasuryCount: row.n });
    }
    for (const row of books) {
      const held = byKey.get(keyOf(row.project_id, row.fund_key));
      if (held === undefined) byKey.set(keyOf(row.project_id, row.fund_key), { projectId: row.project_id, projectCode: row.project_code, fundKey: row.fund_key, fundLabel: row.fund_label, booksVnd: row.vnd, treasuryVnd: '0', booksCount: row.n, treasuryCount: 0 });
      else byKey.set(keyOf(row.project_id, row.fund_key), { ...held, fundLabel: held.fundLabel ?? row.fund_label, booksVnd: row.vnd, booksCount: row.n });
    }
    const lines = [...byKey.values()].sort((a, b) => a.projectCode.localeCompare(b.projectCode) || a.fundKey.localeCompare(b.fundKey));
    return { lines, statementImports: statements?.n ?? 0, transactionCount: treasury.reduce((sum, row) => sum + row.n, 0) };
  }

  /** The default owner of an item: the person who imported the statement of the day, else the person who runs the pass; always an active member. */
  private async ownerOf(tx: TenantTx, day: string, actor: string): Promise<string> {
    const [importer] = await tx.query<{ imported_by: string }>(
      `select i.imported_by from machvon.treasury_import i join machvon.membership m on m.tenant_id = i.tenant_id and m.id = i.imported_by and m.status = 'Active'
        where i.statement_date = $1::date and i.status in ('APPLIED', 'PARTIALLY_APPLIED') order by i.imported_at desc, i.id desc limit 1`,
      [day],
    );
    return importer?.imported_by ?? actor;
  }

  /** The working day test for the due day: the published calendar of the year, else the week; `assumed` says when a day was judged by the week. */
  private async calendarFor(tx: TenantTx, fromDay: string): Promise<{ isWorking: (day: string) => boolean; assumed: () => boolean }> {
    const firstYear = Number(fromDay.slice(0, 4));
    const source: WorkCalendarSource = await this.calendars.source(tx, DEFAULT_CALENDAR, firstYear, firstYear + 2);
    let assumed = false;
    return {
      isWorking: (day) => {
        const calendar = source.forYear(Number(day.slice(0, 4)));
        if (calendar === undefined) {
          assumed = true;
          return isWeekday(day);
        }
        return isWorkingDay(calendar, day);
      },
      assumed: () => assumed,
    };
  }

  /**
   * Runs one business day. `judgeMissing` is false for a pass of the job inside the grace days (a statement that is not due yet is not judged: nothing is written). The pass is idempotent: the lines of the pass are
   * hashed, and the very lines of the latest pass of the day are not written again. A PARTIAL pass opens no item and clears none (a day that could not be seen whole proves nothing).
   */
  async runDay(tx: TenantTx, input: { day: string; actor: string; now: Date; origin: 'JOB' | 'MANUAL'; judgeMissing: boolean }, wholeTenant = true): Promise<RunOutcome> {
    const today = vietnamDateOf(input.now);
    if (!isRealDay(input.day) || input.day > today || input.day < reconAddDays(today, -MAX_AGE_DAYS)) throw invalid('recon_date');
    const rule = await this.rule(tx, today);
    // One pass of one day at a time: a second pass that arrives while the first holds its turn waits for it and then finds its lines.
    await tx.query("select pg_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id', true) || ':daily-recon:' || $1, 0))", [input.day]);
    const calendar = await this.calendarFor(tx, input.day < today ? input.day : today);

    let sides: DaySides = { lines: [], statementImports: 0, transactionCount: 0 };
    let readable = true;
    await tx.query('savepoint daily_recon_read');
    try {
      sides = await this.readSides(tx, input.day);
      await tx.query('release savepoint daily_recon_read');
    } catch {
      // A source that cannot be read makes the day PARTIAL with its reason; the transaction goes on without the half-read data.
      await tx.query('rollback to savepoint daily_recon_read');
      readable = false;
    }
    const workingDay = calendar.isWorking(input.day);
    const verdict = runStatusOf({ statementPresent: sides.statementImports > 0, workingDay, transactions: sides.transactionCount, sourceReadable: readable });
    if (!input.judgeMissing && verdict.reason === 'STATEMENT_MISSING') return { run: null, lines: [], reused: false, notDue: true, openedItemIds: [], clearedItemIds: [] };

    // The neighbouring days are read only to recognise a payment that the two sides date one day apart.
    let neighbours: ReconLine[] = [];
    const differs = sides.lines.some((line) => differenceOf(line) !== 0n);
    if (readable && differs) {
      await tx.query('savepoint daily_recon_neighbours');
      try {
        neighbours = [...(await this.readSides(tx, reconAddDays(input.day, -1))).lines, ...(await this.readSides(tx, reconAddDays(input.day, 1))).lines];
        await tx.query('release savepoint daily_recon_neighbours');
      } catch {
        await tx.query('rollback to savepoint daily_recon_neighbours');
        neighbours = [];
      }
    }
    const complete = verdict.status === 'COMPLETE';
    const judged = sides.lines.map((line) => {
      const near = neighbours.filter((other) => other.projectId === line.projectId && other.fundKey === line.fundKey);
      const kind = classifyLine(line, near);
      return { line, kind, opens: complete && opensItem(line, kind, rule.policy) };
    });
    const hash = sha256Hex(
      canonicalJson({
        day: input.day,
        status: verdict.status,
        reason: verdict.reason,
        imports: sides.statementImports,
        threshold: [rule.policy.thresholdVnd, rule.policy.thresholdPct, rule.version],
        lines: judged.map((entry) => [entry.line.projectId, entry.line.fundKey, entry.line.booksVnd, entry.line.treasuryVnd, entry.kind, entry.opens]),
      }),
    );
    const [latest] = await tx.query<RunSql>(`select ${RUN_COLUMNS} from machvon.treasury_daily_recon_run r where r.recon_date = $1::date order by r.run_no desc limit 1`, [input.day]);
    const [stored] = latest === undefined ? [] : await tx.query<{ same: boolean }>('select result_sha256 = $2 as same from machvon.treasury_daily_recon_run where id = $1::uuid', [latest.id, hash]);
    if (latest !== undefined && stored?.same === true) {
      const lines = await tx.query<LineSql>(this.lineSql(), [latest.id]);
      return { run: toRun(latest, wholeTenant), lines: lines.map(toLine), reused: true, notDue: false, openedItemIds: [], clearedItemIds: [] };
    }

    const runId = randomUUID();
    const runNo = (latest?.run_no ?? 0) + 1;
    const booksTotal = judged.reduce((sum, entry) => sum + BigInt(entry.line.booksVnd), 0n);
    const treasuryTotal = judged.reduce((sum, entry) => sum + BigInt(entry.line.treasuryVnd), 0n);
    const differenceLines = judged.filter((entry) => entry.kind !== null && entry.kind !== 'TIMING').length;

    // What the pass will do to the items is decided before the pass is written, because the row of the pass is never changed: the counts and the calendar that counted the due day are in it from the start.
    const opening = judged.filter((candidate) => candidate.opens);
    const keyOf = (projectId: string, fundKey: string): string => `${projectId}|${fundKey}`;
    const waiting = complete
      ? await tx.query<{ id: string; project_id: string; fund_key: string; latest_difference_vnd: string }>(
          `select id, project_id, fund_key, latest_difference_vnd::text as latest_difference_vnd from machvon.treasury_daily_recon_item where recon_date = $1::date and status in ${LIVE} for update`,
          [input.day],
        )
      : [];
    const waitingBy = new Map(waiting.map((item) => [keyOf(item.project_id, item.fund_key), item]));
    const toOpen = opening.filter((entry) => !waitingBy.has(keyOf(entry.line.projectId, entry.line.fundKey)));
    const stillOpen = new Set(opening.map((entry) => keyOf(entry.line.projectId, entry.line.fundKey)));
    const toClear = waiting.filter((item) => !stillOpen.has(keyOf(item.project_id, item.fund_key)));
    const dueDay = toOpen.length > 0 ? dueOn(today, rule.policy.dueDays, calendar.isWorking) : today;
    const owner = toOpen.length > 0 ? await this.ownerOf(tx, input.day, input.actor) : input.actor;

    await tx.query(
      `insert into machvon.treasury_daily_recon_run
         (tenant_id, id, recon_date, run_no, status, partial_reason, statement_imports, transaction_count, line_count, difference_line_count, opened_items, cleared_items, books_total_vnd, treasury_total_vnd, rule_version, rule_source,
          rule_unverified, threshold_vnd, threshold_pct, due_days, partial_after_days, calendar_basis, result_sha256, origin, created_by)
       values (${TENANT}, $1::uuid, $2::date, $3::int, $4, $5, $6::int, $7::int, $8::int, $9::int, $10::int, $11::int, $12::numeric, $13::numeric, $14::int, $15, $16::boolean, $17::numeric, $18::numeric, $19::int, $20::int, $21, $22, $23, $24::uuid)`,
      [
        runId, input.day, runNo, verdict.status, verdict.reason, sides.statementImports, sides.transactionCount, judged.length, differenceLines, toOpen.length, toClear.length, booksTotal.toString(), treasuryTotal.toString(),
        rule.version, rule.source, rule.unverified, rule.policy.thresholdVnd, rule.policy.thresholdPct, rule.policy.dueDays, rule.policy.partialAfterDays, calendar.assumed() ? 'WEEKDAYS_ASSUMED' : 'WORK_CALENDAR', hash, input.origin, input.actor,
      ],
    );
    if (judged.length > 0) {
      await tx.query(
        `insert into machvon.treasury_daily_recon_line (tenant_id, id, run_id, project_id, project_code, fund_key, fund_label, books_vnd, treasury_vnd, books_count, treasury_count, kind, opens_item)
         select ${TENANT}, gen_random_uuid(), $1::uuid, x.project_id, x.project_code, x.fund_key, x.fund_label, x.books_vnd, x.treasury_vnd, x.books_count, x.treasury_count, x.kind, x.opens_item
           from jsonb_to_recordset($2::jsonb) as x(project_id uuid, project_code text, fund_key text, fund_label text, books_vnd numeric, treasury_vnd numeric, books_count int, treasury_count int, kind text, opens_item boolean)`,
        [
          runId,
          JSON.stringify(
            judged.map((entry) => ({ project_id: entry.line.projectId, project_code: entry.line.projectCode, fund_key: entry.line.fundKey, fund_label: entry.line.fundLabel, books_vnd: entry.line.booksVnd, treasury_vnd: entry.line.treasuryVnd, books_count: entry.line.booksCount, treasury_count: entry.line.treasuryCount, kind: entry.kind, opens_item: entry.opens })),
          ),
        ],
      );
    }

    const opened: string[] = [];
    for (const entry of opening) {
      const { line } = entry;
      const live = waitingBy.get(keyOf(line.projectId, line.fundKey));
      if (live !== undefined) {
        if (live.latest_difference_vnd !== differenceOf(line).toString()) {
          await tx.query('update machvon.treasury_daily_recon_item set latest_difference_vnd = $2::numeric, last_run_id = $3::uuid, updated_by = $4::uuid, updated_at = now(), version = version + 1 where id = $1::uuid', [live.id, differenceOf(line).toString(), runId, input.actor]);
        }
        continue;
      }
      const [created] = await tx.query<{ id: string }>(
        `insert into machvon.treasury_daily_recon_item
           (tenant_id, id, project_id, fund_key, fund_label, recon_date, kind, books_vnd, treasury_vnd, latest_difference_vnd, owner_membership_id, due_on, status, opened_run_id, last_run_id, created_by, updated_by)
         values (${TENANT}, gen_random_uuid(), $1::uuid, $2, $3, $4::date, $5, $6::numeric, $7::numeric, $8::numeric, $9::uuid, $10::date, 'OPEN', $11::uuid, $11::uuid, $12::uuid, $12::uuid) returning id`,
        [line.projectId, line.fundKey, line.fundLabel, input.day, entry.kind, line.booksVnd, line.treasuryVnd, differenceOf(line).toString(), owner, dueDay, runId, input.actor],
      );
      if (created !== undefined) opened.push(created.id);
    }
    // A difference that is gone (or is now a timing pair, or within the threshold) clears the item with the pass that proves it.
    const cleared: string[] = [];
    for (const item of toClear) {
      await tx.query("update machvon.treasury_daily_recon_item set status = 'AUTO_CLEARED', cleared_run_id = $2::uuid, last_run_id = $2::uuid, latest_difference_vnd = 0, updated_by = $3::uuid, updated_at = now(), version = version + 1 where id = $1::uuid", [item.id, runId, input.actor]);
      cleared.push(item.id);
    }
    const [written] = await tx.query<RunSql>(`select ${RUN_COLUMNS} from machvon.treasury_daily_recon_run r where r.id = $1::uuid`, [runId]);
    if (written === undefined) throw new Error('a daily reconciliation pass vanished after it was written');
    const lines = await tx.query<LineSql>(this.lineSql(), [runId]);
    return { run: toRun(written, wholeTenant), lines: lines.map(toLine), reused: false, notDue: false, openedItemIds: opened, clearedItemIds: cleared };
  }

  private lineSql(): string {
    return `select l.id, l.project_id, l.project_code, l.fund_key, l.fund_label, l.books_vnd::text as books_vnd, l.treasury_vnd::text as treasury_vnd, l.difference_vnd::text as difference_vnd,
                   l.books_count, l.treasury_count, l.kind, l.opens_item
              from machvon.treasury_daily_recon_line l where l.run_id = $1::uuid order by l.project_code, l.fund_key`;
  }

  /** The passes, the latest day first; a reader who sees only part of the projects does not get the totals of the tenant. */
  async listRuns(tx: TenantTx, scope: ScopeBuilder, request: { limit: number; after: { code: string; id: string } | undefined; status?: string | undefined; reconDate?: string | undefined }): Promise<ReconRunView[]> {
    if (request.reconDate !== undefined && !isRealDay(request.reconDate)) throw invalid('recon_date');
    if (request.status !== undefined && request.status !== 'COMPLETE' && request.status !== 'PARTIAL') throw invalid('status');
    if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > MAX_PAGE + 1) throw invalid('limit');
    const whole = scope(1).sql === 'true';
    const rows = await tx.query<RunSql>(
      `select ${RUN_COLUMNS} from machvon.treasury_daily_recon_run r
        where ($1::text is null or r.status = $1) and ($2::date is null or r.recon_date = $2::date)
          and ($3::text is null or (to_char(r.recon_date, 'YYYY-MM-DD') || '#' || lpad(r.run_no::text, 6, '0'), r.id) < ($3::text, $4::uuid))
        order by r.recon_date desc, r.run_no desc, r.id desc limit ${request.limit}`,
      [request.status ?? null, request.reconDate ?? null, request.after?.code ?? null, request.after?.id ?? null],
    );
    return rows.map((row) => toRun(row, whole));
  }

  /** One pass with its lines of the projects the caller may see (a total is recomputed from them for a partial reader); undefined when there is no such pass. */
  async getRun(tx: TenantTx, scope: ScopeBuilder, id: string): Promise<{ run: ReconRunView; lines: ReconLineView[]; hiddenLines: number } | undefined> {
    const [row] = await tx.query<RunSql>(`select ${RUN_COLUMNS} from machvon.treasury_daily_recon_run r where r.id = $1::uuid`, [normalizeUuid(id, 'id')]);
    if (row === undefined) return undefined;
    const predicate = scope(2);
    const whole = predicate.sql === 'true';
    const lines = await tx.query<LineSql>(
      `select l.id, l.project_id, l.project_code, l.fund_key, l.fund_label, l.books_vnd::text as books_vnd, l.treasury_vnd::text as treasury_vnd, l.difference_vnd::text as difference_vnd,
              l.books_count, l.treasury_count, l.kind, l.opens_item
         from ${SCOPE_FROM} join machvon.treasury_daily_recon_line l on l.tenant_id = p.tenant_id and l.project_id = p.id
        where l.run_id = $1::uuid and ${predicate.sql} order by l.project_code, l.fund_key`,
      [row.id, ...predicate.params],
    );
    return { run: toRun(row, whole), lines: lines.map(toLine), hiddenLines: Math.max(0, row.line_count - lines.length) };
  }

  /** The days in a range with the state of the latest pass of each, so the screen can say which day has no pass and which is PARTIAL. */
  async days(tx: TenantTx, from: string, to: string): Promise<Array<{ reconDate: string; status: ReconRunStatus; partialReason: ReconPartialReason | null; runNo: number; id: string }>> {
    if (!isRealDay(from) || !isRealDay(to) || from > to) throw invalid('from');
    const rows = await tx.query<{ recon_date: string; status: ReconRunStatus; partial_reason: ReconPartialReason | null; run_no: number; id: string }>(
      `select distinct on (r.recon_date) r.recon_date::text as recon_date, r.status, r.partial_reason, r.run_no, r.id
         from machvon.treasury_daily_recon_run r where r.recon_date between $1::date and $2::date order by r.recon_date desc, r.run_no desc`,
      [from, to],
    );
    return rows.map((row) => ({ reconDate: row.recon_date, status: row.status, partialReason: row.partial_reason, runNo: row.run_no, id: row.id }));
  }

  /** The items of the projects in the scope of the caller, the ones due first; the cursor is the due day and the id. */
  async listItems(tx: TenantTx, scope: ScopeBuilder, filter: ItemFilter, now: Date): Promise<ReconItemView[]> {
    const status = filter.status === undefined ? null : (ITEM_STATUSES.find((candidate) => candidate === filter.status) ?? this.bad('status'));
    const owner = filter.ownerMembershipId === undefined ? null : normalizeUuid(filter.ownerMembershipId, 'owner_membership_id');
    const project = filter.projectId === undefined ? null : normalizeUuid(filter.projectId, 'project_id');
    if (filter.reconDate !== undefined && !isRealDay(filter.reconDate)) throw invalid('recon_date');
    if (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > MAX_PAGE + 1) throw invalid('limit');
    if (filter.after !== undefined && !isRealDay(filter.after.code)) throw invalid('cursor');
    const predicate = scope(8);
    const rows = await tx.query<ItemSql>(
      `select ${ITEM_COLUMNS} ${ITEM_FROM}
        where ($2::text is null or i.status = $2) and ($3::uuid is null or i.owner_membership_id = $3::uuid) and ($4::uuid is null or i.project_id = $4::uuid) and ($5::date is null or i.recon_date = $5::date)
          and ($6::date is null or (i.due_on, i.id) > ($6::date, $7::uuid)) and ${predicate.sql}
        order by i.due_on asc, i.id asc limit ${filter.limit}`,
      [vietnamDateOf(now), status, owner, project, filter.reconDate ?? null, filter.after?.code ?? null, filter.after?.id ?? null, ...predicate.params],
    );
    return rows.map(toItem);
  }

  async findItem(tx: TenantTx, scope: ScopeBuilder, id: string, now: Date): Promise<ReconItemView | undefined> {
    const predicate = scope(3);
    const rows = await tx.query<ItemSql>(`select ${ITEM_COLUMNS} ${ITEM_FROM} where i.id = $2::uuid and ${predicate.sql}`, [vietnamDateOf(now), normalizeUuid(id, 'id'), ...predicate.params]);
    return rows[0] === undefined ? undefined : toItem(rows[0]);
  }

  /** What the board counts for the projects in the scope of the caller. */
  async summary(tx: TenantTx, scope: ScopeBuilder, now: Date): Promise<{ waiting: number; overdue: number; waitingDifferenceVnd: string }> {
    const predicate = scope(2);
    const [row] = await tx.query<{ waiting: string; overdue: string; difference: string }>(
      `select count(*)::text as waiting, (count(*) filter (where i.due_on < $1::date))::text as overdue, coalesce(sum(i.latest_difference_vnd), 0)::text as difference
         from ${SCOPE_FROM} join machvon.treasury_daily_recon_item i on i.tenant_id = p.tenant_id and i.project_id = p.id
        where i.status in ${LIVE} and ${predicate.sql}`,
      [vietnamDateOf(now), ...predicate.params],
    );
    return { waiting: Number(row?.waiting ?? 0), overdue: Number(row?.overdue ?? 0), waitingDifferenceVnd: row?.difference ?? '0' };
  }

  /** Gives the item to an owner (an active member) with the day it is due; while the item waits the owner can be changed as often as needed. */
  async assign(tx: TenantTx, id: string, expectedVersion: number, input: { ownerMembershipId: string; dueOn: string }, actor: string, scope: ScopeBuilder, now: Date): Promise<ItemChange> {
    const owner = normalizeUuid(input.ownerMembershipId, 'owner_membership_id');
    if (!isRealDay(input.dueOn)) throw invalid('due_on');
    if (input.dueOn < vietnamDateOf(now)) throw invalid('due_on', 'NOT_IN_THE_FUTURE');
    const held = await this.lock(tx, id, expectedVersion, scope, now);
    if (!LIVE_STATUSES.includes(held.status)) throw new DomainError('RECONCILIATION_STATE_INVALID', 409, 'id', { extensions: { status: held.status } });
    const members = await tx.query<{ id: string }>("select id from machvon.membership where id = $1::uuid and status = 'Active' and (valid_until is null or valid_until > now())", [owner]);
    if (members[0] === undefined) throw invalid('owner_membership_id', 'NOT_AN_ACTIVE_MEMBER');
    await tx.query('update machvon.treasury_daily_recon_item set owner_membership_id = $2::uuid, due_on = $3::date, overdue_flagged_at = null, updated_by = $4::uuid, updated_at = now(), version = version + 1 where id = $1::uuid', [held.id, owner, input.dueOn, actor]);
    await this.refreshGauges(tx, now);
    return { view: await this.viewOf(tx, held.id, now), fromStatus: held.status, fromOwnerMembershipId: held.owner_membership_id };
  }

  /**
   * Explains, resolves or writes off an item with the words of the person (422 `VALIDATION_FAILED` without them). A write-off asks for the document that approves it (422 `APPROVAL_REQUIRED`, and a clean scan) and for
   * someone who is not the owner, not the person who explained it and not the one who opened it (403 `SELF_APPROVAL_DENIED`); it changes no figure.
   */
  async resolve(
    tx: TenantTx,
    id: string,
    expectedVersion: number,
    input: { resolution: string; note: string | undefined; approvalDocumentVersionId: string | undefined },
    actor: string,
    scope: ScopeBuilder,
    now: Date,
  ): Promise<ItemChange> {
    const resolution: DailyReconResolution = DAILY_RECON_RESOLUTIONS.find((candidate) => candidate === input.resolution) ?? this.bad('resolution');
    const note = input.note?.trim() ?? '';
    if (note === '' || note.length > 2000) throw invalid('note');
    const approval = input.approvalDocumentVersionId === undefined ? undefined : normalizeUuid(input.approvalDocumentVersionId, 'approval_document_version_id');
    const held = await this.lock(tx, id, expectedVersion, scope, now);
    const target = resolution === 'EXPLAINED' ? (held.status === 'OPEN' ? 'EXPLAINED' : undefined) : LIVE_STATUSES.includes(held.status) ? (resolution === 'RESOLVED' ? 'RESOLVED' : 'WRITTEN_OFF_APPROVED') : undefined;
    if (target === undefined) throw new DomainError('RECONCILIATION_STATE_INVALID', 409, 'id', { extensions: { status: held.status, resolution } });
    if (resolution === 'WRITTEN_OFF') {
      if (approval === undefined) throw new DomainError('APPROVAL_REQUIRED', 422, 'approval_document_version_id');
      const [creator] = await tx.query<{ created_by: string; explained_by: string | null }>('select created_by, explained_by from machvon.treasury_daily_recon_item where id = $1::uuid', [held.id]);
      if (actor === held.owner_membership_id || actor === creator?.explained_by || actor === creator?.created_by) throw new DomainError('SELF_APPROVAL_DENIED', 403);
      const [document] = await tx.query<{ scan_status: string }>('select scan_status from machvon.document_version where id = $1::uuid', [approval]);
      if (document === undefined) throw invalid('approval_document_version_id', 'NOT_FOUND');
      if (document.scan_status !== 'CLEAN') throw new DomainError('DOCUMENT_NOT_CLEAN', 422, 'approval_document_version_id');
    }
    const ends = target !== 'EXPLAINED';
    try {
      await tx.query(
        `update machvon.treasury_daily_recon_item
            set status = $2, resolution_note = $3, resolved_by = case when $4 then $5::uuid else null end, resolved_at = case when $4 then now() else null end,
                explained_by = case when $2 = 'EXPLAINED' then $5::uuid else explained_by end, explained_at = case when $2 = 'EXPLAINED' then now() else explained_at end,
                approval_document_version_id = $6::uuid, updated_by = $5::uuid, updated_at = now(), version = version + 1
          where id = $1::uuid`,
        [held.id, target, note, ends, actor, approval ?? null],
      );
    } catch (error) {
      throw this.mapRefusal(error);
    }
    await this.refreshGauges(tx, now);
    return { view: await this.viewOf(tx, held.id, now), fromStatus: held.status, fromOwnerMembershipId: held.owner_membership_id };
  }

  /** Counts the items that wait and the ones past their day, for the whole tenant, on the gauges the alert reads. */
  async refreshGauges(tx: TenantTx, now: Date): Promise<{ waiting: number; overdue: number }> {
    const [row] = await tx.query<{ waiting: string; overdue: string }>(
      `select count(*)::text as waiting, (count(*) filter (where due_on < $1::date))::text as overdue from machvon.treasury_daily_recon_item where status in ${LIVE}`,
      [vietnamDateOf(now)],
    );
    const summary = { waiting: Number(row?.waiting ?? 0), overdue: Number(row?.overdue ?? 0) };
    this.metrics.gauge(TREASURY_DAILY_RECON_OPEN_METRIC, summary.waiting);
    this.metrics.gauge(TREASURY_DAILY_RECON_OVERDUE_METRIC, summary.overdue);
    return summary;
  }

  private async lock(tx: TenantTx, id: string, expectedVersion: number, scope: ScopeBuilder, now: Date): Promise<ItemSql> {
    const found = await this.findItem(tx, scope, id, now);
    // An item outside the scope of the caller is an item that is not there.
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const [row] = await tx.query<ItemSql>(`select ${ITEM_COLUMNS} ${ITEM_FROM} where i.id = $2::uuid for update of i`, [vietnamDateOf(now), found.id]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    return row;
  }

  private async viewOf(tx: TenantTx, id: string, now: Date): Promise<ReconItemView> {
    const [row] = await tx.query<ItemSql>(`select ${ITEM_COLUMNS} ${ITEM_FROM} where i.id = $2::uuid`, [vietnamDateOf(now), id]);
    if (row === undefined) throw new Error('the item vanished after its change');
    return toItem(row);
  }

  private bad(field: string): never {
    throw invalid(field);
  }

  private mapRefusal(error: unknown): unknown {
    const failure = error as { code?: string; message?: string };
    if (failure.code !== CHECK_VIOLATION) return error;
    const message = failure.message ?? '';
    if (message.includes('RECONCILIATION_STATE_INVALID')) return new DomainError('RECONCILIATION_STATE_INVALID', 409, 'id');
    if (message.includes('treasury_daily_recon_item_write_off_chk')) return new DomainError('SELF_APPROVAL_DENIED', 403);
    return error;
  }
}

/** The audit row and the event of a pass that was written (a pass that was reused or not due writes neither). Facts only: ids, counts and codes; nothing a person said. */
export function reconRunRecord(outcome: RunOutcome & { run: ReconRunView }, tenantId: string, actor: string, occurredAt: Date) {
  const { run } = outcome;
  const facts = {
    recon_date: run.reconDate,
    run_no: run.runNo,
    status: run.status,
    partial_reason: run.partialReason,
    statement_imports: run.statementImports,
    transaction_count: run.transactionCount,
    line_count: run.lineCount,
    difference_line_count: run.differenceLineCount,
    opened_items: outcome.openedItemIds.length,
    cleared_items: outcome.clearedItemIds.length,
    rule_version: run.ruleVersion,
    rule_source: run.ruleSource,
    threshold_vnd: run.thresholdVnd,
    calendar_basis: run.calendarBasis,
    origin: run.origin,
  };
  return {
    audit: { action: 'pay.treasury_daily_recon_run', resourceType: TREASURY_RECON_RUN_RESOURCE, resourceId: run.id, classification: 'CONFIDENTIAL' as const, diff: facts },
    event: {
      aggregateType: TREASURY_RECON_RUN_RESOURCE,
      aggregateId: run.id,
      aggregateVersion: 1,
      type: TREASURY_DAILY_RECON_RUN_EVENT,
      schemaVersion: 1,
      payload: { tenant_id: tenantId, run_id: run.id, ...facts, actor_id: actor, occurred_at: occurredAt.toISOString() },
      eventKey: `${TREASURY_RECON_RUN_RESOURCE}:${run.id}`,
    },
  };
}

