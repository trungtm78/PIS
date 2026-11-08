import { ADVANCE_ESCALATION_DAYS, coverageRange, message } from '@machvon/kernel';
import type { NativeClock, WorkItem, WorkKind } from '@machvon/kernel';
import { AUDIT_ESCALATION_DAYS, CONSEQUENCES, EXPIRY_WINDOW_DAYS, GUARANTEE_SOON_DAYS, SOURCE_OF_KIND, severityOf } from './home-work-rules.ts';
import type { SeverityRules, WorkEscalation, WorkLifecycle, WorkSeverity, WorkSource } from './home-work-rules.ts';
import { QmsDiaryCoverageReads } from './qms-diary-coverage.ts';
import { EXPIRY_ALERT_DAYS, alertLevelOf } from './pmt-permit-expiry.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/** What a source gives before the decisions of people are joined on: the item, where it is opened, how urgent it is and what is known of its escalation. */
export interface SourceRow extends WorkItem {
  target: { screen: string; id: string };
  source: WorkSource;
  severity: WorkSeverity;
  escalation: WorkEscalation | null;
  consequence: string | null;
  /** What the module itself says about the state of the item (a warning that was acknowledged is taken up); the decisions of people can only take it further. */
  lifecycle: WorkLifecycle;
  /** The record the item is about, when another source may be about the same one (an issue that was opened for a permit): the two are one cause. */
  causeKey: string | null;
  /**
   * The moment the item became something to act on, when the module knows it (an ISO instant): the claim clock of the item counts from it. Absent when the module does not say, and the clock then is absent too, never guessed.
   */
  startedAt?: string | null;
  /** The action a native clock says is expected, and the type of the clock (only the source `CLOCK` has them). */
  expectedAction?: string | null;
  clockType?: string | null;
  /** A native clock already evaluated for this pass (its end moved by its pauses), which the store shows as the resolve clock of the item. */
  native?: NativeClock;
}

export interface SourceContext {
  tx: TenantTx;
  membershipId: string;
  now: Date;
  today: string;
  /** `mine`: the work of the person; `scope`: the work inside what the person may read. */
  view: 'mine' | 'scope';
  unitScope: ScopeBuilder;
  projectScope: ScopeBuilder;
  rules: SeverityRules;
  /** Counting asks for what counting needs: the names of the levels of an escalation and the history of one are not read. */
  counting: boolean;
  /**
   * Whether the reader holds a grant that carries `permission` (wherever it reaches, or on the whole tenant when `wholeTenant`). A source whose audience is a role (the administrator of the separation of duties, the auditors, the data steward) shows its items only to a
   * reader who holds the permission that role reads them with; the scope of the reader still judges the place an item is about. Absent: the reader holds nothing.
   */
  holds?: (permission: string, wholeTenant?: boolean) => boolean;
}

/** The most one source gives (a person with more than this has a list that says it is cut: the counts are then a lower bound). */
export const SOURCE_LIMIT = 2000;
const LIMIT = SOURCE_LIMIT;
const DAY_MS = 86_400_000;

export const VIETNAM_DAY = (column: string): string => `((${column}) at time zone 'Asia/Ho_Chi_Minh')::date::text`;

/** The parameters of a query, numbered as they are added, so that the scope predicates (which number their own) can be put in any place of it. */
export class Params {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  scope(builder: ScopeBuilder): string {
    const built = builder(this.values.length + 1);
    this.values.push(...built.params);
    return built.sql;
  }
}

/** The project of a record and the two units its scope is judged by (the aliases the scope of a project is compiled over). Left joins: a record that has no project is judged by its unit. */
export const PROJECT_JOINS = (owner: string, projectId: string): string =>
  `left join machvon.project p on p.tenant_id = ${owner}.tenant_id and p.id = ${projectId}
   left join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
   left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id`;

export interface Reach {
  source: WorkSource;
  /** The id of the item, as the decisions of people name it. */
  id: string;
  tenant: string;
  /** The columns that name the person an item is given to (a membership). */
  responsible: readonly string[];
  /** The record is also judged by the unit `u` it belongs to. */
  unit: boolean;
  /**
   * The item is for a role, not for a person (an alert to the auditors): `true` when the reader holds the permission of that role, which makes everything the reader may read theirs, in both views; `false` hides it unless somebody
   * gave it to the reader or the reader took it up. Absent: the item is the work of the person it is given to or of the one who answers for its project.
   */
  audience?: boolean;
}

