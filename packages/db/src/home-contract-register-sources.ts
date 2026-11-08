import { claimAlerts, claimDeadlines, earlyWarningClocks, message, actionAlert, reissuesOwed, registerClockAlert } from '@machvon/kernel';
import type { ClaimAlert, ClaimFacts, ClaimKind, ClaimSide, ContractClaimStatus, ClaimTerm, DeadlineCode, EwAlert, ResponseDecision } from '@machvon/kernel';
import { CtrClaimTermStore } from './ctr-claim-term-store.ts';
import { CtrRegisterPolicy } from './ctr-register-policy.ts';
import { HomeWorkCalendars, WORK_CALENDAR_CODE } from './home-work-clock-store.ts';
import { CONSEQUENCES, severityOf } from './home-work-rules.ts';
import { PROJECT_JOINS, Params, SOURCE_LIMIT, addDays, base, reach, startOfDay } from './home-work-sources.ts';
import type { SourceContext, SourceRow } from './home-work-sources.ts';

/** The screens an item of these sources opens: the record of a claim, the early-warning register of a contract and the record of a warning (screen catalogue of CTR). */
export const CLAIM_SCREEN = 'CTR-33';
export const EARLY_WARNING_REGISTER_SCREEN = 'CTR-35';
export const EARLY_WARNING_SCREEN = 'CTR-36';

const STEP_KEY: Readonly<Record<DeadlineCode, string>> = { NOTICE: 'notice', PARTICULARS: 'particulars', RESPONSE: 'response', SETTLEMENT: 'settlement' };

/** The facet the severity rules read for a claim alert: a missed limitation day is urgent for the owner when it is the owner's own step and to be acted on when it is the other side's. */
function claimFacet(alert: ClaimAlert): string {
  switch (alert.kind) {
    case 'CLAIM_LIMITATION_APPROACHING':
      return 'LIMITATION_APPROACHING';
    case 'CLAIM_LIMITATION_MISSED':
      return alert.owedByOwner ? 'LIMITATION_MISSED_OWN' : 'LIMITATION_MISSED_OTHER';
    case 'CLAIM_RESPONSE_DUE':
      return alert.facet === 'OVERDUE' ? 'RESPONSE_OVERDUE' : 'RESPONSE_DUE_SOON';
    default:
      return 'SETTLEMENT_OVERDUE';
  }
}

/** What is most pressing first: a limitation day missed, a response overdue, a settlement overdue, a response due soon, a limitation day approaching. A claim is one item, the most pressing. */
const URGENCY: readonly string[] = ['LIMITATION_MISSED_OWN', 'RESPONSE_OVERDUE', 'LIMITATION_MISSED_OTHER', 'SETTLEMENT_OVERDUE', 'RESPONSE_DUE_SOON', 'LIMITATION_APPROACHING'];

/** The alert of a claim that the register shows, or undefined when there is none. */
export function topClaimAlert(alerts: readonly ClaimAlert[]): ClaimAlert | undefined {
  return [...alerts].sort((left, right) => URGENCY.indexOf(claimFacet(left)) - URGENCY.indexOf(claimFacet(right)))[0];
}

const label = (...parts: Array<string | null | undefined>): string | null => {
  const text = parts.filter((part): part is string => part !== null && part !== undefined && part !== '').join(' · ');
  return text === '' ? null : text;
};

interface ClaimSourceSql {
  id: string;
  code: string;
  contract_code: string;
  project_code: string | null;
  claimant_side: ClaimSide;
  kind: ClaimKind;
  status: ContractClaimStatus;
  term_id: string | null;
  awareness_on: string;
  notice_on: string | null;
  particulars_on: string | null;
  last_particulars_on: string | null;
  response_on: string | null;
  response_decision: ResponseDecision | null;
  accepted_on: string | null;
  settled_on: string | null;
}

