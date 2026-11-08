import { randomUUID } from 'node:crypto';
import {
  DomainError,
  assertBarDeclarable,
  assertBarDecider,
  assertSettlementDecider,
  claimAllowedSteps,
  claimDeadlines,
  claimLimitation,
  claimNextStatus,
  claimRegisterReport,
  claimTextOf,
  isClaimOpen,
  validateNewClaim,
  validateRecordedStep,
  versionConflict,
  vietnamDateOf,
} from '@machvon/kernel';
import type {
  ClaimFacts,
  ClaimKind,
  ClaimPolicy,
  ClaimReportInput,
  ClaimReportRow,
  ClaimReportTotals,
  ClaimSide,
  ContractClaimStatus,
  ClaimStepInput,
  ClaimStepKind,
  Deadline,
  Limitation,
  LimitationStatus,
  NewClaimInput,
  RecordedStep,
  ResponseDecision,
} from '@machvon/kernel';
import { CtrClaimTermStore } from './ctr-claim-term-store.ts';
import type { ClaimTermRow } from './ctr-claim-term-store.ts';
import { SCOPE_FROM, TIMESTAMP } from './ctr-contract-store.ts';
import type { ContractPlace, ContractScopes } from './ctr-contract-store.ts';
import { CtrContractSource } from './ctr-contract-source.ts';
import { CtrRegisterPolicy } from './ctr-register-policy.ts';
import type { PolicyBasis } from './ctr-register-policy.ts';
import { lockRegisterContract, lockScopedRow, reachOfRow } from './ctr-register-scope.ts';
import { HomeWorkCalendars, WORK_CALENDAR_CODE } from './home-work-clock-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A contract that never began, or was cancelled, has no claims. */
const NO_CLAIM_STATES: readonly string[] = ['DRAFT', 'IN_REVIEW', 'CANCELLED'];
/** The most claims one register read puts through the kernel at once (a register with more says it is cut). */
export const CLAIM_REGISTER_LIMIT = 2000;

export interface ClaimRow {
  id: string;
  code: string;
  contractId: string;
  contractCode: string;
  projectId: string;
  projectCode: string;
  claimantSide: ClaimSide;
  kind: ClaimKind;
  title: string;
  eventDescription: string;
  eventOn: string;
  awarenessOn: string;
  status: ContractClaimStatus;
  termId: string | null;
  claimedAmountVnd: string | null;
  claimedDays: number | null;
  settledAmountVnd: string | null;
  grantedDays: number | null;
  changeRequestId: string | null;
  changeRequestCode: string | null;
  paymentRequestId: string | null;
  responsibleMembershipId: string | null;
  registeredBy: string;
  noticeOn: string | null;
  particularsOn: string | null;
  lastParticularsOn: string | null;
  responseOn: string | null;
  responseDecision: ResponseDecision | null;
  acceptedOn: string | null;
  lastStepOn: string;
  settlementProposedBy: string | null;
  settlementApprovedBy: string | null;
  settledOn: string | null;
  closedOn: string | null;
  closedBy: string | null;
  stepCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  reach: ContractPlace;
}

interface ClaimSql {
  id: string;
  code: string;
  contract_id: string;
  contract_code: string;
  project_id: string;
  project_code: string;
  claimant_side: ClaimSide;
  kind: ClaimKind;
  title: string;
  event_description: string;
  event_on: string;
  awareness_on: string;
  status: ContractClaimStatus;
  term_id: string | null;
  claimed_amount_vnd: string | null;
  claimed_days: number | null;
  settled_amount_vnd: string | null;
  granted_days: number | null;
  change_request_id: string | null;
  change_request_code: string | null;
  payment_request_id: string | null;
  responsible_membership_id: string | null;
  registered_by: string;
  notice_on: string | null;
  particulars_on: string | null;
  last_particulars_on: string | null;
  response_on: string | null;
  response_decision: ResponseDecision | null;
  accepted_on: string | null;
  last_step_on: string;
  settlement_proposed_by: string | null;
  settlement_approved_by: string | null;
  settled_on: string | null;
  closed_on: string | null;
  closed_by: string | null;
  step_count: number;
  version: string;
  created_at: string;
  updated_at: string;
  owner_unit_id: string;
  owner_unit_path: string;
  investor_unit_id: string | null;
  investor_unit_path: string | null;
  created_key: string;
}

export const CLAIM_FROM = `machvon.contract_claim k join ${SCOPE_FROM} on c.tenant_id = k.tenant_id and c.id = k.contract_id`;