/**
 * Who sees an item: what the reader may read (the scope of the projects, and of the unit of the record where it has one). The view `scope` is that; the view `mine` is that and, besides, being the person the item is given to or
 * answering for its project; and an item that somebody gave to the reader or that the reader took up is theirs wherever it lies (the one who gave it chose to hand it over).
 */
export function reach(params: Params, context: SourceContext, spec: Reach): string {
  // The scope is only compiled when the statement uses it (a parameter no part of the statement mentions cannot be typed by the database).
  let visible = 'false';
  if (spec.audience !== false) {
    const scopes = [params.scope(context.projectScope)];
    if (spec.unit) scopes.push(params.scope(context.unitScope));
    visible = `(${scopes.join(' or ')})`;
  }
  if (context.view === 'scope' && spec.audience === undefined) return visible;
  const me = `${params.add(context.membershipId)}::uuid`;
  const accountable = `exists (select 1 from machvon.project_accountability pa where pa.tenant_id = ${spec.tenant}.tenant_id and pa.project_id = p.id and pa.status = 'ACTIVE' and pa.leader_membership_id = ${me})`;
  const mine = [...spec.responsible.map((column) => `${column} = ${me}`), accountable].join(' or ');
  const handed = `exists (select 1 from machvon.work_action h
      where h.tenant_id = ${spec.tenant}.tenant_id and h.source = '${spec.source}' and h.source_id = ${spec.id}::text and h.action in ('CLAIM', 'ASSIGN')
        and ${me} = (case h.action when 'ASSIGN' then h.assignee_membership_id else h.actor_membership_id end)
        and not exists (select 1 from machvon.work_action n where n.tenant_id = h.tenant_id and n.source = h.source and n.source_id = h.source_id and n.action = h.action and (n.created_at, n.id) > (h.created_at, h.id)))`;
  if (spec.audience !== undefined) return `(${visible} or ${handed})`;
  return `((${visible} and (${mine})) or ${handed})`;
}

/** The first instant of a Vietnam day (the day a module says something started on), as an ISO instant. */
export const startOfDay = (day: string): string => new Date(`${day}T00:00:00+07:00`).toISOString();
export const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
const label = (...parts: Array<string | null | undefined>): string | null => {
  const text = parts.filter((part): part is string => part !== null && part !== undefined && part !== '').join(' · ');
  return text === '' ? null : text;
};

export const base = (kind: WorkKind): Pick<SourceRow, 'kind' | 'source' | 'lifecycle' | 'causeKey' | 'escalation'> => ({ kind, source: SOURCE_OF_KIND[kind], lifecycle: 'NEW', causeKey: null, escalation: null });

/** The sources the alert centre adds to the work of a person: what the other modules ask for, each read from the tables of its module in the scope of the reader. */
export class HomeCrossSources {
  /** The warnings of DIS that are open (HOME-03, DIS-20): red is urgent, amber is to be acted on. */
  async earlyWarnings(context: SourceContext): Promise<SourceRow[]> {
    const params = new Params();
    const visible = reach(params, context, { source: 'EARLY_WARNING', id: 'w.id', tenant: 'w', responsible: ['w.owner_membership_id'], unit: true });
    const rows = await context.tx.query<{ id: string; severity: string; status: string; rule_name: string; project_code: string | null; unit_code: string | null; opened_on: string; opened_at: string }>(
      `select w.id, w.severity, w.status, r.name as rule_name, p.code as project_code, u.code as unit_code, ${VIETNAM_DAY('w.opened_at')} as opened_on, to_char(w.opened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as opened_at
         from machvon.early_warning w join machvon.early_warning_rule r on r.tenant_id = w.tenant_id and r.id = w.rule_id
         ${PROJECT_JOINS('w', 'w.project_id')}
         left join machvon.organization_unit u on u.tenant_id = w.tenant_id and u.id = w.unit_id
        where w.status in ('OPEN', 'ACKNOWLEDGED', 'EXPLANATION_REQUESTED') and ${visible}
        order by w.opened_at desc, w.id limit ${LIMIT}`,
      params.values,
    );
    return rows.map((row) => ({
      ...base('EARLY_WARNING'),
      id: row.id,
      dueOn: null,
      originalDueOn: null,
      title: row.rule_name,
      subtitle: row.project_code ?? row.unit_code,
      status: row.status,
      severity: severityOf('EARLY_WARNING', row.severity, context.rules),
      lifecycle: row.status === 'OPEN' ? 'NEW' : row.status === 'ACKNOWLEDGED' ? 'CLAIMED' : 'IN_PROGRESS',
      consequence: CONSEQUENCES.EARLY_WARNING ?? null,
      causeKey: row.id,
      startedAt: row.opened_at,
      target: { screen: 'HOME-06', id: row.id },
    }));
  }

