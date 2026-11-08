import { randomUUID } from 'node:crypto';
import { DomainError, FORFEIT_BEHAVIOUR, FORFEIT_REASONS, assertSecurityEntry, assessSecurity, hasControlChar, moveSecurity, requiredSecurity, securityExpiryFacet, versionConflict, vietnamDateOf } from '@machvon/kernel';
import type { BidSecurityPolicy, ForfeitReason, ReputationBehaviour, ReputationEventState, SecurityAssessment, SecurityExpiryFacet, SecurityKind, SecurityMove, SecurityRequired, SecurityState } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';
import { VendorPackageControlStore } from './vendor-package-control-store.ts';
import { VendorPolicyReader } from './vendor-policy.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const iso = (column: string): string => `to_char(${column} at time zone 'UTC', ${ISO})`;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export interface SecurityRow {
  id: string;
  packageId: string;
  packageCode: string;
  contractorId: string;
  contractorName: string;
  kind: SecurityKind;
  issuer: string;
  securityNo: string;
  amount: number;
  issuedOn: string;
  validUntil: string;
  state: SecurityState;
  documentId: string | null;
  receivedBy: string;
  receivedAt: string;
  requiredAmount: number | null;
  factorApplied: number;
  ruleVersion: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
  issuerReference: string | null;
  rejectedBy: string | null;
  rejectedAt: string | null;
  rejectReason: string | null;
  forfeitProposedBy: string | null;
  forfeitProposedAt: string | null;
  forfeitReasonCode: ForfeitReason | null;
  forfeitReason: string | null;
  forfeitDecidedBy: string | null;
  forfeitDecidedAt: string | null;
  forfeitDecisionDocumentId: string | null;
  forfeitDecisionReason: string | null;
  releasedBy: string | null;
  releasedAt: string | null;
  releaseReason: string | null;
  version: number;
  /** The warning window the last day puts the security in on the day the row was read; null when it is not near its end or is no longer open. */
  expiryFacet: SecurityExpiryFacet;
  /** The behaviour of the ledger of bid conduct a forfeited security stands for, or null (a hook for the investor representative; never posted automatically). */
  conductBehaviour: ReputationBehaviour | null;
}

export interface SecurityEventRow {
  id: string;
  securityId: string;
  move: string;
  fromState: string | null;
  toState: string;
  actorId: string;
  note: string | null;
  occurredAt: string;
}

export interface NewSecurity {
  packageId: string;
  contractorId: string;
  kind: SecurityKind;
  issuer: string;
  securityNo: string;
  amount: number;
  issuedOn: string;
  validUntil: string;
  documentId?: string | undefined;
}

export interface SecurityFilter {
  packageId?: string | undefined;
  contractorId?: string | undefined;
  state?: SecurityState | undefined;
  /** Only these states (applied before the limit, so a long history of closed securities never hides a live one). */
  states?: readonly SecurityState[] | undefined;
  limit?: number | undefined;
}

interface Sql {
  id: string;
  package_id: string;
  package_code: string;
  contractor_id: string;
  contractor_name: string;
  kind: SecurityKind;
  issuer: string;
  security_no: string;
  amount: string;
  issued_on: string;
  valid_until: string;
  state: SecurityState;
  document_id: string | null;
  received_by: string;
  received_at: string;
  required_amount: string | null;
  factor_applied: number;
  rule_version: string;
  confirmed_by: string | null;
  confirmed_at: string | null;
  issuer_reference: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  reject_reason: string | null;
  forfeit_proposed_by: string | null;
  forfeit_proposed_at: string | null;
  forfeit_reason_code: ForfeitReason | null;
  forfeit_reason: string | null;
  forfeit_decided_by: string | null;
  forfeit_decided_at: string | null;
  forfeit_decision_document_id: string | null;
  forfeit_decision_reason: string | null;
  released_by: string | null;
  released_at: string | null;
  release_reason: string | null;
  version: string;
}

