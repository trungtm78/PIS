import { DomainError, pwfDeadlineBand, vietnamDateOf } from '@machvon/kernel';
import { HomeWorkCalendars, WORK_CALENDAR_CODE } from './home-work-clock-store.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import { PwfBandPolicies } from './pwf-band-policies.ts';
import { PwfDeadlinePreferenceStore, hasPersonalLadder, personalThresholdsOf } from './pwf-deadline-preference.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * "My tasks" by deadline (MOB-80, PWF-15; R40): the open tasks the ledger of assignments hands to the caller, each with the OFFICIAL colour and, only when the person set a ladder of their own that differs from it, the colour of THAT ladder, beside
 * the real day of the deadline. The official colour is always there and is the one that counts; the personal one is only ever earlier. A personal ladder the official rule has since passed is read as the official line (the preference names what was
 * raised), and one that cannot be merged into a valid ladder is left out rather than shown wrong. Bounded (R35): the person's open tasks are read once, nearest day first, up to a cap, and the total is the exact count of what the filters leave.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const BANDS = ['NONE', 'GREEN', 'YELLOW', 'RED', 'UNKNOWN'] as const;
const STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'ON_HOLD'] as const;
/** The most open tasks of one person that are read (a person with more has a total that says it is a lower bound by the cap in `read_cap`). */
export const MY_TASKS_CAP = 5000;
const FAR_DAY = '9999-12-31';
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export interface MyTaskFilter {
  band?: string | undefined;
  status?: string | undefined;
  dueBefore?: string | undefined;
}

interface MyTaskSql {
  id: string;
  task_code: string;
  name: string;
  project_id: string;
  project_code: string;
  status: (typeof STATUSES)[number];
  due_date: string | null;
  kind: 'TASK' | 'MILESTONE';
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
  phase_code: string;
  critical: boolean;
  version: number;
  unit_path: string | null;
  sort_day: string;
}

interface BandJson {
  band: pwfDeadlineBand.Band;
  remaining_days: number | null;
  unit: pwfDeadlineBand.DeadlineUnit;
  overdue: boolean;
  reason?: string | null;
}

const viewOf = (result: pwfDeadlineBand.DeadlineBandResult): BandJson => ({ band: result.band, remaining_days: result.remainingDays, unit: result.unit, overdue: result.overdue, reason: result.reason ?? null });

export class PwfMyTaskReads {
  private readonly policies = new PwfBandPolicies();
  private readonly preferences = new PwfDeadlinePreferenceStore();
  private readonly calendars: HomeWorkCalendars;

  constructor(calendars: HomeWorkCalendars = new HomeWorkCalendars()) {
    this.calendars = calendars;
  }

  async list(tx: TenantTx, scope: ScopeBuilder, membershipId: string, filter: MyTaskFilter, page: { limit: number; after?: { code: string; id: string } | undefined }, now: Date): Promise<Record<string, unknown>> {
    if (filter.band !== undefined && !(BANDS as readonly string[]).includes(filter.band)) throw invalid('band');
    if (filter.status !== undefined && !(STATUSES as readonly string[]).includes(filter.status)) throw invalid('status');
    if (filter.dueBefore !== undefined && !DAY.test(filter.dueBefore)) throw invalid('due_before');
    if (page.after !== undefined && (!DAY.test(page.after.code) || !UUID.test(page.after.id))) throw invalid('cursor');
    const today = vietnamDateOf(now);
    const predicate = scope(1);
    const params: unknown[] = [...predicate.params];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const me = bind(membershipId.toLowerCase());
    const day = bind(today);
    const where = [
      predicate.sql,
      `t.tracked and not t.excluded and t.status in ('NOT_STARTED', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'ON_HOLD')`,
      `exists (select 1 from machvon.project_task_assignment a where a.tenant_id = t.tenant_id and a.task_id = t.id and a.role in ('RESPONSIBLE', 'ACCOUNTABLE') and a.membership_id = ${me}::uuid and a.valid_from <= ${day}::date and (a.valid_to is null or a.valid_to >= ${day}::date))`,
    ];
    if (filter.status !== undefined) where.push(`t.status = ${bind(filter.status)}`);
    if (filter.dueBefore !== undefined) where.push(`t.planned_finish <= ${bind(filter.dueBefore)}::date`);
    const rows = await tx.query<MyTaskSql>(
      `select t.id, t.task_code, t.name, p.id as project_id, p.code as project_code, t.status, t.planned_finish::text as due_date, t.kind, t.priority, t.phase_code, t.critical, t.version, ou.path as unit_path,
              coalesce(t.planned_finish, date '${FAR_DAY}')::text as sort_day
         from ${SCOPE_FROM} join machvon.project_task t on t.tenant_id = p.tenant_id and t.project_id = p.id
        where ${where.join(' and ')} order by coalesce(t.planned_finish, date '${FAR_DAY}'), t.id limit ${MY_TASKS_CAP}`,
      params,
    );
    const set = await this.policies.load(tx, today);
    const stored = await this.preferences.stored(tx, membershipId);
    const personal = hasPersonalLadder(stored) ? personalThresholdsOf(stored) : null;
    const calendars = await this.calendars.load(tx, WORK_CALENDAR_CODE, now);
    const listed = rows.map((row) => {
      const policy = set.forUnitPath(row.unit_path);
      const context = { taskKind: row.kind, priority: row.priority, phase: row.phase_code };
      const due = { dueOn: row.due_date, today, unit: policy.unit, calendars };
      let resolved: pwfDeadlineBand.ResolvedBand;
      try {
        resolved = pwfDeadlineBand.resolveBand({ system: pwfDeadlineBand.thresholdsFor(policy, context), policy, personal }, context, due);
      } catch (error) {
        // A personal ladder that cannot be merged into a valid one with the official ladder of this task is not shown; the official colour still is.
        if (!(error instanceof DomainError) || error.code !== 'DEADLINE_BAND_THRESHOLDS_INVALID') throw error;
        resolved = pwfDeadlineBand.resolveBand({ system: pwfDeadlineBand.thresholdsFor(policy, context), policy }, context, due);
      }
      return { row, official: viewOf(resolved.official), personal: resolved.personal !== null && resolved.personalApplied ? viewOf(resolved.personal) : null };
    });
    const wanted = filter.band === undefined ? listed : listed.filter((entry) => entry.official.band === filter.band);
    const after = page.after;
    const rest = after === undefined ? wanted : wanted.filter((entry) => entry.row.sort_day > after.code || (entry.row.sort_day === after.code && entry.row.id > after.id));
    const shown = rest.slice(0, page.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(({ row, official, personal: own }) => ({
        task_id: row.id,
        task_code: row.task_code,
        name: row.name,
        project_id: row.project_id,
        project_code: row.project_code,
        status: row.status,
        due_date: row.due_date,
        official_band: official,
        personal_band: own,
        critical: row.critical,
        version: row.version,
      })),
      next: rest.length > shown.length && last !== undefined ? { code: last.row.sort_day, id: last.row.id } : null,
      total: wanted.length,
      as_of: now.toISOString(),
    };
  }
}