/** The columns of a claim with the contract, the project and the places its scope is judged by. */
export const CLAIM_COLUMNS = `k.id, k.code, k.contract_id, c.code as contract_code, p.id as project_id, p.code as project_code, k.claimant_side, k.kind, k.title, k.event_description, k.event_on::text as event_on,
  k.awareness_on::text as awareness_on, k.status, k.term_id, k.claimed_amount_vnd::text as claimed_amount_vnd, k.claimed_days, k.settled_amount_vnd::text as settled_amount_vnd, k.granted_days,
  k.change_request_id, (select q.code from machvon.change_request q where q.tenant_id = k.tenant_id and q.id = k.change_request_id) as change_request_code, k.payment_request_id,
  k.responsible_membership_id, k.registered_by, k.notice_on::text as notice_on, k.particulars_on::text as particulars_on, k.last_particulars_on::text as last_particulars_on, k.response_on::text as response_on,
  k.response_decision, k.accepted_on::text as accepted_on, k.last_step_on::text as last_step_on, k.settlement_proposed_by, k.settlement_approved_by, k.settled_on::text as settled_on, k.closed_on::text as closed_on,
  k.closed_by, k.step_count, k.version::text as version, ${TIMESTAMP('k.created_at')} as created_at, ${TIMESTAMP('k.updated_at')} as updated_at,
  ou.id as owner_unit_id, ou.path as owner_unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path, to_char(k.created_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS') as created_key`;

export const claimOf = (row: ClaimSql): ClaimRow => ({
  id: row.id,
  code: row.code,
  contractId: row.contract_id,
  contractCode: row.contract_code,
  projectId: row.project_id,
  projectCode: row.project_code,
  claimantSide: row.claimant_side,
  kind: row.kind,
  title: row.title,
  eventDescription: row.event_description,
  eventOn: row.event_on,
  awarenessOn: row.awareness_on,
  status: row.status,
  termId: row.term_id,
  claimedAmountVnd: row.claimed_amount_vnd,
  claimedDays: row.claimed_days,
  settledAmountVnd: row.settled_amount_vnd,
  grantedDays: row.granted_days,
  changeRequestId: row.change_request_id,
  changeRequestCode: row.change_request_code,
  paymentRequestId: row.payment_request_id,
  responsibleMembershipId: row.responsible_membership_id,
  registeredBy: row.registered_by,
  noticeOn: row.notice_on,
  particularsOn: row.particulars_on,
  lastParticularsOn: row.last_particulars_on,
  responseOn: row.response_on,
  responseDecision: row.response_decision,
  acceptedOn: row.accepted_on,
  lastStepOn: row.last_step_on,
  settlementProposedBy: row.settlement_proposed_by,
  settlementApprovedBy: row.settlement_approved_by,
  settledOn: row.settled_on,
  closedOn: row.closed_on,
  closedBy: row.closed_by,
  stepCount: row.step_count,
  version: Number(row.version),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  reach: reachOfRow(row.contract_id, row),
});

/** What the timeline of a claim has done, as the kernel reads it. */
export const factsOf = (row: ClaimRow): ClaimFacts => ({
  claimantSide: row.claimantSide,
  status: row.status,
  awarenessOn: row.awarenessOn,
  noticeOn: row.noticeOn,
  particularsOn: row.particularsOn,
  lastParticularsOn: row.lastParticularsOn,
  responseOn: row.responseOn,
  responseDecision: row.responseDecision,
  acceptedOn: row.acceptedOn,
  settledOn: row.settledOn,
});

export interface ClaimStepRow {
  id: string;
  ordinal: number;
  kind: ClaimStepKind;
  occurredOn: string;
  note: string;
  decision: ResponseDecision | null;
  claimedAmountVnd: string | null;
  claimedDays: number | null;
  settledAmountVnd: string | null;
  grantedDays: number | null;
  evidenceDocumentVersionId: string | null;
  termId: string | null;
  actorId: string;
  createdAt: string;
}

interface StepSql {
  id: string;
  ordinal: number;
  kind: ClaimStepKind;
  occurred_on: string;
  note: string;
  decision: ResponseDecision | null;
  claimed_amount_vnd: string | null;
  claimed_days: number | null;
  settled_amount_vnd: string | null;
  granted_days: number | null;
  evidence_document_version_id: string | null;
  term_id: string | null;
  actor_id: string;
  created_at: string;
}

/** The claim as the register reads it on a day: the row, the term it is bound to, the four deadlines, the limitation and what a person may still do. */
export interface ClaimView {
  row: ClaimRow;
  term: ClaimTermRow | null;
  deadlines: Record<'NOTICE' | 'PARTICULARS' | 'RESPONSE' | 'SETTLEMENT', Deadline>;
  limitation: Limitation;
  /** The steps `recordStep` would accept now, and whether the decision of a settlement and the declaration of a bar are open. */
  allowed: { steps: ClaimStepKind[]; decideSettlement: boolean; declareBar: boolean };
}

