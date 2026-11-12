import { EXISTING_CLOCKS, itemClocks, reminderState, workBucket } from '@machvon/kernel';
import type { ExistingClock, ItemClocks, PauseSpan, ReminderKind, ReminderState, WorkItem, WorkKind } from '@machvon/kernel';
import { HomeWorkActionStore, NO_ACTION_STATE, actionKey, freshActionState } from './home-work-action-store.ts';
import type { SnoozeDetail, WorkActionState } from './home-work-action-store.ts';
import { HomeClockSources, HomeWorkCalendars, WORK_CALENDAR_CODE } from './home-work-clock-store.ts';
import { WorkPolicyReader } from './home-work-policy.ts';
import type { WorkPolicies } from './home-work-policy.ts';
import { HomeWorkReminderStore } from './home-work-reminder-store.ts';
import { CONSEQUENCES, DEFAULT_SEVERITY_RULES, SEVERITY_RANK, SOURCE_OF_KIND, furtherLifecycle, severityOf } from './home-work-rules.ts';
import type { SeverityRules, WorkEscalation, WorkLifecycle, WorkSeverity, WorkSource } from './home-work-rules.ts';
import { HomeConnectorSources } from './home-connector-sources.ts';
import { HomeEgpPostingSources } from './home-egp-posting-sources.ts';
import { HomeVendorSources } from './home-vendor-sources.ts';
import { HomeContractRegisterSources } from './home-contract-register-sources.ts';
import { HomeGov11Sources } from './home-gov11-sources.ts';
import { HomeRiskCommitteeSources } from './home-risk-committee-sources.ts';
import { HomePwfSources } from './home-pwf-sources.ts';
import { HomeDirectiveSources } from './home-directive-sources.ts';
import { HomeAlertFeedbackSources } from './home-alert-feedback-sources.ts';
import { HomeGov10Sources } from './home-gov10-sources.ts';
import { HomeRedFlagSources } from './home-red-flag-sources.ts';
import { HomeIntegritySources } from './home-integrity-sources.ts';
import { HomePrcSources } from './home-prc-sources.ts';
import { HomeMoneySources } from './home-money-sources.ts';
import { AlertEscalationStore } from './alert-escalation-store.ts';
import { AlertGovernancePolicyReader } from './alert-governance-policy.ts';
import { HomeAlertSources, applyPromotions, overlayEscalation } from './home-alert-sources.ts';
import { applyAlertTypes } from './home-work-alert-types.ts';
import type { AlertTypeReading } from './home-work-alert-types.ts';
import { HomeCrossSources, Params, SOURCE_LIMIT, VIETNAM_DAY } from './home-work-sources.ts';
import type { SourceContext, SourceRow } from './home-work-sources.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/** A task of a person, with what the screen needs to take them to it, how urgent it is and what people did about it. */
export interface WorkRow extends WorkItem {
  /** The place the task is opened from: the screen and the id it is about. */
  target: { screen: string; id: string };
  /** The module source the task comes from. */
  source: WorkSource;
  severity: WorkSeverity;
  escalation: WorkEscalation | null;
  /** One sentence: what happens if it is not done. */
  consequence: string | null;
  lifecycle: WorkLifecycle;
  claimedBy: { id: string; name: string; at: string } | null;
  assignee: { id: string; name: string; dueOn: string | null } | null;
  /** When an item that somebody put off comes back, while that is still in the future. */
  snoozedUntil: string | null;
  /** The moment the item became something to act on, when its module says it. */
  startedAt: string | null;
  /** What a native clock says is expected, and its type (the source `CLOCK` only). */
  expectedAction: string | null;
  clockType: string | null;
  /** The postponement that still holds, how many there are in a row, the first and the latest time somebody took the item up, and every pause of its clocks. */
  snooze: SnoozeDetail | null;
  consecutiveSnoozes: number;
  firstClaimAt: string | null;
  lastClaimAt: string | null;
  pauses: PauseSpan[];
  /** Only in the mode `rows` (a count does not need them): the two clocks, the reminders, the notices to the next level, the clock the module already keeps and the version of the policy that judged. */
  clocks: ItemClocks | null;
  reminders: (ReminderState & { sent: number; lastAt: string | null }) | null;
  notices: Array<{ kind: ReminderKind; at: string }>;
  existingClock: ExistingClock | null;
  policyVersion: string | null;
  /** The alert type the item has in the registry (G0-3): its owner, the response time and the version of the rule; the consequence above comes from it. */
  alertType?: AlertTypeReading | null;
  /** The item was only to be watched and was raised one step by the escalation (G2-3): the severity it came from. */
  promotedFrom?: WorkSeverity | undefined;
}

