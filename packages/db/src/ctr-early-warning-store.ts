import { createHash, randomUUID } from 'node:crypto';
import {
  DomainError,
  assertIssueDay,
  claimTextOf,
  earlyWarningClocks,
  earlyWarningSummary,
  isEwOpen,
  issueKindOf,
  registerIssueText,
  statusAfterAction,
  statusAfterAssessment,
  validateAction,
  validateAssessment,
  validateClosure,
  validateMeeting,
  validateNewWarning,
  versionConflict,
  vietnamDateOf,
} from '@machvon/kernel';
import type {
  ActionInput,
  AssessmentInput,
  ClosureInput,
  EwActionStatus,
  EwCategory,
  EwIssueKind,
  EwLikelihood,
  EwMaterialisedInto,
  EwParty,
  EwReviewOutcome,
  EwStatus,
  MeetingFacts,
  MeetingInput,
  NewWarningInput,
  RegisterClocks,
  WarningFacts,
  WarningSummary,
} from '@machvon/kernel';
import { SCOPE_FROM, TIMESTAMP } from './ctr-contract-store.ts';
import type { ContractPlace, ContractScopes } from './ctr-contract-store.ts';
import { CtrContractSource } from './ctr-contract-source.ts';
import { CtrRegisterPolicy } from './ctr-register-policy.ts';
import type { PolicyBasis } from './ctr-register-policy.ts';
import { lockRegisterContract, lockScopedRow, readRegisterContract, reachOfRow } from './ctr-register-scope.ts';
import { HomeWorkCalendars, WORK_CALENDAR_CODE } from './home-work-clock-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A contract that never began, or was cancelled, keeps no early-warning register. */
const NO_REGISTER_STATES: readonly string[] = ['DRAFT', 'IN_REVIEW', 'CANCELLED'];
export const WARNING_REGISTER_LIMIT = 2000;
const ACTION_LIMIT = 5000;

export interface EarlyWarningRow {
  id: string;
  contractId: string;
  contractCode: string;
  projectId: string;
  code: string;
  title: string;
  description: string;
  category: EwCategory;
  raisedByParty: EwParty;
  raisedBy: string;
  raisedOn: string;
  status: EwStatus;
  likelihood: EwLikelihood | null;
  ownerMembershipId: string | null;
  expectedTimeDays: number | null;
  expectedCostVnd: string | null;
  noImpactExpected: boolean;
  assessedBy: string | null;
  assessedAt: string | null;
  closedBy: string | null;
  closedAt: string | null;
  closedReason: string | null;
  changeRequestId: string | null;
  claimId: string | null;
  openActions: number;
  overdueActions: number;
  version: number;
  createdAt: string;
  reach: ContractPlace;
}

interface WarningSql {
  id: string;
  contract_id: string;
  contract_code: string;
  project_id: string;
  code: string;
  title: string;
  description: string;
  category: EwCategory;
  raised_by_party: EwParty;
  raised_by: string;
  raised_on: string;
  status: EwStatus;
  likelihood: EwLikelihood | null;
  owner_membership_id: string | null;
  expected_time_days: number | null;
  expected_cost_vnd: string | null;
  no_impact_expected: boolean;
  assessed_by: string | null;
  assessed_at: string | null;
  closed_by: string | null;
  closed_at: string | null;
  closed_reason: string | null;
  change_request_id: string | null;
  claim_id: string | null;
  open_actions: string;
  overdue_actions: string;
  version: string;
  created_at: string;
  owner_unit_id: string;
  owner_unit_path: string;
  investor_unit_id: string | null;
  investor_unit_path: string | null;
}

/** `$today` is the Vietnam day the overdue actions are counted on (a parameter of the statement, so the reading is the one of the caller's clock). */
const columns = (today: string): string => `w.id, w.contract_id, c.code as contract_code, p.id as project_id, w.code, w.title, w.description, w.category, w.raised_by_party, w.raised_by, w.raised_on::text as raised_on,
  w.status, w.likelihood, w.owner_membership_id, w.expected_time_days, w.expected_cost_vnd::text as expected_cost_vnd, w.no_impact_expected, w.assessed_by, ${TIMESTAMP('w.assessed_at')} as assessed_at,
  w.closed_by, ${TIMESTAMP('w.closed_at')} as closed_at, w.closed_reason, w.change_request_id, w.claim_id,
  (select count(*) from machvon.contract_early_warning_action a where a.tenant_id = w.tenant_id and a.warning_id = w.id and a.status = 'OPEN')::text as open_actions,
  (select count(*) from machvon.contract_early_warning_action a where a.tenant_id = w.tenant_id and a.warning_id = w.id and a.status = 'OPEN' and a.due_on < ${today}::date)::text as overdue_actions,
  w.version::text as version, ${TIMESTAMP('w.created_at')} as created_at, ou.id as owner_unit_id, ou.path as owner_unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path`;