export interface ClaimDetail extends ClaimView {
  steps: ClaimStepRow[];
  /** The payment request linked to the claim, as a reader of the claim needs to see it. */
  payment: { id: string; status: string; grossVnd: string; netVnd: string } | null;
  policy: PolicyBasis;
  /** Whether the working calendar was published for the years the counts passed through. */
  calendarPublished: boolean;
}

/** What a command on a claim changed: the facts its audit row and its event carry. */
export interface ClaimMove {
  id: string;
  code: string;
  contractId: string;
  contractCode: string;
  projectId: string;
  claimantSide: ClaimSide;
  kind: ClaimKind;
  status: ContractClaimStatus;
  fromStatus: ContractClaimStatus | null;
  /** The step the command wrote on the timeline; null for a command that writes none (a link). */
  step: ClaimStepKind | null;
  stepOrdinal: number;
  version: number;
  termId: string | null;
  claimedAmountVnd: string | null;
  settledAmountVnd: string | null;
  claimedDays: number | null;
  grantedDays: number | null;
  reach: ContractPlace;
}

export interface ClaimFilter {
  contractId?: string | undefined;
  status?: ContractClaimStatus | undefined;
  claimantSide?: ClaimSide | undefined;
  /** Only claims that are not closed. */
  open?: boolean | undefined;
  limitation?: LimitationStatus | undefined;
  /** The claims the person answers for (the claim handler). */
  responsibleMembershipId?: string | undefined;
}

/** A claim of the register: what the kernel read of it (deadlines, limitation) beside the row it was read from. */
export interface ClaimListItem extends ClaimReportRow {
  claim: ClaimRow;
}

export interface ClaimRegisterPage {
  rows: ClaimListItem[];
  nextCursor: string | null;
  /** Added up over every claim that matches the filter, whatever page was read. */
  totals: ClaimReportTotals;
  /** More claims matched than the register puts through the kernel at once: the totals are then a lower bound. */
  truncated: boolean;
  policy: PolicyBasis;
  calendarPublished: boolean;
  asOf: string;
}

/**
 * The claim register of a contract (G1-9, `docs/ctr-claims.md`). A claim is registered with the day its claimant became aware of the event (the day the notice limit counts from) and is bound to the approved
 * term of its side if the contract has one; each step is a row of an append-only timeline with the day it happened in the contract world, and the dates the limits are counted from are kept on the claim in the same
 * transaction. A settlement is proposed by one person and approved by another; a claim is declared barred only when a limitation day passed, the term says a miss bars the claim, and by somebody other than the
 * person who registered it. The deadlines and the limitation are computed on the day the claim is read, by the kernel, from the term and the dates: nothing about time is stored that could go stale.
 */
export class CtrClaimStore {
  private readonly terms = new CtrClaimTermStore();
  private readonly policy = new CtrRegisterPolicy();
  private readonly calendars = new HomeWorkCalendars();
  private readonly source = new CtrContractSource();

  // ---- commands -----------------------------------------------------------------------------------------------------------

  async register(
    tx: TenantTx,
    contractId: string,
    input: NewClaimInput & { responsibleMembershipId?: string | undefined; evidenceDocumentVersionId?: string | undefined },
    actor: string,
    scopes: ContractScopes,
    now: Date,
  ): Promise<ClaimMove> {
    const contract = await lockRegisterContract(tx, contractId, scopes);
    if (NO_CLAIM_STATES.includes(contract.status)) throw new DomainError('CONTRACT_STATE_INVALID', 409);
    const today = vietnamDateOf(now);
    const claim = validateNewClaim(input, today);
    const responsible = input.responsibleMembershipId?.toLowerCase() ?? actor;
    if (!UUID.test(responsible) || !(await this.isMember(tx, responsible))) throw new DomainError('VALIDATION_FAILED', 422, 'responsible_membership_id');
    const evidence = await this.evidenceOf(tx, input.evidenceDocumentVersionId);
    const term = await this.terms.approved(tx, contractId, claim.claimantSide);
    const numbered = await tx.query<{ next: string }>("select (coalesce(max(substr(code, 5)::int), 0) + 1)::text as next from machvon.contract_claim where contract_id = $1::uuid", [contractId]);
    const code = `CLM-${String(Number(numbered[0]?.next ?? '1')).padStart(3, '0')}`;
    const id = randomUUID();
    await tx.query(
      `insert into machvon.contract_claim (tenant_id, id, contract_id, code, claimant_side, kind, title, event_description, event_on, awareness_on, status, term_id, claimed_amount_vnd, claimed_days,
         responsible_membership_id, registered_by, last_step_on)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::date, $9::date, 'EVENT_RECORDED', $10::uuid, $11::numeric, $12, $13::uuid, $14::uuid, $9::date)`,
      [id, contractId, code, claim.claimantSide, claim.kind, claim.title, claim.eventDescription, claim.eventOn, claim.awarenessOn, term?.id ?? null, claim.claimedAmountVnd, claim.claimedDays, responsible, actor],
    );
    await this.appendStep(tx, { claimId: id, ordinal: 1, kind: 'EVENT', occurredOn: claim.awarenessOn, note: claim.eventDescription, evidence, actor, versionAfter: 1 });
    return {
      id,
      code,
      contractId,
      contractCode: contract.code,
      projectId: contract.reach.projectId,
      claimantSide: claim.claimantSide,
      kind: claim.kind,
      status: 'EVENT_RECORDED',
      fromStatus: null,
      step: 'EVENT',
      stepOrdinal: 1,
      version: 1,
      termId: term?.id ?? null,
      claimedAmountVnd: claim.claimedAmountVnd,
      settledAmountVnd: null,
      claimedDays: claim.claimedDays,
      grantedDays: null,
      reach: contract.reach,
    };
  }

