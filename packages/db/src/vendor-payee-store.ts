import { randomUUID } from 'node:crypto';
import { DomainError, bankChangeProgress, effectiveAfterOf, hasControlChar, holderMatchesLegalName, maskTail, matchKeyOf, moveBankChange, normaliseAccountNumber, normalisePhoneNumber, payeeVerdict, versionConflict, vietnamDateOf } from '@machvon/kernel';
import type { BankApprovalRole, BankChangeFacts, BankChangeMove, BankChangeState, CallbackOutcome, FieldCipher, PayeeAccountFacts, PayeeAccountPolicy, PayeeAccountState, PayeeVerdict } from '@machvon/kernel';
import { timestampKey } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';
import { VendorPolicyReader } from './vendor-policy.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const REQUEST_TABLE = 'contractor_bank_change_request';
const ACCOUNT_TABLE = 'contractor_bank_account';
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export interface AccountRow {
  id: string;
  contractorId: string;
  bankName: string;
  accountHolder: string;
  holderMatchesLegalName: boolean;
  accountNoMasked: string;
  state: PayeeAccountState;
  effectiveAfter: string;
  /** The account is valid for a payment now: ACTIVE and its waiting period is over. */
  validNow: boolean;
  changeRequestId: string;
  supersededById: string | null;
  supersededAt: string | null;
  closedReason: string | null;
  version: number;
}

export interface PayeeChangeRow {
  id: string;
  contractorId: string;
  contractorName: string;
  bankName: string;
  accountHolder: string;
  holderMatchesLegalName: boolean;
  accountNoMasked: string;
  reason: string;
  evidenceDocumentId: string;
  status: BankChangeState;
  requestedBy: string;
  requestedAt: string;
  expiresAt: string;
  contractMatchBy: string | null;
  contractMatchAt: string | null;
  contractMatchNote: string | null;
  accountMatchBy: string | null;
  accountMatchAt: string | null;
  accountMatchNote: string | null;
  callbackBy: string | null;
  callbackAt: string | null;
  callbackOutcome: CallbackOutcome | null;
  callbackNumberLast4: string | null;
  callbackNote: string | null;
  closedBy: string | null;
  closedAt: string | null;
  closedReason: string | null;
  resultingAccountId: string | null;
  /** What is still missing, in the order a person does it. */
  remaining: Array<'CONTRACT_MATCH' | 'ACCOUNT_MATCH' | 'CALLBACK'>;
  version: number;
}

export interface BankEventRow {
  id: string;
  changeRequestId: string | null;
  accountId: string | null;
  action: string;
  actorId: string;
  note: string | null;
  occurredAt: string;
}

export interface NewChangeRequest {
  bankName: string;
  accountHolder: string;
  accountNumber: string;
  reason: string;
  evidenceDocumentId: string;
}

export interface CallbackInput {
  outcome: CallbackOutcome;
  /** The number the person dialled: compared with the number the profile holds, never stored (only its last four digits are). */
  calledNumber: string;
  /** The person says the call was made to the number on file and not to one in the request. */
  usedNumberOnFile: boolean;
  note?: string | undefined;
}

interface RequestSql {
  id: string;
  contractor_id: string;
  contractor_name: string;
  bank_name: string;
  account_holder: string;
  holder_matches_legal_name: boolean;
  account_no_masked: string;
  reason: string;
  evidence_document_id: string;
  status: BankChangeState;
  requested_by: string;
  requested_at: string;
  expires_at: string;
  contract_match_by: string | null;
  contract_match_at: string | null;
  contract_match_note: string | null;
  account_match_by: string | null;
  account_match_at: string | null;
  account_match_note: string | null;
  callback_by: string | null;
  callback_at: string | null;
  callback_outcome: CallbackOutcome | null;
  callback_number_last4: string | null;
  callback_note: string | null;
  closed_by: string | null;
  closed_at: string | null;
  closed_reason: string | null;
  resulting_account_id: string | null;
  version: string;
}

