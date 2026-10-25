import { randomUUID } from 'node:crypto';
import { NOOP_METRICS, vietnamDateOf } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import type { AuditWriter } from './audit-writer.ts';
import { enqueueOutbox } from './outbox.ts';
import type { TenantTx } from './tenant-database.ts';

/** The gauge of the nightly check: the whole VND by which the balances differ from their ledger, in all (an alert watches it, `CAP_BALANCE_DRIFT`). */
export const CAP_BALANCE_DRIFT_METRIC = 'cap_balance_drift_vnd';
/** The type of the event that reports one appropriation whose balances differ from the ledger. */
export const CAP_BALANCE_DRIFT_EVENT = 'cap.balance.drift_detected.v1';

const RESOURCE_TYPE = 'capital_balance';
const CLASSIFICATION = 'CONFIDENTIAL';

/** The balance columns the ledger entries move, with the entry types that move each (a reversal moves the column of the entry it undoes, the other way). */
const EFFECTS_SQL = `(values
  ('ALLOCATE', 'allocated_vnd', 1), ('REDUCE', 'allocated_vnd', -1), ('TRANSFER_IN', 'allocated_vnd', 1), ('TRANSFER_OUT', 'allocated_vnd', -1),
  ('EXTEND_IN', 'allocated_vnd', 1), ('EXTEND_OUT', 'allocated_vnd', -1), ('LAPSE', 'allocated_vnd', -1),
  ('COMMIT', 'committed_vnd', 1), ('UNCOMMIT', 'committed_vnd', -1),
  ('DISBURSE', 'disbursed_vnd', 1)) as effect(entry_type, balance_column, sign)`;

export interface BalanceDriftRow {
  projectId: string;
  appropriationId: string;
  /** The balance column that differs. */
  column: string;
  ledgerVnd: string;
  balanceVnd: string;
  /** The balance less the ledger. */
  differenceVnd: string;
}

export interface BalanceReconcileResult {
  checked: number;
  drift: BalanceDriftRow[];
  /** The sum of the absolute differences, the value of the gauge. */
  totalDriftVnd: string;
}

/**
 * The nightly job `capital.balance-reconcile` (ST-CAP-006, UAT-PLAN-02): for every appropriation of a project, the allocated, committed and disbursed amounts its ledger entries net to are compared with the sum of the balances of
 * its lines. A difference never changes a balance or an entry (the ledger is the record and a person finds out which of the two is wrong): the gauge `cap_balance_drift_vnd` takes the figure the alert reads, an
 * audit row and the event `cap.balance.drift_detected.v1` say where, once a day for each appropriation, and the same run with no difference sets the gauge back to nothing. The reserved amount is not checked yet:
 * reservations post no entries until the reservation of funds is built.
 */
export class CapBalanceReconcileJob {
  private readonly audit: Pick<AuditWriter, 'recordInTx'>;
  private readonly metrics: MetricsSink;

  constructor(audit: Pick<AuditWriter, 'recordInTx'>, metrics: MetricsSink = NOOP_METRICS) {
    this.audit = audit;
    this.metrics = metrics;
  }