export const WARNING_FROM = `machvon.contract_early_warning w join ${SCOPE_FROM} on c.tenant_id = w.tenant_id and c.id = w.contract_id`;

const warningOf = (row: WarningSql): EarlyWarningRow => ({
  id: row.id,
  contractId: row.contract_id,
  contractCode: row.contract_code,
  projectId: row.project_id,
  code: row.code,
  title: row.title,
  description: row.description,
  category: row.category,
  raisedByParty: row.raised_by_party,
  raisedBy: row.raised_by,
  raisedOn: row.raised_on,
  status: row.status,
  likelihood: row.likelihood,
  ownerMembershipId: row.owner_membership_id,
  expectedTimeDays: row.expected_time_days,
  expectedCostVnd: row.expected_cost_vnd,
  noImpactExpected: row.no_impact_expected,
  assessedBy: row.assessed_by,
  assessedAt: row.assessed_at,
  closedBy: row.closed_by,
  closedAt: row.closed_at,
  closedReason: row.closed_reason,
  changeRequestId: row.change_request_id,
  claimId: row.claim_id,
  openActions: Number(row.open_actions),
  overdueActions: Number(row.overdue_actions),
  version: Number(row.version),
  createdAt: row.created_at,
  reach: reachOfRow(row.contract_id, row),
});

export const warningFactsOf = (row: EarlyWarningRow): WarningFacts => ({
  id: row.id,
  code: row.code,
  status: row.status,
  category: row.category,
  raisedByParty: row.raisedByParty,
  likelihood: row.likelihood,
  ownerMembershipId: row.ownerMembershipId,
  expectedTimeDays: row.expectedTimeDays,
  expectedCostVnd: row.expectedCostVnd,
  noImpactExpected: row.noImpactExpected,
  openActions: row.openActions,
  overdueActions: row.overdueActions,
  raisedOn: row.raisedOn,
  version: row.version,
});

export interface EarlyWarningActionRow {
  id: string;
  warningId: string;
  description: string;
  ownerMembershipId: string;
  dueOn: string;
  status: EwActionStatus;
  doneOn: string | null;
  doneBy: string | null;
  doneNote: string | null;
  overdue: boolean;
  version: number;
}

interface ActionSql {
  id: string;
  warning_id: string;
  description: string;
  owner_membership_id: string;
  due_on: string;
  status: EwActionStatus;
  done_on: string | null;
  done_by: string | null;
  done_note: string | null;
  version: string;
}

const ACTION_COLUMNS = `a.id, a.warning_id, a.description, a.owner_membership_id, a.due_on::text as due_on, a.status, a.done_on::text as done_on, a.done_by, a.done_note, a.version::text as version`;

const actionOf = (row: ActionSql, today: string): EarlyWarningActionRow => ({
  id: row.id,
  warningId: row.warning_id,
  description: row.description,
  ownerMembershipId: row.owner_membership_id,
  dueOn: row.due_on,
  status: row.status,
  doneOn: row.done_on,
  doneBy: row.done_by,
  doneNote: row.done_note,
  overdue: row.status === 'OPEN' && row.due_on < today,
  version: Number(row.version),
});

export interface EarlyWarningMeetingRow {
  id: string;
  ordinal: number;
  heldOn: string;
  attendees: string;
  notes: string | null;
  minutesDocumentVersionId: string | null;
  recordedBy: string;
  /** The day the register was issued again for this meeting; null while it was not. */
  reissuedOn: string | null;
  issueId: string | null;
  reviews: Array<{ warningId: string; warningCode: string; outcome: EwReviewOutcome; note: string | null; statusAtMeeting: string }>;
}

export interface EarlyWarningIssueRow {
  id: string;
  ordinal: number;
  kind: EwIssueKind;
  issuedOn: string;
  meetingId: string | null;
  warningCount: number;
  openCount: number;
  contentHash: string;
  issuedBy: string;
}