  /** The advances that are overdue and still owed (PAY-12): to be acted on, raised to the leader a week late. */
  async advances(context: SourceContext): Promise<SourceRow[]> {
    const params = new Params();
    const visible = reach(params, context, { source: 'ADVANCE', id: 'a.id', tenant: 'a', responsible: [], unit: false });
    const rows = await context.tx.query<{ id: string; status: string; last_alert_level: number; overdue_since: string; recovery_deadline: string | null; contract_code: string; project_code: string | null; acknowledged: boolean }>(
      `select a.id, a.status, a.last_alert_level, a.overdue_since::text as overdue_since, a.recovery_deadline::text as recovery_deadline, c.code as contract_code, p.code as project_code, (a.alert_acknowledged_at is not null) as acknowledged
         from machvon.contract_advance a join machvon.contract c on c.tenant_id = a.tenant_id and c.id = a.contract_id
         ${PROJECT_JOINS('c', 'c.project_id')}
        where a.overdue_since is not null and a.paid_vnd > a.recovered_vnd and ${visible}
        order by a.overdue_since, a.id limit ${LIMIT}`,
      params.values,
    );
    return rows.map((row) => {
      const level = Math.min(Math.max(row.last_alert_level, 3), 4);
      return {
        ...base('ADVANCE_OVERDUE'),
        id: row.id,
        dueOn: row.recovery_deadline ?? row.overdue_since,
        originalDueOn: row.recovery_deadline ?? row.overdue_since,
        title: message('home.source.advance.title', { contract: row.contract_code }),
        subtitle: row.project_code,
        status: row.status,
        severity: severityOf('ADVANCE', 'OVERDUE', context.rules),
        lifecycle: row.acknowledged ? 'IN_PROGRESS' : 'NEW',
        consequence: CONSEQUENCES.ADVANCE ?? null,
        causeKey: row.id,
        startedAt: startOfDay(row.overdue_since),
        escalation: { level, of: 4, nextAt: level < 4 ? addDays(row.overdue_since, ADVANCE_ESCALATION_DAYS) : null, chain: [message('home.source.chain.advance.remind'), message('home.source.chain.advance.due'), message('home.source.chain.advance.overdue'), message('home.source.chain.advance.leader')] },
        target: { screen: 'PAY-12', id: row.id },
      };
    });
  }