const SELECT = `select s.id, s.package_id, p.code as package_code, s.contractor_id, c.legal_name as contractor_name, s.kind, s.issuer, s.security_no, s.amount::text as amount, s.issued_on::text as issued_on, s.valid_until::text as valid_until,
  s.state, s.document_id, s.received_by, ${iso('s.received_at')} as received_at, s.required_amount::text as required_amount, s.factor_applied, s.rule_version, s.confirmed_by, ${iso('s.confirmed_at')} as confirmed_at, s.issuer_reference,
  s.rejected_by, ${iso('s.rejected_at')} as rejected_at, s.reject_reason, s.forfeit_proposed_by, ${iso('s.forfeit_proposed_at')} as forfeit_proposed_at, s.forfeit_reason_code, s.forfeit_reason, s.forfeit_decided_by,
  ${iso('s.forfeit_decided_at')} as forfeit_decided_at, s.forfeit_decision_document_id, s.forfeit_decision_reason, s.released_by, ${iso('s.released_at')} as released_at, s.release_reason, s.version::text as version
  from machvon.vendor_bid_security s
  join machvon.procurement_package p on p.tenant_id = s.tenant_id and p.id = s.package_id
  join machvon.contractor c on c.tenant_id = s.tenant_id and c.id = s.contractor_id`;

const toRow = (row: Sql, today: string, policy: BidSecurityPolicy): SecurityRow => ({
  id: row.id,
  packageId: row.package_id,
  packageCode: row.package_code,
  contractorId: row.contractor_id,
  contractorName: row.contractor_name,
  kind: row.kind,
  issuer: row.issuer,
  securityNo: row.security_no,
  amount: Number(row.amount),
  issuedOn: row.issued_on,
  validUntil: row.valid_until,
  state: row.state,
  documentId: row.document_id,
  receivedBy: row.received_by,
  receivedAt: row.received_at,
  requiredAmount: row.required_amount === null ? null : Number(row.required_amount),
  factorApplied: row.factor_applied,
  ruleVersion: row.rule_version,
  confirmedBy: row.confirmed_by,
  confirmedAt: row.confirmed_at,
  issuerReference: row.issuer_reference,
  rejectedBy: row.rejected_by,
  rejectedAt: row.rejected_at,
  rejectReason: row.reject_reason,
  forfeitProposedBy: row.forfeit_proposed_by,
  forfeitProposedAt: row.forfeit_proposed_at,
  forfeitReasonCode: row.forfeit_reason_code,
  forfeitReason: row.forfeit_reason,
  forfeitDecidedBy: row.forfeit_decided_by,
  forfeitDecidedAt: row.forfeit_decided_at,
  forfeitDecisionDocumentId: row.forfeit_decision_document_id,
  forfeitDecisionReason: row.forfeit_decision_reason,
  releasedBy: row.released_by,
  releasedAt: row.released_at,
  releaseReason: row.release_reason,
  version: Number(row.version),
  expiryFacet: securityExpiryFacet({ state: row.state, validUntil: row.valid_until }, today, policy),
  conductBehaviour: row.state === 'FORFEITED' && row.forfeit_reason_code !== null ? FORFEIT_BEHAVIOUR[row.forfeit_reason_code] : null,
});

function text(value: string, field: string, min: number, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max || hasControlChar(trimmed)) throw invalid(field);
  return trimmed;
}

const reasoned = (value: string, field = 'reason'): string => {
  const trimmed = value.trim();
  if (trimmed.length < 20 || trimmed.length > 2000 || hasControlChar(trimmed)) throw new DomainError('REASON_REQUIRED', 422, field);
  return trimmed;
};

/** What the package asked of one bidder on a day and what was lodged against it (null when the package sets no requirement). */
export interface SecurityStanding {
  required: SecurityRequired;
  assessment: SecurityAssessment;
  policyVersion: string;
}

