import { DomainError, addWorkingTime, nativeClock, vietnamDateOf } from '@machvon/kernel';
import type { ClockSeverity, WorkCalendarSource } from '@machvon/kernel';
import { HomeWorkActionStore, actionKey } from './home-work-action-store.ts';
import { WorkPolicyReader } from './home-work-policy.ts';
import { CONSEQUENCES, SEVERITY_RANK, severityOf } from './home-work-rules.ts';
import type { WorkSeverity } from './home-work-rules.ts';
import { PROJECT_JOINS, Params, SOURCE_LIMIT, base, reach } from './home-work-sources.ts';
import type { SourceContext, SourceRow } from './home-work-sources.ts';
import type { TenantTx } from './tenant-database.ts';
import { WorkCalendarStore } from './work-calendar-store.ts';
import type { WorkCalendarRow } from './work-calendar-store.ts';

/** The working calendar the clocks count on unless a module names another (the one the ISS SLA and the ADM deadlines use). */
export const WORK_CALENDAR_CODE = 'WORKDAY_VN';
/** How many calendar years before and after the current one a pass of the alert centre reads: items older than that say `CALENDAR_UNAVAILABLE` rather than get a guessed day. */
const YEARS_BEFORE = 2;
const YEARS_AFTER = 3;
const CODE = /^[A-Z][A-Z0-9_]{1,39}$/;
const SUBJECT = /^[a-z][a-z0-9_]{1,39}$/;
const SCREEN = /^[A-Z]{2,4}-[0-9]{2}$/;

/** Reads the published calendars the clocks count on, once for a pass: the set of the years that exist, and the ids of the versions that were used. */
export class HomeWorkCalendars {
  private readonly store: WorkCalendarStore;

  constructor(store: WorkCalendarStore = new WorkCalendarStore()) {
    this.store = store;
  }

  /** The calendars of the years around `now`; `undefined` when none of them is published (the clocks then say so). The versions that a count read are noted in `used`. */
  async load(tx: TenantTx, code: string, now: Date, used: Set<string> = new Set()): Promise<WorkCalendarSource | undefined> {
    const year = Number(vietnamDateOf(now).slice(0, 4));
    return this.loadYears(tx, code, year - YEARS_BEFORE, year + YEARS_AFTER, used);
  }

  async loadYears(tx: TenantTx, code: string, fromYear: number, toYear: number, used: Set<string> = new Set()): Promise<WorkCalendarSource | undefined> {
    const byYear = new Map<number, WorkCalendarRow>();
    for (let year = fromYear; year <= toYear; year += 1) {
      const row = await this.store.published(tx, code, year);
      if (row !== undefined) byYear.set(year, row);
    }
    if (byYear.size === 0) return undefined;
    return {
      forYear(year) {
        const row = byYear.get(year);
        if (row !== undefined) used.add(row.id);
        return row?.content;
      },
    };
  }
}

export interface WorkClockInput {
  clockType: string;
  subjectType: string;
  subjectId: string;
  title: string;
  subtitle?: string | undefined;
  /** Who answers for it: a person, a unit, or both. */
  ownerMembershipId?: string | undefined;
  ownerUnitId?: string | undefined;
  projectId?: string | undefined;
  severity: ClockSeverity;
  /** Mandatory: what is expected of the owner, and what happens when the time runs out. */
  expectedAction: string;
  consequence: string;
  startedAt: Date;
  /** How long it may run, in working minutes from the start, on the calendar `calendarCode`. */
  workingMinutes: number;
  calendarCode?: string | undefined;
  /** Where the item opens. */
  targetScreen: string;
  targetId: string;
  createdBy: string;
  policyVersion?: string | undefined;
}

export interface WorkClockRow {
  id: string;
  clockType: string;
  subjectType: string;
  subjectId: string;
  title: string;
  subtitle: string | null;
  ownerMembershipId: string | null;
  ownerUnitId: string | null;
  projectId: string | null;
  severity: ClockSeverity;
  expectedAction: string;
  consequence: string;
  calendarCode: string;
  startedAt: string;
  workingMinutes: number;
  dueAt: string;
  calendarVersionIds: string[];
  policyVersion: string;
  targetScreen: string;
  targetId: string;
  status: 'RUNNING' | 'MET' | 'CANCELLED';
  endedAt: string | null;
  endReason: string | null;
  version: number;
}

