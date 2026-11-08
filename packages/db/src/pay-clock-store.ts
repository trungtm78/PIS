import { DomainError, PAYMENT_CLOCK_RULE_TYPE, PAYMENT_RETURN_REASON_RULE_TYPE, clockDueAt, clockKindOf, judgePaymentClock, payClockParams, returnReasonParams, summariseClocks } from '@machvon/kernel';
import type { ClockBasis, ClockEnd, ClockSummary, PaymentClockKind, PayClockParams, PaymentClockState, Provenance, ReasonCatalogue, ReturnReasonParams, WorkCalendarSource } from '@machvon/kernel';
import { SCOPE_FROM as CONTRACT_SCOPE_FROM } from './ctr-contract-store.ts';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import { HomeWorkCalendars, WORK_CALENDAR_CODE } from './home-work-clock-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export const PAYMENT_CLOCK_RESOURCE = 'payment_clock';
/** How many rows of the window one read judges: a board over more says so (`truncated`) instead of quietly adding up a part. */
export const CLOCK_READ_LIMIT = 5000;
/** The days a board looks back by default. */
export const CLOCK_WINDOW_DAYS = 90;

const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const DAY_MS = 86_400_000;

interface ClockSql {
  id: string;
  payment_request_id: string;
  request_no: string | null;
  request_status: string;
  net_vnd: string;
  project_id: string;
  project_code: string;
  project_name: string;
  contract_id: string;
  contract_code: string;
  owner_unit_id: string;
  investor_unit_id: string | null;
  investor_code: string | null;
  investor_name: string | null;
  clock_kind: PaymentClockKind;
  attempt: number;
  started_at: string;
  working_days: number;
  near_working_hours: number;
  due_at: string | null;
  basis: ClockBasis;
  policy_version: number;
  ended_at: string | null;
  end_kind: ClockEnd | null;
  return_reason_code: string | null;
  returned_by_treasury: boolean | null;
}

export interface PaymentClockRow {
  id: string;
  paymentRequestId: string;
  requestNo: string | null;
  requestStatus: string;
  netVnd: string;
  project: { id: string; code: string; name: string };
  contract: { id: string; code: string };
  investor: { id: string; code: string; name: string } | null;
  clockKind: PaymentClockKind;
  attempt: number;
  startedAt: string;
  workingDays: number;
  policyVersion: number;
  state: PaymentClockState;
  basis: ClockBasis;
  dueAt: string | null;
  workingMinutesLeft: number | null;
  workingMinutesLate: number | null;
  endedAt: string | null;
  endKind: ClockEnd | null;
  returnReasonCode: string | null;
  returnedByTreasury: boolean | null;
}

export interface ClockFilter {
  state?: PaymentClockState | undefined;
  kind?: PaymentClockKind | undefined;
  unitId?: string | undefined;
  /** First day (Vietnam time, `YYYY-MM-DD`) a clock may have started on; default is `CLOCK_WINDOW_DAYS` back from today. */
  from?: string | undefined;
  /** Only the clocks that have not ended (the alert centre reads these). */
  openOnly?: boolean | undefined;
}

export interface ClockBoard {
  rows: PaymentClockRow[];
  summary: ClockSummary;
  /** Whether the window held more rows than one read judges (the figures then count the newest `CLOCK_READ_LIMIT`). */
  truncated: boolean;
  /** Whether any row was counted without a published calendar (its due instant is unknown, never guessed). */
  calendarUnavailable: boolean;
  /** The calendar versions are not named: the board only says whether one was found at all. */
  calendarFound: boolean;
}

export interface ClockRuleReading {
  kind: PaymentClockKind;
  params: PayClockParams;
  version: number;
  source: 'RULE' | 'DEFAULT';
  unverified: boolean;
  provenance: Provenance | null;
}

export interface ReasonReading {
  code: string;
  params: ReturnReasonParams;
  version: number;
  source: 'RULE' | 'DEFAULT';
  unverified: boolean;
}

