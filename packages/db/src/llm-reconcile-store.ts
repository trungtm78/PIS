import { DomainError, RECONCILE_TOLERANCE_PERCENT, checkReconcile, compareInvoice, fromUnits, providerOfInvoice, toUnits, versionConflict, vietnamDateOf } from '@machvon/kernel';
import type { ReconcileRequest } from '@machvon/kernel';
import { cursorFor, cursorOf } from './dgv-keyset.ts';
import { LlmFinopsStore } from './llm-finops-store.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The reconciliation of provider invoices (ST-LLM-008, LLM.md F3, BR-LLM-06, LLM-21, UAT-AC462) and the decision on the reservations that are still waiting for their usage. The sum of the attempts of a provider in a period
 * that cost something is set against the invoice; the attempts that timed out and have since been paid for (late usage) are counted by the attempt that paid for them, and are marked reconciled - the cost of an attempt is
 * never edited. A difference inside the tolerance is RECONCILED (and final); one outside it is a VARIANCE that lists the attempts still waiting, has an owner, and is run again when the usage arrives.
 */
export const INVOICE_RECONCILIATION_RESOURCE = 'ai_invoice_reconciliation';
const MAX_PAGE = 200;
const UNIQUE_VIOLATION = '23505';
const VIETNAM_DAY = "(a.created_at at time zone 'Asia/Ho_Chi_Minh')::date";

interface Sql {
  [column: string]: unknown;
  id: string;
  provider_id: string;
  provider_code: string;
  invoice_ref: string;
  invoice_amount: string;
  currency: string;
  period_from: string;
  period_to: string;
  attempts_total: string;
  variance: string;
  tolerance_pct: string;
  attempt_count: number;
  pending_attempt_ids: string[];
  reconciled_attempt_ids: string[];
  reservations_settled: number;
  status: "VARIANCE" | "RECONCILED";
  owner_id: string;
  run_count: number;
  last_run_at: string;
  created_at: string;
  cost: string;
}

export interface InvoiceReconciliation {
  id: string;
  providerId: string;
  providerCode: string;
  invoiceRef: string;
  invoiceAmount: string;
  currency: string;
  periodFrom: string;
  periodTo: string;
  attemptsTotal: string;
  variance: string;
  tolerancePct: string;
  attemptCount: number;
  pendingAttemptIds: string[];
  reconciledAttemptIds: string[];
  reservationsSettled: number;
  status: 'VARIANCE' | 'RECONCILED';
  ownerId: string;
  runCount: number;
  lastRunAt: string;
  createdAt: string;
  version: number;
}

export interface ReconcileOutcome {
  reconciliation: InvoiceReconciliation;
  /** The invoice was reconciled by an earlier run: nothing was run again. */
  replayed: boolean;
}

export interface ReconciliationPage {
  items: InvoiceReconciliation[];
  next: string | null;
}

export interface BudgetDecisionOutcome {
  released: string[];
  kept: string[];
  version: number;
}

const SELECT = `select r.id, r.provider_id, p.provider_code, r.invoice_ref, r.invoice_amount::text as invoice_amount, r.currency, r.period_from::text as period_from, r.period_to::text as period_to,
  r.attempts_total::text as attempts_total, r.variance::text as variance, r.tolerance_pct::text as tolerance_pct, r.attempt_count, r.pending_attempt_ids, r.reconciled_attempt_ids, r.reservations_settled, r.status,
  r.owner_id, r.run_count, r.last_run_at::text as last_run_at, r.created_at::text as created_at, r.version::text as version
  from machvon.ai_invoice_reconciliation r join machvon.ai_provider p on p.tenant_id = r.tenant_id and p.id = r.provider_id`;

const money = (value: string): string => fromUnits(toUnits(value, 'amount'));

function reconciliationOf(row: Sql): InvoiceReconciliation {
  return {
    id: row.id,
    providerId: row.provider_id,
    providerCode: row.provider_code,
    invoiceRef: row.invoice_ref,
    invoiceAmount: money(row.invoice_amount),
    currency: row.currency,
    periodFrom: row.period_from,
    periodTo: row.period_to,
    attemptsTotal: money(row.attempts_total),
    variance: money(row.variance),
    tolerancePct: row.tolerance_pct,
    attemptCount: row.attempt_count,
    pendingAttemptIds: row.pending_attempt_ids,
    reconciledAttemptIds: row.reconciled_attempt_ids,
    reservationsSettled: row.reservations_settled,
    status: row.status,
    ownerId: row.owner_id,
    runCount: row.run_count,
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
    version: Number(row.version),
  };
}