interface ClockSql {
  id: string;
  clock_type: string;
  subject_type: string;
  subject_id: string;
  title: string;
  subtitle: string | null;
  owner_membership_id: string | null;
  owner_unit_id: string | null;
  project_id: string | null;
  severity: ClockSeverity;
  expected_action: string;
  consequence: string;
  calendar_code: string;
  started_at: string;
  working_minutes: number;
  due_at: string;
  calendar_version_ids: string[];
  policy_version: string;
  target_screen: string;
  target_id: string;
  status: WorkClockRow['status'];
  ended_at: string | null;
  end_reason: string | null;
  version: number;
}

const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
/** The columns of a clock, with the alias the query gives the table (none when it is the only table). */
const columnsOf = (alias = ''): string => {
  const a = alias === '' ? '' : `${alias}.`;
  return `${a}id, ${a}clock_type, ${a}subject_type, ${a}subject_id, ${a}title, ${a}subtitle, ${a}owner_membership_id, ${a}owner_unit_id, ${a}project_id, ${a}severity, ${a}expected_action, ${a}consequence, ${a}calendar_code,
    ${ISO(`${a}started_at`)} as started_at, ${a}working_minutes, ${ISO(`${a}due_at`)} as due_at, ${a}calendar_version_ids, ${a}policy_version, ${a}target_screen, ${a}target_id, ${a}status, ${ISO(`${a}ended_at`)} as ended_at,
    ${a}end_reason, ${a}version`;
};
const COLUMNS = columnsOf();

const toRow = (row: ClockSql): WorkClockRow => ({
  id: row.id,
  clockType: row.clock_type,
  subjectType: row.subject_type,
  subjectId: row.subject_id,
  title: row.title,
  subtitle: row.subtitle,
  ownerMembershipId: row.owner_membership_id,
  ownerUnitId: row.owner_unit_id,
  projectId: row.project_id,
  severity: row.severity,
  expectedAction: row.expected_action,
  consequence: row.consequence,
  calendarCode: row.calendar_code,
  startedAt: row.started_at,
  workingMinutes: row.working_minutes,
  dueAt: row.due_at,
  calendarVersionIds: row.calendar_version_ids,
  policyVersion: row.policy_version,
  targetScreen: row.target_screen,
  targetId: row.target_id,
  status: row.status,
  endedAt: row.ended_at,
  endReason: row.end_reason,
  version: Number(row.version),
});

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const trimmed = (value: string | undefined, field: string, min: number, max: number): string => {
  if (value === undefined || value !== value.trim() || value.length < min || value.length > max) throw invalid(field);
  return value;
};

/**
 * The native clocks of the alert centre (G0-2): a module that has an obligation with a limit of its own starts a clock here, naming who answers for it, what is expected and what happens when the time runs out (the last two
 * are mandatory). The end is counted in working time on the published calendar when the clock starts, and is kept with the versions of the calendar that were read; a year without a published calendar refuses the start
 * (422 CALENDAR_NOT_EFFECTIVE) rather than guess. A clock is ended as MET or CANCELLED, never deleted, and starting the same clock twice gives the one that runs. The module that calls writes its own audit row and event.
 */
export class HomeWorkClockStore {
  private readonly calendars: HomeWorkCalendars;

  constructor(calendars: HomeWorkCalendars = new HomeWorkCalendars()) {
    this.calendars = calendars;
  }

