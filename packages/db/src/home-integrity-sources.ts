import { SOD_EXPIRING_WITHIN_DAYS, message } from '@machvon/kernel';
import { PayIntegrityAlertSource } from './gov-d-integrity-alerts.ts';
import type { IntegrityAlertItem } from './gov-d-integrity-alerts.ts';
import { SodStore } from './gov-d-sod-store.ts';
import { CONSEQUENCES, severityOf } from './home-work-rules.ts';
import type { WorkSource } from './home-work-rules.ts';
import { PROJECT_JOINS, Params, SOURCE_LIMIT, addDays, base, reach, startOfDay } from './home-work-sources.ts';
import type { SourceContext, SourceRow } from './home-work-sources.ts';

/** The permissions the roles that these alerts are for read them with (the owners of the alert types: the administrator of the duties, the auditors, the data steward). */
export const AUDIENCE_PERMISSIONS = {
  sodExceptions: 'adm.sod.read',
  sodUses: 'aud.sod.read',
  crossTotal: 'disbursement.control.read',
  governanceAlerts: 'project.governance.alert.read',
} as const;

/** How many days back a draft that a check blocked still is an alert, and how many days an exception that lapsed unused still is one (the response times of the alert types are 3 and 7 days). */
export const BLOCKED_DRAFT_DAYS = 30;
export const LAPSED_EXCEPTION_DAYS = 7;
/** How many days back a use of a separation-of-duties exception is still waiting to be looked at (the response time of `SOD_EXCEPTION_USED` is 14 days). */
export const SOD_USED_LOOKBACK_DAYS = 14;

const label = (...parts: Array<string | null | undefined>): string | null => {
  const text = parts.filter((part): part is string => part !== null && part !== undefined && part !== '').join(' · ');
  return text === '' ? null : text;
};

/** The ids of the items of a source that somebody gave to the reader or that the reader took up (the last decision of each kind is the one that counts): they are the reader's wherever they lie. */
async function handedTo(context: SourceContext, source: WorkSource, keys: readonly string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const found = await context.tx.query<{ source_id: string }>(
    `select distinct h.source_id from machvon.work_action h
      where h.source = $1 and h.source_id = any($2::text[]) and h.action in ('CLAIM', 'ASSIGN')
        and $3::uuid = (case h.action when 'ASSIGN' then h.assignee_membership_id else h.actor_membership_id end)
        and not exists (select 1 from machvon.work_action n where n.tenant_id = h.tenant_id and n.source = h.source and n.source_id = h.source_id and n.action = h.action and (n.created_at, n.id) > (h.created_at, h.id))`,
    [source, [...keys], context.membershipId],
  );
  return new Set(found.map((row) => row.source_id));
}

/**
 * The items of a source that is for a role (an alert to the auditors, to the administrator of the duties, to the data steward): all of them to a reader who holds the permission of the role, and only the ones somebody handed
 * to the reader to anybody else. `wholeTenant`: the permission is read through a grant on the whole tenant (these records belong to no unit).
 */
export async function forAudience<T extends SourceRow>(context: SourceContext, source: WorkSource, permission: string, rows: readonly T[], wholeTenant: boolean): Promise<T[]> {
  if (context.holds?.(permission, wholeTenant) === true) return [...rows];
  const handed = await handedTo(
    context,
    source,
    rows.map((row) => row.id),
  );
  return rows.filter((row) => handed.has(row.id));
}

interface Reach {
  /** The id the decisions of people name the item by. */
  key: string;
  projectId: string | null;
  paymentRequestId: string | null;
}

/**
 * Which of the entries are the reader's own in the view `mine`: the project is theirs (they are the leader accountable for it), or the payment request is theirs (they drew it up or sent it), or somebody handed the item to them.
 * In the view `scope` every entry is the reader's to read (the scope of the projects was already applied by the read).
 */
async function ownedBy(context: SourceContext, source: WorkSource, entries: readonly Reach[]): Promise<Set<string>> {
  if (context.view === 'scope' || entries.length === 0) return new Set(entries.map((entry) => entry.key));
  const found = await context.tx.query<{ key: string }>(
    `select e.key from unnest($1::text[], $2::uuid[], $3::uuid[]) as e(key, project_id, request_id)
      where exists (select 1 from machvon.project_accountability pa where pa.project_id = e.project_id and pa.status = 'ACTIVE' and pa.leader_membership_id = $4::uuid)
         or exists (select 1 from machvon.payment_request r where r.id = e.request_id and (r.created_by = $4::uuid or r.submitted_by = $4::uuid))`,
    [entries.map((entry) => entry.key), entries.map((entry) => entry.projectId), entries.map((entry) => entry.paymentRequestId), context.membershipId],
  );
  const mine = new Set(found.map((row) => row.key));
  const rest = entries.filter((entry) => !mine.has(entry.key)).map((entry) => entry.key);
  for (const key of await handedTo(context, source, rest)) mine.add(key);
  return mine;
}

