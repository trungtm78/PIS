import { randomUUID } from 'node:crypto';
import {
  DomainError,
  assertBanPeriod,
  assertWithinLimitation,
  banLastDay,
  deadlineClock,
  dueFrom,
  escalationSuggestion,
  hasControlChar,
  isInForce,
  moveRestrictionCase,
  versionConflict,
  vietnamDateOf,
  ventureMembersReached,
} from '@machvon/kernel';
import type { DeadlineClockState, EscalationSuggestion, RestrictionCaseFacts, RestrictionCaseMove, RestrictionCaseState, RestrictionDecision, RestrictionScope, RestrictionTrigger, ResponseOutcome, WorkCalendarSource } from '@machvon/kernel';
import { HomeWorkCalendars, WORK_CALENDAR_CODE } from './home-work-clock-store.ts';
import { timestampKey } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';
import { VendorPolicyReader } from './vendor-policy.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const OPEN_STATES: readonly RestrictionCaseState[] = ['PROPOSED', 'NOTICE_SENT', 'RESPONSE_RECEIVED', 'DECIDED'];

export interface CaseRow {
  id: string;
  caseNo: string;
  subjectKind: 'CONTRACTOR' | 'JOINT_VENTURE';
  contractorId: string | null;
  jointVentureId: string | null;
  subjectName: string;
  triggerKind: RestrictionTrigger;
  triggerRef: string | null;
  egpRecordId: string | null;
  violationGroups: string[];
  violationSummary: string;
  violationOn: string;
  proposedBy: string;
  receivedAt: string;
  receivedOn: string;
  proposalDocumentId: string | null;
  decideBy: string;
  policyVersion: string;
  status: RestrictionCaseState;
  notifiedAt: string | null;
  noticeDocumentId: string | null;
  responseDueAt: string | null;
  responseOutcome: ResponseOutcome | null;
  responseDocumentId: string | null;
  responseSummary: string | null;
  decision: RestrictionDecision | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionDocumentId: string | null;
  decisionReason: string | null;
  decisionScope: RestrictionScope | null;
  banMonths: number | null;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  culpableMemberIds: string[];
  decidedLate: boolean | null;
  effectAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  liftDocumentId: string | null;
  version: number;
  /** The clock of the decision on the day the row was read. */
  clock: DeadlineClockState;
}

export interface CaseEventRow {
  id: string;
  move: string;
  fromStatus: string | null;
  toStatus: string;
  actorId: string;
  note: string | null;
  occurredAt: string;
}

export interface NewCase {
  subjectKind: 'CONTRACTOR' | 'JOINT_VENTURE';
  contractorId?: string | undefined;
  jointVentureId?: string | undefined;
  triggerKind: RestrictionTrigger;
  triggerRef?: string | undefined;
  violationGroups: string[];
  violationSummary: string;
  violationOn: string;
  proposalDocumentId?: string | undefined;
}

export interface DecisionInput {
  decision: RestrictionDecision;
  reason: string;
  scope?: RestrictionScope | undefined;
  banMonths?: number | undefined;
  effectiveFrom?: string | undefined;
  decisionDocumentId?: string | undefined;
  culpableMemberIds?: string[] | undefined;
}

interface CaseSql {
  id: string;
  case_no: string;
  subject_kind: CaseRow['subjectKind'];
  contractor_id: string | null;
  joint_venture_id: string | null;
  subject_name: string;
  trigger_kind: RestrictionTrigger;
  trigger_ref: string | null;
  egp_record_id: string | null;
  violation_groups: string[];
  violation_summary: string;
  violation_on: string;
  proposed_by: string;
  received_at: string;
  received_on: string;
  proposal_document_id: string | null;
  decide_by: string;
  policy_version: string;
  status: RestrictionCaseState;
  notified_at: string | null;
  notice_document_id: string | null;
  response_due_at: string | null;
  response_outcome: ResponseOutcome | null;
  response_document_id: string | null;
  response_summary: string | null;
  decision: RestrictionDecision | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_document_id: string | null;
  decision_reason: string | null;
  decision_scope: RestrictionScope | null;
  ban_months: number | null;
  effective_from: string | null;
  effective_until: string | null;
  culpable_member_ids: string[];
  decided_late: boolean | null;
  effect_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  lift_document_id: string | null;
  version: string;
}

