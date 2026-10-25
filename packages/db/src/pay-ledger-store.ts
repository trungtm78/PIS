import { randomUUID } from 'node:crypto';
import { DomainError, NOOP_METRICS, ZERO_BALANCE, advanceOutstanding, applyDelta, assertEntryShape, assertLedgerInvariants, negate } from '@machvon/kernel';
import type { LedgerBalance, LedgerDelta, LedgerEntryKind, MetricsSink } from '@machvon/kernel';
import { SCOPE_FROM as CONTRACT_SCOPE_FROM, TIMESTAMP } from './ctr-contract-store.ts';
import { lockLedgerRows } from './ledger-lock.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/** Seconds the last writer of the ledger waited for the lock of the contract (a gauge). */
export const PAY_LEDGER_LOCK_WAIT_METRIC = 'pay_ledger_lock_wait_seconds';
/** Entries refused before they reached the database because they would break a rule of the ledger, by rule (a counter). */
export const PAY_VALUE_EXCEEDED_METRIC = 'pay_value_exceeded_total';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PAGE = 200;
const DEFAULT_PAGE = 50;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const idOf = (value: string, field: string): string => {
  if (!UUID.test(value)) throw invalid(field);
  return value.toLowerCase();
};

/** One balance of the ledger as the database holds it. */
interface LedgerRow {
  id: string;
  version: string;
  balance: LedgerBalance;
}

interface LedgerRowSql {
  id: string;
  version: string;
  accepted_vnd: string;
  requested_vnd: string;
  paid_vnd: string;
  advance_recovered_vnd: string;
  retention_held_vnd: string;
}

const toRow = (row: LedgerRowSql): LedgerRow => ({
  id: row.id,
  version: row.version,
  balance: {
    acceptedVnd: row.accepted_vnd,
    requestedVnd: row.requested_vnd,
    paidVnd: row.paid_vnd,
    advanceRecoveredVnd: row.advance_recovered_vnd,
    retentionHeldVnd: row.retention_held_vnd,
  },
});

const BALANCE_COLUMNS = `id, version::text as version, accepted_vnd::text as accepted_vnd, requested_vnd::text as requested_vnd, paid_vnd::text as paid_vnd,
       advance_recovered_vnd::text as advance_recovered_vnd, retention_held_vnd::text as retention_held_vnd`;

export interface PostedEntry {
  id: string;
  ledgerId: string;
  kind: LedgerEntryKind;
  delta: LedgerDelta;
  balance: LedgerBalance;
}

export interface PostEntryInput {
  ledgerId: string;
  kind: LedgerEntryKind;
  delta: LedgerDelta;
  /** The entry this one reverses; a reversal names it and a forward entry does not. */
  reversalOfId?: string | undefined;
  paymentRequestId?: string | undefined;
  reason?: string | undefined;
  /** The identifier of the request that asked for the entry (the event that was delivered, the command that was sent). */
  requestId: string;
  actor: string;
  /** The advance of the contract still to be recovered when the entry is posted. */
  advanceOutstandingVnd: string;
}

export interface LedgerOutcome {
  /** `skipped` when the acceptance is not in the status the event says (the state is read, not the event). */
  outcome: 'posted' | 'skipped' | 'unchanged';
  entries: number;
  acceptedVnd: string;
}

export interface LedgerEntryView {
  id: string;
  kind: LedgerEntryKind;
  acceptedDeltaVnd: string;
  requestedDeltaVnd: string;
  paidDeltaVnd: string;
  advanceRecoveryDeltaVnd: string;
  retentionDeltaVnd: string;
  advanceOutstandingAfterVnd: string;
  reversalOfId: string | null;
  paymentRequestId: string | null;
  reason: string | null;
  postedAt: string;
}

export interface LedgerLineView extends LedgerBalance {
  id: string;
  boqItemId: string;
  boqItemKey: string;
  description: string;
  unitCode: string;
  acceptanceId: string;
  acceptanceNo: string | null;
  partyId: string | null;
  version: string;
  createdAt: string;
  entries: LedgerEntryView[];
}