/**
 * The integrity of the money and of the duties, and the alert of the baseline, as sources of the alert centre (governance deepening: lane D and lane B1, integration GOV-INT). One reader for each source, so that a failure of
 * one names that source and loses no other. Every item comes from the table of its module, in the scope of the reader, with its owner, its expected action and its consequence from the `ALERT_TYPE` of its kind:
 *  - `TREASURY_RECON_ITEM_OVERDUE` (ACTION, G4-4): an item of difference with the Treasury, open or explained, past its day. The owner of the item and the leader accountable for the project have it; the issue the job opened for it is the same cause.
 *  - `CROSS_TOTAL_MISMATCH` (ACTION, G4-5): a snapshot that is still being built and whose latest check says the three totals do not agree. For the data steward (the permission to read the control on the whole tenant); one item for each snapshot.
 *  - `SOD_EXCEPTION_EXPIRING` (ACTION, G4-1): an approved exception that ends within the days of the matrix. For the administrator (`adm.sod.read` on the whole tenant).
 *  - `SOD_EXCEPTION_USED` (WATCH, G4-1): the exceptions that something went through in the last two weeks, one item for each exception that says how many times. For the auditors (`aud.sod.read` on the whole tenant).
 *  - `PAYMENT_INTEGRITY_BLOCKED` (ACTION, G4-2): a draft whose latest check blocked it; `PAYMENT_INTEGRITY_SIGNAL` (WATCH, G4-2): a request that waits for its approver with signals; `DISBURSEMENT_EXCEPTION_EXPIRING` (WATCH, G4-2): an approved
 *    exception to a ceiling that lapses within a week (or lapsed within the last week, unused). The leader accountable for the project and the one who drew up or sent the request have them.
 *  - `RESCHEDULE_COUNT` (ACTION, G1-3): a milestone or the end of a project moved as many times as the rule says, for the auditors (`project.governance.alert.read`); open until an auditor acknowledges it.
 */
export class HomeIntegritySources {
  private readonly sod = new SodStore();
  private readonly payment = new PayIntegrityAlertSource();

  async treasuryRecon(context: SourceContext): Promise<SourceRow[]> {
    const params = new Params();
    const today = params.add(context.today);
    const visible = reach(params, context, { source: 'TREASURY_RECON', id: 'i.id', tenant: 'i', responsible: ['i.owner_membership_id'], unit: false });
    const rows = await context.tx.query<{ id: string; project_code: string | null; fund_key: string; fund_label: string | null; recon_date: string; difference: string; due_on: string; status: string }>(
      `select i.id, p.code as project_code, i.fund_key, i.fund_label, i.recon_date::text as recon_date, i.latest_difference_vnd::text as difference, i.due_on::text as due_on, i.status
         from machvon.treasury_daily_recon_item i
         ${PROJECT_JOINS('i', 'i.project_id')}
        where i.status in ('OPEN', 'EXPLAINED') and i.due_on < ${today}::date and ${visible}
        order by i.due_on, i.id limit ${SOURCE_LIMIT}`,
      params.values,
    );
    return rows.map((row) => ({
      ...base('TREASURY_RECON_ITEM_OVERDUE'),
      id: row.id,
      dueOn: row.due_on,
      originalDueOn: row.due_on,
      title: `${message('home.source.treasury.title')}${row.project_code === null ? '' : ` · ${row.project_code}`}`,
      subtitle: label(row.fund_label ?? row.fund_key, message('home.source.treasury.date', { date: row.recon_date }), message('home.source.treasury.difference', { amount: row.difference })),
      status: row.status,
      severity: severityOf('TREASURY_RECON', 'OVERDUE', context.rules),
      // An item that was explained is in the hands of whoever checks the explanation.
      lifecycle: row.status === 'EXPLAINED' ? 'IN_PROGRESS' : 'NEW',
      consequence: CONSEQUENCES.TREASURY_RECON_ITEM_OVERDUE ?? null,
      // The issue the job opened for the item names the item as its source: the two are one cause.
      causeKey: row.id,
      startedAt: startOfDay(addDays(row.due_on, 1)),
      target: { screen: 'PAY-20', id: row.id },
    }));
  }