/** The most a source gives (a person with more than this has a list that says it is cut: the counts are then a lower bound). */
export const WORK_SOURCE_LIMIT = SOURCE_LIMIT;
const LIMIT = WORK_SOURCE_LIMIT;
/** How many days ahead an obligation of the unit of the person is shown. */
const MNE_AHEAD_DAYS = 14;

export type WorkView = 'mine' | 'scope';

export interface WorkInput {
  membershipId: string;
  now: Date;
  today: string;
  /** The units the person may read (alias `u`) and the projects they may read (the aliases of the register queries): what they wrote is theirs to see only while they may read the place it is about. */
  unitScope: ScopeBuilder;
  projectScope: ScopeBuilder;
  /** `mine` (the default): the work of the person; `scope`: the work inside what they may read. */
  view?: WorkView;
  /** `count`: what counting needs, without the history of the levels of an escalation. */
  mode?: 'rows' | 'count';
  /** The severity of each finding of each source; the default table of design.md when none is given. */
  rules?: SeverityRules;
  /** Keep the items the reader put off themselves (a command acts on them; a list does not show them). */
  includeHidden?: boolean;
  /** Whether the reader holds a grant that carries a permission (on the whole tenant when asked): what the sources that are for a role (the auditors, the administrator of the duties, the data steward) judge their audience by. */
  holds?: (permission: string, wholeTenant?: boolean) => boolean;
}

export interface WorkCollection {
  rows: WorkRow[];
  truncated: boolean;
  /** The sources that could not be read: they are named, never shown as "no work". */
  unavailableSources: WorkSource[];
  /** The policies the rows were judged by (only in the mode `rows`). */
  policies: WorkPolicies | null;
}

const withoutDecisions = (row: SourceRow): WorkRow => withState(row, NO_ACTION_STATE);

/** A row of a source with what people decided about it joined on; the decoration of the clocks is added after, in the mode `rows`. */
function withState(row: SourceRow, state: WorkActionState): WorkRow {
  // The evaluated native clock is only a hand-over to the decoration; it is not part of the row that is given out.
  const rest: SourceRow = { ...row };
  delete rest.native;
  return {
    ...rest,
    lifecycle: furtherLifecycle(row.lifecycle, state.lifecycle),
    claimedBy: state.claimedBy,
    assignee: state.assignee,
    snoozedUntil: state.snoozedUntil,
    startedAt: row.startedAt ?? null,
    expectedAction: row.expectedAction ?? null,
    clockType: row.clockType ?? null,
    snooze: state.snooze,
    consecutiveSnoozes: state.consecutiveSnoozes,
    firstClaimAt: state.firstClaimAt,
    lastClaimAt: state.lastClaimAt,
    pauses: state.pauses,
    clocks: null,
    reminders: null,
    notices: [],
    existingClock: null,
    policyVersion: null,
  };
}

const later = (left: Date | null, right: string | null): Date | null => (right === null ? left : left === null || Date.parse(right) > left.getTime() ? new Date(right) : left);

/**
 * What is asked of one person across the modules (ST-HOME-004, HOME 3 F5, the alert centre): the approvals that wait for them (ADM), the explanations they owe and the ones they asked for and must conclude (PRJ), the reports of theirs
 * that came back or that are drafts past their period (DIS), the monitoring reports of their unit that are near their day (MNE), and what the other modules raise: the early warnings of DIS, the advances of PAY that are overdue, the
 * permits of PMT that ended or end soon, the recommendations of AUD that are past their day, the issues of ISS that missed the SLA, the diaries of QMS that are missing and the guarantees of CTR that end soon. HOME keeps none of it:
 * every read is of the table of the module, in the scope of the reader, and what people did about an item is the state of `work_action`. A source that cannot be read is named in `unavailableSources` and the others go on.
 */