const REQUEST_SELECT = `select r.id, r.contractor_id, c.legal_name as contractor_name, r.bank_name, r.account_holder, r.holder_matches_legal_name, r.account_no_masked, r.reason, r.evidence_document_id, r.status, r.requested_by,
  ${timestampKey('r.requested_at')} as requested_at, ${timestampKey('r.expires_at')} as expires_at, r.contract_match_by, ${timestampKey('r.contract_match_at')} as contract_match_at, r.contract_match_note,
  r.account_match_by, ${timestampKey('r.account_match_at')} as account_match_at, r.account_match_note, r.callback_by, ${timestampKey('r.callback_at')} as callback_at, r.callback_outcome, r.callback_number_last4, r.callback_note,
  r.closed_by, ${timestampKey('r.closed_at')} as closed_at, r.closed_reason, r.resulting_account_id, r.version::text as version
  from machvon.contractor_bank_change_request r join machvon.contractor c on c.tenant_id = r.tenant_id and c.id = r.contractor_id`;

const toRequest = (row: RequestSql): PayeeChangeRow => ({
  id: row.id,
  contractorId: row.contractor_id,
  contractorName: row.contractor_name,
  bankName: row.bank_name,
  accountHolder: row.account_holder,
  holderMatchesLegalName: row.holder_matches_legal_name,
  accountNoMasked: row.account_no_masked,
  reason: row.reason,
  evidenceDocumentId: row.evidence_document_id,
  status: row.status,
  requestedBy: row.requested_by,
  requestedAt: row.requested_at,
  expiresAt: row.expires_at,
  contractMatchBy: row.contract_match_by,
  contractMatchAt: row.contract_match_at,
  contractMatchNote: row.contract_match_note,
  accountMatchBy: row.account_match_by,
  accountMatchAt: row.account_match_at,
  accountMatchNote: row.account_match_note,
  callbackBy: row.callback_by,
  callbackAt: row.callback_at,
  callbackOutcome: row.callback_outcome,
  callbackNumberLast4: row.callback_number_last4,
  callbackNote: row.callback_note,
  closedBy: row.closed_by,
  closedAt: row.closed_at,
  closedReason: row.closed_reason,
  resultingAccountId: row.resulting_account_id,
  remaining: row.status === 'REQUESTED' ? bankChangeProgress({ contractMatchBy: row.contract_match_by, accountMatchBy: row.account_match_by, callbackOutcome: row.callback_outcome }) : [],
  version: Number(row.version),
});

interface AccountSql {
  id: string;
  contractor_id: string;
  bank_name: string;
  account_holder: string;
  holder_matches_legal_name: boolean;
  account_no_masked: string;
  state: PayeeAccountState;
  effective_after: string;
  change_request_id: string;
  superseded_by_id: string | null;
  superseded_at: string | null;
  closed_reason: string | null;
  version: string;
}

const ACCOUNT_SELECT = `select id, contractor_id, bank_name, account_holder, holder_matches_legal_name, account_no_masked, state, ${timestampKey('effective_after')} as effective_after, change_request_id, superseded_by_id,
  ${timestampKey('superseded_at')} as superseded_at, closed_reason, version::text as version from machvon.contractor_bank_account`;

const toAccount = (row: AccountSql, now: Date): AccountRow => ({
  id: row.id,
  contractorId: row.contractor_id,
  bankName: row.bank_name,
  accountHolder: row.account_holder,
  holderMatchesLegalName: row.holder_matches_legal_name,
  accountNoMasked: row.account_no_masked,
  state: row.state,
  effectiveAfter: row.effective_after,
  validNow: row.state === 'ACTIVE' && Date.parse(row.effective_after) <= now.getTime(),
  changeRequestId: row.change_request_id,
  supersededById: row.superseded_by_id,
  supersededAt: row.superseded_at,
  closedReason: row.closed_reason,
  version: Number(row.version),
});

function textOf(value: string, field: string, min: number, max: number): string {
  const text = value.trim();
  if (text.length < min || text.length > max || hasControlChar(text)) throw invalid(field);
  return text;
}