  async start(tx: TenantTx, input: WorkClockInput): Promise<{ clock: WorkClockRow; created: boolean }> {
    if (!CODE.test(input.clockType)) throw invalid('clock_type');
    if (!SUBJECT.test(input.subjectType)) throw invalid('subject_type');
    const subjectId = trimmed(input.subjectId, 'subject_id', 1, 64);
    const title = trimmed(input.title, 'title', 1, 200);
    const subtitle = input.subtitle === undefined ? null : trimmed(input.subtitle, 'subtitle', 1, 200);
    const expectedAction = trimmed(input.expectedAction, 'expected_action', 5, 500);
    const consequence = trimmed(input.consequence, 'consequence', 5, 500);
    if (!SCREEN.test(input.targetScreen)) throw invalid('target_screen');
    const targetId = trimmed(input.targetId, 'target_id', 1, 64);
    if (input.ownerMembershipId === undefined && input.ownerUnitId === undefined) throw invalid('owner');
    if (!Number.isInteger(input.workingMinutes) || input.workingMinutes < 1 || input.workingMinutes > 144_000) throw invalid('working_minutes');
    if (Number.isNaN(input.startedAt.getTime())) throw invalid('started_at');
    const calendarCode = input.calendarCode ?? WORK_CALENDAR_CODE;
    if (!CODE.test(calendarCode)) throw invalid('calendar_code');

    const running = await tx.query<ClockSql>(`select ${COLUMNS} from machvon.work_clock where clock_type = $1 and subject_type = $2 and subject_id = $3 and status = 'RUNNING'`, [input.clockType, input.subjectType, subjectId]);
    if (running[0] !== undefined) return { clock: toRow(running[0]), created: false };

    const used = new Set<string>();
    const firstYear = Number(vietnamDateOf(input.startedAt).slice(0, 4));
    const source = await this.calendars.loadYears(tx, calendarCode, firstYear, firstYear + YEARS_AFTER, used);
    if (source === undefined) throw new DomainError('CALENDAR_NOT_EFFECTIVE', 422, 'calendar_code');
    const dueAt = addWorkingTime(source, input.startedAt, { minutes: input.workingMinutes });

    const inserted = await tx.query<ClockSql>(
      `insert into machvon.work_clock (tenant_id, clock_type, subject_type, subject_id, title, subtitle, owner_membership_id, owner_unit_id, project_id, severity, expected_action, consequence, calendar_code, started_at,
                                       working_minutes, due_at, calendar_version_ids, policy_version, target_screen, target_id, created_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4, $5, $6::uuid, $7::uuid, $8::uuid, $9, $10, $11, $12, $13::timestamptz, $14::int, $15::timestamptz, $16::uuid[], $17, $18, $19, $20::uuid)
       on conflict (tenant_id, clock_type, subject_type, subject_id) where status = 'RUNNING' do nothing
       returning ${COLUMNS}`,
      [
        input.clockType,
        input.subjectType,
        subjectId,
        title,
        subtitle,
        input.ownerMembershipId ?? null,
        input.ownerUnitId ?? null,
        input.projectId ?? null,
        input.severity,
        expectedAction,
        consequence,
        calendarCode,
        input.startedAt.toISOString(),
        input.workingMinutes,
        dueAt.toISOString(),
        [...used],
        input.policyVersion ?? 'builtin',
        input.targetScreen,
        targetId,
        input.createdBy,
      ],
    );
    if (inserted[0] !== undefined) return { clock: toRow(inserted[0]), created: true };
    // Another process started it between the read and the insert: it is theirs, and the same clock.
    const again = await tx.query<ClockSql>(`select ${COLUMNS} from machvon.work_clock where clock_type = $1 and subject_type = $2 and subject_id = $3 and status = 'RUNNING'`, [input.clockType, input.subjectType, subjectId]);
    return { clock: toRow(again[0] as ClockSql), created: false };
  }