  /** Records a step of the timeline (a notice served, the particulars, a response, a settlement proposal, a withdrawal, a referral), on the day it happened. */
  async recordStep(tx: TenantTx, id: string, expectedVersion: number, input: ClaimStepInput & { evidenceDocumentVersionId?: string | undefined }, actor: string, scopes: ContractScopes, now: Date): Promise<ClaimMove> {
    const held = await this.lock(tx, id, scopes);
    if (held.version !== expectedVersion) throw versionConflict(held.version);
    if (!isClaimOpen(held.status)) throw new DomainError('CTR_CLAIM_STATE_INVALID', 409, 'status');
    const today = vietnamDateOf(now);
    const step = validateRecordedStep(input, { awarenessOn: held.awarenessOn, lastStepOn: held.lastStepOn, claimedAmountVnd: held.claimedAmountVnd, claimedDays: held.claimedDays }, today);
    const next = claimNextStatus(held.status, step.kind, held.responseDecision);
    const evidence = await this.evidenceOf(tx, input.evidenceDocumentVersionId);
    const set = new SetList();
    set.add('status', next);
    set.add('last_step_on', step.occurredOn, 'date');
    this.stepColumns(set, held, step, actor);
    const version = held.version + 1;
    await tx.query(`update machvon.contract_claim set ${set.sql}, step_count = step_count + 1, version = ${set.next(version)}, updated_at = now() where id = ${set.next(id, 'uuid')}`, set.values);
    await this.appendStep(tx, { claimId: id, ordinal: held.stepCount + 1, kind: step.kind, occurredOn: step.occurredOn, note: step.note, decision: step.decision, figures: step.figures, evidence, actor, versionAfter: version });
    return this.moveOf(held, next, step.kind, held.stepCount + 1, version, step);
  }

  /** Decides the settlement a person proposed: APPROVE settles the claim (somebody other than the proposer), REJECT sends it back to the response with words. */
  async decideSettlement(tx: TenantTx, id: string, expectedVersion: number, decision: unknown, note: unknown, actor: string, scopes: ContractScopes, now: Date): Promise<ClaimMove> {
    const held = await this.lock(tx, id, scopes);
    if (held.version !== expectedVersion) throw versionConflict(held.version);
    if (decision !== 'APPROVE' && decision !== 'REJECT') throw new DomainError('VALIDATION_FAILED', 422, 'decision');
    const kind: ClaimStepKind = decision === 'APPROVE' ? 'SETTLEMENT_APPROVED' : 'SETTLEMENT_REJECTED';
    const next = claimNextStatus(held.status, kind, held.responseDecision);
    if (held.settlementProposedBy === null) throw new DomainError('CTR_CLAIM_STATE_INVALID', 409, 'status');
    assertSettlementDecider(held.settlementProposedBy, actor);
    const text = claimTextOf(note, 'note');
    const today = vietnamDateOf(now);
    const version = held.version + 1;
    if (decision === 'APPROVE') {
      await tx.query(
        `update machvon.contract_claim set status = 'SETTLED', settlement_approved_by = $2::uuid, settled_on = $3::date, closed_on = $3::date, closed_by = $2::uuid, last_step_on = $3::date, step_count = step_count + 1, version = $4, updated_at = now() where id = $1::uuid`,
        [id, actor, today, version],
      );
    } else {
      await tx.query(
        `update machvon.contract_claim set status = 'RESPONDED', settled_amount_vnd = null, granted_days = null, settlement_proposed_by = null, last_step_on = $2::date, step_count = step_count + 1, version = $3, updated_at = now() where id = $1::uuid`,
        [id, today, version],
      );
    }
    await this.appendStep(tx, { claimId: id, ordinal: held.stepCount + 1, kind, occurredOn: today, note: text, figures: decision === 'APPROVE' ? { claimedAmountVnd: null, claimedDays: null, settledAmountVnd: held.settledAmountVnd, grantedDays: held.grantedDays } : undefined, actor, versionAfter: version });
    return { ...this.moveOf(held, next, kind, held.stepCount + 1, version, undefined), settledAmountVnd: decision === 'APPROVE' ? held.settledAmountVnd : null, grantedDays: decision === 'APPROVE' ? held.grantedDays : null };
  }