/**
 * The bid security register (VND-2, V10; docs/vendor-controls-security-subcontract.md). A security is received by one person and confirmed with the issuer by another (the database holds that too); a forfeiture is proposed
 * by one person and decided by another on a decision paper; every move is a row of an append-only ledger and the moves are the kernel's (`moveSecurity`). The amount the package asked (the base times the factor of the
 * ledger of bid conduct) is kept on the row as of the day it was received. The state `EXPIRED` is not written by a job: the list says when a last day has passed (`expiryFacet`), and a person records the expiry or the release.
 */
export class VendorSecurityStore {
  private readonly policies: VendorPolicyReader;
  private readonly controls = new VendorPackageControlStore();

  constructor(policies: VendorPolicyReader = new VendorPolicyReader()) {
    this.policies = policies;
  }

  async list(tx: TenantTx, filter: SecurityFilter, today: string): Promise<SecurityRow[]> {
    const policy = (await this.policies.bidSecurity(tx, today)).value;
    const rows = await tx.query<Sql>(
      `${SELECT} where ($1::uuid is null or s.package_id = $1::uuid) and ($2::uuid is null or s.contractor_id = $2::uuid) and ($3::text is null or s.state = $3::text) and ($5::text[] is null or s.state = any($5::text[]))
        order by s.valid_until, s.id limit $4::int`,
      [filter.packageId ?? null, filter.contractorId ?? null, filter.state ?? null, Math.min(filter.limit ?? 200, 500), filter.states === undefined ? null : [...filter.states]],
    );
    return rows.map((row) => toRow(row, today, policy));
  }

  async find(tx: TenantTx, id: string, today: string, lock = false): Promise<SecurityRow | undefined> {
    const policy = (await this.policies.bidSecurity(tx, today)).value;
    const rows = await tx.query<Sql>(`${SELECT} where s.id = $1::uuid${lock ? ' for update of s' : ''}`, [id]);
    return rows[0] === undefined ? undefined : toRow(rows[0], today, policy);
  }

  async events(tx: TenantTx, securityId: string): Promise<SecurityEventRow[]> {
    const rows = await tx.query<{ id: string; security_id: string; move: string; from_state: string | null; to_state: string; actor_id: string; note: string | null; occurred_at: string }>(
      `select id, security_id, move, from_state, to_state, actor_id, note, ${iso('occurred_at')} as occurred_at from machvon.vendor_bid_security_event where security_id = $1::uuid order by occurred_at, id`,
      [securityId],
    );
    return rows.map((row) => ({ id: row.id, securityId: row.security_id, move: row.move, fromState: row.from_state, toState: row.to_state, actorId: row.actor_id, note: row.note, occurredAt: row.occurred_at }));
  }

  /** The amount a bidder must lodge on a day: the base of the package times the factor of its ledger of bid conduct; null when the package sets no base amount or no last day for its bids. */
  async requiredFor(tx: TenantTx, packageId: string, contractorId: string, today: string): Promise<(SecurityRequired & { policyVersion: string }) | null> {
    const control = await this.controls.get(tx, packageId);
    if (control.securityBaseAmount === null || control.bidValidUntil === null) return null;
    const [policy, reputation] = await Promise.all([this.policies.bidSecurity(tx, today), this.policies.reputation(tx, today)]);
    const events = await tx.query<{ id: string; status: ReputationEventState; posted_on: string | null }>(
      "select id, status, (posted_at at time zone 'Asia/Ho_Chi_Minh')::date::text as posted_on from machvon.contractor_reputation_event where contractor_id = $1::uuid and status = 'POSTED'",
      [contractorId],
    );
    const required = requiredSecurity({ baseAmount: control.securityBaseAmount, bidValidUntil: control.bidValidUntil }, events.map((row) => ({ id: row.id, state: row.status, postedOn: row.posted_on })), today, reputation.value, policy.value);
    return { ...required, policyVersion: `${policy.version}/${reputation.version}` };
  }