export interface EarlyWarningMove {
  id: string;
  code: string;
  contractId: string;
  contractCode: string;
  projectId: string;
  status: EwStatus;
  fromStatus: EwStatus | null;
  version: number;
  ownerMembershipId: string | null;
  materialisedInto: EwMaterialisedInto | null;
  materialisedId: string | null;
  reach: ContractPlace;
}

export interface EarlyWarningActionMove extends EarlyWarningMove {
  actionId: string;
  actionStatus: EwActionStatus;
  actionVersion: number;
  dueOn: string;
}

export interface EarlyWarningMeetingMove {
  id: string;
  ordinal: number;
  contractId: string;
  contractCode: string;
  projectId: string;
  heldOn: string;
  reviewed: number;
  reach: ContractPlace;
}

export interface EarlyWarningIssueMove {
  id: string;
  ordinal: number;
  kind: EwIssueKind;
  contractId: string;
  contractCode: string;
  projectId: string;
  issuedOn: string;
  meetingId: string | null;
  warningCount: number;
  openCount: number;
  contentHash: string;
  reach: ContractPlace;
}

export interface EarlyWarningFilter {
  contractId?: string | undefined;
  status?: EwStatus | undefined;
  /** Only warnings that are not closed. */
  open?: boolean | undefined;
  category?: EwCategory | undefined;
  raisedByParty?: EwParty | undefined;
  ownerMembershipId?: string | undefined;
}

export interface EarlyWarningPage {
  rows: EarlyWarningRow[];
  nextCursor: string | null;
  summary: WarningSummary;
  truncated: boolean;
  asOf: string;
}

export interface EarlyWarningDetail {
  row: EarlyWarningRow;
  actions: EarlyWarningActionRow[];
  reviews: Array<{ meetingId: string; heldOn: string; outcome: EwReviewOutcome; note: string | null; statusAtMeeting: string }>;
}

export interface EarlyWarningRegisterView {
  contract: { id: string; code: string; status: string; effectiveFrom: string | null };
  clocks: RegisterClocks;
  meetings: EarlyWarningMeetingRow[];
  issues: EarlyWarningIssueRow[];
  summary: WarningSummary;
  /** The policy that sets the rhythm: its source, its day and whether anybody confirmed it. */
  policy: PolicyBasis & { initialIssueWithinDays: number; meetingEveryDays: number; reissueWithinDaysAfterMeeting: number; approachDays: number; basis: string };
  calendarPublished: boolean;
  asOf: string;
}

/**
 * The early-warning register of a contract (G1-15, `docs/ctr-early-warning.md`): the warnings the parties raise, their assessment (owner, likelihood, expected time and cost impact), the mitigation actions with a
 * person and a due day, the meetings that review the register and the issues of the register. The rhythm (first issue, meeting, re-issue) comes from the rule `EARLY_WARNING_POLICY` and is read by the kernel on
 * the day the register is read. A warning closed as resolved is not closed by the person who answers for it; one that came true names the change order or the claim it became.
 */
export class CtrEarlyWarningStore {
  private readonly policy = new CtrRegisterPolicy();
  private readonly calendars = new HomeWorkCalendars();
  private readonly source = new CtrContractSource();

  // ---- commands on warnings -----------------------------------------------------------------------------------------------

  async raise(tx: TenantTx, contractId: string, input: NewWarningInput, actor: string, scopes: ContractScopes, now: Date): Promise<EarlyWarningMove> {
    const contract = await lockRegisterContract(tx, contractId, scopes);
    if (NO_REGISTER_STATES.includes(contract.status)) throw new DomainError('CONTRACT_STATE_INVALID', 409);
    const warning = validateNewWarning(input, vietnamDateOf(now));
    const numbered = await tx.query<{ next: string }>('select (coalesce(max(substr(code, 4)::int), 0) + 1)::text as next from machvon.contract_early_warning where contract_id = $1::uuid', [contractId]);
    const code = `EW-${String(Number(numbered[0]?.next ?? '1')).padStart(3, '0')}`;
    const id = randomUUID();
    await tx.query(
      `insert into machvon.contract_early_warning (tenant_id, id, contract_id, code, title, description, category, raised_by_party, raised_by, raised_on, status)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::uuid, $9::date, 'RAISED')`,
      [id, contractId, code, warning.title, warning.description, warning.category, warning.raisedByParty, actor, warning.raisedOn],
    );
    return { id, code, contractId, contractCode: contract.code, projectId: contract.reach.projectId, status: 'RAISED', fromStatus: null, version: 1, ownerMembershipId: null, materialisedInto: null, materialisedId: null, reach: contract.reach };
  }