  /** The appropriations and columns whose balances differ from the ledger, read without changing anything. */
  async drift(tx: TenantTx): Promise<BalanceDriftRow[]> {
    const rows = await tx.query<{ project_id: string; appropriation_id: string; balance_column: string; ledger_vnd: string; balance_vnd: string; difference_vnd: string }>(
      `with ledger as (
         select l.project_id, l.appropriation_id, effect.balance_column, sum(case when e.entry_type = 'REVERSAL' then -effect.sign else effect.sign end * e.amount_vnd) as total
           from machvon.capital_ledger_entry e
           left join machvon.capital_ledger_entry original on original.tenant_id = e.tenant_id and original.id = e.reversal_of_id
           join ${EFFECTS_SQL} on effect.entry_type = coalesce(original.entry_type, e.entry_type)
           join machvon.allocation_line l on l.tenant_id = e.tenant_id and l.id = e.allocation_line_id
          group by l.project_id, l.appropriation_id, effect.balance_column
       ), held as (
         select l.project_id, l.appropriation_id, column_totals.balance_column, sum(column_totals.total) as total
           from machvon.allocation_balance b
           join machvon.allocation_line l on l.tenant_id = b.tenant_id and l.id = b.allocation_line_id
           cross join lateral (values ('allocated_vnd', b.allocated_vnd), ('committed_vnd', b.committed_vnd), ('disbursed_vnd', b.disbursed_vnd)) as column_totals(balance_column, total)
          group by l.project_id, l.appropriation_id, column_totals.balance_column
       )
       select coalesce(ledger.project_id, held.project_id) as project_id, coalesce(ledger.appropriation_id, held.appropriation_id) as appropriation_id,
              coalesce(ledger.balance_column, held.balance_column) as balance_column, coalesce(ledger.total, 0)::text as ledger_vnd, coalesce(held.total, 0)::text as balance_vnd,
              (coalesce(held.total, 0) - coalesce(ledger.total, 0))::text as difference_vnd
         from ledger full join held on held.project_id = ledger.project_id and held.appropriation_id = ledger.appropriation_id and held.balance_column = ledger.balance_column
        where coalesce(ledger.total, 0) <> coalesce(held.total, 0)
        order by 1, 2, 3`,
    );
    return rows.map((row) => ({
      projectId: row.project_id,
      appropriationId: row.appropriation_id,
      column: row.balance_column,
      ledgerVnd: row.ledger_vnd,
      balanceVnd: row.balance_vnd,
      differenceVnd: row.difference_vnd,
    }));
  }

  async run(tx: TenantTx, actor: string, now: Date): Promise<BalanceReconcileResult> {
    const [tenant] = await tx.query<{ tenant_id: string }>("select nullif(current_setting('app.tenant_id', true), '') as tenant_id");
    const tenantId = tenant?.tenant_id ?? '';
    const [counted] = await tx.query<{ checked: string }>('select count(*)::text as checked from machvon.allocation_balance');
    const drift = await this.drift(tx);
    const correlationId = randomUUID();
    const day = vietnamDateOf(now);
    const byAppropriation = new Map<string, { first: BalanceDriftRow; columns: Array<Record<string, string>> }>();
    for (const row of drift) {
      const key = `${row.projectId}:${row.appropriationId}`;
      const column = { column: row.column, ledger_vnd: row.ledgerVnd, balance_vnd: row.balanceVnd, difference_vnd: row.differenceVnd };
      const found = byAppropriation.get(key);
      if (found === undefined) byAppropriation.set(key, { first: row, columns: [column] });
      else found.columns.push(column);
    }
    for (const { first, columns } of byAppropriation.values()) {
      await this.audit.recordInTx(tx, actor, {
        action: 'cap.balance_drift_detected',
        resourceType: RESOURCE_TYPE,
        resourceId: first.appropriationId,
        classification: CLASSIFICATION,
        diff: { project_id: first.projectId, columns },
        correlationId,
        requestId: randomUUID(),
      });
      await enqueueOutbox(tx, {
        aggregateType: RESOURCE_TYPE,
        aggregateId: first.appropriationId,
        aggregateVersion: 1,
        type: CAP_BALANCE_DRIFT_EVENT,
        schemaVersion: 1,
        payload: { tenant_id: tenantId, project_id: first.projectId, appropriation_id: first.appropriationId, columns, occurred_at: now.toISOString(), source_module: 'CAP' },
        eventKey: `${RESOURCE_TYPE}:${first.appropriationId}:${first.projectId}:drift:${day}`,
        correlationId,
      });
    }
    const total = drift.reduce((sum, row) => sum + absolute(BigInt(row.differenceVnd)), 0n);
    this.metrics.gauge(CAP_BALANCE_DRIFT_METRIC, Number(total), { tenant_id: tenantId });
    return { checked: Number(counted?.checked ?? 0), drift, totalDriftVnd: total.toString() };
  }
}

const absolute = (value: bigint): bigint => (value < 0n ? -value : value);