/**
 * The accounts a contractor is paid into and the control of a change of account (VND-1, V12). The number of an account is sealed with the field cipher and indexed blind; it is shown only masked. A change of account is a
 * request that two people approve in separate roles and that somebody confirms by a call to the number the profile already held; it takes effect after the waiting period of the rule `VENDOR_PAYEE_ACCOUNT`, and a payment
 * looks at `verdict`. Every step is audited by the caller and recorded in the append-only chain of `contractor_bank_event`.
 */
export class VendorPayeeStore {
  private readonly sealer: FieldCipher | undefined;
  private readonly policies: VendorPolicyReader;

  /** The cipher is needed to take a request and to activate an account; the reads and the verdict of a payment need none, so the gates build the store without one. */
  constructor(cipher?: FieldCipher, policies: VendorPolicyReader = new VendorPolicyReader()) {
    this.sealer = cipher;
    this.policies = policies;
  }

  private get cipher(): FieldCipher {
    if (this.sealer === undefined) throw new DomainError('PROVIDER_UNAVAILABLE', 503);
    return this.sealer;
  }

  private async tenantOf(tx: TenantTx): Promise<string> {
    const [row] = await tx.query<{ tenant: string }>("select nullif(current_setting('app.tenant_id', true), '')::text as tenant");
    return (row as { tenant: string }).tenant;
  }

  private async event(tx: TenantTx, contractorId: string, requestId: string | null, accountId: string | null, action: string, actor: string, note: string | null): Promise<void> {
    await tx.query(
      `insert into machvon.contractor_bank_event (tenant_id, id, contractor_id, change_request_id, account_id, action, actor_id, note, occurred_at) values (${TENANT}, gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6, clock_timestamp())`,
      [contractorId, requestId, accountId, action, actor, note],
    );
  }

  async accounts(tx: TenantTx, contractorId: string, now: Date): Promise<AccountRow[]> {
    const rows = await tx.query<AccountSql>(`${ACCOUNT_SELECT} where contractor_id = $1::uuid order by created_at desc, id desc`, [contractorId]);
    return rows.map((row) => toAccount(row, now));
  }

  async requests(tx: TenantTx, filter: { contractorId?: string | undefined; status?: BankChangeState | undefined; limit?: number | undefined }): Promise<PayeeChangeRow[]> {
    const rows = await tx.query<RequestSql>(`${REQUEST_SELECT} where ($1::uuid is null or r.contractor_id = $1::uuid) and ($2::text is null or r.status = $2) order by r.requested_at desc, r.id desc limit $3`, [filter.contractorId ?? null, filter.status ?? null, filter.limit ?? 200]);
    return rows.map(toRequest);
  }

  async findRequest(tx: TenantTx, id: string, lock = false): Promise<PayeeChangeRow | undefined> {
    const rows = await tx.query<RequestSql>(`${REQUEST_SELECT} where r.id = $1::uuid${lock ? ' for update of r' : ''}`, [id]);
    return rows[0] === undefined ? undefined : toRequest(rows[0]);
  }

  async events(tx: TenantTx, contractorId: string, limit = 100): Promise<BankEventRow[]> {
    const rows = await tx.query<{ id: string; change_request_id: string | null; account_id: string | null; action: string; actor_id: string; note: string | null; occurred_at: string }>(
      `select id, change_request_id, account_id, action, actor_id, note, ${timestampKey('occurred_at')} as occurred_at from machvon.contractor_bank_event where contractor_id = $1::uuid order by occurred_at desc, id desc limit $2`,
      [contractorId, limit],
    );
    return rows.map((row) => ({ id: row.id, changeRequestId: row.change_request_id, accountId: row.account_id, action: row.action, actorId: row.actor_id, note: row.note, occurredAt: row.occurred_at }));
  }