export interface LedgerHeaderView {
  contractId: string;
  contractCode: string;
  contractVersion: number;
  contractValueVnd: string;
  acceptedTotalVnd: string;
  requestedTotalVnd: string;
  paidTotalVnd: string;
  advancePaidVnd: string;
  advanceRecoveredVnd: string;
  advanceOutstandingVnd: string;
  retentionHeldVnd: string;
  retentionReleasedVnd: string;
}

export interface LedgerPage {
  header: LedgerHeaderView;
  items: LedgerLineView[];
  /** What the lines that match the filter add up to. */
  total: LedgerBalance;
  /** Whether the balances of the whole contract add up to what the contract says it accepted. */
  reconciled: boolean;
  hasMore: boolean;
}

export interface LedgerFilter {
  boqItemId?: string | undefined;
  acceptanceId?: string | undefined;
  limit?: number | undefined;
  after?: { createdAt: string; id: string } | undefined;
}

interface ReadSql extends LedgerRowSql {
  boq_item_id: string;
  boq_item_key: string;
  description: string;
  unit_code: string;
  acceptance_id: string;
  acceptance_no: string | null;
  party_id: string | null;
  created_at: string;
}

interface EntrySql {
  id: string;
  ledger_id: string;
  entry_kind: LedgerEntryKind;
  accepted_delta_vnd: string;
  requested_delta_vnd: string;
  paid_delta_vnd: string;
  advance_recovery_delta_vnd: string;
  retention_delta_vnd: string;
  advance_outstanding_after_vnd: string;
  reversal_of_id: string | null;
  payment_request_id: string | null;
  reason: string | null;
  posted_at: string;
}

/**
 * The cumulative ledger of a contract (ST-PAY-001, PAY 3.1, BR-PAY-01). The balances are written only together with the entry that explains them, with the contract row locked first and the
 * balances next in the order of their identifiers (the lock order of the ledger registry), so two writers never wait for each other in a circle. An acceptance that is approved is recognised once
 * on each item it holds, and one that is revoked is taken back by entries that are the opposite of the first, whoever delivers the event and however often; both read the state of the acceptance
 * under the lock, never the order of the events.
 */
export class PayLedgerStore {
  private readonly metrics: MetricsSink;
  private readonly applicationChecks: boolean;

  /**
   * `applicationChecks: false` is for the tests that prove the database holds the rules when the checks of the application are bypassed (UAT-AC321): an entry that would break a rule is then
   * refused by the CHECKs of the tables, and told as the same 409 `VALUE_EXCEEDED`.
   */
  constructor(metrics: MetricsSink = NOOP_METRICS, options: { applicationChecks?: boolean } = {}) {
    this.metrics = metrics;
    this.applicationChecks = options.applicationChecks ?? true;
  }

  /** Recognises an approved acceptance: one entry on the balance of each item, worth the lines of the item. */
  async recognize(tx: TenantTx, input: { acceptanceId: string; requestId: string; actor: string }): Promise<LedgerOutcome> {
    return this.settle(tx, input, 'APPROVED', async (held) => {
      const lines = await tx.query<{ boq_item_id: string; party_id: string | null; amount_vnd: string }>(
        `select boq_item_id, party_id, sum(amount_vnd)::text as amount_vnd from machvon.acceptance_line where acceptance_id = $1::uuid
          group by boq_item_id, party_id order by boq_item_id, party_id nulls first`,
        [held.acceptanceId],
      );
      const rows = await this.rowsFor(tx, held, lines);
      let entries = 0;
      for (const line of lines) {
        const ledger = rows.get(`${line.boq_item_id}:${line.party_id ?? ''}`);
        if (ledger === undefined) continue;
        const done = await tx.query('select 1 from machvon.cumulative_ledger_entry where ledger_id = $1::uuid and entry_kind = \'RECOGNIZE_ACCEPTANCE\'', [ledger]);
        if (done.length > 0) continue;
        await this.post(tx, {
          ledgerId: ledger,
          kind: 'RECOGNIZE_ACCEPTANCE',
          delta: { accepted: line.amount_vnd, requested: '0', paid: '0', advanceRecovery: '0', retention: '0' },
          requestId: held.requestId,
          actor: held.actor,
          advanceOutstandingVnd: held.advanceOutstandingVnd,
        });
        entries += 1;
      }
      return entries;
    });
  }