const SELECT = `select k.id, k.case_no, k.subject_kind, k.contractor_id, k.joint_venture_id, coalesce(c.legal_name, v.name) as subject_name, k.trigger_kind, k.trigger_ref, k.egp_record_id, k.violation_groups, k.violation_summary,
  k.violation_on::text as violation_on, k.proposed_by, ${timestampKey('k.received_at')} as received_at, k.received_on::text as received_on, k.proposal_document_id, ${timestampKey('k.decide_by')} as decide_by, k.policy_version, k.status,
  ${timestampKey('k.notified_at')} as notified_at, k.notice_document_id, ${timestampKey('k.response_due_at')} as response_due_at, k.response_outcome, k.response_document_id, k.response_summary, k.decision, k.decided_by,
  ${timestampKey('k.decided_at')} as decided_at, k.decision_document_id, k.decision_reason, k.decision_scope, k.ban_months, k.effective_from::text as effective_from, k.effective_until::text as effective_until, k.culpable_member_ids,
  k.decided_late, ${timestampKey('k.effect_at')} as effect_at, ${timestampKey('k.ended_at')} as ended_at, k.end_reason, k.lift_document_id, k.version::text as version
  from machvon.restriction_case k
  left join machvon.contractor c on c.tenant_id = k.tenant_id and c.id = k.contractor_id
  left join machvon.joint_venture v on v.tenant_id = k.tenant_id and v.id = k.joint_venture_id`;

function textOf(value: string, field: string, min: number, max: number): string {
  const text = value.trim();
  if (text.length < min || text.length > max || hasControlChar(text)) throw invalid(field);
  return text;
}

const realDay = (value: string, field: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw invalid(field);
  return value;
};

/**
 * The debarment case (VND-1, V2): the workflow that ends in a restriction on a contractor, counted on the published working calendar and judged by the kernel (`moveRestrictionCase`). A case about a joint venture reaches
 * every member (or only the culpable ones for the groups the policy excepts), each with its own restriction row; a restriction row that a case wrote carries the case, and one that was lifted on an appeal never blocks.
 * Putting a decision into effect writes the legal record the gates read (`contractor_restriction`), on a decision paper that is in force. Audit and events are written by the caller.
 */
export class RestrictionCaseStore {
  private readonly policies: VendorPolicyReader;
  private readonly calendars: HomeWorkCalendars;

  constructor(policies: VendorPolicyReader = new VendorPolicyReader(), calendars: HomeWorkCalendars = new HomeWorkCalendars()) {
    this.policies = policies;
    this.calendars = calendars;
  }

  private async calendarOf(tx: TenantTx, now: Date): Promise<WorkCalendarSource> {
    const source = await this.calendars.load(tx, WORK_CALENDAR_CODE, now);
    if (source === undefined) throw new DomainError('CALENDAR_NOT_EFFECTIVE', 422, 'calendar_code');
    return source;
  }

  private rowOf(row: CaseSql, remindBeforeDays: number, now: Date): CaseRow {
    return {
      id: row.id,
      caseNo: row.case_no,
      subjectKind: row.subject_kind,
      contractorId: row.contractor_id,
      jointVentureId: row.joint_venture_id,
      subjectName: row.subject_name,
      triggerKind: row.trigger_kind,
      triggerRef: row.trigger_ref,
      egpRecordId: row.egp_record_id,
      violationGroups: row.violation_groups,
      violationSummary: row.violation_summary,
      violationOn: row.violation_on,
      proposedBy: row.proposed_by,
      receivedAt: row.received_at,
      receivedOn: row.received_on,
      proposalDocumentId: row.proposal_document_id,
      decideBy: row.decide_by,
      policyVersion: row.policy_version,
      status: row.status,
      notifiedAt: row.notified_at,
      noticeDocumentId: row.notice_document_id,
      responseDueAt: row.response_due_at,
      responseOutcome: row.response_outcome,
      responseDocumentId: row.response_document_id,
      responseSummary: row.response_summary,
      decision: row.decision,
      decidedBy: row.decided_by,
      decidedAt: row.decided_at,
      decisionDocumentId: row.decision_document_id,
      decisionReason: row.decision_reason,
      decisionScope: row.decision_scope,
      banMonths: row.ban_months,
      effectiveFrom: row.effective_from,
      effectiveUntil: row.effective_until,
      culpableMemberIds: row.culpable_member_ids,
      decidedLate: row.decided_late,
      effectAt: row.effect_at,
      endedAt: row.ended_at,
      endReason: row.end_reason,
      liftDocumentId: row.lift_document_id,
      version: Number(row.version),
      clock: deadlineClock({ dueAt: new Date(row.decide_by), doneAt: row.decided_at === null ? (row.status === 'DISMISSED' && row.decision === null ? new Date(row.decide_by) : null) : new Date(row.decided_at), now, remindBeforeDays }),
    };
  }

