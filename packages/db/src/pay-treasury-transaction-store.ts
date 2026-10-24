import { DomainError, NOOP_METRICS, canonicalJson, compareDecimal, sha256Hex } from '@machvon/kernel';
import type { MetricsSink, ProviderSigningKey } from '@machvon/kernel';
import { DEFAULT_ITEM_DUE_SECONDS, normalizeUuid } from './file-import-item-store.ts';
import { timestampKey } from './keyset.ts';
import { TREASURY_CALLBACK_SCHEME, TREASURY_CALLBACK_WINDOW_SECONDS, callbackTimestampSeconds, treasuryCallbackPayload } from './pay-treasury-callback.ts';
import { TREASURY_FILE_PROVIDER, statementDate, statementInstant, treasuryBusinessKey, wholeVnd } from './pay-treasury-statement-format.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import { ProviderCallbackStore } from './provider-callback-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/** The provider of a transaction that a person confirmed by hand with evidence. */
export const TREASURY_MANUAL_PROVIDER = 'MANUAL';
const MAX_TEXT = 100;
const PROVIDER = /^[A-Za-z][A-Za-z0-9_]{1,39}$/;
const RESERVED_PROVIDERS: ReadonlySet<string> = new Set([TREASURY_FILE_PROVIDER, TREASURY_MANUAL_PROVIDER]);
const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

export type TreasurySourceKind = 'FILE_IMPORT' | 'MANUAL_CONFIRMED' | 'CALLBACK_MOCK';
export type TreasuryMatchStatus = 'UNMATCHED' | 'MATCHED' | 'EXCEPTION';

export interface TreasuryTransactionRow {
  id: string;
  projectId: string;
  projectCode: string;
  provider: string;
  sourceKind: TreasurySourceKind;
  direction: 'PAYMENT' | 'REFUND';
  documentNo: string | null;
  documentDate: string | null;
  amountVnd: string;
  confirmedAt: string;
  matchStatus: TreasuryMatchStatus;
  paymentRequestId: string | null;
  importId: string | null;
  planYear: number | null;
  /** The confirmation time to the microsecond (UTC): the ordering key of the list and its cursor. */
  confirmedAtKey: string;
}

interface TransactionSql {
  id: string;
  project_id: string;
  project_code: string;
  provider: string;
  source_kind: TreasurySourceKind;
  direction: 'PAYMENT' | 'REFUND';
  document_no: string | null;
  document_date: string | null;
  amount_vnd: string;
  confirmed_at: string;
  match_status: TreasuryMatchStatus;
  payment_request_id: string | null;
  import_id: string | null;
  plan_year: number | null;
  confirmed_at_key: string;
}

const COLUMNS = `t.id, t.project_id, p.code as project_code, t.provider, t.source_kind, t.direction, t.document_no, t.document_date::text as document_date, t.amount_vnd::text as amount_vnd,
  to_char(t.confirmed_at at time zone 'UTC', ${ISO}) as confirmed_at, t.match_status, t.payment_request_id, t.import_id, t.plan_year, ${timestampKey('t.confirmed_at')} as confirmed_at_key`;
const FROM = `from ${SCOPE_FROM} join machvon.treasury_transaction t on t.tenant_id = p.tenant_id and t.project_id = p.id`;

const toRow = (row: TransactionSql): TreasuryTransactionRow => ({
  id: row.id,
  projectId: row.project_id,
  projectCode: row.project_code,
  provider: row.provider,
  sourceKind: row.source_kind,
  direction: row.direction,
  documentNo: row.document_no,
  documentDate: row.document_date,
  amountVnd: row.amount_vnd,
  confirmedAt: row.confirmed_at,
  matchStatus: row.match_status,
  paymentRequestId: row.payment_request_id,
  importId: row.import_id,
  planYear: row.plan_year,
  confirmedAtKey: row.confirmed_at_key,
});

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** A voucher number or a project code that may sit in a business key. */
function keyText(value: string, field: string): string {
  const text = value.trim();
  if (text === '' || text.length > MAX_TEXT || text.includes('|') || Array.from(text).some((character) => (character.codePointAt(0) ?? 0) < 0x20 || character.codePointAt(0) === 0x7f)) throw invalid(field);
  return text;
}

function amountOf(value: string): string {
  const amount = wholeVnd(value);
  if (amount === undefined) throw invalid('amount_vnd');
  return amount;
}

function dateOf(value: string, field: string): string {
  const date = statementDate(value);
  if (date === undefined) throw invalid(field);
  return date;
}

function instantOf(value: string, field: string): string {
  const instant = statementInstant(value);
  if (instant === undefined) throw invalid(field);
  return instant;
}