/**
 * The claim register and the early-warning register of a contract as sources of the alert centre (GOV-8, G1-9 and G1-15). Both are computed from the tables when the list is read, by the kernel, on the day of the
 * reader (no job to run, nothing to fall behind), with the working numbers of the rules `CLAIM_POLICY` and `EARLY_WARNING_POLICY` read through the governance port and the working calendar published for the tenant.
 *
 *  - Claims (`CONTRACT_CLAIM`): one item per open claim, the most pressing of: a limitation day missed, a response owed by the owner overdue or due soon, a settlement past its day, a limitation day the owner owes
 *    approaching. Owner: the person who answers for the claim (else the project leader). A claim without an approved term has no limitation clock, so none of its limitation days raise anything.
 *  - Early warnings (`CONTRACT_EARLY_WARNING`): the first issue of a register, the meeting and the re-issue that are approaching or past their day, and each mitigation action still open past its day (owner: the
 *    person it was given to).
 * Each kind has its ALERT_TYPE (owner, expected action, consequence) in the registry of alert types.
 */
export class HomeContractRegisterSources {
  private readonly policy = new CtrRegisterPolicy();
  private readonly calendars = new HomeWorkCalendars();
  private readonly terms = new CtrClaimTermStore();

  async claims(context: SourceContext): Promise<SourceRow[]> {
    const params = new Params();
    const visible = reach(params, context, { source: 'CONTRACT_CLAIM', id: 'k.id', tenant: 'k', responsible: ['k.responsible_membership_id'], unit: false });
    const rows = await context.tx.query<ClaimSourceSql>(
      `select k.id, k.code, c.code as contract_code, p.code as project_code, k.claimant_side, k.kind, k.status, k.term_id, k.awareness_on::text as awareness_on, k.notice_on::text as notice_on,
              k.particulars_on::text as particulars_on, k.last_particulars_on::text as last_particulars_on, k.response_on::text as response_on, k.response_decision, k.accepted_on::text as accepted_on, k.settled_on::text as settled_on
         from machvon.contract_claim k join machvon.contract c on c.tenant_id = k.tenant_id and c.id = k.contract_id
         ${PROJECT_JOINS('c', 'c.project_id')}
        where k.status not in ('SETTLED', 'WITHDRAWN', 'REFERRED', 'TIME_BARRED') and k.term_id is not null and ${visible}
        order by k.awareness_on, k.id limit ${SOURCE_LIMIT}`,
      params.values,
    );
    if (rows.length === 0) return [];
    const policy = (await this.policy.claim(context.tx, context.now)).params;
    const calendars = await this.calendars.load(context.tx, WORK_CALENDAR_CODE, context.now);
    const terms = await this.terms.byIds(context.tx, [...new Set(rows.map((row) => row.term_id as string))]);
    const items: SourceRow[] = [];
    for (const row of rows) {
      const term: ClaimTerm | null = terms.get(row.term_id as string)?.term ?? null;
      const facts: ClaimFacts = {
        claimantSide: row.claimant_side,
        status: row.status,
        awarenessOn: row.awareness_on,
        noticeOn: row.notice_on,
        particularsOn: row.particulars_on,
        lastParticularsOn: row.last_particulars_on,
        responseOn: row.response_on,
        responseDecision: row.response_decision,
        acceptedOn: row.accepted_on,
        settledOn: row.settled_on,
      };
      const alert = topClaimAlert(claimAlerts(row.status, claimDeadlines(facts, term, context.today, policy.approachDays, calendars), policy));
      if (alert === undefined) continue;
      const facet = claimFacet(alert);
      const overdue = alert.dueOn < context.today;
      const title =
        alert.kind === 'CLAIM_RESPONSE_DUE'
          ? message(alert.facet === 'OVERDUE' ? 'home.source.claim.title.claim_response_due.overdue' : 'home.source.claim.title.claim_response_due.due_soon', { code: row.code })
          : message(`home.source.claim.title.${alert.kind.toLowerCase()}`, { code: row.code });
      items.push({
        ...base(alert.kind),
        id: row.id,
        dueOn: alert.dueOn,
        originalDueOn: alert.dueOn,
        title,
        subtitle: label(row.project_code, message('home.source.claim.detail', { contract: row.contract_code, step: message(`home.source.claim.step.${STEP_KEY[alert.code]}`), due: alert.dueOn })),
        status: alert.facet,
        severity: severityOf('CONTRACT_CLAIM', facet, context.rules),
        lifecycle: 'NEW',
        consequence: CONSEQUENCES[alert.kind] ?? null,
        causeKey: `claim:${row.id}`,
        ...(overdue ? { startedAt: startOfDay(addDays(alert.dueOn, 1)) } : {}),
        target: { screen: CLAIM_SCREEN, id: row.id },
      });
    }
    return items;
  }