  async find(tx: TenantTx, id: string, now: Date, lock = false): Promise<CaseRow | undefined> {
    const policy = (await this.policies.debarment(tx, vietnamDateOf(now))).value;
    const rows = await tx.query<CaseSql>(`${SELECT} where k.id = $1::uuid${lock ? ' for update of k' : ''}`, [id]);
    return rows[0] === undefined ? undefined : this.rowOf(rows[0], policy.remind_before_days, now);
  }

  async require(tx: TenantTx, id: string, now: Date, lock = false): Promise<CaseRow> {
    const row = await this.find(tx, id, now, lock);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return row;
  }

  async list(tx: TenantTx, filter: { status?: RestrictionCaseState | undefined; contractorId?: string | undefined; open?: boolean | undefined; limit?: number | undefined }, now: Date): Promise<CaseRow[]> {
    const policy = (await this.policies.debarment(tx, vietnamDateOf(now))).value;
    const rows = await tx.query<CaseSql>(
      `${SELECT} where ($1::text is null or k.status = $1) and ($2::uuid is null or k.contractor_id = $2::uuid or exists (select 1 from machvon.restriction_case_member m where m.tenant_id = k.tenant_id and m.case_id = k.id and m.contractor_id = $2::uuid))
          and ($3::boolean is null or ($3 = (k.status = any($4::text[]))))
        order by k.received_at desc, k.id desc limit $5`,
      [filter.status ?? null, filter.contractorId ?? null, filter.open ?? null, [...OPEN_STATES], filter.limit ?? 200],
    );
    return rows.map((row) => this.rowOf(row, policy.remind_before_days, now));
  }

  async events(tx: TenantTx, caseId: string): Promise<CaseEventRow[]> {
    const rows = await tx.query<{ id: string; move: string; from_status: string | null; to_status: string; actor_id: string; note: string | null; occurred_at: string }>(
      `select id, move, from_status, to_status, actor_id, note, ${timestampKey('occurred_at')} as occurred_at from machvon.restriction_case_event where case_id = $1::uuid order by occurred_at, id`,
      [caseId],
    );
    return rows.map((row) => ({ id: row.id, move: row.move, fromStatus: row.from_status, toStatus: row.to_status, actorId: row.actor_id, note: row.note, occurredAt: row.occurred_at }));
  }

  async members(tx: TenantTx, caseId: string): Promise<Array<{ contractorId: string; contractorName: string; restrictionId: string | null }>> {
    const rows = await tx.query<{ contractor_id: string; name: string; restriction_id: string | null }>(
      'select m.contractor_id, c.legal_name as name, m.restriction_id from machvon.restriction_case_member m join machvon.contractor c on c.tenant_id = m.tenant_id and c.id = m.contractor_id where m.case_id = $1::uuid order by c.legal_name, m.id',
      [caseId],
    );
    return rows.map((row) => ({ contractorId: row.contractor_id, contractorName: row.name, restrictionId: row.restriction_id }));
  }

  private async log(tx: TenantTx, caseId: string, move: string, from: string | null, to: string, actor: string, note: string | null): Promise<void> {
    await tx.query(`insert into machvon.restriction_case_event (tenant_id, id, case_id, move, from_status, to_status, actor_id, note, occurred_at) values (${TENANT}, gen_random_uuid(), $1::uuid, $2, $3, $4, $5::uuid, $6, clock_timestamp())`, [caseId, move, from, to, actor, note]);
  }

  private async assertDocument(tx: TenantTx, documentId: string | undefined, field: string, inForce = false): Promise<void> {
    if (documentId === undefined) return;
    const rows = await tx.query<{ effect_status: string }>('select effect_status from machvon.document where id = $1::uuid', [documentId]);
    if (rows[0] === undefined) throw invalid(field);
    if (inForce && !isInForce(rows[0].effect_status)) throw new DomainError('DECISION_DOCUMENT_NOT_EFFECTIVE', 422, field);
  }

  private async nextNumber(tx: TenantTx, year: number): Promise<string> {
    await tx.query("select pg_advisory_xact_lock(hashtext(nullif(current_setting('app.tenant_id', true), '') || ':restriction_case'))");
    const [row] = await tx.query<{ n: number }>("select count(*)::int as n from machvon.restriction_case where case_no like $1", [`RC-${year}-%`]);
    return `RC-${year}-${String((row?.n ?? 0) + 1).padStart(5, '0')}`;
  }