  async find(tx: TenantTx, id: string): Promise<WorkClockRow | undefined> {
    const rows = await tx.query<ClockSql>(`select ${COLUMNS} from machvon.work_clock where id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  /** Ends a running clock as MET (what it waited for was done) or CANCELLED (it no longer applies), saying who and why. 404 when there is none, 409 when it already ended. */
  async end(tx: TenantTx, id: string, status: 'MET' | 'CANCELLED', by: string, reason: string): Promise<WorkClockRow> {
    const why = trimmed(reason, 'reason', 1, 500);
    const updated = await tx.query<ClockSql>(
      `update machvon.work_clock set status = $2, ended_at = now(), ended_by_membership_id = $3::uuid, end_reason = $4, version = version + 1
        where id = $1::uuid and status = 'RUNNING' returning ${COLUMNS}`,
      [id, status, by, why],
    );
    if (updated[0] !== undefined) return toRow(updated[0]);
    if ((await this.find(tx, id)) === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    throw new DomainError('STAGE_TRANSITION_DENIED', 409);
  }

  /** Ends the running clock of a subject, if there is one (a module that finishes its obligation calls this without having kept the id). */
  async endBySubject(tx: TenantTx, key: { clockType: string; subjectType: string; subjectId: string }, status: 'MET' | 'CANCELLED', by: string, reason: string): Promise<WorkClockRow | undefined> {
    const running = await tx.query<{ id: string }>(`select id from machvon.work_clock where clock_type = $1 and subject_type = $2 and subject_id = $3 and status = 'RUNNING'`, [key.clockType, key.subjectType, key.subjectId]);
    return running[0] === undefined ? undefined : this.end(tx, running[0].id, status, by, reason);
  }
}

const MORE_URGENT = (left: WorkSeverity, right: WorkSeverity): WorkSeverity => (SEVERITY_RANK[left] <= SEVERITY_RANK[right] ? left : right);

/**
 * The native clocks as a source of the alert centre (G0-2, source `CLOCK`, kind `CLOCK_DEADLINE`): the running clocks the reader answers for, or may read. The end is the one the clock was given, moved later by the working time it was
 * paused for; it is urgent once past, and to be acted on when it is within the cadence of the reminders of its severity (a threshold of the policy, not of this file). The severity the module gave the clock is kept when it is higher.
 */
export class HomeClockSources {
  private readonly actions = new HomeWorkActionStore();
  private readonly policies: WorkPolicyReader;
  private readonly calendars: HomeWorkCalendars;

  constructor(policies: WorkPolicyReader = new WorkPolicyReader(), calendars: HomeWorkCalendars = new HomeWorkCalendars()) {
    this.policies = policies;
    this.calendars = calendars;
  }

  async items(context: SourceContext): Promise<SourceRow[]> {
    const params = new Params();
    // The one a module named as the owner of a clock sees it, wherever it lies: they were handed the obligation.
    const owner = context.view === 'mine' ? `c.owner_membership_id = ${params.add(context.membershipId)}::uuid or ` : '';
    const visible = reach(params, context, { source: 'CLOCK', id: 'c.id', tenant: 'c', responsible: ['c.owner_membership_id'], unit: true });
    const where = `(${owner}${visible})`;
    const rows = await context.tx.query<ClockSql>(
      `select ${columnsOf('c')}
         from machvon.work_clock c
         left join machvon.organization_unit u on u.tenant_id = c.tenant_id and u.id = c.owner_unit_id
         ${PROJECT_JOINS('c', 'c.project_id')}
        where c.status = 'RUNNING' and ${where}
        order by c.due_at, c.id limit ${SOURCE_LIMIT}`,
      params.values,
    );
    if (rows.length === 0) return [];
    const policies = await this.policies.read(context.tx, context.today);
    const states = await this.actions.stateOf(
      context.tx,
      rows.map((row) => ({ source: 'CLOCK', sourceId: row.id })),
      context.membershipId,
      context.now,
    );
    const sources = new Map<string, WorkCalendarSource | undefined>();
    const items: SourceRow[] = [];
    for (const raw of rows) {
      const clock = toRow(raw);
      if (!sources.has(clock.calendarCode)) sources.set(clock.calendarCode, await this.calendars.load(context.tx, clock.calendarCode, context.now));
      const native = nativeClock({
        startedAt: new Date(clock.startedAt),
        dueAt: new Date(clock.dueAt),
        now: context.now,
        pauses: states.get(actionKey('CLOCK', clock.id))?.pauses ?? [],
        calendars: sources.get(clock.calendarCode),
        nearWorkingHours: policies.reminder.every_working_hours[clock.severity],
      });
      const facet = native.resolve.state === 'BREACHED' ? 'BREACHED' : native.near ? 'DUE_SOON' : 'RUNNING';
      items.push({
        ...base('CLOCK_DEADLINE'),
        id: clock.id,
        dueOn: vietnamDateOf(new Date(native.resolve.due_at)),
        originalDueOn: vietnamDateOf(new Date(clock.dueAt)),
        title: clock.title,
        subtitle: clock.subtitle,
        status: native.resolve.state,
        severity: MORE_URGENT(clock.severity, severityOf('CLOCK', facet, context.rules)),
        consequence: clock.consequence || (CONSEQUENCES.CLOCK ?? null),
        causeKey: null,
        target: { screen: clock.targetScreen, id: clock.targetId },
        startedAt: clock.startedAt,
        expectedAction: clock.expectedAction,
        clockType: clock.clockType,
        native,
      });
    }
    return items;
  }
}