export class HomeWorkStore {
  private readonly cross = new HomeCrossSources();
  private readonly money = new HomeMoneySources();
  private readonly directives = new HomeDirectiveSources();
  private readonly procurement = new HomePrcSources();
  private readonly integrity = new HomeIntegritySources();
  private readonly connectors = new HomeConnectorSources();
  private readonly egpPostings = new HomeEgpPostingSources();
  private readonly vendors = new HomeVendorSources();
  private readonly contractRegisters = new HomeContractRegisterSources();
  private readonly gov10 = new HomeGov10Sources();
  private readonly redFlags = new HomeRedFlagSources();
  private readonly feedback = new HomeAlertFeedbackSources();
  private readonly gov11 = new HomeGov11Sources();
  private readonly riskCommittee = new HomeRiskCommitteeSources();
  private readonly pwfTasks = new HomePwfSources();
  private readonly clocks = new HomeClockSources();
  private readonly actions = new HomeWorkActionStore();
  private readonly policies = new WorkPolicyReader();
  private readonly calendars = new HomeWorkCalendars();
  private readonly reminders = new HomeWorkReminderStore();
  private readonly alerts = new HomeAlertSources();
  private readonly escalations = new AlertEscalationStore();
  private readonly governance = new AlertGovernancePolicyReader();

  async collect(tx: TenantTx, input: WorkInput): Promise<WorkCollection> {
    const context: SourceContext = {
      tx,
      membershipId: input.membershipId,
      now: input.now,
      today: input.today,
      view: input.view ?? 'mine',
      unitScope: input.unitScope,
      projectScope: input.projectScope,
      rules: input.rules ?? DEFAULT_SEVERITY_RULES,
      counting: input.mode === 'count',
      ...(input.holds === undefined ? {} : { holds: input.holds }),
    };
    const readers: Array<[WorkSource, () => Promise<SourceRow[]>]> = [
      ['APPROVAL', () => this.approvals(context)],
      ['EXPLANATION', () => this.explanationsOwed(context)],
      ['EXPLANATION_CONCLUDE', () => this.explanationsToConclude(context)],
      ['REPORT', () => this.reports(context)],
      ['OBLIGATION', () => this.obligations(context)],
      ['EARLY_WARNING', () => this.cross.earlyWarnings(context)],
      ['ADVANCE', () => this.cross.advances(context)],
      ['PERMIT', () => this.cross.permits(context)],
      ['AUDIT_RECOMMENDATION', () => this.cross.recommendations(context)],
      ['ISSUE', () => this.cross.issues(context)],
      ['SITE_DIARY', () => this.cross.siteDiaries(context)],
      ['GUARANTEE', () => this.cross.guarantees(context)],
      ['MONEY_CONTROL', () => this.money.items(context)],
      ['DIRECTIVE', () => this.directives.items(context)],
      ['CLOCK', () => this.clocks.items(context)],
      ['PROCUREMENT_WORKFLOW', () => this.procurement.items(context)],
      ['TREASURY_RECON', () => this.integrity.treasuryRecon(context)],
      ['CROSS_TOTAL', () => this.integrity.crossTotal(context)],
      ['SOD_EXCEPTION', async () => [...(await this.integrity.sodExpiring(context)), ...(await this.integrity.sodUsed(context))]],
      ['PAYMENT_INTEGRITY', () => this.integrity.paymentIntegrity(context)],
      ['DISBURSEMENT_EXCEPTION', () => this.integrity.disbursementExceptions(context)],
      ['PROJECT_GOVERNANCE', () => this.integrity.projectGovernance(context)],
      ['CONNECTOR', () => this.connectors.items(context)],
      ['EGP_POSTING', () => this.egpPostings.items(context)],
      ['VENDOR', () => this.vendors.items(context)],
      ['CONTRACT_CLAIM', () => this.contractRegisters.claims(context)],
      ['CONTRACT_EARLY_WARNING', () => this.contractRegisters.earlyWarnings(context)],
      ['ESCALATION', () => this.alerts.escalated(context)],
      ['COVERAGE', () => this.alerts.coverageGaps(context)],
      ['CONTRACT_CLOCK', () => this.gov10.contractClock(context)],
      ['DOC_REVIEW', () => this.gov10.docReview(context)],
      ['DATA_FRESHNESS', () => this.gov10.dataFreshness(context)],
      ['ANOMALY', () => this.gov10.anomalies(context)],
      ['RED_FLAG', () => this.redFlags.items(context)],
      ['ALERT_FEEDBACK', () => this.feedback.items(context)],
      ['PAYMENT_CLOCK', () => this.gov11.paymentClockItems(context)],
      ['DISBURSEMENT_FORECAST', () => this.gov11.disMilestones(context)],
      ['SETTLEMENT_CLOCK', () => this.gov11.settlementClocks(context)],
      ['CONTRACT_ADJUSTMENT', () => this.gov11.adjustmentReviews(context)],
      ['LOOK_AHEAD', () => this.gov11.lookAhead(context)],
      ['LESSONS_LEARNED', () => this.gov11.lessonsMissing(context)],
      ['PROJECT_RISK', () => this.riskCommittee.projectRisk(context)],
      ['COMMITTEE', () => this.riskCommittee.committee(context)],
      ['PROJECT_TASK', () => this.pwfTasks.items(context)],
    ];
    const read: SourceRow[][] = [];
    const unavailableSources: WorkSource[] = [];
    let truncated = false;
    for (const [source, reader] of readers) {
      // A source that fails must not take the list with it: its statement is rolled back to a savepoint so that the transaction goes on, and the source is named as unavailable.
      await tx.query('savepoint home_work_source');
      try {
        const rows = await reader();
        await tx.query('release savepoint home_work_source');
        if (rows.length >= LIMIT) truncated = true;
        read.push(rows);
      } catch {
        await tx.query('rollback to savepoint home_work_source');
        await tx.query('release savepoint home_work_source');
        unavailableSources.push(source);
      }
    }
    const merged = this.foldByCause(read.flat());
    const states = await this.actions.stateOf(
      tx,
      merged.map((row) => ({ source: row.source, sourceId: row.id })),
      input.membershipId,
      input.now,
    );
    const rows: WorkRow[] = [];
    const natives = new Map<string, NonNullable<SourceRow['native']>>();
    for (const row of merged) {
      const state = states.get(actionKey(row.source, row.id));
      // What the reader put off themselves is not on their list until it comes back.
      if (state?.hiddenForReader === true && input.includeHidden !== true) continue;
      if (row.native !== undefined) natives.set(actionKey(row.source, row.id), row.native);
      rows.push(state === undefined ? withoutDecisions(row) : withState(row, state));
    }
    // G2-3: an item that was only to be watched and was raised one step by the escalation is shown to be acted on, in the list and in the counts.
    await applyPromotions(tx, rows);
    if (context.counting) return { rows, truncated, unavailableSources, policies: null };
    const policies = await this.decorate(tx, rows, natives, states, input);
    // G0-3: the consequence and the response time of an item are those of its alert type, an `ALERT_TYPE` rule read through the governance port.
    await applyAlertTypes(tx, rows, input.today);
    return { rows, truncated, unavailableSources, policies };
  }