export interface StartInput {
  requestId: string;
  actor: string;
  now: Date;
}

export interface EndInput {
  requestId: string;
  endKind: ClockEnd;
  actor: string;
  now: Date;
  reasonCode?: string | null | undefined;
  byTreasury?: boolean | undefined;
}

const toRow = (row: ClockSql, reading: ReturnType<typeof judgePaymentClock>): PaymentClockRow => ({
  id: row.id,
  paymentRequestId: row.payment_request_id,
  requestNo: row.request_no,
  requestStatus: row.request_status,
  netVnd: row.net_vnd,
  project: { id: row.project_id, code: row.project_code, name: row.project_name },
  contract: { id: row.contract_id, code: row.contract_code },
  investor: row.investor_unit_id === null ? null : { id: row.investor_unit_id, code: row.investor_code ?? '', name: row.investor_name ?? '' },
  clockKind: row.clock_kind,
  attempt: row.attempt,
  startedAt: row.started_at,
  workingDays: row.working_days,
  policyVersion: row.policy_version,
  state: reading.state,
  basis: reading.basis,
  dueAt: reading.dueAt === null ? null : reading.dueAt.toISOString(),
  workingMinutesLeft: reading.workingMinutesLeft,
  workingMinutesLate: reading.workingMinutesLate,
  endedAt: row.ended_at,
  endKind: row.end_kind,
  returnReasonCode: row.return_reason_code,
  returnedByTreasury: row.returned_by_treasury,
});

/**
 * The clocks of the Treasury control of payment requests (G1-17): `start` when the dossier is sent to the Treasury (the clock of the request kind, 2 working days for a payment and 1 for an advance as the
 * rule `PAYMENT_CLOCK` says, counted on the published working calendar), `end` when the request is settled or returned (a return carries the code of a standard reason), and the reads of the board and of the
 * catalogue of reasons. The state of a clock is never written: it is judged when read. A request that has no clock (sent before this module) simply has none; nothing is made up for it.
 */
export class PayClockStore {
  private readonly policy: GovernancePolicyPort;
  private readonly calendars: HomeWorkCalendars;

  constructor(policy: GovernancePolicyPort = new GovernancePolicyPort(), calendars: HomeWorkCalendars = new HomeWorkCalendars()) {
    this.policy = policy;
    this.calendars = calendars;
  }

  /** The rule of a clock kind in force on a day, read through the governance port (the approved rule of the tenant, else the built-in default). */
  async rule(tx: TenantTx, kind: PaymentClockKind, today: string): Promise<ClockRuleReading> {
    const resolved = await this.policy.require(tx, PAYMENT_CLOCK_RULE_TYPE, kind, today);
    return { kind, params: payClockParams(resolved.params), version: resolved.version, source: resolved.source, unverified: resolved.unverified, provenance: resolved.provenance };
  }

  /** The standard reasons in force on a day (a code a tenant retired is `active: false` and still read on old returns); sorted by code. */
  async reasons(tx: TenantTx, today: string): Promise<ReasonReading[]> {
    const all = await this.policy.getAll(tx, PAYMENT_RETURN_REASON_RULE_TYPE, today);
    const readings: ReasonReading[] = [];
    for (const resolved of all) {
      try {
        readings.push({ code: resolved.code, params: returnReasonParams(resolved.params), version: resolved.version, source: resolved.source, unverified: resolved.unverified });
      } catch (failure) {
        // A rule that does not read is skipped here (the governance store refuses to approve one that does not pass its schema); the others stay usable.
        if (!(failure instanceof DomainError)) throw failure;
      }
    }
    return readings;
  }

  async catalogue(tx: TenantTx, today: string): Promise<ReasonCatalogue> {
    return new Map((await this.reasons(tx, today)).map((reading) => [reading.code, reading.params]));
  }