  /** The permits that expired or end within 30 days (PMT-05): expired is urgent, ending is to be watched. */
  async permits(context: SourceContext): Promise<SourceRow[]> {
    const params = new Params();
    const today = params.add(context.today);
    const visible = reach(params, context, { source: 'PERMIT', id: 'x.id', tenant: 'x', responsible: ['x.responsible_membership_id', 'd.owner_membership_id'], unit: false });
    const rows = await context.tx.query<{ id: string; status: string; permit_no: string | null; valid_until: string | null; days_left: number | null; type_name: string | null; project_code: string | null }>(
      `select x.id, x.status, x.permit_no, x.valid_until::text as valid_until, (x.valid_until - ${today}::date) as days_left, t.name as type_name, p.code as project_code
         from machvon.permit x join machvon.permit_dossier d on d.tenant_id = x.tenant_id and d.id = x.dossier_id
         left join machvon.permit_type t on t.tenant_id = x.tenant_id and t.id = x.permit_type_id
         ${PROJECT_JOINS('d', 'd.project_id')}
        where ((x.status = 'ISSUED' and not x.no_expiry and x.valid_until is not null and (x.valid_until - ${today}::date) <= ${EXPIRY_WINDOW_DAYS}) or x.status = 'EXPIRED') and ${visible}
        order by x.valid_until nulls first, x.id limit ${LIMIT}`,
      params.values,
    );
    return rows.map((row) => {
      const expired = row.status === 'EXPIRED' || (row.days_left !== null && row.days_left < 0);
      const level = expired ? 4 : alertLevelOf(row.days_left ?? 0);
      const next = level >= 1 && level < 4 && row.valid_until !== null ? addDays(row.valid_until, -((EXPIRY_ALERT_DAYS as readonly number[])[level] ?? 0)) : null;
      return {
        ...base('PERMIT_EXPIRY'),
        id: row.id,
        dueOn: row.valid_until,
        originalDueOn: row.valid_until,
        title: label(row.type_name ?? message('home.source.permit.fallback'), row.permit_no) ?? message('home.source.permit.fallback'),
        subtitle: row.project_code,
        status: row.status,
        severity: severityOf('PERMIT', expired ? 'EXPIRED' : 'EXPIRING', context.rules),
        consequence: (expired ? CONSEQUENCES.PERMIT_EXPIRED : CONSEQUENCES.PERMIT_EXPIRING) ?? null,
        causeKey: row.id,
        startedAt: row.valid_until === null ? null : startOfDay(expired ? addDays(row.valid_until, 1) : addDays(row.valid_until, -EXPIRY_WINDOW_DAYS)),
        escalation: level === 0 ? null : { level, of: 4, nextAt: next, chain: [message('home.source.chain.days_left_60'), message('home.source.chain.days_left_30'), message('home.source.chain.days_left_15'), message('home.source.chain.permit.expired')] },
        target: { screen: 'PMT-02', id: row.id },
      };
    });
  }

  /** The recommendations of an audit that are past their day (AUD-11): once they are a month late they are raised to the leader and are urgent. */
  async recommendations(context: SourceContext): Promise<SourceRow[]> {
    const params = new Params();
    const today = params.add(context.today);
    const visible = reach(params, context, { source: 'AUDIT_RECOMMENDATION', id: 'r.id', tenant: 'r', responsible: ['r.owner_user_id'], unit: true });
    const rows = await context.tx.query<{ id: string; rec_code: string; status: string; due_on: string; project_code: string | null; unit_code: string | null }>(
      `select r.id, r.rec_code, r.status, r.due_on::text as due_on, p.code as project_code, u.code as unit_code
         from machvon.audit_recommendation r
         ${PROJECT_JOINS('r', 'r.project_id')}
         left join machvon.organization_unit u on u.tenant_id = r.tenant_id and u.id = r.owner_unit_id
        where r.status in ('OPEN', 'ASSIGNED', 'IN_PROGRESS') and r.due_on is not null and r.due_on < ${today}::date and ${visible}
        order by r.due_on, r.id limit ${LIMIT}`,
      params.values,
    );
    return rows.map((row) => {
      const late = daysBetween(row.due_on, context.today);
      const escalated = late >= AUDIT_ESCALATION_DAYS;
      return {
        ...base('AUDIT_RECOMMENDATION_OVERDUE'),
        id: row.id,
        dueOn: row.due_on,
        originalDueOn: row.due_on,
        title: message('home.source.audit.title', { code: row.rec_code }),
        subtitle: row.project_code ?? row.unit_code,
        status: row.status,
        severity: severityOf('AUDIT_RECOMMENDATION', escalated ? 'ESCALATED' : 'OVERDUE', context.rules),
        lifecycle: row.status === 'IN_PROGRESS' ? 'IN_PROGRESS' : row.status === 'ASSIGNED' ? 'CLAIMED' : 'NEW',
        consequence: (escalated ? CONSEQUENCES.AUDIT_RECOMMENDATION_ESCALATED : CONSEQUENCES.AUDIT_RECOMMENDATION_OVERDUE) ?? null,
        causeKey: row.id,
        startedAt: startOfDay(addDays(row.due_on, 1)),
        escalation: { level: escalated ? 2 : 1, of: 2, nextAt: escalated ? null : addDays(row.due_on, AUDIT_ESCALATION_DAYS), chain: [message('home.source.chain.audit.unit'), message('home.source.chain.audit.leader')] },
        target: { screen: 'AUD-11', id: row.id },
      };
    });
  }