  /**
   * The clocks of each item, the reminders it has had and when the next is due, the notices that went to the next level, and the clock its module already keeps (G0-2, G2-2, G2-4): read through the policies of the governance port
   * and the published working calendar, only when the rows are shown. A year without a published calendar leaves the clocks that need it absent and says so (`basis`); nothing is guessed.
   */
  private async decorate(tx: TenantTx, rows: WorkRow[], natives: ReadonlyMap<string, NonNullable<SourceRow['native']>>, states: ReadonlyMap<string, WorkActionState>, input: WorkInput): Promise<WorkPolicies> {
    const policies = await this.policies.read(tx, input.today);
    if (rows.length === 0) return policies;
    const calendars = await this.calendars.load(tx, WORK_CALENDAR_CODE, input.now);
    const keys = rows.map((row) => ({ source: row.source, sourceId: row.id }));
    const sent = await this.reminders.summary(tx, keys, input.membershipId);
    const notices = await this.reminders.notices(tx, keys);
    for (const row of rows) {
      const key = actionKey(row.source, row.id);
      const state = states.get(key) ?? freshActionState();
      const native = natives.get(key);
      const started = row.startedAt === null ? null : new Date(row.startedAt);
      let clocks = itemClocks({
        severity: row.severity,
        now: input.now,
        startedAt: started,
        dueOn: native === undefined ? row.dueOn : null,
        firstClaimAt: state.firstClaimAt === null ? null : new Date(state.firstClaimAt),
        lastClaimAt: state.lastClaimAt === null ? null : new Date(state.lastClaimAt),
        lifecycle: row.lifecycle,
        pauses: state.pauses,
        policy: policies.clock,
        calendars,
      });
      // A native clock keeps the end it was given (moved by its pauses); the claim clock still counts from its start.
      if (native !== undefined) clocks = { ...clocks, resolve: native.resolve, paused: native.paused };
      const summary = sent.get(key);
      let anchor = later(started, state.lastClaimAt);
      for (const span of state.pauses) anchor = later(anchor, span.resumedAt ?? span.until);
      if (state.snooze !== null) anchor = later(anchor, state.snooze.until);
      anchor = later(anchor, summary?.lastAt ?? null);
      const reminder = reminderState({
        severity: row.severity,
        now: input.now,
        anchorAt: anchor,
        sent: summary?.sent ?? 0,
        snoozedUntil: state.snooze === null ? null : new Date(state.snooze.until),
        paused: clocks.paused !== null,
        lifecycle: row.lifecycle,
        policy: policies.reminder,
        calendars,
      });
      row.clocks = clocks;
      // The tasks of a workflow are reminded at the points of their deadline rule (the pass of the reminder job over `project_task_reminder`), not by the cadence of the severity: the cadence never says one is due.
      const cadence = row.source === 'PROJECT_TASK' ? { ...reminder, due: false, nextAt: null } : reminder;
      row.reminders = { ...cadence, sent: summary?.sent ?? 0, lastAt: summary?.lastAt ?? null };
      row.notices = notices.get(key) ?? [];
      row.existingClock = EXISTING_CLOCKS.find((clock) => clock.source === row.source) ?? null;
      row.policyVersion = policies.versions.clock;
    }
    // G2-3: the chain of escalation, where an item stands on it and when the next level comes.
    const escalation = (await this.governance.read(tx, input.today)).escalation;
    overlayEscalation(rows, { policy: escalation, climbs: await this.escalations.climbOf(tx, keys), calendars, now: input.now });
    return policies;
  }