  /**
   * Declares the claim barred (it passed a limitation day and the term says that bars it), with the words of why, by somebody other than the person who registered it. The register never invents a bar: 409
   * `CLAIM_BAR_NOT_DUE` when no limitation day was missed or the term does not say the claim is lost.
   */
  async declareBar(tx: TenantTx, id: string, expectedVersion: number, reason: unknown, evidenceDocumentVersionId: string | undefined, actor: string, scopes: ContractScopes, now: Date): Promise<ClaimMove> {
    const held = await this.lock(tx, id, scopes);
    if (held.version !== expectedVersion) throw versionConflict(held.version);
    const next = claimNextStatus(held.status, 'BAR_DECLARED', held.responseDecision);
    const text = claimTextOf(reason, 'reason');
    assertBarDecider(held.registeredBy, actor);
    const today = vietnamDateOf(now);
    const term = held.termId === null ? null : ((await this.terms.byIds(tx, [held.termId])).get(held.termId)?.term ?? null);
    const policy = await this.policy.claim(tx, now);
    const calendars = await this.calendars.load(tx, WORK_CALENDAR_CODE, now);
    const deadlines = claimDeadlines(factsOf(held), term, today, policy.params.approachDays, calendars);
    assertBarDeclarable(claimLimitation(held.status, term, deadlines));
    const evidence = await this.evidenceOf(tx, evidenceDocumentVersionId);
    const version = held.version + 1;
    await tx.query(
      `update machvon.contract_claim set status = 'TIME_BARRED', closed_on = $2::date, closed_by = $3::uuid, last_step_on = $2::date, step_count = step_count + 1, version = $4, updated_at = now() where id = $1::uuid`,
      [id, today, actor, version],
    );
    await this.appendStep(tx, { claimId: id, ordinal: held.stepCount + 1, kind: 'BAR_DECLARED', occurredOn: today, note: text, evidence, actor, versionAfter: version });
    return this.moveOf(held, next, 'BAR_DECLARED', held.stepCount + 1, version, undefined);
  }

  /** Links the claim to a change order and/or a payment request of the same contract (the links stay when the claim ends: the settlement is paid after it). */
  async link(tx: TenantTx, id: string, expectedVersion: number, links: { changeRequestId?: string | undefined; paymentRequestId?: string | undefined }, scopes: ContractScopes): Promise<ClaimMove> {
    const held = await this.lock(tx, id, scopes);
    if (held.version !== expectedVersion) throw versionConflict(held.version);
    if (links.changeRequestId === undefined && links.paymentRequestId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'change_request_id');
    const changeId = links.changeRequestId?.toLowerCase();
    const paymentId = links.paymentRequestId?.toLowerCase();
    if (changeId !== undefined) {
      const found = UUID.test(changeId) ? await tx.query<{ id: string }>('select id from machvon.change_request where id = $1::uuid and contract_id = $2::uuid', [changeId, held.contractId]) : [];
      if (found[0] === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'change_request_id');
    }
    if (paymentId !== undefined) {
      const found = UUID.test(paymentId) ? await tx.query<{ id: string }>('select id from machvon.payment_request where id = $1::uuid and contract_id = $2::uuid', [paymentId, held.contractId]) : [];
      if (found[0] === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'payment_request_id');
    }
    const version = held.version + 1;
    await tx.query('update machvon.contract_claim set change_request_id = coalesce($2::uuid, change_request_id), payment_request_id = coalesce($3::uuid, payment_request_id), version = $4, updated_at = now() where id = $1::uuid', [id, changeId ?? null, paymentId ?? null, version]);
    return this.moveOf(held, held.status, null, held.stepCount, version, undefined);
  }

  // ---- reads --------------------------------------------------------------------------------------------------------------