  /** What was lodged by a bidder for a package against what the package requires; null when the package requires nothing. */
  async standing(tx: TenantTx, packageId: string, contractorId: string, today: string): Promise<SecurityStanding | null> {
    const required = await this.requiredFor(tx, packageId, contractorId, today);
    if (required === null) return null;
    const policy = (await this.policies.bidSecurity(tx, today)).value;
    const lodged = await this.list(tx, { packageId, contractorId }, today);
    const assessment = assessSecurity(required, lodged.map((row) => ({ id: row.id, state: row.state, amount: row.amount, validUntil: row.validUntil, confirmed: row.confirmedBy !== null })), today, policy);
    return { required, assessment, policyVersion: required.policyVersion };
  }

  async receive(tx: TenantTx, input: NewSecurity, actor: string, now: Date): Promise<SecurityRow> {
    const today = vietnamDateOf(now);
    assertSecurityEntry({ kind: input.kind, amount: input.amount, issuer: input.issuer, number: input.securityNo, issuedOn: input.issuedOn, validUntil: input.validUntil });
    if ((await tx.query('select 1 from machvon.procurement_package where id = $1::uuid', [input.packageId])).length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'package_id');
    if ((await tx.query('select 1 from machvon.contractor where id = $1::uuid', [input.contractorId])).length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'contractor_id');
    if (input.documentId !== undefined && (await tx.query('select 1 from machvon.document where id = $1::uuid', [input.documentId])).length === 0) throw invalid('document_id');
    const required = await this.requiredFor(tx, input.packageId, input.contractorId, today);
    const id = randomUUID();
    await tx.query(
      `insert into machvon.vendor_bid_security (tenant_id, id, package_id, contractor_id, kind, issuer, security_no, amount, issued_on, valid_until, document_id, received_by, required_amount, factor_applied, rule_version)
       values (${TENANT}, $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::numeric, $8::date, $9::date, $10::uuid, $11::uuid, $12::numeric, $13::int, $14)`,
      [id, input.packageId, input.contractorId, input.kind, text(input.issuer, 'issuer', 2, 300), text(input.securityNo, 'security_no', 1, 100), input.amount, input.issuedOn, input.validUntil, input.documentId ?? null, actor, required?.amount ?? null, required?.factor ?? 1, required?.policyVersion ?? 'builtin'],
    );
    await this.record(tx, id, 'RECEIVE', null, 'RECEIVED', actor, null);
    return (await this.find(tx, id, today)) as SecurityRow;
  }

  private async record(tx: TenantTx, securityId: string, move: string, from: SecurityState | null, to: SecurityState, actor: string, note: string | null): Promise<void> {
    await tx.query(`insert into machvon.vendor_bid_security_event (tenant_id, id, security_id, move, from_state, to_state, actor_id, note) values (${TENANT}, gen_random_uuid(), $1::uuid, $2, $3, $4, $5::uuid, $6)`, [securityId, move, from, to, actor, note]);
  }

  private async locked(tx: TenantTx, id: string, expectedVersion: number, today: string): Promise<SecurityRow> {
    const row = await this.find(tx, id, today, true);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (row.version !== expectedVersion) throw versionConflict(row.version);
    return row;
  }

  private async step(tx: TenantTx, current: SecurityRow, move: SecurityMove, auditMove: string, actor: string, set: string, params: unknown[], note: string | null, now: Date): Promise<SecurityRow> {
    const to = moveSecurity(current.state, move, { actor, receivedBy: current.receivedBy, forfeitProposedBy: current.forfeitProposedBy });
    await tx.query(`update machvon.vendor_bid_security set state = $2, ${set}${set === '' ? '' : ', '}updated_at = now(), version = version + 1 where id = $1::uuid`, [current.id, to, ...params]);
    await this.record(tx, current.id, auditMove, current.state, to, actor, note);
    return (await this.find(tx, current.id, vietnamDateOf(now))) as SecurityRow;
  }