  /** Assesses a warning: the person who answers for it, the likelihood and the expected impact on time and cost (a figure or an explicit "no impact"); can be repeated while the warning is open. */
  async assess(tx: TenantTx, id: string, expectedVersion: number, input: AssessmentInput, actor: string, scopes: ContractScopes, now: Date): Promise<EarlyWarningMove> {
    const held = await this.lock(tx, id, scopes, now);
    if (held.version !== expectedVersion) throw versionConflict(held.version);
    const status = statusAfterAssessment(held.status);
    const assessment = validateAssessment(input);
    if (!(await this.isMember(tx, assessment.ownerMembershipId))) throw new DomainError('VALIDATION_FAILED', 422, 'owner_membership_id');
    const version = held.version + 1;
    await tx.query(
      `update machvon.contract_early_warning set status = $2, likelihood = $3, owner_membership_id = $4::uuid, expected_time_days = $5, expected_cost_vnd = $6::numeric, no_impact_expected = $7,
         assessed_by = $8::uuid, assessed_at = $9::timestamptz, version = $10, updated_at = now() where id = $1::uuid`,
      [id, status, assessment.likelihood, assessment.ownerMembershipId, assessment.expectedTimeDays, assessment.expectedCostVnd, assessment.noImpactExpected, actor, now.toISOString(), version],
    );
    return { ...this.moveOf(held, status, version), ownerMembershipId: assessment.ownerMembershipId };
  }

  /** Agrees a mitigation action on an assessed warning; the first action makes it MITIGATING. */
  async addAction(tx: TenantTx, id: string, input: ActionInput, actor: string, scopes: ContractScopes, now: Date): Promise<EarlyWarningActionMove> {
    const held = await this.lock(tx, id, scopes, now);
    const status = statusAfterAction(held.status);
    const action = validateAction(input, vietnamDateOf(now));
    if (!(await this.isMember(tx, action.ownerMembershipId))) throw new DomainError('VALIDATION_FAILED', 422, 'owner_membership_id');
    const actionId = randomUUID();
    await tx.query(
      `insert into machvon.contract_early_warning_action (tenant_id, id, warning_id, description, owner_membership_id, due_on, created_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4::uuid, $5::date, $6::uuid)`,
      [actionId, id, action.description, action.ownerMembershipId, action.dueOn, actor],
    );
    let version = held.version;
    if (status !== held.status) {
      version += 1;
      await tx.query('update machvon.contract_early_warning set status = $2, version = $3, updated_at = now() where id = $1::uuid', [id, status, version]);
    }
    return { ...this.moveOf(held, status, version), actionId, actionStatus: 'OPEN', actionVersion: 1, dueOn: action.dueOn };
  }

  /** Ends an action: DONE with what was done, or CANCELLED with why; the action keeps its words, its owner and its day (the database refuses to change them). */
  async completeAction(tx: TenantTx, actionId: string, expectedVersion: number, outcome: unknown, note: unknown, actor: string, scopes: ContractScopes, now: Date): Promise<EarlyWarningActionMove> {
    const found = await lockScopedRow<ActionSql & { warning_version: string }>(
      tx,
      { columns: `${ACTION_COLUMNS}, w.version::text as warning_version`, from: `machvon.contract_early_warning_action a join machvon.contract_early_warning w on w.tenant_id = a.tenant_id and w.id = a.warning_id join ${SCOPE_FROM} on c.tenant_id = w.tenant_id and c.id = w.contract_id`, alias: 'a', id: actionId },
      scopes,
    );
    if (Number(found.version) !== expectedVersion) throw versionConflict(Number(found.version));
    if (found.status !== 'OPEN') throw new DomainError('EARLY_WARNING_STATE_INVALID', 409, 'status');
    if (outcome !== 'DONE' && outcome !== 'CANCELLED') throw new DomainError('VALIDATION_FAILED', 422, 'outcome');
    const text = claimTextOf(note, 'note');
    // An action that was left open when its warning was withdrawn or came true can still be ended: nothing is left that nobody can resolve.
    const held = await this.lock(tx, found.warning_id, scopes, now);
    const today = vietnamDateOf(now);
    const version = Number(found.version) + 1;
    await tx.query('update machvon.contract_early_warning_action set status = $2, done_on = $3::date, done_by = $4::uuid, done_note = $5, version = $6, updated_at = now() where id = $1::uuid', [actionId, outcome, today, actor, text, version]);
    return { ...this.moveOf(held, held.status, held.version), actionId, actionStatus: outcome, actionVersion: version, dueOn: found.due_on };
  }