  async crossTotal(context: SourceContext): Promise<SourceRow[]> {
    const rows = await context.tx.query<{ snapshot_id: string; fiscal_year: number; cutoff: string; disagreeing: string[]; total_unit: string; total_fund: string; total_project: string; checked_at: string }>(
      `select c.snapshot_id, c.fiscal_year, c.treasury_cutoff_date::text as cutoff, c.disagreeing, c.total_unit_vnd::text as total_unit, c.total_fund_vnd::text as total_fund, c.total_project_vnd::text as total_project,
              to_char(c.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as checked_at
         from machvon.cross_total_check c join machvon.period_snapshot s on s.tenant_id = c.tenant_id and s.id = c.snapshot_id
        where not c.published and s.status = 'BUILDING'
          and c.id = (select l.id from machvon.cross_total_check l where l.tenant_id = c.tenant_id and l.snapshot_id = c.snapshot_id order by l.created_at desc, l.id desc limit 1)
        order by c.created_at desc, c.snapshot_id limit ${SOURCE_LIMIT}`,
    );
    const dimensions: Readonly<Record<string, string>> = { UNIT: message('home.source.cross_total.dimension.unit'), FUND: message('home.source.cross_total.dimension.fund'), PROJECT: message('home.source.cross_total.dimension.project') };
    const items: SourceRow[] = rows.map((row) => ({
      ...base('CROSS_TOTAL_MISMATCH'),
      id: row.snapshot_id,
      dueOn: null,
      originalDueOn: null,
      title: message('home.source.cross_total.title', { year: row.fiscal_year }),
      subtitle: label(
        row.disagreeing.length === 0 ? null : message('home.source.cross_total.disagreeing', { dimensions: row.disagreeing.map((dimension) => dimensions[dimension] ?? dimension).join(', ') }),
        message('home.source.cross_total.totals', { unit: row.total_unit, fund: row.total_fund, project: row.total_project }),
        message('home.source.cross_total.cutoff', { date: row.cutoff }),
      ),
      status: 'MISMATCH',
      severity: severityOf('CROSS_TOTAL', 'MISMATCH', context.rules),
      consequence: CONSEQUENCES.CROSS_TOTAL_MISMATCH ?? null,
      // One item for the snapshot: a later check of the same snapshot is the same cause.
      causeKey: `snapshot:${row.snapshot_id}`,
      startedAt: row.checked_at,
      target: { screen: 'DIS-26', id: row.snapshot_id },
    }));
    return forAudience(context, 'CROSS_TOTAL', AUDIENCE_PERMISSIONS.crossTotal, items, true);
  }

  async sodExpiring(context: SourceContext): Promise<SourceRow[]> {
    const expiring = await this.sod.expiring(context.tx, context.today, SOD_EXPIRING_WITHIN_DAYS);
    const items: SourceRow[] = expiring.map((row) => ({
      ...base('SOD_EXCEPTION_EXPIRING'),
      id: row.id,
      dueOn: row.validTo,
      originalDueOn: row.validTo,
      title: message('home.source.sod.expiring.title', { actionA: row.actionA, actionB: row.actionB }),
      subtitle: label(row.memberName, message('home.source.until_end_of_day', { date: row.validTo })),
      status: row.view,
      severity: severityOf('SOD_EXCEPTION', 'EXPIRING', context.rules),
      consequence: CONSEQUENCES.SOD_EXCEPTION_EXPIRING ?? null,
      causeKey: `sod:${row.id}`,
      startedAt: startOfDay(addDays(row.validTo, -SOD_EXPIRING_WITHIN_DAYS)),
      target: { screen: 'ADM-24', id: row.id },
    }));
    return forAudience(context, 'SOD_EXCEPTION', AUDIENCE_PERMISSIONS.sodExceptions, items, true);
  }