  async earlyWarnings(context: SourceContext): Promise<SourceRow[]> {
    const policy = (await this.policy.earlyWarning(context.tx, context.now)).params;
    const calendars = await this.calendars.load(context.tx, WORK_CALENDAR_CODE, context.now);
    return [...(await this.rhythm(context, policy, calendars)), ...(await this.reissues(context, policy, calendars)), ...(await this.actions(context))];
  }

  private async rhythm(context: SourceContext, policy: Parameters<typeof earlyWarningClocks>[2], calendars: Parameters<typeof earlyWarningClocks>[3]): Promise<SourceRow[]> {
    const params = new Params();
    // Two items can come from one contract (the first issue and the meeting), so each has an id of its own and is judged for visibility by it.
    const initial = reach(params, context, { source: 'CONTRACT_EARLY_WARNING', id: "(c.id::text || ':initial')", tenant: 'c', responsible: [], unit: false });
    const meeting = reach(params, context, { source: 'CONTRACT_EARLY_WARNING', id: "(c.id::text || ':meeting')", tenant: 'c', responsible: [], unit: false });
    const rows = await context.tx.query<{ id: string; code: string; effective_from: string; project_code: string | null; first_issue_on: string | null; last_meeting_on: string | null; see_initial: boolean; see_meeting: boolean }>(
      `select c.id, c.code, c.effective_from::text as effective_from, p.code as project_code,
              (select min(i.issued_on)::text from machvon.contract_early_warning_issue i where i.tenant_id = c.tenant_id and i.contract_id = c.id) as first_issue_on,
              (select max(m.held_on)::text from machvon.contract_early_warning_meeting m where m.tenant_id = c.tenant_id and m.contract_id = c.id) as last_meeting_on,
              ${initial} as see_initial, ${meeting} as see_meeting
         from machvon.contract c
         ${PROJECT_JOINS('c', 'c.project_id')}
        where c.status = 'ACTIVE' and c.effective_from is not null and (${initial} or ${meeting})
        order by c.code, c.id limit ${SOURCE_LIMIT}`,
      params.values,
    );
    const items: SourceRow[] = [];
    for (const row of rows) {
      const clocks = earlyWarningClocks({ active: true, startOn: row.effective_from, firstIssueOn: row.first_issue_on, lastMeetingOn: row.last_meeting_on, latestMeeting: null }, context.today, policy, calendars);
      const picks: Array<[EwAlert | null, string, boolean]> = [
        [registerClockAlert(clocks.initial), 'initial_issue', row.see_initial],
        [registerClockAlert(clocks.meeting), 'meeting', row.see_meeting],
      ];
      for (const [alert, key, seen] of picks) {
        if (alert === null || !seen) continue;
        items.push(this.item(context, alert, `${row.id}:${key === 'meeting' ? 'meeting' : 'initial'}`, message(`home.source.early_warning.title.${key}.${alert.facet.toLowerCase()}`, { contract: row.code }), label(row.project_code, message('home.source.early_warning.detail', { contract: row.code, due: alert.dueOn })), { screen: EARLY_WARNING_REGISTER_SCREEN, id: row.id }, `ew-register:${row.id}`));
      }
    }
    return items;
  }