  /** The issues that missed the SLA (ISS-09, ISS-10), with the level they were raised to: level 3 (the task force) is urgent. */
  async issues(context: SourceContext): Promise<SourceRow[]> {
    const params = new Params();
    const visible = reach(params, context, { source: 'ISSUE', id: 'i.id', tenant: 'i', responsible: ['i.assignee_id'], unit: true });
    const rows = await context.tx.query<{ id: string; code: string; title: string; status: string; escalation_level: number; due_on: string; project_code: string | null; source_module: string; source_ref_id: string | null; overdue_at: string }>(
      `select i.id, i.code, i.title, i.status, i.escalation_level, ${VIETNAM_DAY('i.due_at')} as due_on, p.code as project_code, i.source_ref_id::text as source_ref_id, to_char(i.overdue_since at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as overdue_at
         from machvon.issue i join machvon.organization_unit u on u.tenant_id = i.tenant_id and u.id = i.owner_unit_id
         ${PROJECT_JOINS('i', 'i.project_id')}
        where i.status in ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ESCALATED', 'REOPENED') and i.overdue_since is not null and ${visible}
        order by i.due_at, i.id limit ${LIMIT}`,
      params.values,
    );
    const levels = new Map<string, Array<{ level: number; unit: string | null }>>();
    if (!context.counting && rows.length > 0) {
      const raised = await context.tx.query<{ issue_id: string; level: number; unit_name: string | null }>(
        `select e.issue_id, e.level, tu.name as unit_name from machvon.issue_escalation e left join machvon.organization_unit tu on tu.tenant_id = e.tenant_id and tu.id = e.target_unit_id
          where e.status in ('OPEN', 'ACCEPTED', 'RESOLVED') and e.issue_id = any($1::uuid[]) order by e.level, e.created_at`,
        [rows.map((row) => row.id)],
      );
      for (const entry of raised) levels.set(entry.issue_id, [...(levels.get(entry.issue_id) ?? []), { level: entry.level, unit: entry.unit_name }]);
    }
    return rows.map((row) => {
      const level = Math.min(Math.max(row.escalation_level, 1), 3);
      const unit = levels.get(row.id)?.find((entry) => entry.level === 2)?.unit;
      return {
        ...base('ISSUE_SLA_BREACH'),
        id: row.id,
        dueOn: row.due_on,
        originalDueOn: row.due_on,
        title: `${row.code} ${row.title}`,
        subtitle: row.project_code,
        status: row.status,
        severity: severityOf('ISSUE', `LEVEL_${level}`, context.rules),
        lifecycle: row.status === 'IN_PROGRESS' || row.status === 'ESCALATED' ? 'IN_PROGRESS' : row.status === 'ASSIGNED' ? 'CLAIMED' : 'NEW',
        consequence: (level === 3 ? CONSEQUENCES.ISSUE_SLA_BREACH_L3 : CONSEQUENCES.ISSUE_SLA_BREACH) ?? null,
        causeKey: row.source_ref_id,
        startedAt: row.overdue_at,
        // The day the next level is reached depends on the working calendar of the policy and is the job's to count; it is not guessed here.
        escalation: { level, of: 3, nextAt: null, chain: [message('home.source.chain.issue.handler'), unit ?? message('home.source.chain.issue.unit'), message('home.source.chain.issue.task_force')] },
        target: { screen: 'ISS-03', id: row.id },
      };
    });
  }