  /** One claim with its term, deadlines and limitation on the day, the timeline and what may be done next (404 for a claim outside the read scope). */
  async get(tx: TenantTx, id: string, read: ScopeBuilder, now: Date): Promise<ClaimDetail> {
    const predicate = read(2);
    const rows = await tx.query<ClaimSql>(`select ${CLAIM_COLUMNS} from ${CLAIM_FROM} where k.id = $1::uuid and ${predicate.sql}`, [id, ...predicate.params]);
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const row = claimOf(rows[0]);
    const policy = await this.policy.claim(tx, now);
    const calendars = await this.calendars.load(tx, WORK_CALENDAR_CODE, now);
    const terms = row.termId === null ? new Map<string, ClaimTermRow>() : await this.terms.byIds(tx, [row.termId]);
    const view = claimViewOf(row, row.termId === null ? null : (terms.get(row.termId) ?? null), vietnamDateOf(now), policy.params, calendars);
    const steps = await tx.query<StepSql>(
      `select id, ordinal, kind, occurred_on::text as occurred_on, note, decision, claimed_amount_vnd::text as claimed_amount_vnd, claimed_days, settled_amount_vnd::text as settled_amount_vnd, granted_days,
         evidence_document_version_id, term_id, actor_id, ${TIMESTAMP('created_at')} as created_at from machvon.contract_claim_step where claim_id = $1::uuid order by ordinal`,
      [id],
    );
    const payments = row.paymentRequestId === null ? [] : await tx.query<{ id: string; status: string; gross_vnd: string; net_vnd: string }>('select id, status, gross_vnd::text as gross_vnd, net_vnd::text as net_vnd from machvon.payment_request where id = $1::uuid', [row.paymentRequestId]);
    const payment = payments[0] === undefined ? null : { id: payments[0].id, status: payments[0].status, grossVnd: payments[0].gross_vnd, netVnd: payments[0].net_vnd };
    return {
      ...view,
      steps: steps.map((step) => ({
        id: step.id,
        ordinal: step.ordinal,
        kind: step.kind,
        occurredOn: step.occurred_on,
        note: step.note,
        decision: step.decision,
        claimedAmountVnd: step.claimed_amount_vnd,
        claimedDays: step.claimed_days,
        settledAmountVnd: step.settled_amount_vnd,
        grantedDays: step.granted_days,
        evidenceDocumentVersionId: step.evidence_document_version_id,
        termId: step.term_id,
        actorId: step.actor_id,
        createdAt: step.created_at,
      })),
      payment,
      policy: policy.basis,
      calendarPublished: calendars !== undefined,
    };
  }

  /**
   * The inputs of the claim reports, one per claim of the filter inside the read scope (newest first, at most `CLAIM_REGISTER_LIMIT`): the facts of each timeline, the term it is bound to and the figures. The
   * reports of CA-3 (claims and limitation) read these and nothing else, and the kernel (`claimRegisterReport`, `limitationHorizon`) does the arithmetic.
   */
  async reportInputs(tx: TenantTx, filter: ClaimFilter, read: ScopeBuilder): Promise<{ inputs: ClaimReportInput[]; rows: ClaimRow[]; truncated: boolean }> {
    const values: unknown[] = [];
    const where: string[] = [];
    const add = (value: unknown, cast = ''): string => {
      values.push(value);
      return `$${values.length}${cast}`;
    };
    const predicate = read(1);
    values.push(...predicate.params);
    where.push(predicate.sql);
    if (filter.contractId !== undefined) where.push(`k.contract_id = ${add(filter.contractId, '::uuid')}`);
    if (filter.status !== undefined) where.push(`k.status = ${add(filter.status)}`);
    if (filter.claimantSide !== undefined) where.push(`k.claimant_side = ${add(filter.claimantSide)}`);
    if (filter.open === true) where.push("k.status not in ('SETTLED', 'WITHDRAWN', 'REFERRED', 'TIME_BARRED')");
    if (filter.responsibleMembershipId !== undefined) where.push(`k.responsible_membership_id = ${add(filter.responsibleMembershipId, '::uuid')}`);
    const rows = (await tx.query<ClaimSql>(`select ${CLAIM_COLUMNS} from ${CLAIM_FROM} where ${where.join(' and ')} order by k.created_at desc, k.id desc limit ${CLAIM_REGISTER_LIMIT + 1}`, values)).map(claimOf);
    const truncated = rows.length > CLAIM_REGISTER_LIMIT;
    const kept = truncated ? rows.slice(0, CLAIM_REGISTER_LIMIT) : rows;
    const terms = await this.terms.byIds(tx, [...new Set(kept.map((row) => row.termId).filter((term): term is string => term !== null))]);
    const inputs = kept.map(
      (row): ClaimReportInput => ({
        id: row.id,
        code: row.code,
        contractId: row.contractId,
        contractCode: row.contractCode,
        title: row.title,
        kind: row.kind,
        facts: factsOf(row),
        term: row.termId === null ? null : (terms.get(row.termId)?.term ?? null),
        claimedAmountVnd: row.claimedAmountVnd,
        settledAmountVnd: row.settledAmountVnd,
        claimedDays: row.claimedDays,
        grantedDays: row.grantedDays,
      }),
    );
    return { inputs, rows: kept, truncated };
  }