  /** Takes a revoked acceptance back: the entries that recognised it are reversed, once. */
  async revoke(tx: TenantTx, input: { acceptanceId: string; requestId: string; actor: string }): Promise<LedgerOutcome> {
    return this.settle(tx, input, 'REVOKED', async (held) => {
      const recognised = await tx.query<{ id: string; ledger_id: string }>(
        `select e.id, e.ledger_id from machvon.cumulative_ledger_entry e
          where e.acceptance_id = $1::uuid and e.entry_kind = 'RECOGNIZE_ACCEPTANCE'
            and not exists (select 1 from machvon.cumulative_ledger_entry r where r.tenant_id = e.tenant_id and r.reversal_of_id = e.id)
          order by e.ledger_id`,
        [held.acceptanceId],
      );
      await lockLedgerRows(tx, recognised.map((row) => ({ table: 'cumulative_ledger', id: row.ledger_id })));
      for (const entry of recognised) {
        const [original] = await tx.query<{ accepted: string; requested: string; paid: string; recovered: string; retention: string }>(
          `select accepted_delta_vnd::text as accepted, requested_delta_vnd::text as requested, paid_delta_vnd::text as paid, advance_recovery_delta_vnd::text as recovered,
                  retention_delta_vnd::text as retention from machvon.cumulative_ledger_entry where id = $1::uuid`,
          [entry.id],
        );
        await this.post(tx, {
          ledgerId: entry.ledger_id,
          kind: 'REVOKE_ACCEPTANCE',
          delta: negate({ accepted: original!.accepted, requested: original!.requested, paid: original!.paid, advanceRecovery: original!.recovered, retention: original!.retention }),
          reversalOfId: entry.id,
          requestId: held.requestId,
          actor: held.actor,
          advanceOutstandingVnd: held.advanceOutstandingVnd,
        });
      }
      return recognised.length;
    });
  }

  /**
   * Takes back what a payment request put on the ledger (PAY 3.1, the branch of the return): the retention it held is released, the advance it recovered is given back and the claim is released,
   * in that order (what is recovered and held is part of what is requested), each by an entry that is the opposite of the one it undoes and says so. An entry already undone is not undone twice.
   * The caller holds the lock of the contract and has moved the totals of the contract; `advanceOutstandingVnd` is the advance still to recover after the return.
   */
  async releaseRequest(tx: TenantTx, input: { paymentRequestId: string; requestId: string; actor: string; advanceOutstandingVnd: string; reason?: string | undefined }): Promise<number> {
    const entries = await tx.query<{ id: string; ledger_id: string; entry_kind: LedgerEntryKind; accepted: string; requested: string; paid: string; recovered: string; retention: string }>(
      `select e.id, e.ledger_id, e.entry_kind, e.accepted_delta_vnd::text as accepted, e.requested_delta_vnd::text as requested, e.paid_delta_vnd::text as paid,
              e.advance_recovery_delta_vnd::text as recovered, e.retention_delta_vnd::text as retention
         from machvon.cumulative_ledger_entry e
        where e.payment_request_id = $1::uuid and e.entry_kind in ('CLAIM', 'ADVANCE_RECOVERY', 'RETENTION_HOLD')
          and not exists (select 1 from machvon.cumulative_ledger_entry r where r.tenant_id = e.tenant_id and r.reversal_of_id = e.id)
          and not (e.entry_kind = 'RETENTION_HOLD' and exists (select 1 from machvon.cumulative_ledger_entry r where r.tenant_id = e.tenant_id and r.ledger_id = e.ledger_id
                                                                 and r.payment_request_id = e.payment_request_id and r.entry_kind = 'RETENTION_RELEASE' and r.created_at > e.created_at))
        order by case e.entry_kind when 'RETENTION_HOLD' then 0 when 'ADVANCE_RECOVERY' then 1 else 2 end, e.ledger_id, e.id`,
      [input.paymentRequestId],
    );
    await lockLedgerRows(tx, [...new Set(entries.map((entry) => entry.ledger_id))].map((id) => ({ table: 'cumulative_ledger', id })));
    for (const entry of entries) {
      const opposite = negate({ accepted: entry.accepted, requested: entry.requested, paid: entry.paid, advanceRecovery: entry.recovered, retention: entry.retention });
      const kind: LedgerEntryKind = entry.entry_kind === 'CLAIM' ? 'CLAIM_RELEASE' : entry.entry_kind === 'ADVANCE_RECOVERY' ? 'ADVANCE_RECOVERY_REVERSAL' : 'RETENTION_RELEASE';
      await this.post(tx, {
        ledgerId: entry.ledger_id,
        kind,
        delta: opposite,
        ...(kind === 'RETENTION_RELEASE' ? {} : { reversalOfId: entry.id }),
        paymentRequestId: input.paymentRequestId,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        requestId: input.requestId,
        actor: input.actor,
        advanceOutstandingVnd: input.advanceOutstandingVnd,
      });
    }
    return entries.length;
  }

