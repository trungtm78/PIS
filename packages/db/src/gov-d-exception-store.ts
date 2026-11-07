import { randomUUID } from 'node:crypto';
import { DomainError, PAYMENT_INTEGRITY_CODE, PAYMENT_INTEGRITY_TYPE, assertNotProposer, exceptionWindowEnd, isExceptionalCeiling, paymentIntegrityFallback, parsePaymentIntegrityParams, versionConflict, wholeVnd } from '@machvon/kernel';
import type { ExceptionalCeiling } from '@machvon/kernel';
import { CtrContractStore, calendarDate } from './ctr-contract-store.ts';
import type { ContractScopes } from './ctr-contract-store.ts';
import { resolveGovD } from './gov-d-policy.ts';
import { PayIntegrityStore } from './gov-d-integrity-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNIQUE_VIOLATION = '23505';
const MAX_TEXT = 2000;

export type ExceptionStatus = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'REVOKED' | 'USED';
/** What a reader is told: an approved exception whose day has gone is EXPIRED (derived, never stored: the row stays APPROVED until someone revokes it or the day is past on the day of reading). */
export type ExceptionView = ExceptionStatus | 'EXPIRED';

export interface DisbursementException {
  id: string;
  paymentRequestId: string;
  requestNo: string | null;
  contractId: string;
  contractCode: string;
  projectId: string;
  ceiling: ExceptionalCeiling;
  allowedAmountVnd: string;
  validTo: string;
  reason: string;
  status: ExceptionStatus;
  view: ExceptionView;
  requestedBy: string;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  usedAt: string | null;
  version: number;
  /** The days left to the day it lapses (negative once past); null when it no longer holds. */
  daysLeft: number | null;
}

/** What a command on an exception did, for the audit row and the event: identifiers, amounts and states, never the words. */
export interface ExceptionResult {
  id: string;
  version: number;
  status: ExceptionStatus;
  fromStatus: ExceptionStatus | null;
  paymentRequestId: string;
  contractId: string;
  projectId: string;
  ceiling: ExceptionalCeiling;
  allowedAmountVnd: string;
  validTo: string;
}

interface Sql {
  id: string;
  payment_request_id: string;
  request_no: string | null;
  contract_id: string;
  contract_code: string;
  project_id: string;
  ceiling: ExceptionalCeiling;
  allowed: string;
  valid_to: string;
  reason: string;
  status: ExceptionStatus;
  requested_by: string;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  used_at: string | null;
  version: string;
  days_left: number;
  created_by: string | null;
  submitted_by: string | null;
}

const TIMESTAMP = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const COLUMNS = `e.id, e.payment_request_id, pr.request_no, e.contract_id, c.code as contract_code, e.project_id, e.ceiling, e.allowed_amount_vnd::text as allowed, e.valid_to::text as valid_to, e.reason, e.status, e.requested_by,
  ${TIMESTAMP('e.requested_at')} as requested_at, e.decided_by, ${TIMESTAMP('e.decided_at')} as decided_at, e.decision_note, ${TIMESTAMP('e.used_at')} as used_at, e.version::text as version,
  (e.valid_to - $1::date) as days_left, pr.created_by, pr.submitted_by`;
const FROM = `machvon.disbursement_exception e
  join machvon.payment_request pr on pr.tenant_id = e.tenant_id and pr.id = e.payment_request_id
  join machvon.contract c on c.tenant_id = e.tenant_id and c.id = e.contract_id
  join machvon.project p on p.tenant_id = c.tenant_id and p.id = c.project_id
  join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
  left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id`;

const invalid = (field: string, reason?: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, reason === undefined ? undefined : { extensions: { reason } });
const textOf = (value: string | undefined, field: string): string => {
  const trimmed = (value ?? '').trim();
  if (trimmed === '' || trimmed.length > MAX_TEXT) throw invalid(field);
  return trimmed;
};
const stateInvalid = (status: ExceptionStatus): DomainError => new DomainError('DISBURSEMENT_EXCEPTION_STATE_INVALID', 409, 'id', { extensions: { status } });