  /** The register: the claims of a filter with their limitation on the day (a filter on the limitation is applied after the kernel read each claim), one page of them and the totals of all. */
  async list(tx: TenantTx, filter: ClaimFilter, read: ScopeBuilder, page: { limit: number; after?: string | undefined }, now: Date): Promise<ClaimRegisterPage> {
    const policy = await this.policy.claim(tx, now);
    const calendars = await this.calendars.load(tx, WORK_CALENDAR_CODE, now);
    const today = vietnamDateOf(now);
    const { inputs, rows: claimRows, truncated } = await this.reportInputs(tx, filter, read);
    const report = claimRegisterReport(inputs, today, policy.params, calendars);
    const matching = filter.limitation === undefined ? report.rows : report.rows.filter((row) => row.limitation.status === filter.limitation);
    // The totals describe the register that was asked for: with a filter on the limitation, they add up the claims that match it.
    const totals = filter.limitation === undefined ? report.totals : claimRegisterReport(inputs.filter((input) => matching.some((row) => row.id === input.id)), today, policy.params, calendars).totals;
    const start = page.after === undefined ? 0 : matching.findIndex((row) => row.id === page.after) + 1;
    const byId = new Map(claimRows.map((claim) => [claim.id, claim]));
    const rows = matching.slice(start, start + page.limit).map((item): ClaimListItem => ({ ...item, claim: byId.get(item.id) as ClaimRow }));
    const last = rows[rows.length - 1];
    const nextCursor = last !== undefined && start + page.limit < matching.length ? last.id : null;
    return { rows, nextCursor, totals, truncated, policy: policy.basis, calendarPublished: calendars !== undefined, asOf: today };
  }

  /** The claim policy and the calendar of the day, for a caller that evaluates claims itself (the alert source). */
  async clock(tx: TenantTx, now: Date): Promise<{ policy: ClaimPolicy; basis: PolicyBasis; calendars: Awaited<ReturnType<HomeWorkCalendars['load']>> }> {
    const policy = await this.policy.claim(tx, now);
    return { policy: policy.params, basis: policy.basis, calendars: await this.calendars.load(tx, WORK_CALENDAR_CODE, now) };
  }

  // ---- internals ----------------------------------------------------------------------------------------------------------

  private async lock(tx: TenantTx, id: string, scopes: ContractScopes): Promise<ClaimRow> {
    const held = await lockScopedRow<ClaimSql>(tx, { columns: CLAIM_COLUMNS, from: CLAIM_FROM, alias: 'k', id }, scopes);
    return claimOf(held);
  }

  private async isMember(tx: TenantTx, membershipId: string): Promise<boolean> {
    const rows = await tx.query<{ found: boolean }>('select exists (select 1 from machvon.membership where id = $1::uuid) as found', [membershipId]);
    return rows[0]?.found === true;
  }

  private async evidenceOf(tx: TenantTx, documentVersionId: string | undefined): Promise<string | null> {
    if (documentVersionId === undefined) return null;
    const id = documentVersionId.toLowerCase();
    if (!UUID.test(id) || !(await this.source.cleanDocumentVersionExists(tx, id))) throw new DomainError('VALIDATION_FAILED', 422, 'evidence_document_version_id');
    return id;
  }

  /** The columns of the claim that a recorded step moves: the dates the limits are counted from, the decision, the figures and the end of the claim. */
  private stepColumns(set: SetList, held: ClaimRow, step: RecordedStep, actor: string): void {
    switch (step.kind) {
      case 'NOTICE':
        set.add('notice_on', step.occurredOn, 'date');
        break;
      case 'PARTICULARS':
        set.add('particulars_on', held.particularsOn ?? step.occurredOn, 'date');
        set.add('last_particulars_on', step.occurredOn, 'date');
        // New particulars answer the request for more information: the response clock starts again, whatever day the earlier response was dated.
        set.add('response_on', null, 'date');
        set.add('response_decision', null);
        if (step.figures.claimedAmountVnd !== null) set.add('claimed_amount_vnd', step.figures.claimedAmountVnd, 'numeric');
        if (step.figures.claimedDays !== null) set.add('claimed_days', step.figures.claimedDays);
        break;
      case 'RESPONSE':
        set.add('response_on', step.occurredOn, 'date');
        set.add('response_decision', step.decision);
        set.add('accepted_on', step.decision === 'ACCEPTED' || step.decision === 'PARTLY_ACCEPTED' ? step.occurredOn : null, 'date');
        break;
      case 'SETTLEMENT_PROPOSAL':
        set.add('settled_amount_vnd', step.figures.settledAmountVnd, 'numeric');
        set.add('granted_days', step.figures.grantedDays);
        set.add('settlement_proposed_by', actor, 'uuid');
        break;
      case 'WITHDRAWAL':
      case 'REFERRAL':
        set.add('closed_on', step.occurredOn, 'date');
        set.add('closed_by', actor, 'uuid');
        break;
      default:
        break;
    }
  }