  /**
   * One cause is one item: an issue that ISS opened for a permit, a guarantee or an advance that is already on the list is the same cause as that record. The record stays (it is what the person acts on), takes the more
   * urgent of the two severities, and shows the escalation of the issue, which is the one that is going up.
   */
  private foldByCause(rows: SourceRow[]): SourceRow[] {
    const owners = new Map<string, SourceRow>();
    for (const row of rows) if (row.source !== 'ISSUE' && row.causeKey !== null) owners.set(row.causeKey, row);
    const folded: SourceRow[] = [];
    for (const row of rows) {
      const owner = row.source === 'ISSUE' && row.causeKey !== null ? owners.get(row.causeKey) : undefined;
      if (owner === undefined) {
        folded.push(row);
        continue;
      }
      if (SEVERITY_RANK[row.severity] < SEVERITY_RANK[owner.severity]) owner.severity = row.severity;
      if (row.escalation !== null) owner.escalation = row.escalation;
    }
    return folded;
  }

  private legacy(context: SourceContext, kind: WorkKind, row: Omit<SourceRow, 'source' | 'severity' | 'escalation' | 'consequence' | 'lifecycle' | 'causeKey' | 'kind'>): SourceRow {
    const source = SOURCE_OF_KIND[kind];
    return { ...row, kind, source, severity: severityOf(source, workBucket(row, context.today), context.rules), escalation: null, consequence: CONSEQUENCES[source] ?? null, lifecycle: 'NEW', causeKey: null };
  }