  /**
   * Takes back the payment of a request that was settled (PAY 3.4): each entry that put the payment on a balance is undone by an entry that is its exact opposite and names it (`PAYMENT_REVERSAL`), so
   * the paid amount comes off before the claim does. An entry already undone is not undone twice (the unique index of the reversal holds the same rule). The caller holds the lock of the contract.
   */
  async reversePayments(tx: TenantTx, input: { paymentRequestId: string; requestId: string; actor: string; advanceOutstandingVnd: string; reason: string }): Promise<number> {
    const entries = await tx.query<{ id: string; ledger_id: string; accepted: string; requested: string; paid: string; recovered: string; retention: string }>(
      `select e.id, e.ledger_id, e.accepted_delta_vnd::text as accepted, e.requested_delta_vnd::text as requested, e.paid_delta_vnd::text as paid, e.advance_recovery_delta_vnd::text as recovered,
              e.retention_delta_vnd::text as retention
         from machvon.cumulative_ledger_entry e
        where e.payment_request_id = $1::uuid and e.entry_kind = 'PAYMENT' and not exists (select 1 from machvon.cumulative_ledger_entry r where r.tenant_id = e.tenant_id and r.reversal_of_id = e.id)
        order by e.ledger_id, e.id`,
      [input.paymentRequestId],
    );
    await lockLedgerRows(tx, [...new Set(entries.map((entry) => entry.ledger_id))].map((id) => ({ table: 'cumulative_ledger', id })));
    for (const entry of entries) {
      await this.post(tx, {
        ledgerId: entry.ledger_id,
        kind: 'PAYMENT_REVERSAL',
        delta: negate({ accepted: entry.accepted, requested: entry.requested, paid: entry.paid, advanceRecovery: entry.recovered, retention: entry.retention }),
        reversalOfId: entry.id,
        paymentRequestId: input.paymentRequestId,
        reason: input.reason,
        requestId: input.requestId,
        actor: input.actor,
        advanceOutstandingVnd: input.advanceOutstandingVnd,
      });
    }
    return entries.length;
  }