const viewOf = (row: Sql): DisbursementException => ({
  id: row.id,
  paymentRequestId: row.payment_request_id,
  requestNo: row.request_no,
  contractId: row.contract_id,
  contractCode: row.contract_code,
  projectId: row.project_id,
  ceiling: row.ceiling,
  allowedAmountVnd: row.allowed,
  validTo: row.valid_to,
  reason: row.reason,
  status: row.status,
  view: row.status === 'APPROVED' && row.days_left < 0 ? 'EXPIRED' : row.status,
  requestedBy: row.requested_by,
  requestedAt: row.requested_at,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at,
  decisionNote: row.decision_note,
  usedAt: row.used_at,
  version: Number(row.version),
  daysLeft: row.status === 'APPROVED' || row.status === 'REQUESTED' ? row.days_left : null,
});
const resultOf = (row: Sql, status: ExceptionStatus, fromStatus: ExceptionStatus | null, version: number): ExceptionResult => ({
  id: row.id,
  version,
  status,
  fromStatus,
  paymentRequestId: row.payment_request_id,
  contractId: row.contract_id,
  projectId: row.project_id,
  ceiling: row.ceiling,
  allowedAmountVnd: row.allowed,
  validTo: row.valid_to,
});

export interface ExceptionFilter {
  status?: ExceptionView | undefined;
  contractId?: string | undefined;
  paymentRequestId?: string | undefined;
}

export interface RequestExceptionInput {
  ceiling: string;
  allowedAmountVnd: string;
  validTo: string;
  reason: string;
}

/**
 * The exception to a ceiling of disbursement (G4-2, G4-5, lane D): asked for a draft request that a ceiling blocks, decided by someone other than whoever asked and than whoever drew up or sent the request, limited to the days the rule
 * PAYMENT_INTEGRITY allows, covering at most the amount it names, and used once by the request that sends under it. An exception is asked only while a ceiling really stands (otherwise it would be a blanket permission), and only for the
 * ceilings the books allow it for: the value of an acceptance has none.
 */
export class DisbursementExceptionStore {
  private readonly contracts = new CtrContractStore();
  private readonly integrity = new PayIntegrityStore();