  /** The approvals that wait for the person; in the view `scope`, the ones that wait past their day in the units they may read. */
  private async approvals(context: SourceContext): Promise<SourceRow[]> {
    const params = new Params();
    const where =
      context.view === 'mine'
        ? `a.assignee_id = ${params.add(context.membershipId)}::uuid`
        : `a.due_at < ${params.add(context.now.toISOString())}::timestamptz and ${params.scope(context.unitScope)}`;
    const rows = await context.tx.query<{ id: string; due_on: string; resource_type: string }>(
      `select a.id, ${VIETNAM_DAY('a.due_at')} as due_on, i.document_type as resource_type
         from machvon.approval_task a join machvon.workflow_instance i on i.tenant_id = a.tenant_id and i.id = a.workflow_instance_id
         left join machvon.organization_unit u on u.tenant_id = i.tenant_id and u.id = i.unit_id
        where ${where} and a.status = 'Pending' and a.decided_at is null and a.decision is null
        order by a.due_at, a.id limit ${LIMIT}`,
      params.values,
    );
    return rows.map((row) => this.legacy(context, 'APPROVAL', { id: row.id, dueOn: row.due_on, originalDueOn: row.due_on, title: row.resource_type, subtitle: null, status: 'PENDING', target: { screen: 'ADM-06', id: row.id } }));
  }

  /** The explanations that were asked of the person and are not answered: asked, sent back, or late; in the view `scope`, the late ones of the places they may read. */
  private async explanationsOwed(context: SourceContext): Promise<SourceRow[]> {
    const params = new Params();
    let where: string;
    if (context.view === 'mine') where = `e.requested_from_membership_id = ${params.add(context.membershipId)}::uuid and e.status in ('REQUESTED', 'RETURNED', 'OVERDUE')`;
    else {
      const projects = params.scope(context.projectScope);
      const units = params.scope(context.unitScope);
      where = `(e.status = 'OVERDUE' or (e.status in ('REQUESTED', 'RETURNED') and e.due_at < ${params.add(context.now.toISOString())}::timestamptz))
          and ((e.project_id is not null and exists (select 1 from ${SCOPE_FROM} where p.id = e.project_id and ${projects}))
               or (e.project_id is null and exists (select 1 from machvon.organization_unit u where u.tenant_id = e.tenant_id and u.id = e.unit_id and ${units})))`;
    }
    const rows = await context.tx.query<{ id: string; question: string; status: string; due_on: string; original_due_on: string; project_code: string | null; unit_code: string | null }>(
      `select e.id, e.question, e.status, ${VIETNAM_DAY('e.due_at')} as due_on, ${VIETNAM_DAY('e.original_due_at')} as original_due_on, p.code as project_code, u.code as unit_code
         from machvon.explanation_request e left join machvon.project p on p.tenant_id = e.tenant_id and p.id = e.project_id left join machvon.organization_unit u on u.tenant_id = e.tenant_id and u.id = e.unit_id
        where ${where}
        order by e.due_at, e.id limit ${LIMIT}`,
      params.values,
    );
    return rows.map((row) =>
      this.legacy(context, 'EXPLANATION', { id: row.id, dueOn: row.due_on, originalDueOn: row.original_due_on, title: row.question, subtitle: row.project_code ?? row.unit_code, status: row.status, target: { screen: 'PRJ-19', id: row.id } }),
    );
  }

  /** The explanations that the person asked for and that were answered: they are the ones to conclude (the work of the person who asked, so it is not in the view `scope`). */
  private async explanationsToConclude(context: SourceContext): Promise<SourceRow[]> {
    if (context.view === 'scope') return [];
    const params = new Params();
    const me = params.add(context.membershipId);
    const projects = params.scope(context.projectScope);
    const units = params.scope(context.unitScope);
    const rows = await context.tx.query<{ id: string; question: string; due_on: string; original_due_on: string; project_code: string | null; unit_code: string | null }>(
      `select e.id, e.question, ${VIETNAM_DAY('e.due_at')} as due_on, ${VIETNAM_DAY('e.original_due_at')} as original_due_on, p.code as project_code, u.code as unit_code
         from machvon.explanation_request e left join machvon.project p on p.tenant_id = e.tenant_id and p.id = e.project_id left join machvon.organization_unit u on u.tenant_id = e.tenant_id and u.id = e.unit_id
        where e.created_by = ${me}::uuid and e.requested_from_membership_id <> ${me}::uuid and e.status = 'RESPONDED'
          and ((e.project_id is not null and exists (select 1 from ${SCOPE_FROM} where p.id = e.project_id and ${projects}))
               or (e.project_id is null and exists (select 1 from machvon.organization_unit u where u.tenant_id = e.tenant_id and u.id = e.unit_id and ${units})))
        order by e.due_at, e.id limit ${LIMIT}`,
      params.values,
    );
    return rows.map((row) =>
      this.legacy(context, 'EXPLANATION_REVIEW', { id: row.id, dueOn: row.due_on, originalDueOn: row.original_due_on, title: row.question, subtitle: row.project_code ?? row.unit_code, status: 'RESPONDED', target: { screen: 'PRJ-19', id: row.id } }),
    );
  }