  /**
   * Posts one entry and moves its balance by it, in the same transaction; the caller holds the lock of the contract. 409 `VALUE_EXCEEDED` when the balance would break a rule of the ledger
   * (the database keeps the same rules behind this check).
   */
  async post(tx: TenantTx, input: PostEntryInput): Promise<PostedEntry> {
    assertEntryShape(input.kind, input.delta, input.reversalOfId ?? null);
    const [row] = await tx.query<LedgerRowSql>(`select ${BALANCE_COLUMNS} from machvon.cumulative_ledger where id = $1::uuid for update`, [input.ledgerId]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const next = applyDelta(toRow(row).balance, input.delta);
    if (this.applicationChecks) {
      try {
        assertLedgerInvariants(next);
      } catch (error) {
        this.metrics.increment(PAY_VALUE_EXCEEDED_METRIC, { rule: String((error as DomainError).extensions?.rule) });
        throw error;
      }
    }
    const entryId = randomUUID();
    try {
      await this.write(tx, input, entryId, next);
    } catch (error) {
      throw valueExceeded(error, this.metrics) ?? error;
    }
    return { id: entryId, ledgerId: input.ledgerId, kind: input.kind, delta: input.delta, balance: next };
  }

  private async write(tx: TenantTx, input: PostEntryInput, entryId: string, next: LedgerBalance): Promise<void> {
    await tx.query(
      `insert into machvon.cumulative_ledger_entry (tenant_id, id, ledger_id, contract_id, boq_item_id, acceptance_id, payment_request_id, entry_kind, accepted_delta_vnd, requested_delta_vnd,
              paid_delta_vnd, advance_recovery_delta_vnd, retention_delta_vnd, advance_outstanding_after_vnd, reversal_of_id, reason, request_id, created_by)
       select l.tenant_id, $2::uuid, l.id, l.contract_id, l.boq_item_id, l.acceptance_id, $3::uuid, $4, $5::numeric, $6::numeric, $7::numeric, $8::numeric, $9::numeric, $10::numeric, $11::uuid,
              $12, $13::uuid, $14::uuid
         from machvon.cumulative_ledger l where l.id = $1::uuid`,
      [
        input.ledgerId,
        entryId,
        input.paymentRequestId ?? null,
        input.kind,
        input.delta.accepted,
        input.delta.requested,
        input.delta.paid,
        input.delta.advanceRecovery,
        input.delta.retention,
        input.advanceOutstandingVnd,
        input.reversalOfId ?? null,
        input.reason ?? null,
        input.requestId,
        input.actor,
      ],
    );
    await tx.query(
      `update machvon.cumulative_ledger set accepted_vnd = $2::numeric, requested_vnd = $3::numeric, paid_vnd = $4::numeric, advance_recovered_vnd = $5::numeric, retention_held_vnd = $6::numeric,
              updated_at = now(), updated_by = $7::uuid, version = version + 1 where id = $1::uuid`,
      [input.ledgerId, next.acceptedVnd, next.requestedVnd, next.paidVnd, next.advanceRecoveredVnd, next.retentionHeldVnd, input.actor],
    );
  }

  /** The version of a contract inside the scope of the caller (what a cached page is keyed by); undefined when the contract is outside it. */
  async versionOf(tx: TenantTx, contractId: string, scope: ScopeBuilder): Promise<number | undefined> {
    const predicate = scope(2);
    const [row] = await tx.query<{ version: string }>(`select c.version::text as version from ${CONTRACT_SCOPE_FROM} where c.id = $1::uuid and ${predicate.sql}`, [idOf(contractId, 'contract_id'), ...predicate.params]);
    return row === undefined ? undefined : Number(row.version);
  }

  /** One page of the balances of a contract inside the scope of the caller, with the recent entries of each and the totals. 404 when the contract is outside what the caller may read. */
  async page(tx: TenantTx, contractId: string, scope: ScopeBuilder, filter: LedgerFilter = {}): Promise<LedgerPage> {
    const id = idOf(contractId, 'contract_id');
    const boqItemId = filter.boqItemId === undefined ? null : idOf(filter.boqItemId, 'boq_item_id');
    const acceptanceId = filter.acceptanceId === undefined ? null : idOf(filter.acceptanceId, 'acceptance_id');
    const limit = Math.min(Math.max(filter.limit ?? DEFAULT_PAGE, 1), MAX_PAGE);
    const predicate = scope(2);
    const [head] = await tx.query<{
      code: string;
      version: string;
      contract_value_vnd: string;
      accepted_total_vnd: string;
      requested_total_vnd: string;
      paid_total_vnd: string;
      advance_paid_vnd: string;
      advance_recovered_vnd: string;
      advance_outstanding_vnd: string;
      retention_held_vnd: string;
      retention_released_vnd: string;
    }>(
      `select c.code, c.version::text as version, c.contract_value_vnd::text as contract_value_vnd, c.accepted_total_vnd::text as accepted_total_vnd, c.requested_total_vnd::text as requested_total_vnd,
              c.paid_total_vnd::text as paid_total_vnd, c.advance_paid_vnd::text as advance_paid_vnd, c.advance_recovered_vnd::text as advance_recovered_vnd,
              c.advance_outstanding_vnd::text as advance_outstanding_vnd, c.retention_held_vnd::text as retention_held_vnd, c.retention_released_vnd::text as retention_released_vnd
         from ${CONTRACT_SCOPE_FROM} where c.id = $1::uuid and ${predicate.sql}`,
      [id, ...predicate.params],
    );
    if (head === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const rows = await tx.query<ReadSql>(
      `select l.id, l.version::text as version, l.accepted_vnd::text as accepted_vnd, l.requested_vnd::text as requested_vnd, l.paid_vnd::text as paid_vnd,
              l.advance_recovered_vnd::text as advance_recovered_vnd, l.retention_held_vnd::text as retention_held_vnd, l.boq_item_id, i.business_key as boq_item_key, i.description,
              i.unit_code, l.acceptance_id, a.acceptance_no, l.party_id, ${TIMESTAMP('l.created_at')} as created_at
         from machvon.cumulative_ledger l
         join machvon.boq_item i on i.tenant_id = l.tenant_id and i.id = l.boq_item_id
         join machvon.acceptance a on a.tenant_id = l.tenant_id and a.id = l.acceptance_id
        where l.contract_id = $1::uuid and ($2::uuid is null or l.boq_item_id = $2::uuid) and ($3::uuid is null or l.acceptance_id = $3::uuid)
          and ($4::text is null or (${TIMESTAMP('l.created_at')}, l.id) > ($4::text, $5::uuid))
        order by l.created_at, l.id limit ${limit + 1}`,
      [id, boqItemId, acceptanceId, filter.after?.createdAt ?? null, filter.after?.id ?? null],
    );
    const shown = rows.slice(0, limit);
    const entries = shown.length === 0 ? [] : await tx.query<EntrySql>(
      `select id, ledger_id, entry_kind, accepted_delta_vnd::text as accepted_delta_vnd, requested_delta_vnd::text as requested_delta_vnd, paid_delta_vnd::text as paid_delta_vnd,
              advance_recovery_delta_vnd::text as advance_recovery_delta_vnd, retention_delta_vnd::text as retention_delta_vnd, advance_outstanding_after_vnd::text as advance_outstanding_after_vnd,
              reversal_of_id, payment_request_id, reason, ${TIMESTAMP('posted_at')} as posted_at
         from machvon.cumulative_ledger_entry where ledger_id = any($1::uuid[]) order by posted_at, id`,
      [shown.map((row) => row.id)],
    );
    const byLedger = new Map<string, LedgerEntryView[]>();
    for (const entry of entries) {
      const list = byLedger.get(entry.ledger_id) ?? [];
      list.push({
        id: entry.id,
        kind: entry.entry_kind,
        acceptedDeltaVnd: entry.accepted_delta_vnd,
        requestedDeltaVnd: entry.requested_delta_vnd,
        paidDeltaVnd: entry.paid_delta_vnd,
        advanceRecoveryDeltaVnd: entry.advance_recovery_delta_vnd,
        retentionDeltaVnd: entry.retention_delta_vnd,
        advanceOutstandingAfterVnd: entry.advance_outstanding_after_vnd,
        reversalOfId: entry.reversal_of_id,
        paymentRequestId: entry.payment_request_id,
        reason: entry.reason,
        postedAt: entry.posted_at,
      });
      byLedger.set(entry.ledger_id, list);
    }
    const [sum] = await tx.query<LedgerRowSql & { all_accepted_vnd: string }>(
      `select '' as id, '' as version, coalesce(sum(accepted_vnd) filter (where ($2::uuid is null or boq_item_id = $2::uuid) and ($3::uuid is null or acceptance_id = $3::uuid)), 0)::text as accepted_vnd,
              coalesce(sum(requested_vnd) filter (where ($2::uuid is null or boq_item_id = $2::uuid) and ($3::uuid is null or acceptance_id = $3::uuid)), 0)::text as requested_vnd,
              coalesce(sum(paid_vnd) filter (where ($2::uuid is null or boq_item_id = $2::uuid) and ($3::uuid is null or acceptance_id = $3::uuid)), 0)::text as paid_vnd,
              coalesce(sum(advance_recovered_vnd) filter (where ($2::uuid is null or boq_item_id = $2::uuid) and ($3::uuid is null or acceptance_id = $3::uuid)), 0)::text as advance_recovered_vnd,
              coalesce(sum(retention_held_vnd) filter (where ($2::uuid is null or boq_item_id = $2::uuid) and ($3::uuid is null or acceptance_id = $3::uuid)), 0)::text as retention_held_vnd,
              coalesce(sum(accepted_vnd), 0)::text as all_accepted_vnd
         from machvon.cumulative_ledger where contract_id = $1::uuid`,
      [id, boqItemId, acceptanceId],
    );
    const items: LedgerLineView[] = shown.map((row) => ({
      ...toRow(row).balance,
      id: row.id,
      boqItemId: row.boq_item_id,
      boqItemKey: row.boq_item_key,
      description: row.description,
      unitCode: row.unit_code,
      acceptanceId: row.acceptance_id,
      acceptanceNo: row.acceptance_no,
      partyId: row.party_id,
      version: row.version,
      createdAt: row.created_at,
      entries: byLedger.get(row.id) ?? [],
    }));
    return {
      header: {
        contractId: id,
        contractCode: head.code,
        contractVersion: Number(head.version),
        contractValueVnd: head.contract_value_vnd,
        acceptedTotalVnd: head.accepted_total_vnd,
        requestedTotalVnd: head.requested_total_vnd,
        paidTotalVnd: head.paid_total_vnd,
        advancePaidVnd: head.advance_paid_vnd,
        advanceRecoveredVnd: head.advance_recovered_vnd,
        advanceOutstandingVnd: head.advance_outstanding_vnd,
        retentionHeldVnd: head.retention_held_vnd,
        retentionReleasedVnd: head.retention_released_vnd,
      },
      items,
      total: sum === undefined ? ZERO_BALANCE : { ...toRow(sum).balance },
      reconciled: sum !== undefined && sum.all_accepted_vnd === head.accepted_total_vnd,
      hasMore: rows.length > limit,
    };
  }

  // ---- internals ------------------------------------------------------------------------------------------------------------

  /**
   * Locks the contract of the acceptance (the first lock of every writer of the ledger), reads the acceptance under it, and does the work only when the acceptance has the status the event is
   * about. The version of the contract moves when entries were posted, so what is cached by it is dropped.
   */
  private async settle(
    tx: TenantTx,
    input: { acceptanceId: string; requestId: string; actor: string },
    status: 'APPROVED' | 'REVOKED',
    work: (held: { acceptanceId: string; contractId: string; requestId: string; actor: string; advanceOutstandingVnd: string }) => Promise<number>,
  ): Promise<LedgerOutcome> {
    const acceptanceId = idOf(input.acceptanceId, 'acceptance_id');
    const [first] = await tx.query<{ contract_id: string }>('select contract_id from machvon.acceptance where id = $1::uuid', [acceptanceId]);
    if (first === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const waitStarted = performance.now();
    const [contract] = await tx.query<{ advance_paid_vnd: string; advance_recovered_vnd: string }>(
      'select advance_paid_vnd::text as advance_paid_vnd, advance_recovered_vnd::text as advance_recovered_vnd from machvon.contract where id = $1::uuid for update',
      [first.contract_id],
    );
    this.metrics.gauge(PAY_LEDGER_LOCK_WAIT_METRIC, (performance.now() - waitStarted) / 1000);
    const [acceptance] = await tx.query<{ status: string; accepted_amount_vnd: string }>('select status, accepted_amount_vnd::text as accepted_amount_vnd from machvon.acceptance where id = $1::uuid', [acceptanceId]);
    if (contract === undefined || acceptance === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (acceptance.status !== status) return { outcome: 'skipped', entries: 0, acceptedVnd: '0' };
    const entries = await work({
      acceptanceId,
      contractId: first.contract_id,
      requestId: idOf(input.requestId, 'request_id'),
      actor: idOf(input.actor, 'actor'),
      advanceOutstandingVnd: advanceOutstanding(contract.advance_paid_vnd, contract.advance_recovered_vnd),
    });
    if (entries === 0) return { outcome: 'unchanged', entries, acceptedVnd: acceptance.accepted_amount_vnd };
    await tx.query('update machvon.contract set updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid', [first.contract_id, input.actor]);
    return { outcome: 'posted', entries, acceptedVnd: acceptance.accepted_amount_vnd };
  }

  /** The balance of each item the acceptance holds, created empty where it does not exist yet; the existing ones are locked in the order of the registry first. Keyed by item and party. */
  private async rowsFor(
    tx: TenantTx,
    held: { acceptanceId: string; contractId: string; actor: string },
    lines: ReadonlyArray<{ boq_item_id: string; party_id: string | null }>,
  ): Promise<Map<string, string>> {
    const existing = await tx.query<{ id: string; boq_item_id: string; party_id: string | null }>(
      'select id, boq_item_id, party_id from machvon.cumulative_ledger where contract_id = $1::uuid and acceptance_id = $2::uuid',
      [held.contractId, held.acceptanceId],
    );
    await lockLedgerRows(tx, existing.map((row) => ({ table: 'cumulative_ledger', id: row.id })));
    const found = new Map(existing.map((row) => [`${row.boq_item_id}:${row.party_id ?? ''}`, row.id]));
    for (const line of lines) {
      const key = `${line.boq_item_id}:${line.party_id ?? ''}`;
      if (found.has(key)) continue;
      const [created] = await tx.query<{ id: string }>(
        `insert into machvon.cumulative_ledger (tenant_id, id, contract_id, boq_item_id, acceptance_id, party_id, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $6::uuid) returning id`,
        [randomUUID(), held.contractId, line.boq_item_id, held.acceptanceId, line.party_id, held.actor],
      );
      found.set(key, created!.id);
    }
    return found;
  }
}

/** The checks of the database that keep the money within its bounds: a refusal by one of them is the 409 `VALUE_EXCEEDED` of the contract, not a constraint name. */
const VALUE_CONSTRAINTS: ReadonlySet<string> = new Set([
  'cumulative_ledger_nonneg_chk',
  'cumulative_ledger_requested_le_accepted_chk',
  'cumulative_ledger_paid_le_requested_chk',
  'cumulative_ledger_deductions_chk',
  'contract_ledger_order_chk',
  'contract_cash_out_chk',
  'contract_advance_order_chk',
  'contract_retention_order_chk',
]);

/**
 * A DomainError 409 `VALUE_EXCEEDED` (counted by `pay_value_exceeded_total`, naming the constraint as the rule) when the database refused a write for one of the checks that keep the money within
 * its bounds; undefined for any other failure.
 */
export function valueExceeded(error: unknown, metrics: MetricsSink = NOOP_METRICS): DomainError | undefined {
  const failure = error as { code?: string; constraint?: string };
  if (failure.code !== '23514' || failure.constraint === undefined || !VALUE_CONSTRAINTS.has(failure.constraint)) return undefined;
  metrics.increment(PAY_VALUE_EXCEEDED_METRIC, { rule: failure.constraint });
  return new DomainError('VALUE_EXCEEDED', 409, 'ledger', { extensions: { rule: failure.constraint } });
}