  async request(tx: TenantTx, requestId: string, input: RequestExceptionInput, actor: string, scopes: ContractScopes, today: string): Promise<ExceptionResult> {
    if (!UUID.test(requestId)) throw invalid('id');
    const id = requestId.toLowerCase();
    const reason = textOf(input.reason, 'reason');
    if (!isExceptionalCeiling(input.ceiling)) throw new DomainError('DISBURSEMENT_EXCEPTION_NOT_ALLOWED', 422, 'ceiling', { extensions: { reason: input.ceiling === 'EXCEEDS_ACCEPTED' ? 'ACCEPTED_VALUE_HAS_NO_EXCEPTION' : 'UNKNOWN_CEILING' } });
    const allowed = wholeVnd(input.allowedAmountVnd, 'allowed_amount_vnd');
    if (allowed <= 0n) throw invalid('allowed_amount_vnd', 'NOT_ABOVE_ZERO');
    const validTo = calendarDate(input.validTo, 'valid_to');
    const [peek] = await tx.query<{ contract_id: string }>('select contract_id from machvon.payment_request where id = $1::uuid', [id]);
    if (peek === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.contracts.lock(tx, peek.contract_id, scopes);
    const [request] = await tx.query<{ status: string; project_id: string; contract_id: string }>('select status, project_id, contract_id from machvon.payment_request where id = $1::uuid for update', [id]);
    if (request === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    // Only a draft is sent, so only a draft needs a way past a ceiling.
    if (request.status !== 'DRAFT') throw new DomainError('PAYMENT_STATE_INVALID', 409, 'id', { extensions: { status: request.status } });
    const rule = await resolveGovD(tx, PAYMENT_INTEGRITY_TYPE, PAYMENT_INTEGRITY_CODE, today, paymentIntegrityFallback());
    const maxDays = parsePaymentIntegrityParams(rule.params).exception_max_days;
    const last = exceptionWindowEnd(today, maxDays);
    if (validTo < today || validTo > last) throw new DomainError('DISBURSEMENT_EXCEPTION_WINDOW_INVALID', 422, 'valid_to', { extensions: { earliest: today, latest: last, max_days: maxDays, rule_version: rule.version } });
    // The ceiling must really stand now, and the amount must cover how far over it is: an exception that covers nothing is not asked for.
    const checked = await this.integrity.evaluate(tx, id, { trigger: 'PREVIEW', actor, today, scopes, persist: false });
    const standing = checked?.verdict.findings.find((one) => one.kind === 'INVARIANT' && one.code === input.ceiling);
    if (standing === undefined) throw new DomainError('DISBURSEMENT_EXCEPTION_NOT_NEEDED', 422, 'ceiling', { extensions: { ceiling: input.ceiling } });
    const over = BigInt(String(standing.params.over_by_vnd ?? '0'));
    if (allowed < over) throw invalid('allowed_amount_vnd', 'BELOW_OVER_BY');
    const exceptionId = randomUUID();
    try {
      await tx.query(
        `insert into machvon.disbursement_exception (tenant_id, id, payment_request_id, contract_id, project_id, ceiling, allowed_amount_vnd, valid_to, reason, requested_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::numeric, $7::date, $8, $9::uuid)`,
        [exceptionId, id, request.contract_id, request.project_id, input.ceiling, allowed.toString(), validTo, reason, actor],
      );
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('DISBURSEMENT_EXCEPTION_STATE_INVALID', 409, 'ceiling', { extensions: { reason: 'ALREADY_LIVE' } });
      throw error;
    }
    return { id: exceptionId, version: 1, status: 'REQUESTED', fromStatus: null, paymentRequestId: id, contractId: request.contract_id, projectId: request.project_id, ceiling: input.ceiling, allowedAmountVnd: allowed.toString(), validTo };
  }

  /** Approves an asked exception: not the one who asked, not the one who drew up or sent the request (403 `SELF_APPROVAL_DENIED`), and not after its day. */
  async approve(tx: TenantTx, id: string, expectedVersion: number, note: string | undefined, actor: string, scopes: ContractScopes, today: string): Promise<ExceptionResult> {
    const text = note === undefined ? null : textOf(note, 'note');
    const held = await this.lock(tx, id, expectedVersion, scopes, today);
    if (held.status !== 'REQUESTED') throw stateInvalid(held.status);
    assertNotProposer(actor, [held.requested_by, held.created_by, held.submitted_by]);
    if (held.valid_to < today) throw new DomainError('DISBURSEMENT_EXCEPTION_WINDOW_INVALID', 422, 'valid_to', { extensions: { earliest: today, latest: held.valid_to } });
    await tx.query("update machvon.disbursement_exception set status = 'APPROVED', decided_by = $2::uuid, decided_at = now(), decision_note = $3, updated_at = now(), version = version + 1 where id = $1::uuid", [held.id, actor, text]);
    return resultOf(held, 'APPROVED', 'REQUESTED', Number(held.version) + 1);
  }

  /** Refuses an asked exception, with the reason; by someone other than whoever asked. */
  async reject(tx: TenantTx, id: string, expectedVersion: number, reason: string, actor: string, scopes: ContractScopes, today: string): Promise<ExceptionResult> {
    const text = textOf(reason, 'reason');
    const held = await this.lock(tx, id, expectedVersion, scopes, today);
    if (held.status !== 'REQUESTED') throw stateInvalid(held.status);
    assertNotProposer(actor, [held.requested_by]);
    await tx.query("update machvon.disbursement_exception set status = 'REJECTED', decided_by = $2::uuid, decided_at = now(), decision_note = $3, updated_at = now(), version = version + 1 where id = $1::uuid", [held.id, actor, text]);
    return resultOf(held, 'REJECTED', 'REQUESTED', Number(held.version) + 1);
  }

  /** Takes back an approved exception that was not used (and is not past its day: a lapsed one is already nothing), with the reason; by someone other than whoever asked. */
  async revoke(tx: TenantTx, id: string, expectedVersion: number, reason: string, actor: string, scopes: ContractScopes, today: string): Promise<ExceptionResult> {
    const text = textOf(reason, 'reason');
    const held = await this.lock(tx, id, expectedVersion, scopes, today);
    if (held.status !== 'APPROVED') throw stateInvalid(held.status);
    assertNotProposer(actor, [held.requested_by]);
    await tx.query("update machvon.disbursement_exception set status = 'REVOKED', decided_by = $2::uuid, decided_at = now(), decision_note = $3, updated_at = now(), version = version + 1 where id = $1::uuid", [held.id, actor, text]);
    return resultOf(held, 'REVOKED', 'APPROVED', Number(held.version) + 1);
  }

  /** The register in the scope of the reader: newest first, keyset by (requested_at, id). A reader outside the scope of a contract does not see its exceptions. */
  async list(tx: TenantTx, read: ScopeBuilder, filter: ExceptionFilter, today: string, limit: number, after: { requestedAt: string; id: string } | undefined): Promise<DisbursementException[]> {
    const params: unknown[] = [today];
    const add = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = [];
    if (filter.status === 'EXPIRED') where.push("e.status = 'APPROVED' and e.valid_to < $1::date");
    else if (filter.status === 'APPROVED') where.push("e.status = 'APPROVED' and e.valid_to >= $1::date");
    else if (filter.status !== undefined) where.push(`e.status = ${add(filter.status)}`);
    if (filter.contractId !== undefined) where.push(`e.contract_id = ${add(filter.contractId)}::uuid`);
    if (filter.paymentRequestId !== undefined) where.push(`e.payment_request_id = ${add(filter.paymentRequestId)}::uuid`);
    if (after !== undefined) where.push(`(e.requested_at, e.id) < (${add(after.requestedAt)}::timestamptz, ${add(after.id)}::uuid)`);
    const predicate = read(params.length + 1);
    params.push(...predicate.params);
    const rows = await tx.query<Sql>(`select ${COLUMNS} from ${FROM} where ${[...where, predicate.sql].join(' and ')} order by e.requested_at desc, e.id desc limit ${add(limit)}`, params);
    return rows.map(viewOf);
  }

  /** One exception within the read scope; undefined when the reader does not reach it. */
  async get(tx: TenantTx, id: string, read: ScopeBuilder, today: string): Promise<DisbursementException | undefined> {
    if (!UUID.test(id)) throw invalid('id');
    const predicate = read(3);
    const [row] = await tx.query<Sql>(`select ${COLUMNS} from ${FROM} where e.id = $2::uuid and ${predicate.sql}`, [today, id.toLowerCase(), ...predicate.params]);
    return row === undefined ? undefined : viewOf(row);
  }

  /** Approved exceptions that lapse within `withinDays` (or already lapsed unused): the source of the alert DISBURSEMENT_EXCEPTION_EXPIRING. */
  async expiring(tx: TenantTx, read: ScopeBuilder, today: string, withinDays: number): Promise<DisbursementException[]> {
    const predicate = read(3);
    const rows = await tx.query<Sql>(`select ${COLUMNS} from ${FROM} where e.status = 'APPROVED' and e.valid_to <= ($1::date + $2::int) and ${predicate.sql} order by e.valid_to, e.id limit 500`, [today, withinDays, ...predicate.params]);
    return rows.map(viewOf);
  }

  private async lock(tx: TenantTx, id: string, expectedVersion: number, scopes: ContractScopes, today: string): Promise<Sql> {
    if (!UUID.test(id)) throw invalid('id');
    const [peek] = await tx.query<{ contract_id: string }>('select contract_id from machvon.disbursement_exception where id = $1::uuid', [id.toLowerCase()]);
    if (peek === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.contracts.lock(tx, peek.contract_id, scopes);
    await tx.query('select id from machvon.disbursement_exception where id = $1::uuid for update', [id.toLowerCase()]);
    const [row] = await tx.query<Sql>(`select ${COLUMNS} from ${FROM} where e.id = $2::uuid`, [today, id.toLowerCase()]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    return row;
  }
}