export interface ManualConfirmationInput {
  paymentRequestId: string;
  documentNo: string;
  documentDate: string;
  amountVnd: string;
  confirmedAt: string;
  evidenceDocumentVersionId: string;
  actor: string;
  /** The scope in which the caller may confirm for a project (`treasury.confirm_manual`). */
  scope: ScopeBuilder;
  now?: Date;
}

export interface ManualConfirmationResult {
  transactionId: string;
  projectId: string;
  paymentRequestId: string;
  documentNo: string;
  amountVnd: string;
  netVnd: string;
  matchStatus: TreasuryMatchStatus;
  /** The work item opened when the amount is not the net of the request. */
  mismatchItemId: string | null;
}

export interface TreasuryCallbackInput {
  providerEventId: string;
  provider: string;
  documentNo: string;
  documentDate: string;
  projectCode: string;
  amountVnd: string;
  direction: string;
  confirmedAt: string;
  signature: string;
  keys: readonly ProviderSigningKey[];
  /** Where the signed body is kept (the inbox keeps its hash and this pointer). */
  payloadReference: string;
  actor: string;
  metrics?: MetricsSink;
  now?: () => number;
}

export interface TreasuryCallbackResult {
  transactionId: string;
  matchStatus: TreasuryMatchStatus;
  /** True when this event, or the same voucher, was received before: nothing was written and the answer is the first one. */
  duplicate: boolean;
}

/**
 * The Treasury transactions (ST-PAY-006): the read model of PAY, the confirmation by hand with evidence, and the callback of the Treasury. A
 * transaction says the same for good (the database refuses an update of what it says): matching it to a payment is the work of the match, and
 * a mistake is corrected by a reversal. Every route to a transaction ends in the same unique key, provider and business key, so the same
 * voucher is never counted twice, whichever way it arrives.
 */
export class PayTreasuryTransactionStore {
  private readonly callbacks = new ProviderCallbackStore();