  /** Closes a warning: resolved (no open action, and not by the person who answers for it), come true (naming the change order or claim of the contract it became) or withdrawn. */
  async close(tx: TenantTx, id: string, expectedVersion: number, input: ClosureInput, actor: string, scopes: ContractScopes, now: Date): Promise<EarlyWarningMove> {
    const held = await this.lock(tx, id, scopes, now);
    if (held.version !== expectedVersion) throw versionConflict(held.version);
    const closure = validateClosure(input, held.status, held.openActions, held.ownerMembershipId, actor);
    if (closure.materialisedInto !== null) await this.assertMaterialised(tx, held.contractId, closure.materialisedInto, closure.materialisedId as string);
    const version = held.version + 1;
    await tx.query(
      `update machvon.contract_early_warning set status = $2, closed_by = $3::uuid, closed_at = $4::timestamptz, closed_reason = $5,
         change_request_id = $6::uuid, claim_id = $7::uuid, version = $8, updated_at = now() where id = $1::uuid`,
      [id, closure.status, actor, now.toISOString(), closure.reason, closure.materialisedInto === 'CHANGE_REQUEST' ? closure.materialisedId : null, closure.materialisedInto === 'CLAIM' ? closure.materialisedId : null, version],
    );
    return { ...this.moveOf(held, closure.status, version), materialisedInto: closure.materialisedInto, materialisedId: closure.materialisedId };
  }

  // ---- commands on the register -------------------------------------------------------------------------------------------

  /** Records a meeting that reviewed the register: every warning open on the day is named once with what the meeting concluded. */
  async recordMeeting(tx: TenantTx, contractId: string, input: MeetingInput & { minutesDocumentVersionId?: string | undefined }, actor: string, scopes: ContractScopes, now: Date): Promise<EarlyWarningMeetingMove> {
    const contract = await lockRegisterContract(tx, contractId, scopes);
    if (NO_REGISTER_STATES.includes(contract.status)) throw new DomainError('CONTRACT_STATE_INVALID', 409);
    const today = vietnamDateOf(now);
    const open = await tx.query<{ id: string; status: string }>("select id, status from machvon.contract_early_warning where contract_id = $1::uuid and status in ('RAISED', 'ASSESSED', 'MITIGATING') for share", [contractId]);
    const last = await tx.query<{ held_on: string | null; ordinal: number | null }>('select max(held_on)::text as held_on, max(ordinal) as ordinal from machvon.contract_early_warning_meeting where contract_id = $1::uuid', [contractId]);
    const meeting = validateMeeting(input, open.map((row) => row.id), today, contract.effectiveFrom, last[0]?.held_on ?? null);
    const minutes = input.minutesDocumentVersionId?.toLowerCase();
    if (minutes !== undefined && !(UUID.test(minutes) && (await this.source.cleanDocumentVersionExists(tx, minutes)))) throw new DomainError('VALIDATION_FAILED', 422, 'minutes_document_version_id');
    const statusOf = new Map(open.map((row) => [row.id, row.status]));
    const id = randomUUID();
    const ordinal = (last[0]?.ordinal ?? 0) + 1;
    await tx.query(
      `insert into machvon.contract_early_warning_meeting (tenant_id, id, contract_id, ordinal, held_on, attendees, notes, minutes_document_version_id, recorded_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4::date, $5, $6, $7::uuid, $8::uuid)`,
      [id, contractId, ordinal, meeting.heldOn, meeting.attendees, meeting.notes, minutes ?? null, actor],
    );
    for (const review of meeting.reviews) {
      await tx.query(
        `insert into machvon.contract_early_warning_review (tenant_id, id, meeting_id, warning_id, outcome, note, status_at_meeting)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5)`,
        [id, review.warningId, review.outcome, review.note, statusOf.get(review.warningId)],
      );
    }
    return { id, ordinal, contractId, contractCode: contract.code, projectId: contract.reach.projectId, heldOn: meeting.heldOn, reviewed: meeting.reviews.length, reach: contract.reach };
  }