  private moveOf(held: ClaimRow, status: ContractClaimStatus, step: ClaimStepKind | null, ordinal: number, version: number, recorded: RecordedStep | undefined): ClaimMove {
    return {
      id: held.id,
      code: held.code,
      contractId: held.contractId,
      contractCode: held.contractCode,
      projectId: held.projectId,
      claimantSide: held.claimantSide,
      kind: held.kind,
      status,
      fromStatus: held.status,
      step,
      stepOrdinal: ordinal,
      version,
      termId: held.termId,
      claimedAmountVnd: recorded?.figures.claimedAmountVnd ?? held.claimedAmountVnd,
      settledAmountVnd: recorded?.figures.settledAmountVnd ?? held.settledAmountVnd,
      claimedDays: recorded?.figures.claimedDays ?? held.claimedDays,
      grantedDays: recorded?.figures.grantedDays ?? held.grantedDays,
      reach: held.reach,
    };
  }

  private async appendStep(
    tx: TenantTx,
    step: { claimId: string; ordinal: number; kind: ClaimStepKind; occurredOn: string; note: string; decision?: ResponseDecision | null | undefined; figures?: { claimedAmountVnd: string | null; claimedDays: number | null; settledAmountVnd: string | null; grantedDays: number | null } | undefined; evidence?: string | null | undefined; actor: string; versionAfter: number },
  ): Promise<void> {
    await tx.query(
      `insert into machvon.contract_claim_step (tenant_id, id, claim_id, ordinal, kind, occurred_on, note, decision, claimed_amount_vnd, claimed_days, settled_amount_vnd, granted_days, evidence_document_version_id, actor_id, claim_version_after)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3, $4::date, $5, $6, $7::numeric, $8, $9::numeric, $10, $11::uuid, $12::uuid, $13)`,
      [step.claimId, step.ordinal, step.kind, step.occurredOn, step.note, step.decision ?? null, step.figures?.claimedAmountVnd ?? null, step.figures?.claimedDays ?? null, step.figures?.settledAmountVnd ?? null, step.figures?.grantedDays ?? null, step.evidence ?? null, step.actor, step.versionAfter],
    );
  }
}

/** A claim on a day: its deadlines and limitation by the kernel and the steps a person may take. */
export function claimViewOf(row: ClaimRow, term: ClaimTermRow | null, today: string, policy: ClaimPolicy, calendars: Parameters<typeof claimDeadlines>[4]): ClaimView {
  const facts = factsOf(row);
  const deadlines = claimDeadlines(facts, term?.term ?? null, today, policy.approachDays, calendars);
  const limitation = claimLimitation(row.status, term?.term ?? null, deadlines);
  const open = isClaimOpen(row.status);
  const steps = open ? claimAllowedSteps(row.status, row.responseDecision).filter((kind) => kind !== 'BAR_DECLARED' && kind !== 'SETTLEMENT_APPROVED' && kind !== 'SETTLEMENT_REJECTED') : [];
  return {
    row,
    term,
    deadlines,
    limitation,
    allowed: { steps, decideSettlement: row.status === 'SETTLEMENT_PROPOSED', declareBar: open && limitation.status === 'MISSED' && limitation.barEffect === 'BARS_CLAIM' && claimAllowedSteps(row.status, row.responseDecision).includes('BAR_DECLARED') },
  };
}

/** The assignments of an `update` statement, numbered as they are added (a column set to null is written as null, not left out). */
class SetList {
  readonly values: unknown[] = [];
  private readonly parts: string[] = [];

  add(column: string, value: unknown, cast = ''): void {
    this.values.push(value);
    this.parts.push(`${column} = $${this.values.length}${cast === '' ? '' : `::${cast}`}`);
  }

  get sql(): string {
    return this.parts.join(', ');
  }

  /** A parameter for the rest of the statement. */
  next(value: unknown, cast = ''): string {
    this.values.push(value);
    return `$${this.values.length}${cast === '' ? '' : `::${cast}`}`;
  }
}