  /** The transactions of the projects in the scope of the caller, the latest booked first; the cursor is the booking time and the id. */
  async list(tx: TenantTx, scope: ScopeBuilder, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<TreasuryTransactionRow[]> {
    const predicate = scope(4);
    const rows = await tx.query<TransactionSql>(
      `select ${COLUMNS} ${FROM}
        where ($1::text is null or (${timestampKey('t.confirmed_at')}, t.id) < ($1::text, $2::uuid)) and ${predicate.sql}
        order by t.confirmed_at desc, t.id desc limit $3`,
      [request.after?.code ?? null, request.after?.id ?? null, request.limit, ...predicate.params],
    );
    return rows.map(toRow);
  }

  /** One transaction of a project in the scope of the caller; undefined when it does not exist or lies outside the scope. */
  async find(tx: TenantTx, scope: ScopeBuilder, id: string): Promise<TreasuryTransactionRow | undefined> {
    const predicate = scope(2);
    const rows = await tx.query<TransactionSql>(`select ${COLUMNS} ${FROM} where t.id = $1::uuid and ${predicate.sql}`, [normalizeUuid(id, 'id'), ...predicate.params]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  /**
   * Records that a person confirmed a payment with the Treasury by hand, with the evidence document (PAY 3.3, source MANUAL_CONFIRMED). The
   * request must be SENT_TREASURY and in the scope of the caller, and the confirmer is neither the person who drafted it nor the one who sent
   * it (maker and checker). A second confirmation of a request that already has one is refused. The amount is compared with the net of the
   * request: equal, the transaction waits for the match; different, it is in EXCEPTION and an AMOUNT_MISMATCH item with both figures and an
   * owner is opened. The larger figure is never chosen. The request itself does not move: matching settles it.
   */
  async confirmManually(tx: TenantTx, input: ManualConfirmationInput): Promise<ManualConfirmationResult> {
    const now = input.now ?? new Date();
    const actor = normalizeUuid(input.actor, 'actor');
    const documentNo = keyText(input.documentNo, 'document_no');
    const documentDate = dateOf(input.documentDate, 'document_date');
    const amount = amountOf(input.amountVnd);
    const confirmedAt = instantOf(input.confirmedAt, 'confirmed_at');
    const evidence = normalizeUuid(input.evidenceDocumentVersionId, 'evidence_document_version_id');
    const predicate = input.scope(2);
    const [request] = await tx.query<{
      id: string;
      project_id: string;
      project_code: string;
      contract_id: string;
      allocation_line_id: string | null;
      plan_year: number | null;
      status: string;
      net_vnd: string;
      created_by: string | null;
      submitted_by: string | null;
    }>(
      `select pr.id, pr.project_id, p.code as project_code, pr.contract_id, pr.allocation_line_id, pr.plan_year, pr.status, pr.net_vnd::text as net_vnd, pr.created_by, pr.submitted_by
         from ${SCOPE_FROM} join machvon.payment_request pr on pr.tenant_id = p.tenant_id and pr.project_id = p.id
        where pr.id = $1::uuid and ${predicate.sql}
        for update of pr`,
      [normalizeUuid(input.paymentRequestId, 'payment_request_id'), ...predicate.params],
    );
    // A request of another tenant, or outside the scope, is indistinguishable from one that does not exist.
    if (request === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (request.status !== 'SENT_TREASURY') throw new DomainError('PAYMENT_STATE_INVALID', 409, 'status');
    if (request.created_by === actor || request.submitted_by === actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    const [document] = await tx.query<{ scan_status: string }>('select scan_status from machvon.document_version where id = $1::uuid', [evidence]);
    if (document === undefined || document.scan_status !== 'CLEAN') throw invalid('evidence_document_version_id');
    const [held] = await tx.query<{ id: string }>(
      "select id from machvon.treasury_transaction where payment_request_id = $1::uuid and direction = 'PAYMENT' and match_status in ('UNMATCHED', 'MATCHED') limit 1",
      [request.id],
    );
    if (held !== undefined) throw new DomainError('TREASURY_TRANSACTION_DUPLICATE', 409, 'payment_request_id');

    const matchStatus: TreasuryMatchStatus = compareDecimal(amount, request.net_vnd) === 0 ? 'UNMATCHED' : 'EXCEPTION';
    const hash = sha256Hex(canonicalJson({ provider: TREASURY_MANUAL_PROVIDER, document_no: documentNo, document_date: documentDate, project_code: request.project_code, amount_vnd: amount, confirmed_at: confirmedAt, payment_request_id: request.id }));
    const inserted = await tx.query<{ id: string }>(
      `insert into machvon.treasury_transaction
         (tenant_id, id, project_id, contract_id, payment_request_id, allocation_line_id, plan_year, external_id, provider, amount_vnd, confirmed_at, source_hash, row_hash, direction,
          document_no, document_date, source_kind, evidence_document_version_id, match_status, created_by)
       values (${TENANT}, gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::numeric, $9::timestamptz, $10, $10, 'PAYMENT', $11, $12::date, 'MANUAL_CONFIRMED', $13::uuid, $14, $15::uuid)
       on conflict do nothing
       returning id`,
      [
        request.project_id,
        request.contract_id,
        request.id,
        request.allocation_line_id,
        request.plan_year,
        treasuryBusinessKey(TREASURY_MANUAL_PROVIDER, documentNo, documentDate, request.project_code),
        TREASURY_MANUAL_PROVIDER,
        amount,
        confirmedAt,
        hash,
        documentNo,
        documentDate,
        evidence,
        matchStatus,
        actor,
      ],
    );
    const created = inserted[0];
    if (created === undefined) throw new DomainError('TREASURY_TRANSACTION_DUPLICATE', 409, 'document_no');
    let mismatchItemId: string | null = null;
    if (matchStatus === 'EXCEPTION') {
      const [item] = await tx.query<{ id: string }>(
        `insert into machvon.reconciliation_item
           (tenant_id, id, project_id, contract_id, payment_request_id, treasury_transaction_id, kind, internal_amount_vnd, confirmed_amount_vnd, owner_membership_id, due_at, status, created_by, updated_by)
         values (${TENANT}, gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'AMOUNT_MISMATCH', $5::numeric, $6::numeric, $7::uuid, $8::timestamptz + make_interval(secs => $9), 'OPEN', $7::uuid, $7::uuid)
         returning id`,
        [request.project_id, request.contract_id, request.id, created.id, request.net_vnd, amount, actor, now.toISOString(), DEFAULT_ITEM_DUE_SECONDS],
      );
      mismatchItemId = item?.id ?? null;
    }
    return { transactionId: created.id, projectId: request.project_id, paymentRequestId: request.id, documentNo, amountVnd: amount, netVnd: request.net_vnd, matchStatus, mismatchItemId };
  }

  /**
   * Takes a callback of the Treasury (adapter MOCK): the signature is checked, the event is written to the inbox once (provider and event id),
   * and the transaction is created once. The same event again, and the same voucher again with the same content under another event id,
   * answer what the first delivery answered and write nothing. The same voucher with other content is refused (409): the original is never
   * altered. A refund is not taken here, because it names the payment it undoes (PAY 3.4).
   */
  async receiveCallback(tx: TenantTx, input: TreasuryCallbackInput): Promise<TreasuryCallbackResult> {
    const metrics = input.metrics ?? NOOP_METRICS;
    const received = await this.callbacks.receive(tx, {
      provider: input.provider,
      eventKey: input.providerEventId,
      eventType: 'treasury.payment.confirmed',
      rawBody: treasuryCallbackPayload(input),
      signature: input.signature,
      timestampSeconds: callbackTimestampSeconds(input.confirmedAt),
      keys: input.keys,
      scheme: TREASURY_CALLBACK_SCHEME,
      replayWindowSeconds: TREASURY_CALLBACK_WINDOW_SECONDS,
      payloadReference: input.payloadReference,
      metrics,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    // The provider reused an event id for other content: that is not a repeat and is never applied.
    if (received.duplicate && received.payloadChanged) throw new DomainError('TREASURY_TRANSACTION_DUPLICATE', 409, 'provider_event_id');

    const provider = input.provider.trim();
    if (!PROVIDER.test(provider) || RESERVED_PROVIDERS.has(provider)) throw invalid('provider');
    const documentNo = keyText(input.documentNo, 'document_no');
    const documentDate = dateOf(input.documentDate, 'document_date');
    const projectCode = keyText(input.projectCode, 'project_code');
    const amount = amountOf(input.amountVnd);
    const confirmedAt = instantOf(input.confirmedAt, 'confirmed_at');
    // A refund names the payment it undoes, which this event has no field for; it is taken with the reversal (ST-PAY-008).
    if (input.direction !== 'PAYMENT') throw invalid('direction');
    const key = treasuryBusinessKey(provider, documentNo, documentDate, projectCode);
    if (received.duplicate) {
      // The event came before: it created the transaction, or it was itself a repeat of a voucher that did.
      const first = (await this.byEvent(tx, provider, input.providerEventId)) ?? (await this.byKey(tx, provider, key));
      if (first === undefined) throw new Error('a Treasury callback was received without its transaction');
      return { ...first, duplicate: true };
    }
    const [project] = await tx.query<{ id: string }>('select id from machvon.project where code = $1', [projectCode]);
    if (project === undefined) throw invalid('project_code');

    const hash = sha256Hex(canonicalJson({ provider, document_no: documentNo, document_date: documentDate, project_code: projectCode, amount_vnd: amount, confirmed_at: confirmedAt, direction: 'PAYMENT' }));
    const inserted = await tx.query<{ id: string }>(
      `insert into machvon.treasury_transaction
         (tenant_id, id, project_id, external_id, provider, amount_vnd, confirmed_at, source_hash, row_hash, direction, document_no, document_date, source_kind, provider_event_id, match_status, created_by)
       values (${TENANT}, gen_random_uuid(), $1::uuid, $2, $3, $4::numeric, $5::timestamptz, $6, $6, 'PAYMENT', $7, $8::date, 'CALLBACK_MOCK', $9, 'UNMATCHED', $10::uuid)
       on conflict do nothing
       returning id`,
      [project.id, key, provider, amount, confirmedAt, hash, documentNo, documentDate, input.providerEventId, normalizeUuid(input.actor, 'actor')],
    );
    let result: TreasuryCallbackResult;
    if (inserted[0] !== undefined) {
      result = { transactionId: inserted[0].id, matchStatus: 'UNMATCHED', duplicate: false };
    } else {
      const [same] = await tx.query<{ id: string; match_status: TreasuryMatchStatus; row_hash: string | null }>(
        'select id, match_status, row_hash from machvon.treasury_transaction where provider = $1 and external_id = $2',
        [provider, key],
      );
      if (same === undefined) throw new Error('a Treasury transaction vanished after a key conflict');
      // The same voucher with other content never alters the original.
      if (same.row_hash !== hash) throw new DomainError('TREASURY_TRANSACTION_DUPLICATE', 409, 'document_no');
      result = { transactionId: same.id, matchStatus: same.match_status, duplicate: true };
    }
    await tx.query("update machvon.integration_event_inbox set status = 'PROCESSED', processed_at = now(), error_code = $2, next_attempt_at = null where id = $1::uuid", [
      received.inboxId,
      result.duplicate ? 'DUPLICATE_BUSINESS_KEY' : null,
    ]);
    return result;
  }

  private async byKey(tx: TenantTx, provider: string, key: string): Promise<Omit<TreasuryCallbackResult, 'duplicate'> | undefined> {
    const [row] = await tx.query<{ id: string; match_status: TreasuryMatchStatus }>('select id, match_status from machvon.treasury_transaction where provider = $1 and external_id = $2', [provider, key]);
    return row === undefined ? undefined : { transactionId: row.id, matchStatus: row.match_status };
  }

  private async byEvent(tx: TenantTx, provider: string, providerEventId: string): Promise<Omit<TreasuryCallbackResult, 'duplicate'> | undefined> {
    const [row] = await tx.query<{ id: string; match_status: TreasuryMatchStatus }>(
      'select id, match_status from machvon.treasury_transaction where provider = $1 and provider_event_id = $2',
      [provider, providerEventId],
    );
    return row === undefined ? undefined : { transactionId: row.id, matchStatus: row.match_status };
  }
}