  /**
   * Issues the register: the first issue after the contract starts (INITIAL), the one that follows a meeting (AFTER_MEETING: `meetingId`, one per meeting) or another (PERIODIC). The warnings of the contract at
   * that moment are kept as a snapshot with its hash, so what was issued on a day can be read back as it was.
   */
  async issueRegister(tx: TenantTx, contractId: string, input: { issuedOn?: unknown; meetingId?: unknown }, actor: string, scopes: ContractScopes, now: Date): Promise<EarlyWarningIssueMove> {
    const contract = await lockRegisterContract(tx, contractId, scopes);
    if (NO_REGISTER_STATES.includes(contract.status)) throw new DomainError('CONTRACT_STATE_INVALID', 409);
    const today = vietnamDateOf(now);
    let meetingHeldOn: string | null = null;
    let meetingId: string | null = null;
    if (input.meetingId !== undefined && input.meetingId !== null) {
      const wanted = typeof input.meetingId === 'string' ? input.meetingId.toLowerCase() : '';
      const meeting = UUID.test(wanted)
        ? await tx.query<{ id: string; held_on: string; issued: boolean }>(
            'select m.id, m.held_on::text as held_on, exists (select 1 from machvon.contract_early_warning_issue i where i.tenant_id = m.tenant_id and i.meeting_id = m.id) as issued from machvon.contract_early_warning_meeting m where m.id = $1::uuid and m.contract_id = $2::uuid',
            [wanted, contractId],
          )
        : [];
      if (meeting[0] === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'meeting_id');
      if (meeting[0].issued) throw new DomainError('EARLY_WARNING_STATE_INVALID', 409, 'meeting_id');
      meetingId = meeting[0].id;
      meetingHeldOn = meeting[0].held_on;
    }
    const issuedOn = assertIssueDay(input.issuedOn === undefined ? today : input.issuedOn, today, contract.effectiveFrom, meetingHeldOn);
    const rows = await this.warningsOf(tx, contractId, today);
    const facts = rows.map(warningFactsOf);
    const hash = createHash('sha256').update(registerIssueText(facts)).digest('hex');
    const counted = await tx.query<{ n: number }>('select coalesce(max(ordinal), 0) as n from machvon.contract_early_warning_issue where contract_id = $1::uuid', [contractId]);
    const ordinal = (counted[0]?.n ?? 0) + 1;
    const kind = issueKindOf(ordinal - 1, meetingId);
    const id = randomUUID();
    const open = facts.filter((row) => isEwOpen(row.status)).length;
    await tx.query(
      `insert into machvon.contract_early_warning_issue (tenant_id, id, contract_id, ordinal, kind, issued_on, meeting_id, warning_count, open_count, content_hash, snapshot, issued_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4, $5::date, $6::uuid, $7, $8, $9, $10::jsonb, $11::uuid)`,
      [id, contractId, ordinal, kind, issuedOn, meetingId, facts.length, open, hash, JSON.stringify(facts), actor],
    );
    return { id, ordinal, kind, contractId, contractCode: contract.code, projectId: contract.reach.projectId, issuedOn, meetingId, warningCount: facts.length, openCount: open, contentHash: hash, reach: contract.reach };
  }

  // ---- reads --------------------------------------------------------------------------------------------------------------

  /** The warnings of a filter inside the read scope, newest first, one page and the summary of all (the same summary the reports read). */
  async list(tx: TenantTx, filter: EarlyWarningFilter, read: ScopeBuilder, page: { limit: number; after?: string | undefined }, now: Date): Promise<EarlyWarningPage> {
    const today = vietnamDateOf(now);
    const values: unknown[] = [today];
    const where: string[] = [];
    const add = (value: unknown, cast = ''): string => {
      values.push(value);
      return `$${values.length}${cast}`;
    };
    const predicate = read(2);
    values.push(...predicate.params);
    where.push(predicate.sql);
    if (filter.contractId !== undefined) where.push(`w.contract_id = ${add(filter.contractId, '::uuid')}`);
    if (filter.status !== undefined) where.push(`w.status = ${add(filter.status)}`);
    if (filter.open === true) where.push("w.status in ('RAISED', 'ASSESSED', 'MITIGATING')");
    if (filter.category !== undefined) where.push(`w.category = ${add(filter.category)}`);
    if (filter.raisedByParty !== undefined) where.push(`w.raised_by_party = ${add(filter.raisedByParty)}`);
    if (filter.ownerMembershipId !== undefined) where.push(`w.owner_membership_id = ${add(filter.ownerMembershipId, '::uuid')}`);
    const fetched = (await tx.query<WarningSql>(`select ${columns('$1')} from ${WARNING_FROM} where ${where.join(' and ')} order by w.created_at desc, w.id desc limit ${WARNING_REGISTER_LIMIT + 1}`, values)).map(warningOf);
    const truncated = fetched.length > WARNING_REGISTER_LIMIT;
    const all = truncated ? fetched.slice(0, WARNING_REGISTER_LIMIT) : fetched;
    const start = page.after === undefined ? 0 : all.findIndex((row) => row.id === page.after) + 1;
    const rows = all.slice(start, start + page.limit);
    const last = rows[rows.length - 1];
    return { rows, nextCursor: last !== undefined && start + page.limit < all.length ? last.id : null, summary: earlyWarningSummary(all.map(warningFactsOf)), truncated, asOf: today };
  }