  /** A person other than the receiver confirms the security with the issuer and keeps the reference the issuer gave (403 `SELF_APPROVAL_DENIED`); once (409 `STAGE_TRANSITION_DENIED`). */
  async confirm(tx: TenantTx, id: string, expectedVersion: number, issuerReference: string, actor: string, now: Date): Promise<SecurityRow> {
    const reference = text(issuerReference, 'issuer_reference', 3, 200);
    const current = await this.locked(tx, id, expectedVersion, vietnamDateOf(now));
    return this.step(tx, current, 'CONFIRM', 'CONFIRM', actor, 'confirmed_by = $3::uuid, confirmed_at = now(), issuer_reference = $4', [actor, reference], reference, now);
  }

  /** The issuer does not know the security (or it is not what it says): a person other than the receiver rejects it with a reason of 20 characters. */
  async reject(tx: TenantTx, id: string, expectedVersion: number, reason: string, actor: string, now: Date): Promise<SecurityRow> {
    const why = reasoned(reason);
    const current = await this.locked(tx, id, expectedVersion, vietnamDateOf(now));
    return this.step(tx, current, 'REJECT', 'REJECT', actor, 'rejected_by = $3::uuid, rejected_at = now(), reject_reason = $4', [actor, why], why, now);
  }

  /** Proposes the forfeiture for one of the reasons of the law, with a reason of 20 characters; the decision is another person's. */
  async proposeForfeiture(tx: TenantTx, id: string, expectedVersion: number, reasonCode: string, reason: string, actor: string, now: Date): Promise<SecurityRow> {
    if (!(FORFEIT_REASONS as readonly string[]).includes(reasonCode)) throw invalid('reason_code');
    const why = reasoned(reason);
    const current = await this.locked(tx, id, expectedVersion, vietnamDateOf(now));
    return this.step(tx, current, 'PROPOSE_FORFEIT', 'PROPOSE_FORFEIT', actor, 'forfeit_proposed_by = $3::uuid, forfeit_proposed_at = now(), forfeit_reason_code = $4, forfeit_reason = $5', [actor, reasonCode, why], why, now);
  }

  async withdrawForfeiture(tx: TenantTx, id: string, expectedVersion: number, actor: string, now: Date): Promise<SecurityRow> {
    const current = await this.locked(tx, id, expectedVersion, vietnamDateOf(now));
    if (current.forfeitProposedBy !== actor) throw new DomainError('SCOPE_DENIED', 403);
    return this.step(tx, current, 'WITHDRAW_FORFEIT', 'WITHDRAW_FORFEIT', actor, '', [], null, now);
  }