  /**
   * Opens a case: the day the proposal is received starts the clock of the decision (the rule `VENDOR_DEBARMENT`, counted on the published working calendar: 422 `CALENDAR_NOT_EFFECTIVE` when there is none). The
   * violation groups must be groups the rule `VENDOR_DEBARMENT_PERIOD` knows, and the violation must be within the limitation (422 `RESTRICTION_CASE_TIME_BARRED`). The same proposal is not opened twice (the unique index).
   */
  async open(tx: TenantTx, input: NewCase & { egpRecordId?: string | undefined }, actor: string, now: Date): Promise<CaseRow> {
    const today = vietnamDateOf(now);
    const policy = await this.policies.debarment(tx, today);
    const periods = await this.policies.periods(tx, today);
    const summary = textOf(input.violationSummary, 'violation_summary', 20, 2000);
    const violationOn = realDay(input.violationOn, 'violation_on');
    if (violationOn > today) throw invalid('violation_on');
    const groups = [...new Set(input.violationGroups)];
    if (groups.length === 0 || groups.length > 5 || groups.some((group) => periods.value[group] === undefined)) throw invalid('violation_groups');
    assertWithinLimitation(violationOn, today, policy.value.limitation_years);
    if (input.subjectKind === 'CONTRACTOR') {
      if (input.contractorId === undefined || input.jointVentureId !== undefined) throw invalid('contractor_id');
      if ((await tx.query('select 1 from machvon.contractor where id = $1::uuid', [input.contractorId])).length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    } else {
      if (input.jointVentureId === undefined || input.contractorId !== undefined) throw invalid('joint_venture_id');
      if ((await tx.query('select 1 from machvon.joint_venture where id = $1::uuid', [input.jointVentureId])).length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    }
    await this.assertDocument(tx, input.proposalDocumentId, 'proposal_document_id');
    const decideBy = dueFrom(policy.value.decide_day_unit, policy.value.decide_within_days, now, await this.calendarOf(tx, now));
    const id = randomUUID();
    const caseNo = await this.nextNumber(tx, Number(today.slice(0, 4)));
    try {
      await tx.query('savepoint restriction_case_open');
      await tx.query(
        `insert into machvon.restriction_case
           (tenant_id, id, case_no, subject_kind, contractor_id, joint_venture_id, trigger_kind, trigger_ref, egp_record_id, violation_groups, violation_summary, violation_on, proposed_by, received_at, received_on, proposal_document_id, decide_by, policy_version)
         values (${TENANT}, $1::uuid, $2, $3, $4::uuid, $5::uuid, $6, $7, $8::uuid, $9::text[], $10, $11::date, $12::uuid, $13::timestamptz, $14::date, $15::uuid, $16::timestamptz, $17)`,
        [id, caseNo, input.subjectKind, input.contractorId ?? null, input.jointVentureId ?? null, input.triggerKind, input.triggerRef === undefined ? null : textOf(input.triggerRef, 'trigger_ref', 1, 200), input.egpRecordId ?? null, groups, summary, violationOn, actor, now.toISOString(), today, input.proposalDocumentId ?? null, decideBy.toISOString(), `${policy.version}|${periods.version}`],
      );
      await tx.query('release savepoint restriction_case_open');
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        await tx.query('rollback to savepoint restriction_case_open');
        throw new DomainError('RESTRICTION_CASE_DUPLICATE', 409, 'trigger_ref');
      }
      throw error;
    }
    await this.log(tx, id, 'PROPOSE', null, 'PROPOSED', actor, null);
    return this.require(tx, id, now);
  }

  /**
   * Opens a case from a record of the national network that a file import kept (`egp_record`, kind RESTRICTION; docs/egp-connector.md section 10): the contractor is found by the tax code of the record, the
   * trigger is EGP_IMPORT with the restriction code and the decision number, and the violation day is the day of the decision of the network (else the first day of the restriction). The person still gives the
   * violation groups the authority puts it in; nothing is written to `contractor_restriction` until the case is decided and put into effect on a decision paper of the tenant.
   */
  async openFromEgpRecord(tx: TenantTx, egpRecordId: string, input: { violationGroups: string[]; violationSummary?: string | undefined; proposalDocumentId?: string | undefined }, actor: string, now: Date): Promise<CaseRow> {
    const [record] = await tx.query<{ record: { restrictionCode: string; contractorTaxCode: string; restrictionKind: string; validFrom: string; validUntil: string; decisionNo: string; decisionDate: string | null; legalBasis: string | null }; kind: string }>(
      'select record, kind from machvon.egp_record where id = $1::uuid',
      [egpRecordId],
    );
    if (record === undefined || record.kind !== 'RESTRICTION') throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const data = record.record;
    const [contractor] = await tx.query<{ id: string }>("select id from machvon.contractor where tax_identifier = $1 order by (verification_status = 'VERIFIED') desc, created_at limit 1", [data.contractorTaxCode]);
    if (contractor === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'contractor_tax_code');
    const summary = input.violationSummary ?? `National network restriction ${data.restrictionCode} (${data.restrictionKind}), decision ${data.decisionNo}, valid ${data.validFrom} to ${data.validUntil}${data.legalBasis === null ? '' : `, basis ${data.legalBasis}`}`;
    const today = vietnamDateOf(now);
    const violationOn = [data.decisionDate, data.validFrom].find((day): day is string => day !== null && day <= today) ?? today;
    return this.open(tx, { subjectKind: 'CONTRACTOR', contractorId: contractor.id, triggerKind: 'EGP_IMPORT', triggerRef: `${data.restrictionCode}/${data.decisionNo}`.slice(0, 200), egpRecordId, violationGroups: input.violationGroups, violationSummary: summary, violationOn, proposalDocumentId: input.proposalDocumentId }, actor, now);
  }

  private factsOf(row: CaseRow): RestrictionCaseFacts {
    return {
      state: row.status,
      proposedBy: row.proposedBy,
      receivedAt: new Date(row.receivedAt),
      notifiedAt: row.notifiedAt === null ? null : new Date(row.notifiedAt),
      responseDueAt: row.responseDueAt === null ? null : new Date(row.responseDueAt),
      responseOutcome: row.responseOutcome,
      decision: row.decision,
      decidedBy: row.decidedBy,
      effectiveFrom: row.effectiveFrom,
      banMonths: row.banMonths,
    };
  }

  private async locked(tx: TenantTx, id: string, expectedVersion: number, now: Date): Promise<CaseRow> {
    const row = await this.require(tx, id, now, true);
    if (row.version !== expectedVersion) throw versionConflict(row.version);
    return row;
  }

  private async finish(tx: TenantTx, current: CaseRow, move: string, to: string, actor: string, note: string | null, now: Date): Promise<CaseRow> {
    await this.log(tx, current.id, move, current.status, to, actor, note);
    return this.require(tx, current.id, now);
  }

  /** Tells the contractor: the notice paper and the window to answer (`response_days` of the rule, counted on the working calendar). */
  async sendNotice(tx: TenantTx, id: string, expectedVersion: number, noticeDocumentId: string | undefined, actor: string, now: Date): Promise<CaseRow> {
    const current = await this.locked(tx, id, expectedVersion, now);
    const policy = (await this.policies.debarment(tx, vietnamDateOf(now))).value;
    await this.assertDocument(tx, noticeDocumentId, 'notice_document_id');
    const due = dueFrom('CALENDAR_DAYS', policy.response_days, now, await this.calendarOf(tx, now));
    const after = moveRestrictionCase(this.factsOf(current), { move: 'SEND_NOTICE', by: actor, at: now, responseDueAt: due } satisfies RestrictionCaseMove);
    await tx.query("update machvon.restriction_case set status = $2, notified_by = $3::uuid, notified_at = $4::timestamptz, response_due_at = $5::timestamptz, notice_document_id = $6::uuid, version = version + 1 where id = $1::uuid", [id, after.state, actor, now.toISOString(), due.toISOString(), noticeDocumentId ?? null]);
    return this.finish(tx, current, 'SEND_NOTICE', after.state, actor, null, now);
  }

  /** Records the answer of the contractor (a summary, and its paper when there is one). */
  async recordResponse(tx: TenantTx, id: string, expectedVersion: number, input: { summary: string; documentId?: string | undefined }, actor: string, now: Date): Promise<CaseRow> {
    const current = await this.locked(tx, id, expectedVersion, now);
    const summary = textOf(input.summary, 'summary', 5, 2000);
    await this.assertDocument(tx, input.documentId, 'response_document_id');
    const after = moveRestrictionCase(this.factsOf(current), { move: 'RECORD_RESPONSE', by: actor, at: now });
    await tx.query("update machvon.restriction_case set status = $2, response_outcome = 'RESPONDED', response_summary = $3, response_document_id = $4::uuid, response_recorded_at = $5::timestamptz, version = version + 1 where id = $1::uuid", [id, after.state, summary, input.documentId ?? null, now.toISOString()]);
    return this.finish(tx, current, 'RECORD_RESPONSE', after.state, actor, null, now);
  }

  /** Closes the window of an answer that did not come: only after it was due (409 `RESTRICTION_RESPONSE_WINDOW_OPEN`). */
  async closeNoResponse(tx: TenantTx, id: string, expectedVersion: number, actor: string, now: Date): Promise<CaseRow> {
    const current = await this.locked(tx, id, expectedVersion, now);
    const after = moveRestrictionCase(this.factsOf(current), { move: 'CLOSE_NO_RESPONSE', by: actor, at: now });
    await tx.query("update machvon.restriction_case set status = $2, response_outcome = 'NO_RESPONSE', response_recorded_at = $3::timestamptz, version = version + 1 where id = $1::uuid", [id, after.state, now.toISOString()]);
    return this.finish(tx, current, 'CLOSE_NO_RESPONSE', after.state, actor, null, now);
  }

  /**
   * The decision of the person with authority (a person other than the proposer). A ban names its months (within the range of its violation groups), its scope, its first day and the decision paper; the last day is
   * counted from them. `decided_late` records whether the decision came after the time limit: a late decision is allowed (the case is not lost) and is a figure and an alert, never a silent pass.
   */
  async decide(tx: TenantTx, id: string, expectedVersion: number, input: DecisionInput, actor: string, now: Date): Promise<CaseRow> {
    const current = await this.locked(tx, id, expectedVersion, now);
    // What takes a contractor out of public procurement is decided by a second person: this is asked before anything about the decision.
    if (actor === current.proposedBy) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    const today = vietnamDateOf(now);
    const reason = textOf(input.reason, 'reason', 10, 2000);
    const policy = (await this.policies.debarment(tx, today)).value;
    const periods = (await this.policies.periods(tx, today)).value;
    let effectiveFrom: string | null = null;
    let until: string | null = null;
    let culpable: string[] = [];
    if (input.decision === 'BAN') {
      if (input.banMonths === undefined || input.scope === undefined || input.effectiveFrom === undefined || input.decisionDocumentId === undefined) throw invalid(input.banMonths === undefined ? 'ban_months' : input.scope === undefined ? 'scope' : input.effectiveFrom === undefined ? 'effective_from' : 'decision_document_id');
      assertBanPeriod(input.banMonths, current.violationGroups, periods, policy);
      effectiveFrom = realDay(input.effectiveFrom, 'effective_from');
      until = banLastDay(effectiveFrom, input.banMonths);
      await this.assertDocument(tx, input.decisionDocumentId, 'decision_document_id');
      culpable = input.culpableMemberIds ?? [];
      if (current.subjectKind === 'JOINT_VENTURE') {
        const members = await this.ventureMembers(tx, current.jointVentureId as string);
        ventureMembersReached(members, current.violationGroups, culpable, policy);
      } else if (culpable.length > 0) throw invalid('culpable_member_ids');
    }
    const after = moveRestrictionCase(this.factsOf(current), { move: 'DECIDE', by: actor, at: now, decision: input.decision, effectiveFrom, banMonths: input.decision === 'BAN' ? (input.banMonths as number) : null });
    const late = now.getTime() > Date.parse(current.decideBy);
    await tx.query(
      `update machvon.restriction_case
          set status = $2, decision = $3, decided_by = $4::uuid, decided_at = $5::timestamptz, decision_reason = $6, decision_document_id = $7::uuid, decision_scope = $8, ban_months = $9, effective_from = $10::date, effective_until = $11::date,
              culpable_member_ids = $12::uuid[], decided_late = $13, ended_by = case when $2 = 'DISMISSED' then $4::uuid else null end, ended_at = case when $2 = 'DISMISSED' then $5::timestamptz else null end, end_reason = case when $2 = 'DISMISSED' then $6 else null end,
              version = version + 1
        where id = $1::uuid`,
      [id, after.state, input.decision, actor, now.toISOString(), reason, input.decisionDocumentId ?? null, input.scope ?? null, input.banMonths ?? null, effectiveFrom, until, culpable, late],
    );
    return this.finish(tx, current, 'DECIDE', after.state, actor, reason, now);
  }

  private async ventureMembers(tx: TenantTx, ventureId: string): Promise<Array<{ contractorId: string; sharePct: string; lead: boolean }>> {
    const rows = await tx.query<{ contractor_id: string; share_pct: string; is_lead: boolean }>('select contractor_id, share_pct::text as share_pct, is_lead from machvon.joint_venture_member where joint_venture_id = $1::uuid order by is_lead desc, contractor_id', [ventureId]);
    return rows.map((row) => ({ contractorId: row.contractor_id, sharePct: row.share_pct, lead: row.is_lead }));
  }

  /**
   * Puts a ban into effect: writes the legal record the gates read for every contractor the case reaches, on a decision paper that is in force (422 `DECISION_DOCUMENT_NOT_EFFECTIVE`), from the first day of the ban
   * (409 `RESTRICTION_NOT_YET_EFFECTIVE` before it). Returns the case and the restrictions written.
   */
  async putIntoEffect(tx: TenantTx, id: string, expectedVersion: number, actor: string, now: Date): Promise<{ row: CaseRow; restrictions: Array<{ restrictionId: string; contractorId: string; effectiveFrom: string; effectiveUntil: string }> }> {
    const current = await this.locked(tx, id, expectedVersion, now);
    const today = vietnamDateOf(now);
    const after = moveRestrictionCase(this.factsOf(current), { move: 'PUT_INTO_EFFECT', by: actor, at: now, today });
    await this.assertDocument(tx, current.decisionDocumentId ?? undefined, 'decision_document_id', true);
    const policy = (await this.policies.debarment(tx, today)).value;
    const reached =
      current.subjectKind === 'CONTRACTOR'
        ? [current.contractorId as string]
        : ventureMembersReached(await this.ventureMembers(tx, current.jointVentureId as string), current.violationGroups, current.culpableMemberIds, policy);
    const written: Array<{ restrictionId: string; contractorId: string; effectiveFrom: string; effectiveUntil: string }> = [];
    for (const contractorId of reached) {
      const restrictionId = randomUUID();
      await tx.query(
        `insert into machvon.contractor_restriction (tenant_id, id, contractor_id, kind, source, effective_from, effective_until, decision_document_id, note, created_by, updated_by, case_id)
         values (${TENANT}, $1::uuid, $2::uuid, 'DEBARMENT', 'DECISION', $3::date, $4::date, $5::uuid, $6, $7::uuid, $7::uuid, $8::uuid)`,
        [restrictionId, contractorId, current.effectiveFrom, current.effectiveUntil, current.decisionDocumentId, `Case ${current.caseNo}, scope ${current.decisionScope}`, actor, id],
      );
      await tx.query(`insert into machvon.restriction_case_member (tenant_id, id, case_id, contractor_id, restriction_id) values (${TENANT}, gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid)`, [id, contractorId, restrictionId]);
      written.push({ restrictionId, contractorId, effectiveFrom: current.effectiveFrom as string, effectiveUntil: current.effectiveUntil as string });
    }
    await tx.query('update machvon.restriction_case set status = $2, effect_by = $3::uuid, effect_at = $4::timestamptz, version = version + 1 where id = $1::uuid', [id, after.state, actor, now.toISOString()]);
    return { row: await this.finish(tx, current, 'PUT_INTO_EFFECT', after.state, actor, null, now), restrictions: written };
  }

  /** Lifts a decision (an appeal that succeeded, a decision withdrawn): every restriction row of the case is marked lifted, so none blocks any more, even on its first day. A reason of 10 characters. */
  async lift(tx: TenantTx, id: string, expectedVersion: number, input: { reason: string; documentId?: string | undefined }, actor: string, now: Date): Promise<CaseRow> {
    const current = await this.locked(tx, id, expectedVersion, now);
    const reason = textOf(input.reason, 'reason', 10, 2000);
    await this.assertDocument(tx, input.documentId, 'lift_document_id');
    const after = moveRestrictionCase(this.factsOf(current), { move: 'LIFT', by: actor, at: now });
    await tx.query('update machvon.contractor_restriction set lifted_at = $2::timestamptz, lifted_by = $3::uuid, lift_reason = $4 where case_id = $1::uuid and lifted_at is null', [id, now.toISOString(), actor, reason]);
    await tx.query('update machvon.restriction_case set status = $2, ended_by = $3::uuid, ended_at = $4::timestamptz, end_reason = $5, lift_document_id = $6::uuid, version = version + 1 where id = $1::uuid', [id, after.state, actor, now.toISOString(), reason, input.documentId ?? null]);
    return this.finish(tx, current, 'LIFT', after.state, actor, reason, now);
  }

  /** Withdraws a case that is not decided (the proposal was wrong or is dropped), with a reason; the case ends as DISMISSED. */
  async withdraw(tx: TenantTx, id: string, expectedVersion: number, reason: string, actor: string, now: Date): Promise<CaseRow> {
    const current = await this.locked(tx, id, expectedVersion, now);
    const why = textOf(reason, 'reason', 10, 2000);
    const after = moveRestrictionCase(this.factsOf(current), { move: 'WITHDRAW', by: actor, at: now });
    await tx.query('update machvon.restriction_case set status = $2, ended_by = $3::uuid, ended_at = $4::timestamptz, end_reason = $5, version = version + 1 where id = $1::uuid', [id, after.state, actor, now.toISOString(), why]);
    return this.finish(tx, current, 'WITHDRAW', after.state, actor, why, now);
  }

  /** The job: bans whose last day has passed end as EXPIRED. Returns the cases ended. */
  async expireDue(tx: TenantTx, actor: string, now: Date): Promise<string[]> {
    const today = vietnamDateOf(now);
    const due = await tx.query<{ id: string; version: string }>("select id, version::text as version from machvon.restriction_case where status = 'EFFECTIVE' and effective_until < $1::date for update", [today]);
    const ended: string[] = [];
    for (const row of due) {
      const current = await this.require(tx, row.id, now);
      const after = moveRestrictionCase(this.factsOf(current), { move: 'EXPIRE', by: actor, at: now, today, effectiveUntil: current.effectiveUntil });
      await tx.query("update machvon.restriction_case set status = $2, ended_by = $3::uuid, ended_at = $4::timestamptz, end_reason = 'The ban ran its course', version = version + 1 where id = $1::uuid", [row.id, after.state, actor, now.toISOString()]);
      await this.log(tx, row.id, 'EXPIRE', current.status, after.state, actor, null);
      ended.push(row.id);
    }
    return ended;
  }

  /** Every restriction row of a contractor, the latest start first, with the case it came from and whether it is in force on the day (a lifted one never is). */
  async restrictionLines(tx: TenantTx, contractorId: string, today: string): Promise<Array<{ id: string; kind: string; source: string; effectiveFrom: string; effectiveUntil: string | null; decisionDocumentId: string | null; caseId: string | null; lifted: boolean; inForce: boolean }>> {
    const rows = await tx.query<{ id: string; kind: string; source: string; effective_from: string; effective_until: string | null; decision_document_id: string | null; case_id: string | null; lifted: boolean; in_force: boolean }>(
      `select id, kind, source, effective_from::text as effective_from, effective_until::text as effective_until, decision_document_id, case_id, lifted_at is not null as lifted,
              (lifted_at is null and effective_from <= $2::date and (effective_until is null or effective_until >= $2::date)) as in_force
         from machvon.contractor_restriction where contractor_id = $1::uuid order by effective_from desc, created_at desc, id desc`,
      [contractorId, today],
    );
    return rows.map((row) => ({ id: row.id, kind: row.kind, source: row.source, effectiveFrom: row.effective_from, effectiveUntil: row.effective_until, decisionDocumentId: row.decision_document_id, caseId: row.case_id, lifted: row.lifted, inForce: row.in_force }));
  }

  /** How many bans in force a contractor holds and the wider ban that suggests (Điều 133): the suggestion is for the authority and decides nothing. */
  async escalation(tx: TenantTx, contractorId: string, now: Date): Promise<{ decisionsInForce: number; suggestion: EscalationSuggestion }> {
    const today = vietnamDateOf(now);
    const policy = (await this.policies.debarment(tx, today)).value;
    const [row] = await tx.query<{ n: number }>(
      `select count(distinct k.id)::int as n from machvon.restriction_case k join machvon.restriction_case_member m on m.tenant_id = k.tenant_id and m.case_id = k.id
        where m.contractor_id = $1::uuid and k.status = 'EFFECTIVE' and k.decision = 'BAN' and k.effective_until >= $2::date`,
      [contractorId, today],
    );
    const decisionsInForce = row?.n ?? 0;
    return { decisionsInForce, suggestion: escalationSuggestion(decisionsInForce, policy) };
  }

  /** The cases that raise an alert now: open and past the decision limit, or within the reminder window. */
  async alertable(tx: TenantTx, now: Date): Promise<CaseRow[]> {
    const open = await this.list(tx, { open: true, limit: 500 }, now);
    return open.filter((row) => (row.status === 'PROPOSED' || row.status === 'NOTICE_SENT' || row.status === 'RESPONSE_RECEIVED') && (row.clock === 'DUE_SOON' || row.clock === 'OVERDUE'));
  }

  /** Figures of the register for the indicators: the cases decided on time against the cases decided or past the limit. */
  async figures(tx: TenantTx, now: Date): Promise<{ decidedInTime: number; decidedLate: number; overdueOpen: number; open: number }> {
    const [row] = await tx.query<{ in_time: number; late: number; overdue: number; open: number }>(
      `select count(*) filter (where decided_late = false)::int as in_time, count(*) filter (where decided_late = true)::int as late,
              count(*) filter (where status in ('PROPOSED', 'NOTICE_SENT', 'RESPONSE_RECEIVED') and decide_by < $1::timestamptz)::int as overdue,
              count(*) filter (where status in ('PROPOSED', 'NOTICE_SENT', 'RESPONSE_RECEIVED', 'DECIDED'))::int as open
         from machvon.restriction_case`,
      [now.toISOString()],
    );
    return { decidedInTime: row?.in_time ?? 0, decidedLate: row?.late ?? 0, overdueOpen: row?.overdue ?? 0, open: row?.open ?? 0 };
  }
}