  async sodUsed(context: SourceContext): Promise<SourceRow[]> {
    const uses = await this.sod.usedSince(context.tx, startOfDay(addDays(context.today, -SOD_USED_LOOKBACK_DAYS)));
    // One item for each exception, whatever the number of times something went through it; the newest use is the one it shows.
    const byException = new Map<string, { count: number; latest: (typeof uses)[number] }>();
    for (const use of uses) {
      if (use.exceptionId === null) continue;
      const found = byException.get(use.exceptionId);
      byException.set(use.exceptionId, { count: (found?.count ?? 0) + 1, latest: found !== undefined && found.latest.usedAt >= use.usedAt ? found.latest : use });
    }
    const items: SourceRow[] = [...byException.entries()].map(([exceptionId, { count, latest }]) => ({
      ...base('SOD_EXCEPTION_USED'),
      id: `used:${exceptionId}`,
      dueOn: null,
      originalDueOn: null,
      title: message('home.source.sod.used.title', { actionA: latest.actionA, actionB: latest.actionB }),
      subtitle: label(latest.memberName, message('home.source.sod.used.detail', { count, date: latest.usedAt.slice(0, 10) })),
      status: 'USED',
      severity: severityOf('SOD_EXCEPTION', 'USED', context.rules),
      consequence: CONSEQUENCES.SOD_EXCEPTION_USED ?? null,
      causeKey: `sod:${exceptionId}`,
      startedAt: latest.usedAt,
      target: { screen: 'AUD-13', id: exceptionId },
    }));
    return forAudience(context, 'SOD_EXCEPTION', AUDIENCE_PERMISSIONS.sodUses, items, true);
  }

  /** The name of a payment request and of its contract and project, for the title of an item. */
  private async requests(context: SourceContext, ids: readonly string[]): Promise<Map<string, { requestNo: string | null; contractCode: string; projectCode: string | null }>> {
    if (ids.length === 0) return new Map();
    const rows = await context.tx.query<{ id: string; request_no: string | null; contract_code: string; project_code: string | null }>(
      `select r.id, r.request_no, c.code as contract_code, p.code as project_code
         from machvon.payment_request r join machvon.contract c on c.tenant_id = r.tenant_id and c.id = r.contract_id left join machvon.project p on p.tenant_id = c.tenant_id and p.id = c.project_id
        where r.id = any($1::uuid[])`,
      [[...ids]],
    );
    return new Map(rows.map((row) => [row.id, { requestNo: row.request_no, contractCode: row.contract_code, projectCode: row.project_code }]));
  }

  /** The items of the payment integrity source the reader may read, as the reader's own in the view `mine`. */
  private async integrity(context: SourceContext, source: WorkSource, only: readonly IntegrityAlertItem['alertType'][], windowDays: number, keyOf: (item: IntegrityAlertItem) => string): Promise<Array<{ item: IntegrityAlertItem; key: string; name: { requestNo: string | null; contractCode: string; projectCode: string | null } | undefined }>> {
    const found = await this.payment.items(context.tx, context.projectScope, context.today, windowDays, only);
    const owned = await ownedBy(
      context,
      source,
      found.map((item) => ({ key: keyOf(item), projectId: item.projectId, paymentRequestId: item.paymentRequestId })),
    );
    const mine = found.filter((item) => owned.has(keyOf(item)));
    const names = await this.requests(context, [...new Set(mine.map((item) => item.paymentRequestId))]);
    return mine.map((item) => ({ item, key: keyOf(item), name: names.get(item.paymentRequestId) }));
  }

  async paymentIntegrity(context: SourceContext): Promise<SourceRow[]> {
    const read = await this.integrity(context, 'PAYMENT_INTEGRITY', ['PAYMENT_INTEGRITY_BLOCKED', 'PAYMENT_INTEGRITY_SIGNAL'], BLOCKED_DRAFT_DAYS, (item) => `${item.alertType === 'PAYMENT_INTEGRITY_BLOCKED' ? 'blocked' : 'signal'}:${item.itemId}`);
    return read.map(({ item, key, name }): SourceRow => {
      const blocked = item.alertType === 'PAYMENT_INTEGRITY_BLOCKED';
      const codes = Array.isArray(item.detail.codes) ? (item.detail.codes as string[]).join(', ') : null;
      const request = name === undefined ? message('home.source.payment.request') : message('home.source.payment.request_named', { name: name.requestNo ?? name.contractCode });
      return {
        ...base(item.alertType),
        id: key,
        dueOn: null,
        originalDueOn: null,
        title: blocked ? message('home.source.payment.blocked.title', { request }) : message('home.source.payment.signal.title', { request }),
        subtitle: label(name?.projectCode, name?.contractCode, codes),
        status: blocked ? 'BLOCKED' : 'SIGNAL',
        severity: severityOf('PAYMENT_INTEGRITY', blocked ? 'BLOCKED' : 'SIGNAL', context.rules),
        // A request that was blocked and one that waits with signals are different alerts of the same request: each has its own item.
        consequence: (blocked ? CONSEQUENCES.PAYMENT_INTEGRITY_BLOCKED : CONSEQUENCES.PAYMENT_INTEGRITY_SIGNAL) ?? null,
        causeKey: `payment-integrity:${item.paymentRequestId}`,
        startedAt: startOfDay(item.since),
        target: { screen: 'PAY-03', id: item.paymentRequestId },
      };
    });
  }