  /** What a return needs to be judged: the catalogue of the day and, for each kind of clock, whether a code is required. */
  async returnRules(tx: TenantTx, today: string): Promise<{ catalogue: ReasonCatalogue; required: Readonly<Record<PaymentClockKind, boolean>> }> {
    const [catalogue, payment, advance] = await Promise.all([this.catalogue(tx, today), this.rule(tx, 'PAYMENT', today), this.rule(tx, 'ADVANCE', today)]);
    return { catalogue, required: { PAYMENT: payment.params.reason_code_required, ADVANCE: advance.params.reason_code_required } };
  }

  /**
   * Starts the clock of a request that was just sent to the Treasury: the instant is the one the send recorded (`treasury_sent_at`), the kind is that of the request, the days and the policy version are the
   * ones in force today, and the due instant is counted on the published calendar (null, with the basis `CALENDAR_UNAVAILABLE`, when no calendar covers the days). One attempt for each send: a request that was
   * returned and is sent again has a second clock. Returns the attempt number, or undefined when the request is not at the Treasury (nothing is started).
   */
  async start(tx: TenantTx, input: StartInput): Promise<{ attempt: number; dueAt: string | null; basis: ClockBasis } | undefined> {
    const [request] = await tx.query<{ id: string; request_kind: string; project_id: string; contract_id: string; owner_unit_id: string; sent_at: string | null }>(
      `select pr.id, pr.request_kind, pr.project_id, pr.contract_id, p.owner_unit_id, ${ISO('pr.treasury_sent_at')} as sent_at
         from machvon.payment_request pr join machvon.project p on p.tenant_id = pr.tenant_id and p.id = pr.project_id
        where pr.id = $1::uuid and pr.status = 'SENT_TREASURY' and pr.treasury_sent_at is not null`,
      [input.requestId],
    );
    if (request === undefined || request.sent_at === null) return undefined;
    const kind = clockKindOf(request.request_kind);
    const day = new Date(input.now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
    const rule = await this.rule(tx, kind, day);
    const startedAt = new Date(request.sent_at);
    const calendars = await this.calendars.load(tx, WORK_CALENDAR_CODE, startedAt);
    const due = clockDueAt(calendars, startedAt, rule.params.working_days);
    const [next] = await tx.query<{ attempt: number }>('select coalesce(max(attempt), 0) + 1 as attempt from machvon.payment_clock where payment_request_id = $1::uuid', [request.id]);
    const attempt = Number(next?.attempt ?? 1);
    await tx.query(
      `insert into machvon.payment_clock
         (tenant_id, payment_request_id, project_id, contract_id, owner_unit_id, clock_kind, attempt, started_at, working_days, near_working_hours, due_at, basis, policy_version, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::timestamptz, $8, $9, $10::timestamptz, $11, $12, $13::uuid, $13::uuid)`,
      [request.id, request.project_id, request.contract_id, request.owner_unit_id, kind, attempt, request.sent_at, rule.params.working_days, rule.params.near_working_hours, due.dueAt === null ? null : due.dueAt.toISOString(), due.basis, rule.version, input.actor],
    );
    return { attempt, dueAt: due.dueAt === null ? null : due.dueAt.toISOString(), basis: due.basis };
  }

  /** Ends the open clock of a request, if it has one: settled by the Treasury, or returned (with the code of the reason). A request without an open clock is left alone. Returns whether a clock ended. */
  async end(tx: TenantTx, input: EndInput): Promise<boolean> {
    const done = await tx.query<{ id: string }>(
      `update machvon.payment_clock
          set ended_at = $2::timestamptz, end_kind = $3, ended_by = $4::uuid, return_reason_code = $5, returned_by_treasury = $6, updated_at = $2::timestamptz, updated_by = $4::uuid, version = version + 1
        where payment_request_id = $1::uuid and ended_at is null
        returning id`,
      [input.requestId, input.now.toISOString(), input.endKind, input.actor, input.endKind === 'RETURNED' ? (input.reasonCode ?? null) : null, input.endKind === 'RETURNED' ? (input.byTreasury ?? false) : null],
    );
    return done.length > 0;
  }

  /**
   * The board of the clocks in the scope of the caller: the rows of the window (newest first, at most `CLOCK_READ_LIMIT`), each judged now on the published calendar, the totals of all of them (never of the
   * page) and the page that was asked for. A caller sees only what the scope of the contract reaches.
   */
  async board(tx: TenantTx, scope: ScopeBuilder, filter: ClockFilter, now: Date): Promise<ClockBoard> {
    const visible = scope(5);
    const today = new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
    const from = filter.from ?? new Date(Date.parse(`${today}T00:00:00Z`) - CLOCK_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
    const rows = await tx.query<ClockSql>(
      `select k.id, k.payment_request_id, pr.request_no, pr.status as request_status, pr.net_vnd::text as net_vnd, c.project_id, p.code as project_code, p.name as project_name, c.id as contract_id, c.code as contract_code,
              k.owner_unit_id, p.investor_unit_id, iu.code as investor_code, iu.name as investor_name, k.clock_kind, k.attempt, ${ISO('k.started_at')} as started_at, k.working_days, k.near_working_hours,
              ${ISO('k.due_at')} as due_at, k.basis, k.policy_version, ${ISO('k.ended_at')} as ended_at, k.end_kind, k.return_reason_code, k.returned_by_treasury
         from ${CONTRACT_SCOPE_FROM}
         join machvon.payment_clock k on k.tenant_id = c.tenant_id and k.contract_id = c.id
         join machvon.payment_request pr on pr.tenant_id = k.tenant_id and pr.id = k.payment_request_id
        where (k.started_at at time zone 'Asia/Ho_Chi_Minh')::date >= $1::date and ($2::text is null or k.clock_kind = $2) and ($3::uuid is null or p.investor_unit_id = $3::uuid or k.owner_unit_id = $3::uuid)
          and ($4::boolean is false or k.ended_at is null) and ${visible.sql}
        order by k.started_at desc, k.id desc
        limit ${CLOCK_READ_LIMIT + 1}`,
      [from, filter.kind ?? null, filter.unitId ?? null, filter.openOnly === true, ...visible.params],
    );
    const truncated = rows.length > CLOCK_READ_LIMIT;
    const kept = rows.slice(0, CLOCK_READ_LIMIT);
    const calendars = await this.calendarsFor(tx, kept, now);
    const judged = kept.map((row) =>
      toRow(
        row,
        judgePaymentClock({
          startedAt: new Date(row.started_at),
          dueAt: row.due_at === null ? null : new Date(row.due_at),
          workingDays: row.working_days,
          nearWorkingHours: row.near_working_hours,
          now,
          endedAt: row.ended_at === null ? null : new Date(row.ended_at),
          endKind: row.end_kind,
          calendars,
        }),
      ),
    );
    const summary = summariseClocks(judged.map((row) => ({ kind: row.clockKind, state: row.state, returnReasonCode: row.returnReasonCode })));
    const shown = filter.state === undefined ? judged : judged.filter((row) => row.state === filter.state);
    return { rows: shown, summary, truncated, calendarUnavailable: judged.some((row) => row.basis === 'CALENDAR_UNAVAILABLE'), calendarFound: calendars !== undefined };
  }

  /** The clocks that run (not ended) in the scope of the caller, judged now: what the alert centre reads. */
  async running(tx: TenantTx, scope: ScopeBuilder, now: Date): Promise<PaymentClockRow[]> {
    const board = await this.board(tx, scope, { from: '2000-01-01', openOnly: true }, now);
    return board.rows.filter((row) => row.endedAt === null);
  }

  private async calendarsFor(tx: TenantTx, rows: readonly ClockSql[], now: Date): Promise<WorkCalendarSource | undefined> {
    if (rows.length === 0) return undefined;
    return this.calendars.load(tx, WORK_CALENDAR_CODE, now);
  }
}