  /**
   * Opens a request to change the account of a contractor (a first account goes through the same control). The contractor must be VERIFIED and must hold a telephone number on file to be called back on (422
   * `BANK_CHANGE_CALLBACK_INVALID`, reason NO_NUMBER_ON_FILE); the holder must be the legal name of the contractor when the policy says REQUIRE (422 `PAYEE_ACCOUNT_NAME_MISMATCH`); the letter of the contractor is the evidence
   * (a document of the tenant); one request is open for a contractor at a time (409 `BANK_CHANGE_STATE_INVALID`).
   */
  async request(tx: TenantTx, contractorId: string, input: NewChangeRequest, actor: string, now: Date): Promise<PayeeChangeRow> {
    const today = vietnamDateOf(now);
    const policy = (await this.policies.payee(tx, today)).value;
    const [contractor] = await tx.query<{ legal_name: string; verification_status: string; phone_key: string | null }>('select legal_name, verification_status, phone_key from machvon.contractor where id = $1::uuid for update', [contractorId]);
    if (contractor === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (contractor.verification_status !== 'VERIFIED') throw new DomainError('CONTRACTOR_NOT_VERIFIED', 422);
    if (contractor.phone_key === null) throw new DomainError('BANK_CHANGE_CALLBACK_INVALID', 422, 'phone', { extensions: { reason: 'NO_NUMBER_ON_FILE' } });
    const bankName = textOf(input.bankName, 'bank_name', 2, 200);
    const holder = textOf(input.accountHolder, 'account_holder', 2, 300);
    const reason = textOf(input.reason, 'reason', 10, 500);
    const number = normaliseAccountNumber(input.accountNumber);
    const matches = holderMatchesLegalName(holder, contractor.legal_name);
    if (!matches && policy.name_match === 'REQUIRE') throw new DomainError('PAYEE_ACCOUNT_NAME_MISMATCH', 422, 'account_holder');
    if ((await tx.query('select 1 from machvon.document where id = $1::uuid', [input.evidenceDocumentId])).length === 0) throw invalid('evidence_document_id');
    const open = await tx.query<{ id: string }>("select id from machvon.contractor_bank_change_request where contractor_id = $1::uuid and status = 'REQUESTED'", [contractorId]);
    if (open[0] !== undefined) throw new DomainError('BANK_CHANGE_STATE_INVALID', 409, 'status', { extensions: { status: 'REQUESTED', change_request_id: open[0].id } });
    const tenantId = await this.tenantOf(tx);
    const id = randomUUID();
    const sealed = this.cipher.seal({ tenantId, table: REQUEST_TABLE, column: 'account_no_enc', rowId: id }, number);
    const key = this.cipher.blindIndex(tenantId, 'payee-account', number);
    const expires = new Date(now.getTime() + policy.request_valid_days * 86_400_000);
    await tx.query(
      `insert into machvon.contractor_bank_change_request
         (tenant_id, id, contractor_id, bank_name, account_holder, holder_matches_legal_name, account_no_enc, account_no_masked, account_no_key, reason, evidence_document_id, requested_by, requested_at, expires_at, profile_phone_key)
       values (${TENANT}, $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::uuid, $11::uuid, $12::timestamptz, $13::timestamptz, $14)`,
      [id, contractorId, bankName, holder, matches, sealed, maskTail(number, 4), key, reason, input.evidenceDocumentId, actor, now.toISOString(), expires.toISOString(), contractor.phone_key],
    );
    await this.event(tx, contractorId, id, null, 'REQUESTED', actor, reason);
    return (await this.findRequest(tx, id)) as PayeeChangeRow;
  }

  private factsOf(row: PayeeChangeRow): BankChangeFacts {
    return {
      state: row.status,
      requestedBy: row.requestedBy,
      requestedAt: new Date(row.requestedAt),
      expiresAt: new Date(row.expiresAt),
      contractMatchBy: row.contractMatchBy,
      accountMatchBy: row.accountMatchBy,
      callbackBy: row.callbackBy,
      callbackOutcome: row.callbackOutcome,
      nameMatch: row.holderMatchesLegalName,
    };
  }

  private async locked(tx: TenantTx, id: string, expectedVersion: number): Promise<PayeeChangeRow> {
    const row = await this.findRequest(tx, id, true);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (row.version !== expectedVersion) throw versionConflict(row.version);
    return row;
  }

  /** One of the two approvals. The second approver is another person than the first and than the requester (403 `SELF_APPROVAL_DENIED`). When it completes the change the new account is activated here. */
  async approve(tx: TenantTx, id: string, expectedVersion: number, role: BankApprovalRole, note: string | undefined, actor: string, now: Date): Promise<{ request: PayeeChangeRow; account: AccountRow | null }> {
    const current = await this.locked(tx, id, expectedVersion);
    const policy = (await this.policies.payee(tx, vietnamDateOf(now))).value;
    const why = note === undefined ? null : textOf(note, 'note', 1, 500);
    const effect = moveBankChange(this.factsOf(current), { move: 'APPROVE', role, by: actor, at: now } satisfies BankChangeMove, policy);
    const column = role === 'CONTRACT_MATCH' ? 'contract_match' : 'account_match';
    await tx.query(`update machvon.contractor_bank_change_request set ${column}_by = $2::uuid, ${column}_at = $3::timestamptz, ${column}_note = $4, version = version + 1 where id = $1::uuid`, [id, actor, now.toISOString(), why]);
    await this.event(tx, current.contractorId, id, null, role === 'CONTRACT_MATCH' ? 'CONTRACT_MATCHED' : 'ACCOUNT_MATCHED', actor, why);
    const account = effect.activated ? await this.activate(tx, current, actor, now, policy) : null;
    return { request: (await this.findRequest(tx, id)) as PayeeChangeRow, account };
  }

  /**
   * The call to the contractor. It is valid only when the person says the number called is the one on file, the number dialled is the number the profile holds now and held when the request was made, and the number has been on
   * file long enough (422 `BANK_CHANGE_CALLBACK_INVALID`). A call that does not confirm rejects the request at once; one that does is recorded and, when it completes the change, activates the account.
   */
  async callback(tx: TenantTx, id: string, expectedVersion: number, input: CallbackInput, actor: string, now: Date): Promise<{ request: PayeeChangeRow; account: AccountRow | null }> {
    const current = await this.locked(tx, id, expectedVersion);
    const policy = (await this.policies.payee(tx, vietnamDateOf(now))).value;
    const note = input.note === undefined ? null : textOf(input.note, 'note', 1, 500);
    const dialled = normalisePhoneNumber(input.calledNumber);
    if (dialled === null) throw invalid('called_number');
    const [held] = await tx.query<{ phone_key: string | null; phone_set_at: string | null; request_phone_key: string | null }>(
      `select c.phone_key, ${timestampKey('c.phone_set_at')} as phone_set_at, r.profile_phone_key as request_phone_key
         from machvon.contractor c join machvon.contractor_bank_change_request r on r.tenant_id = c.tenant_id and r.contractor_id = c.id where r.id = $1::uuid`,
      [id],
    );
    const dialledKey = matchKeyOf(dialled);
    const matches = held?.phone_key !== null && held?.phone_key === dialledKey && held?.request_phone_key === dialledKey;
    const effect = moveBankChange(
      this.factsOf(current),
      { move: 'CALLBACK', by: actor, at: now, outcome: input.outcome, usedNumberOnFile: input.usedNumberOnFile, numberMatchesFile: matches, numberOnFileSince: held?.phone_set_at === null || held === undefined ? null : new Date(held.phone_set_at) },
      policy,
    );
    await tx.query(
      `update machvon.contractor_bank_change_request set callback_by = $2::uuid, callback_at = $3::timestamptz, callback_outcome = $4, callback_number_last4 = $5, callback_note = $6,
              status = $7, closed_by = $8::uuid, closed_at = $9::timestamptz, closed_reason = $10, version = version + 1 where id = $1::uuid`,
      [id, actor, now.toISOString(), input.outcome, dialled.slice(-4), note, effect.autoRejected ? 'REJECTED' : 'REQUESTED', effect.autoRejected ? actor : null, effect.autoRejected ? now.toISOString() : null, effect.autoRejected ? 'The contractor did not confirm the change when called back' : null],
    );
    await this.event(tx, current.contractorId, id, null, input.outcome === 'CONFIRMED' ? 'CALLBACK_CONFIRMED' : 'CALLBACK_FAILED', actor, note);
    const account = effect.activated ? await this.activate(tx, current, actor, now, policy) : null;
    return { request: (await this.findRequest(tx, id)) as PayeeChangeRow, account };
  }

  /** Rejects (anybody but the requester, with a reason) or cancels (the requester only) an open request. */
  async close(tx: TenantTx, id: string, expectedVersion: number, kind: 'REJECT' | 'CANCEL', reason: string, actor: string, now: Date): Promise<PayeeChangeRow> {
    const current = await this.locked(tx, id, expectedVersion);
    const policy = (await this.policies.payee(tx, vietnamDateOf(now))).value;
    const why = textOf(reason, 'reason', 5, 500);
    const effect = moveBankChange(this.factsOf(current), kind === 'REJECT' ? { move: 'REJECT', by: actor, at: now, reason: why } : { move: 'CANCEL', by: actor, at: now, reason: why }, policy);
    await tx.query("update machvon.contractor_bank_change_request set status = $2, closed_by = $3::uuid, closed_at = $4::timestamptz, closed_reason = $5, version = version + 1 where id = $1::uuid", [id, effect.facts.state, actor, now.toISOString(), why]);
    await this.event(tx, current.contractorId, id, null, kind === 'REJECT' ? 'REJECTED' : 'CANCELLED', actor, why);
    return (await this.findRequest(tx, id)) as PayeeChangeRow;
  }

  /** The job: requests that ran out are closed as EXPIRED (by the system actor given). Returns how many. */
  async expireDue(tx: TenantTx, now: Date, actor: string): Promise<number> {
    const due = await tx.query<{ id: string; contractor_id: string }>("select id, contractor_id from machvon.contractor_bank_change_request where status = 'REQUESTED' and expires_at < $1::timestamptz for update", [now.toISOString()]);
    for (const row of due) {
      await tx.query("update machvon.contractor_bank_change_request set status = 'EXPIRED', closed_by = $2::uuid, closed_at = $3::timestamptz, closed_reason = 'The request ran out before it was confirmed', version = version + 1 where id = $1::uuid", [row.id, actor, now.toISOString()]);
      await this.event(tx, row.contractor_id, row.id, null, 'EXPIRED', actor, null);
    }
    return due.length;
  }

  /** Closes the account in force (a contractor that no longer exists, an account the bank closed): payments to the contractor are blocked until a new one is confirmed. A reason of 5 characters. */
  async closeAccount(tx: TenantTx, accountId: string, expectedVersion: number, reason: string, actor: string, now: Date): Promise<AccountRow> {
    const why = textOf(reason, 'reason', 5, 500);
    const [row] = await tx.query<AccountSql>(`${ACCOUNT_SELECT} where id = $1::uuid for update`, [accountId]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    if (row.state !== 'ACTIVE') throw new DomainError('BANK_CHANGE_STATE_INVALID', 409, 'state', { extensions: { status: row.state } });
    await tx.query("update machvon.contractor_bank_account set state = 'CLOSED', closed_by = $2::uuid, closed_at = $3::timestamptz, closed_reason = $4, version = version + 1 where id = $1::uuid", [accountId, actor, now.toISOString(), why]);
    await this.event(tx, row.contractor_id, null, accountId, 'ACCOUNT_CLOSED', actor, why);
    const [after] = await tx.query<AccountSql>(`${ACCOUNT_SELECT} where id = $1::uuid`, [accountId]);
    return toAccount(after as AccountSql, now);
  }

  private async activate(tx: TenantTx, request: PayeeChangeRow, actor: string, now: Date, policy: PayeeAccountPolicy): Promise<AccountRow> {
    const tenantId = await this.tenantOf(tx);
    const [sealed] = await tx.query<{ account_no_enc: Buffer; account_no_key: string }>('select account_no_enc, account_no_key from machvon.contractor_bank_change_request where id = $1::uuid', [request.id]);
    const number = this.cipher.open({ tenantId, table: REQUEST_TABLE, column: 'account_no_enc', rowId: request.id }, (sealed as { account_no_enc: Buffer }).account_no_enc);
    const accountId = randomUUID();
    const effectiveAfter = effectiveAfterOf(now, policy);
    // The account in force is superseded first: one account is valid at a time (the unique index), and the new one waits for its period.
    await tx.query("update machvon.contractor_bank_account set state = 'SUPERSEDED', superseded_by_id = $2::uuid, superseded_at = $3::timestamptz, version = version + 1 where contractor_id = $1::uuid and state = 'ACTIVE'", [request.contractorId, accountId, now.toISOString()]);
    await tx.query(
      `insert into machvon.contractor_bank_account
         (tenant_id, id, contractor_id, bank_name, account_holder, holder_matches_legal_name, account_no_enc, account_no_masked, account_no_key, state, effective_after, change_request_id, created_by)
       values (${TENANT}, $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, 'ACTIVE', $9::timestamptz, $10::uuid, $11::uuid)`,
      [accountId, request.contractorId, request.bankName, request.accountHolder, request.holderMatchesLegalName, this.cipher.seal({ tenantId, table: ACCOUNT_TABLE, column: 'account_no_enc', rowId: accountId }, number), request.accountNoMasked, (sealed as { account_no_key: string }).account_no_key, effectiveAfter.toISOString(), request.id, actor],
    );
    await tx.query("update machvon.contractor_bank_change_request set status = 'ACTIVATED', resulting_account_id = $2::uuid where id = $1::uuid", [request.id, accountId]);
    await this.event(tx, request.contractorId, request.id, accountId, 'ACTIVATED', actor, null);
    const [row] = await tx.query<AccountSql>(`${ACCOUNT_SELECT} where id = $1::uuid`, [accountId]);
    return toAccount(row as AccountSql, now);
  }

  /** What a payment to this contractor may do now: the verdict of the kernel on the accounts of the contractor under the policy in force. Reads only. */
  async verdict(tx: TenantTx, contractorId: string, now: Date): Promise<{ verdict: PayeeVerdict; policyVersion: string; unverified: boolean }> {
    const policy = await this.policies.payee(tx, vietnamDateOf(now));
    const accounts = await tx.query<{ id: string; state: PayeeAccountState; effective_after: string; superseded_by_id: string | null; superseded_at: string | null }>(
      `select id, state, ${timestampKey('effective_after')} as effective_after, superseded_by_id, ${timestampKey('superseded_at')} as superseded_at from machvon.contractor_bank_account where contractor_id = $1::uuid`,
      [contractorId],
    );
    const pending = await tx.query("select 1 from machvon.contractor_bank_change_request where contractor_id = $1::uuid and status = 'REQUESTED'", [contractorId]);
    const facts: PayeeAccountFacts[] = accounts.map((row) => ({ id: row.id, state: row.state, effectiveAfter: new Date(row.effective_after), supersededById: row.superseded_by_id, supersededAt: row.superseded_at === null ? null : new Date(row.superseded_at) }));
    return { verdict: payeeVerdict(facts, pending.length > 0, now, policy.value), policyVersion: policy.version, unverified: policy.unverified };
  }

  /** Accounts that more than one contractor holds (the same blind index): the signal V-A6 sends to the auditors. */
  async sharedAccounts(tx: TenantTx): Promise<Array<{ accountNoKey: string; contractorIds: string[] }>> {
    const rows = await tx.query<{ key: string; ids: string[] }>(
      `select account_no_key::text as key, array_agg(distinct contractor_id) as ids from machvon.contractor_bank_account where state in ('ACTIVE', 'SUPERSEDED') group by account_no_key having count(distinct contractor_id) > 1`,
    );
    return rows.map((row) => ({ accountNoKey: row.key, contractorIds: row.ids }));
  }
}