  /** One warning with its actions and what the meetings concluded about it (404 for a warning outside the read scope). */
  async get(tx: TenantTx, id: string, read: ScopeBuilder, now: Date): Promise<EarlyWarningDetail> {
    const today = vietnamDateOf(now);
    const predicate = read(3);
    const found = await tx.query<WarningSql>(`select ${columns('$2')} from ${WARNING_FROM} where w.id = $1::uuid and ${predicate.sql}`, [id, today, ...predicate.params]);
    if (found[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const actions = await tx.query<ActionSql>(`select ${ACTION_COLUMNS} from machvon.contract_early_warning_action a where a.warning_id = $1::uuid order by a.due_on, a.id limit ${ACTION_LIMIT}`, [id]);
    const reviews = await tx.query<{ meeting_id: string; held_on: string; outcome: EwReviewOutcome; note: string | null; status_at_meeting: string }>(
      `select r.meeting_id, m.held_on::text as held_on, r.outcome, r.note, r.status_at_meeting from machvon.contract_early_warning_review r
         join machvon.contract_early_warning_meeting m on m.tenant_id = r.tenant_id and m.id = r.meeting_id where r.warning_id = $1::uuid order by m.held_on desc`,
      [id],
    );
    return {
      row: warningOf(found[0]),
      actions: actions.map((row) => actionOf(row, today)),
      reviews: reviews.map((row) => ({ meetingId: row.meeting_id, heldOn: row.held_on, outcome: row.outcome, note: row.note, statusAtMeeting: row.status_at_meeting })),
    };
  }

  /** The register of one contract: the three clocks of its rhythm on the day, its meetings with what they concluded, its issues and the summary of its warnings. */
  async register(tx: TenantTx, contractId: string, read: ScopeBuilder, now: Date): Promise<EarlyWarningRegisterView> {
    const today = vietnamDateOf(now);
    const contract = await readRegisterContract(tx, contractId, read);
    const policy = await this.policy.earlyWarning(tx, now);
    const calendars = await this.calendars.load(tx, WORK_CALENDAR_CODE, now);
    const meetings = await this.meetingsOf(tx, contractId);
    const issues = await this.issuesOf(tx, contractId);
    const warnings = await this.warningsOf(tx, contractId, today);
    const latest = meetings[0];
    const latestMeeting: MeetingFacts | null = latest === undefined ? null : { id: latest.id, heldOn: latest.heldOn, reissuedOn: latest.reissuedOn };
    const clocks = earlyWarningClocks(
      { active: contract.status === 'ACTIVE', startOn: contract.effectiveFrom, firstIssueOn: issues.length === 0 ? null : (issues[issues.length - 1] as EarlyWarningIssueRow).issuedOn, lastMeetingOn: latest?.heldOn ?? null, latestMeeting },
      today,
      policy.params,
      calendars,
    );
    return {
      contract: { id: contract.id, code: contract.code, status: contract.status, effectiveFrom: contract.effectiveFrom },
      clocks,
      meetings,
      issues,
      summary: earlyWarningSummary(warnings.map(warningFactsOf)),
      policy: { ...policy.basis, initialIssueWithinDays: policy.params.initialIssueWithinDays, meetingEveryDays: policy.params.meetingEveryDays, reissueWithinDaysAfterMeeting: policy.params.reissueWithinDaysAfterMeeting, approachDays: policy.params.approachDays, basis: policy.params.basis },
      calendarPublished: calendars !== undefined,
      asOf: today,
    };
  }

  // ---- internals ----------------------------------------------------------------------------------------------------------

  private async lock(tx: TenantTx, id: string, scopes: ContractScopes, now: Date): Promise<EarlyWarningRow> {
    const today = vietnamDateOf(now);
    const held = await lockScopedRow<WarningSql>(tx, { columns: columns(`'${today}'`), from: WARNING_FROM, alias: 'w', id }, scopes);
    return warningOf(held);
  }

  private moveOf(held: EarlyWarningRow, status: EwStatus, version: number): EarlyWarningMove {
    return { id: held.id, code: held.code, contractId: held.contractId, contractCode: held.contractCode, projectId: held.projectId, status, fromStatus: held.status, version, ownerMembershipId: held.ownerMembershipId, materialisedInto: null, materialisedId: null, reach: held.reach };
  }

  private async isMember(tx: TenantTx, membershipId: string): Promise<boolean> {
    const rows = await tx.query<{ found: boolean }>('select exists (select 1 from machvon.membership where id = $1::uuid) as found', [membershipId]);
    return rows[0]?.found === true;
  }

  private async assertMaterialised(tx: TenantTx, contractId: string, into: EwMaterialisedInto, id: string): Promise<void> {
    const table = into === 'CHANGE_REQUEST' ? 'machvon.change_request' : 'machvon.contract_claim';
    const found = await tx.query<{ id: string }>(`select id from ${table} where id = $1::uuid and contract_id = $2::uuid`, [id, contractId]);
    if (found[0] === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'materialised_id');
  }

  private async warningsOf(tx: TenantTx, contractId: string, today: string): Promise<EarlyWarningRow[]> {
    const rows = await tx.query<WarningSql>(`select ${columns('$2')} from ${WARNING_FROM} where w.contract_id = $1::uuid order by w.code`, [contractId, today]);
    return rows.map(warningOf);
  }

  /** The meetings of a contract, latest first, with what each concluded and the day the register was issued again for it. */
  private async meetingsOf(tx: TenantTx, contractId: string): Promise<EarlyWarningMeetingRow[]> {
    const meetings = await tx.query<{ id: string; ordinal: number; held_on: string; attendees: string; notes: string | null; minutes_document_version_id: string | null; recorded_by: string; issue_id: string | null; reissued_on: string | null }>(
      `select m.id, m.ordinal, m.held_on::text as held_on, m.attendees, m.notes, m.minutes_document_version_id, m.recorded_by, i.id as issue_id, i.issued_on::text as reissued_on
         from machvon.contract_early_warning_meeting m left join machvon.contract_early_warning_issue i on i.tenant_id = m.tenant_id and i.meeting_id = m.id
        where m.contract_id = $1::uuid order by m.held_on desc, m.id desc`,
      [contractId],
    );
    const reviews = await tx.query<{ meeting_id: string; warning_id: string; warning_code: string; outcome: EwReviewOutcome; note: string | null; status_at_meeting: string }>(
      `select r.meeting_id, r.warning_id, w.code as warning_code, r.outcome, r.note, r.status_at_meeting from machvon.contract_early_warning_review r
         join machvon.contract_early_warning w on w.tenant_id = r.tenant_id and w.id = r.warning_id where w.contract_id = $1::uuid order by w.code`,
      [contractId],
    );
    return meetings.map((row) => ({
      id: row.id,
      ordinal: row.ordinal,
      heldOn: row.held_on,
      attendees: row.attendees,
      notes: row.notes,
      minutesDocumentVersionId: row.minutes_document_version_id,
      recordedBy: row.recorded_by,
      reissuedOn: row.reissued_on,
      issueId: row.issue_id,
      reviews: reviews.filter((review) => review.meeting_id === row.id).map((review) => ({ warningId: review.warning_id, warningCode: review.warning_code, outcome: review.outcome, note: review.note, statusAtMeeting: review.status_at_meeting })),
    }));
  }

  /** The issues of a contract, latest first. */
  private async issuesOf(tx: TenantTx, contractId: string): Promise<EarlyWarningIssueRow[]> {
    const rows = await tx.query<{ id: string; ordinal: number; kind: EwIssueKind; issued_on: string; meeting_id: string | null; warning_count: number; open_count: number; content_hash: string; issued_by: string }>(
      'select id, ordinal, kind, issued_on::text as issued_on, meeting_id, warning_count, open_count, content_hash, issued_by from machvon.contract_early_warning_issue where contract_id = $1::uuid order by ordinal desc',
      [contractId],
    );
    return rows.map((row) => ({ id: row.id, ordinal: row.ordinal, kind: row.kind, issuedOn: row.issued_on, meetingId: row.meeting_id, warningCount: row.warning_count, openCount: row.open_count, contentHash: row.content_hash, issuedBy: row.issued_by }));
  }
}