  /** The guarantees that end within 30 days (CTR-05): to be watched, and to be acted on in the last week. */
  async guarantees(context: SourceContext): Promise<SourceRow[]> {
    const params = new Params();
    const today = params.add(context.today);
    const visible = reach(params, context, { source: 'GUARANTEE', id: 'g.id', tenant: 'g', responsible: [], unit: false });
    const rows = await context.tx.query<{ id: string; kind: string; expires_on: string; days_left: number; contract_code: string; project_code: string | null }>(
      `select g.id, g.kind, (g.expires_at at time zone 'Asia/Ho_Chi_Minh')::date::text as expires_on, ((g.expires_at at time zone 'Asia/Ho_Chi_Minh')::date - ${today}::date) as days_left, c.code as contract_code, p.code as project_code
         from machvon.guarantee g join machvon.contract c on c.tenant_id = g.tenant_id and c.id = g.contract_id
         ${PROJECT_JOINS('c', 'c.project_id')}
        where g.status = 'ACTIVE' and ((g.expires_at at time zone 'Asia/Ho_Chi_Minh')::date - ${today}::date) <= ${EXPIRY_WINDOW_DAYS} and ${visible}
        order by g.expires_at, g.id limit ${LIMIT}`,
      params.values,
    );
    const thresholds = [30, 15, 7, 0];
    return rows.map((row) => {
      const level = Math.max(thresholds.filter((days) => row.days_left <= days).length, 1);
      const nextDays = thresholds[level];
      return {
        ...base('GUARANTEE_EXPIRING'),
        id: row.id,
        dueOn: row.expires_on,
        originalDueOn: row.expires_on,
        title: message('home.source.guarantee.title', { contract: row.contract_code }),
        subtitle: row.project_code,
        status: 'ACTIVE',
        severity: severityOf('GUARANTEE', row.days_left <= GUARANTEE_SOON_DAYS ? 'EXPIRING_SOON' : 'EXPIRING', context.rules),
        consequence: CONSEQUENCES.GUARANTEE ?? null,
        causeKey: row.id,
        startedAt: startOfDay(addDays(row.expires_on, -EXPIRY_WINDOW_DAYS)),
        escalation: { level, of: 4, nextAt: nextDays === undefined ? null : addDays(row.expires_on, -nextDays), chain: [message('home.source.chain.days_left_30'), message('home.source.chain.days_left_15'), message('home.source.chain.days_left_7'), message('home.source.chain.guarantee.due')] },
        target: { screen: 'CTR-05', id: row.id },
      };
    });
  }

  /**
   * The contracts in execution whose diaries of the month, up to yesterday, are missing (QMS-11): the contracts are one cause, so that "12 projects miss the diary" is one item that says how many. A year of the working calendar
   * that is not published makes the source unavailable (the days are not guessed).
   */
  async siteDiaries(context: SourceContext): Promise<SourceRow[]> {
    const params = new Params();
    const yesterday = addDays(context.today, -1);
    const month = yesterday.slice(0, 7);
    const visible = reach(params, context, { source: 'SITE_DIARY', id: `'site-diary:${month}'`, tenant: 'c', responsible: [], unit: false });
    const contracts = await context.tx.query<{ id: string; code: string; project_id: string; project_code: string }>(
      `select c.id, c.code, p.id as project_id, p.code as project_code
         from machvon.contract c
         ${PROJECT_JOINS('c', 'c.project_id')}
        where c.status = 'ACTIVE' and p.id is not null and ${visible}
        order by p.code, c.code, c.id limit ${LIMIT}`,
      params.values,
    );
    const reads = new QmsDiaryCoverageReads();
    const missing = new Map<string, { code: string; days: number; worst: number; contract: string }>();
    let total = 0;
    for (const contract of contracts) {
      const coverage = await reads.coverage(context.tx, contract.id, coverageRange(`${yesterday.slice(0, 8)}01`, yesterday, yesterday));
      const days = coverage.totals.missing;
      if (days <= 0) continue;
      total += days;
      const entry = missing.get(contract.project_id) ?? { code: contract.project_code, days: 0, worst: 0, contract: contract.id };
      entry.days += days;
      // The item opens at the contract of the project that misses the most.
      if (days > entry.worst) {
        entry.worst = days;
        entry.contract = contract.id;
      }
      missing.set(contract.project_id, entry);
    }
    if (missing.size === 0) return [];
    const projects = [...missing.values()].sort((left, right) => right.days - left.days || left.code.localeCompare(right.code, 'en'));
    const [first] = projects;
    return [
      {
        ...base('SITE_DIARY_MISSING'),
        id: `site-diary:${month}`,
        dueOn: null,
        originalDueOn: null,
        title: projects.length === 1 && first !== undefined ? message('home.source.site_diary.title_one', { total, code: first.code }) : message('home.source.site_diary.title_many', { count: projects.length }),
        subtitle: message('home.source.site_diary.detail', {
          codes: `${projects
            .slice(0, 3)
            .map((project) => project.code)
            .join(', ')}${projects.length > 3 ? '…' : ''}`,
          total,
          month: month.slice(5),
          year: month.slice(0, 4),
        }),
        status: 'MISSING',
        severity: severityOf('SITE_DIARY', 'MISSING', context.rules),
        consequence: CONSEQUENCES.SITE_DIARY ?? null,
        causeKey: null,
        target: { screen: 'QMS-11', id: first?.contract ?? '' },
      },
    ];
  }
}