  /** The decision on a proposed forfeiture by a person other than the proposer: FORFEIT needs the decision paper and a reason of 20 characters; REFUSE returns the security to CONFIRMED with a reason. */
  async decideForfeiture(tx: TenantTx, id: string, expectedVersion: number, input: { decision: 'FORFEIT' | 'REFUSE'; reason: string; decisionDocumentId?: string | undefined }, actor: string, now: Date): Promise<SecurityRow> {
    const why = reasoned(input.reason);
    const current = await this.locked(tx, id, expectedVersion, vietnamDateOf(now));
    if (input.decision === 'REFUSE') {
      if (current.state !== 'FORFEIT_PROPOSED') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status', { extensions: { status: current.state, move: 'REFUSE_FORFEIT' } });
      if (current.forfeitProposedBy === actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
      await tx.query('update machvon.vendor_bid_security set state = $2, forfeit_decision_reason = $3, updated_at = now(), version = version + 1 where id = $1::uuid', [id, 'CONFIRMED', why]);
      await this.record(tx, id, 'REFUSE_FORFEIT', current.state, 'CONFIRMED', actor, why);
      return (await this.find(tx, id, vietnamDateOf(now))) as SecurityRow;
    }
    if (input.decisionDocumentId === undefined) throw invalid('decision_document_id');
    if ((await tx.query('select 1 from machvon.document where id = $1::uuid', [input.decisionDocumentId])).length === 0) throw invalid('decision_document_id');
    return this.step(tx, current, 'DECIDE_FORFEIT', 'DECIDE_FORFEIT', actor, 'forfeit_decided_by = $3::uuid, forfeit_decided_at = now(), forfeit_decision_document_id = $4::uuid, forfeit_decision_reason = $5', [actor, input.decisionDocumentId, why], why, now);
  }

  /** Releases the security (the bid lost or the contract was signed) or records that it expired, with a reason; the state a person records is final. */
  async release(tx: TenantTx, id: string, expectedVersion: number, reason: string, expired: boolean, actor: string, now: Date): Promise<SecurityRow> {
    const why = text(reason, 'reason', 5, 2000);
    const current = await this.locked(tx, id, expectedVersion, vietnamDateOf(now));
    return this.step(tx, current, expired ? 'EXPIRE' : 'RELEASE', expired ? 'EXPIRE' : 'RELEASE', actor, 'released_by = $3::uuid, released_at = now(), release_reason = $4', [actor, why], why, now);
  }

  /** Securities that raise an alert on a day: received or confirmed and in a warning window or past the last day. */
  async alertable(tx: TenantTx, today: string): Promise<SecurityRow[]> {
    const open = await this.list(tx, { states: ['CONFIRMED', 'RECEIVED'], limit: 500 }, today);
    return open.filter((row) => row.expiryFacet !== null);
  }

  /** Forfeited securities of a contractor (a factor of its risk grade). */
  async forfeitCount(tx: TenantTx, contractorId: string): Promise<number> {
    const [row] = await tx.query<{ n: string }>("select count(*)::text as n from machvon.vendor_bid_security where contractor_id = $1::uuid and state = 'FORFEITED'", [contractorId]);
    return Number(row?.n ?? 0);
  }

  /** The figure of the register: securities confirmed with the issuer over securities received and not rejected. */
  async figure(tx: TenantTx, now: Date): Promise<{ code: string; numerator: number; denominator: number; asOf: string }> {
    const [row] = await tx.query<{ confirmed: string; received: string }>("select count(*) filter (where confirmed_by is not null)::text as confirmed, count(*) filter (where state <> 'REJECTED')::text as received from machvon.vendor_bid_security");
    return { code: 'VENDOR_SECURITY_CONFIRMED', numerator: Number(row?.confirmed ?? 0), denominator: Number(row?.received ?? 0), asOf: vietnamDateOf(now) };
  }
}

export const securityForfeitCount = (tx: TenantTx, contractorId: string): Promise<number> => new VendorSecurityStore().forfeitCount(tx, contractorId);
export const securityFigures = async (tx: TenantTx, now: Date): Promise<Array<{ code: string; numerator: number; denominator: number; asOf: string }>> => [await new VendorSecurityStore().figure(tx, now)];

/**
 * The precondition the result of a package asks about the bid security of the winner (VND-2, V10): a package that sets a base amount for its bids refuses a bidder whose lodged security does not meet it, as the rule
 * `VENDOR_BID_SECURITY` enforces (BLOCK; a softened amount only warns). A package with no requirement is not blocked.
 */
export class VendorSecurityGate {
  private readonly store: VendorSecurityStore;

  constructor(store: VendorSecurityStore = new VendorSecurityStore()) {
    this.store = store;
  }

  async assertAllowed(tx: TenantTx, request: { packageId: string; contractorId: string; today: string }): Promise<void> {
    const standing = await this.store.standing(tx, request.packageId, request.contractorId, request.today);
    if (standing === null || standing.assessment.enforcement !== 'BLOCK') return;
    throw new DomainError('BID_SECURITY_NOT_VALID', 422, 'contractor_id', {
      extensions: { package_id: request.packageId, contractor_id: request.contractorId, gaps: standing.assessment.gaps, required_amount: standing.required.amount, factor: standing.required.factor, shortfall: standing.assessment.shortfall },
    });
  }
}