  /** The reports of the person that came back, and the drafts whose period is past its deadline (in the view `scope`, the ones of the projects they may read, whoever wrote them). */
  private async reports(context: SourceContext): Promise<SourceRow[]> {
    const params = new Params();
    const who = context.view === 'mine' ? `(r.created_by = ${params.add(context.membershipId)}::uuid or r.submitted_by = ${params.add(context.membershipId)}::uuid) and ` : '';
    const projects = params.scope(context.projectScope);
    const rows = await context.tx.query<{ id: string; status: string; due_on: string; project_code: string; period_code: string }>(
      `select r.id, r.status, ${VIETNAM_DAY('rp.deadline_at')} as due_on, p.code as project_code, rp.code as period_code
         from machvon.report_revision r join ${SCOPE_FROM} on p.tenant_id = r.tenant_id and p.id = r.project_id join machvon.reporting_period rp on rp.tenant_id = r.tenant_id and rp.id = r.period_id
        where r.deleted_at is null and ${who}${projects}
          and not exists (select 1 from machvon.report_revision n where n.tenant_id = r.tenant_id and n.supersedes_id = r.id and n.deleted_at is null)
          and (r.status in ('RETURNED', 'AMENDMENT_REQUESTED') or (r.status = 'DRAFT' and rp.deadline_at < ${params.add(context.now.toISOString())}::timestamptz))
        order by rp.deadline_at, r.id limit ${LIMIT}`,
      params.values,
    );
    return rows.map((row) =>
      this.legacy(context, row.status === 'DRAFT' ? 'REPORT_DRAFT_OVERDUE' : 'REPORT_RETURNED', {
        id: row.id,
        dueOn: row.due_on,
        originalDueOn: row.due_on,
        title: row.period_code,
        subtitle: row.project_code,
        status: row.status,
        target: { screen: 'DIS-03', id: row.id },
      }),
    );
  }

  /**
   * The monitoring reports of the unit of the person (and the units under it) that are not handed in and are late or near their day, in the units they may read: their unit is where the work is, their right to read is
   * what lets them see it (a membership in a parent unit with a grant of one branch sees that branch only). In the view `scope` the unit of the person is not the limit, the units they may read are.
   */
  private async obligations(context: SourceContext): Promise<SourceRow[]> {
    const params = new Params();
    const mine = context.view === 'mine';
    const me = mine ? params.add(context.membershipId) : '';
    const today = params.add(context.today);
    const visible = params.scope(context.unitScope);
    const rows = await context.tx.query<{ id: string; status: string; due_date: string; period_label: string; unit_code: string | null; form_code: string | null }>(
      `select r.id, r.status, r.due_date::text as due_date, r.period_label, u.code as unit_code, f.form_code
         from ${mine ? 'machvon.membership m join machvon.organization_unit mu on mu.tenant_id = m.tenant_id and mu.id = m.organization_id join machvon.mne_report r on r.tenant_id = m.tenant_id' : 'machvon.mne_report r'}
         join machvon.organization_unit u on u.tenant_id = r.tenant_id and u.id = r.scope_unit_id${mine ? ' and starts_with(u.path, mu.path)' : ''}
         left join machvon.mne_report_form f on f.tenant_id = r.tenant_id and f.id = r.form_id
        where ${mine ? `m.id = ${me}::uuid and ` : ''}r.revision = 1 and r.status in ('DRAFT', 'RETURNED') and r.due_date <= (${today}::date + ${MNE_AHEAD_DAYS}) and ${visible}
        order by r.due_date, r.id limit ${LIMIT}`,
      params.values,
    );
    return rows.map((row) =>
      this.legacy(context, 'MNE_OBLIGATION', { id: row.id, dueOn: row.due_date, originalDueOn: row.due_date, title: `${row.form_code ?? 'MNE'} ${row.period_label}`, subtitle: row.unit_code, status: row.status, target: { screen: 'MNE-03', id: row.id } }),
    );
  }
}