  async disbursementExceptions(context: SourceContext): Promise<SourceRow[]> {
    const read = await this.integrity(context, 'DISBURSEMENT_EXCEPTION', ['DISBURSEMENT_EXCEPTION_EXPIRING'], LAPSED_EXCEPTION_DAYS, (item) => item.itemId);
    // The read gives every approved exception that ends within the window, however long ago it lapsed; an exception that lapsed unused is an alert for the week after its last day only.
    return read
      .filter(({ item }) => typeof item.detail.days_left === 'number' && item.detail.days_left >= -LAPSED_EXCEPTION_DAYS)
      .map(({ item, name }): SourceRow => {
        const ceilings: Readonly<Record<string, string>> = { EXCEEDS_PLAN: message('home.source.disbursement_exception.ceiling.exceeds_plan'), EXCEEDS_CONTRACT: message('home.source.disbursement_exception.ceiling.exceeds_contract') };
        const ceiling = typeof item.detail.ceiling === 'string' ? (ceilings[item.detail.ceiling] ?? item.detail.ceiling) : null;
        return {
          ...base('DISBURSEMENT_EXCEPTION_EXPIRING'),
          id: item.itemId,
          dueOn: item.since,
          originalDueOn: item.since,
          title: ceiling === null ? message('home.source.disbursement_exception.title') : message('home.source.disbursement_exception.title_ceiling', { ceiling }),
          subtitle: label(name?.projectCode, name?.contractCode, name?.requestNo, message('home.source.until_end_of_day', { date: item.since })),
          status: 'APPROVED',
          severity: severityOf('DISBURSEMENT_EXCEPTION', 'EXPIRING', context.rules),
          consequence: CONSEQUENCES.DISBURSEMENT_EXCEPTION_EXPIRING ?? null,
          causeKey: `disbursement-exception:${item.itemId}`,
          startedAt: startOfDay(addDays(item.since, -LAPSED_EXCEPTION_DAYS)),
          target: { screen: 'PAY-21', id: item.itemId },
        };
      });
  }

  async projectGovernance(context: SourceContext): Promise<SourceRow[]> {
    const params = new Params();
    const holds = context.holds?.(AUDIENCE_PERMISSIONS.governanceAlerts, false) === true;
    const visible = reach(params, context, { source: 'PROJECT_GOVERNANCE', id: 'a.id', tenant: 'a', responsible: [], unit: false, audience: holds });
    const rows = await context.tx.query<{ id: string; project_id: string; project_code: string | null; subject_kind: string; milestone_name: string | null; move_count: number; threshold: number; raised_on: string; raised_at: string }>(
      `select a.id, a.project_id, p.code as project_code, a.subject_kind, m.name as milestone_name, a.move_count, a.threshold, ((a.raised_at) at time zone 'Asia/Ho_Chi_Minh')::date::text as raised_on,
              to_char(a.raised_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as raised_at
         from machvon.project_governance_alert a
         ${PROJECT_JOINS('a', 'a.project_id')}
         left join machvon.project_milestone m on m.tenant_id = a.tenant_id and m.project_id = a.project_id and m.id = a.subject_id
        where a.status = 'OPEN' and a.alert_type = 'RESCHEDULE_COUNT' and ${visible}
        order by a.raised_at, a.id limit ${SOURCE_LIMIT}`,
      params.values,
    );
    return rows.map((row) => ({
      ...base('RESCHEDULE_COUNT'),
      id: row.id,
      dueOn: null,
      originalDueOn: null,
      title: `${row.subject_kind === 'MILESTONE' ? (row.milestone_name === null ? message('home.source.governance.milestone', { count: row.move_count }) : message('home.source.governance.milestone_named', { name: row.milestone_name, count: row.move_count })) : message('home.source.governance.project_end', { count: row.move_count })}${row.project_code === null ? '' : ` · ${row.project_code}`}`,
      subtitle: label(row.project_code, message('home.source.governance.threshold', { threshold: row.threshold }), message('home.source.governance.since', { date: row.raised_on })),
      status: 'OPEN',
      severity: severityOf('PROJECT_GOVERNANCE', 'RESCHEDULE_COUNT', context.rules),
      consequence: CONSEQUENCES.RESCHEDULE_COUNT ?? null,
      // One alert is open for one subject at a time and a later move only raises its count: one cause.
      causeKey: `reschedule:${row.id}`,
      startedAt: row.raised_at,
      target: { screen: 'PRJ-26', id: row.project_id },
    }));
  }
}