  private async reissues(context: SourceContext, policy: Parameters<typeof earlyWarningClocks>[2], calendars: Parameters<typeof earlyWarningClocks>[3]): Promise<SourceRow[]> {
    const params = new Params();
    const visible = reach(params, context, { source: 'CONTRACT_EARLY_WARNING', id: "('reissue:' || m.id::text)", tenant: 'c', responsible: [], unit: false });
    const rows = await context.tx.query<{ id: string; held_on: string; contract_id: string; contract_code: string; project_code: string | null }>(
      `select m.id, m.held_on::text as held_on, c.id as contract_id, c.code as contract_code, p.code as project_code
         from machvon.contract_early_warning_meeting m join machvon.contract c on c.tenant_id = m.tenant_id and c.id = m.contract_id
         ${PROJECT_JOINS('c', 'c.project_id')}
        where c.status = 'ACTIVE' and not exists (select 1 from machvon.contract_early_warning_issue i where i.tenant_id = m.tenant_id and i.meeting_id = m.id) and ${visible}
        order by m.held_on, m.id limit ${SOURCE_LIMIT}`,
      params.values,
    );
    const items: SourceRow[] = [];
    for (const row of rows) {
      for (const clock of reissuesOwed([{ id: row.id, heldOn: row.held_on, reissuedOn: null }], context.today, policy, calendars)) {
        const alert = registerClockAlert(clock);
        if (alert === null) continue;
        items.push(this.item(context, alert, `reissue:${row.id}`, message(`home.source.early_warning.title.reissue.${alert.facet.toLowerCase()}`, { contract: row.contract_code }), label(row.project_code, message('home.source.early_warning.detail', { contract: row.contract_code, due: alert.dueOn })), { screen: EARLY_WARNING_REGISTER_SCREEN, id: row.contract_id }, `ew-reissue:${row.id}`));
      }
    }
    return items;
  }

  private async actions(context: SourceContext): Promise<SourceRow[]> {
    const params = new Params();
    const today = params.add(context.today);
    const visible = reach(params, context, { source: 'CONTRACT_EARLY_WARNING', id: 'a.id', tenant: 'a', responsible: ['a.owner_membership_id'], unit: false });
    const rows = await context.tx.query<{ id: string; description: string; due_on: string; warning_id: string; warning_code: string; contract_code: string; project_code: string | null }>(
      `select a.id, a.description, a.due_on::text as due_on, w.id as warning_id, w.code as warning_code, c.code as contract_code, p.code as project_code
         from machvon.contract_early_warning_action a
         join machvon.contract_early_warning w on w.tenant_id = a.tenant_id and w.id = a.warning_id
         join machvon.contract c on c.tenant_id = w.tenant_id and c.id = w.contract_id
         ${PROJECT_JOINS('c', 'c.project_id')}
        where a.status = 'OPEN' and w.status in ('RAISED', 'ASSESSED', 'MITIGATING') and a.due_on < ${today}::date and ${visible}
        order by a.due_on, a.id limit ${SOURCE_LIMIT}`,
      params.values,
    );
    const items: SourceRow[] = [];
    for (const row of rows) {
      const alert = actionAlert('OPEN', row.due_on, context.today);
      if (alert === null) continue;
      const text = row.description.length <= 80 ? row.description : `${row.description.slice(0, 79).trimEnd()}...`;
      items.push(this.item(context, alert, row.id, message('home.source.early_warning.title.action.overdue', { code: row.warning_code }), label(row.project_code, message('home.source.early_warning.action_detail', { contract: row.contract_code, text, due: row.due_on })), { screen: EARLY_WARNING_SCREEN, id: row.warning_id }, `ew-action:${row.id}`));
    }
    return items;
  }

  private item(context: SourceContext, alert: EwAlert, id: string, title: string, subtitle: string | null, target: { screen: string; id: string }, causeKey: string): SourceRow {
    return {
      ...base(alert.kind),
      id,
      dueOn: alert.dueOn,
      originalDueOn: alert.dueOn,
      title,
      subtitle,
      status: alert.facet,
      severity: severityOf('CONTRACT_EARLY_WARNING', alert.kind === 'EW_ACTION_OVERDUE' ? 'OVERDUE' : alert.facet, context.rules),
      lifecycle: 'NEW',
      consequence: CONSEQUENCES[alert.kind] ?? null,
      causeKey,
      ...(alert.dueOn < context.today ? { startedAt: startOfDay(addDays(alert.dueOn, 1)) } : {}),
      target,
    };
  }
}