export class LlmReconcileStore {
  private readonly finops = new LlmFinopsStore();

  async find(tx: TenantTx, id: string): Promise<InvoiceReconciliation | undefined> {
    const rows = await tx.query<Sql>(`${SELECT} where r.id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : reconciliationOf(rows[0]);
  }

  async list(tx: TenantTx, filter: { status?: string | undefined; cursor?: string | undefined; limit: number }): Promise<ReconciliationPage> {
    if (filter.status !== undefined && !['VARIANCE', 'RECONCILED'].includes(filter.status)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const limit = Math.min(filter.limit, MAX_PAGE);
    const after = cursorOf(filter.cursor);
    const rows = await tx.query<Sql>(
      `${SELECT} where ($1::text is null or r.status = $1) and ($2::timestamptz is null or (r.created_at, r.id) < ($2::timestamptz, $3::uuid)) order by r.created_at desc, r.id desc limit $4::int`,
      [filter.status ?? null, after?.at ?? null, after?.id ?? null, limit + 1],
    );
    const page = rows.slice(0, limit).map(reconciliationOf);
    const last = page[page.length - 1];
    return { items: page, next: rows.length > limit && last !== undefined ? cursorFor(last.createdAt, last.id) : null };
  }

  /**
   * Runs the reconciliation of an invoice, or runs it again. 409 `RECONCILE_PERIOD_OPEN` while the period is not over, 422 `VALIDATION_FAILED` for an invoice that is for no provider of the tenant, 422
   * `CURRENCY_MISMATCH` when an attempt that cost something was priced in another currency than the invoice, 409 `DUPLICATE_KEY` for a reference that was reconciled with other figures. An invoice that is RECONCILED
   * is final: it answers what it said.
   */
  async reconcile(tx: TenantTx, request: ReconcileRequest, actor: string, now: Date): Promise<ReconcileOutcome> {
    const today = vietnamDateOf(now);
    const checked = checkReconcile(request, today);
    const providers = await tx.query<{ id: string; provider_code: string }>('select id, provider_code from machvon.ai_provider');
    const code = providerOfInvoice(
      checked.invoiceRef,
      providers.map((provider) => provider.provider_code),
    );
    const provider = providers.find((candidate) => candidate.provider_code === code);
    if (provider === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'invoice_ref');
    await tx.query("select pg_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id', true) || ':invoice:' || $1 || ':' || $2, 0))", [provider.id, checked.invoiceRef]);

    const earlier = await tx.query<Sql>(`${SELECT} where r.provider_id = $1::uuid and r.invoice_ref = $2 for update of r`, [provider.id, checked.invoiceRef]);
    const held = earlier[0] === undefined ? undefined : reconciliationOf(earlier[0]);
    if (held !== undefined) {
      const same =
        toUnits(held.invoiceAmount, 'invoice_amount') === checked.invoiceAmount && held.currency === checked.currency && held.periodFrom === checked.periodFrom && held.periodTo === checked.periodTo;
      if (!same) throw new DomainError('DUPLICATE_KEY', 409, 'invoice_ref');
      if (held.status === 'RECONCILED') return { reconciliation: held, replayed: true };
    }

    // The attempts of the provider in the period, and the attempts that paid for the ones that timed out in it (they were written when the usage came, which may be after the period). An attempt that paid for
    // one that timed out in another period belongs to that period, so it is counted once.
    const attempts = await tx.query<Sql>(
      `select a.id, a.ai_request_id, a.attempt_no, a.provider_id, a.cost::text as cost, a.currency, a.reconcile_status
         from machvon.llm_attempt a where a.provider_id = $1::uuid and ${VIETNAM_DAY} between $2::date and $3::date
          and not (a.reconcile_status = 'SETTLED' and exists (
            select 1 from machvon.llm_attempt w
             where w.provider_id = a.provider_id and w.ai_request_id = a.ai_request_id and w.attempt_no = a.attempt_no and w.id <> a.id
               and w.reconcile_status in ('PENDING', 'RECONCILED') and not ((w.created_at at time zone 'Asia/Ho_Chi_Minh')::date between $2::date and $3::date)))
        order by a.created_at, a.id for update`,
      [provider.id, checked.periodFrom, checked.periodTo],
    );
    const waiting = attempts.filter((attempt) => attempt.reconcile_status === 'PENDING' || attempt.reconcile_status === 'RECONCILED');
    const paying =
      waiting.length === 0
        ? []
        : await tx.query<Sql>(
            `select a.id, a.ai_request_id, a.attempt_no, a.cost::text as cost, a.currency
             from machvon.llm_attempt a
            where a.reconcile_status = 'SETTLED' and a.provider_id = $1::uuid
              and exists (select 1 from machvon.llm_attempt w where w.id = any($2::uuid[]) and w.ai_request_id = a.ai_request_id and w.attempt_no = a.attempt_no and w.provider_id = a.provider_id)
              and not (${VIETNAM_DAY} between $3::date and $4::date)`,
            [provider.id, waiting.map((attempt) => attempt.id), checked.periodFrom, checked.periodTo],
          );
    const counted = [...attempts.filter((attempt) => attempt.reconcile_status === 'SETTLED'), ...paying];
    if (counted.some((attempt) => attempt.currency !== checked.currency && toUnits(attempt.cost, 'cost') !== 0n)) throw new DomainError('CURRENCY_MISMATCH', 422, 'currency');
    const total = counted.reduce((sum, attempt) => sum + toUnits(attempt.cost, 'cost'), 0n);

    // A timed-out attempt that has been paid for by a later one of the same request, provider and number is reconciled; its own figures stay as they were.
    const paid = new Set(paying.map((attempt) => `${attempt.ai_request_id}:${attempt.attempt_no}`));
    const settledInPeriod = new Set(attempts.filter((attempt) => attempt.reconcile_status === 'SETTLED').map((attempt) => `${attempt.ai_request_id}:${attempt.attempt_no}`));
    const nowPaid = waiting.filter(
      (attempt) => attempt.reconcile_status === 'PENDING' && (paid.has(`${attempt.ai_request_id}:${attempt.attempt_no}`) || settledInPeriod.has(`${attempt.ai_request_id}:${attempt.attempt_no}`)),
    );
    if (nowPaid.length > 0) {
      await tx.query("update machvon.llm_attempt set reconcile_status = 'RECONCILED', invoice_ref = $2 where id = any($1::uuid[])", [nowPaid.map((attempt) => attempt.id), checked.invoiceRef]);
    }
    const reconciledIds = waiting.filter((attempt) => attempt.reconcile_status === 'RECONCILED' || nowPaid.includes(attempt)).map((attempt) => attempt.id);
    const pendingIds = waiting.filter((attempt) => attempt.reconcile_status === 'PENDING' && !nowPaid.includes(attempt)).map((attempt) => attempt.id);
    // The attempts that were counted say which invoice counted them.
    await tx.query('update machvon.llm_attempt set invoice_ref = $2 where id = any($1::uuid[]) and invoice_ref is distinct from $2', [counted.map((attempt) => attempt.id), checked.invoiceRef]);

    const { variance, withinTolerance } = compareInvoice(checked.invoiceAmount, total);
    const status = withinTolerance ? 'RECONCILED' : 'VARIANCE';
    const requests = [...new Set([...waiting, ...paying].map((attempt) => attempt.ai_request_id).filter((id): id is string => typeof id === 'string'))];
    const settled =
      requests.length === 0 ? [] : await tx.query<{ n: string }>("select count(*)::text as n from machvon.budget_reservation where request_id = any($1::uuid[]) and status = 'SETTLED'", [requests]);
    const reservationsSettled = Number(settled[0]?.n ?? 0);

    const figures = [
      checked.invoiceAmount.toString(),
      fromUnits(total),
      fromUnits(variance),
      counted.length,
      JSON.stringify(pendingIds),
      JSON.stringify(reconciledIds),
      reservationsSettled,
      status,
    ] as const;
    let id: string;
    if (held === undefined) {
      try {
        const rows = await tx.query<{ id: string }>(
          `insert into machvon.ai_invoice_reconciliation (tenant_id, id, provider_id, invoice_ref, invoice_amount, currency, period_from, period_to, attempts_total, variance, tolerance_pct, attempt_count,
             pending_attempt_ids, reconciled_attempt_ids, reservations_settled, status, owner_id, created_by, updated_by)
           values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3::numeric / 100000000, $4, $5::date, $6::date, $7::numeric, $8::numeric, $9::numeric, $10::int,
             $11::jsonb, $12::jsonb, $13::int, $14, $15::uuid, $15::uuid, $15::uuid) returning id`,
          [
            provider.id,
            checked.invoiceRef,
            figures[0],
            checked.currency,
            checked.periodFrom,
            checked.periodTo,
            figures[1],
            figures[2],
            RECONCILE_TOLERANCE_PERCENT,
            figures[3],
            figures[4],
            figures[5],
            figures[6],
            figures[7],
            actor,
          ],
        );
        id = (rows[0] as { id: string }).id;
      } catch (error) {
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('DUPLICATE_KEY', 409, 'invoice_ref');
        throw error;
      }
    } else {
      id = held.id;
      await tx.query(
        `update machvon.ai_invoice_reconciliation set attempts_total = $2::numeric, variance = $3::numeric, attempt_count = $4::int, pending_attempt_ids = $5::jsonb, reconciled_attempt_ids = $6::jsonb,
           reservations_settled = $7::int, status = $8, run_count = run_count + 1, last_run_at = now(), updated_at = now(), updated_by = $9::uuid, version = version + 1 where id = $1::uuid`,
        [id, figures[1], figures[2], figures[3], figures[4], figures[5], figures[6], figures[7], actor],
      );
    }
    return { reconciliation: (await this.find(tx, id)) as InvoiceReconciliation, replayed: false };
  }

  /**
   * The decision of the owner of a budget about the reservations that are still waiting for their usage (`post_budgets_id_reconcile`): `approve` releases the ones named (or all of them) that have no usage at all - a
   * decision with a reason, which is the audit BR-LLM-06 asks for before a hold is given back - and leaves alone the ones that have been paid for in part; `return` and `reject` keep them waiting and say so. Against the
   * version of the budget that was read (409 `VERSION_CONFLICT`); a reservation named that is not waiting under this budget is 422 `VALIDATION_FAILED`.
   */
  async decideBudget(
    tx: TenantTx,
    budgetId: string,
    expected: number,
    input: { decision: 'approve' | 'return' | 'reject'; reason: string; reservationIds: readonly string[] },
    actor: string,
  ): Promise<BudgetDecisionOutcome> {
    const budgets = await tx.query<{ version: string }>('select version::text as version from machvon.ai_budget where id = $1::uuid for update', [budgetId]);
    if (budgets[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(budgets[0].version) !== expected) throw versionConflict(Number(budgets[0].version));
    const reason = input.reason.trim();
    if (reason.length < 10 || reason.length > 2000) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
    const waiting = await tx.query<{ id: string; settled_amount: string | null }>(
      `select r.id, r.settled_amount::text as settled_amount from machvon.budget_reservation r
        where r.status = 'PENDING_RECONCILE' and exists (select 1 from jsonb_array_elements(r.scope_json) s where s ->> 'budgetId' = $1)
        order by r.created_at, r.id for update of r`,
      [budgetId],
    );
    const named = new Set(input.reservationIds.map((id) => id.toLowerCase()));
    if ([...named].some((id) => !waiting.some((row) => row.id === id))) throw new DomainError('VALIDATION_FAILED', 422, 'evidence_ids');
    const decided = named.size === 0 ? waiting : waiting.filter((row) => named.has(row.id));
    const released: string[] = [];
    const kept: string[] = [];
    for (const row of decided) {
      if (input.decision === 'approve' && toUnits(row.settled_amount ?? '0', 'settled_amount') === 0n) {
        await this.finops.release(tx, row.id, reason);
        released.push(row.id);
      } else kept.push(row.id);
    }
    await tx.query('update machvon.ai_budget set updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid', [budgetId, actor]);
    return { released, kept, version: expected + 1 };
  }
}
