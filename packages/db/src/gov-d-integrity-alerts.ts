import { DisbursementExceptionStore } from './gov-d-exception-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The alert types of the payment integrity checks (G4-2, lane D), as the alert centre reads them: the codes are the ones of the `ALERT_TYPE` rule (kernel `registerIntegrityRules`), the owner, the expected action and the consequence are
 * the ones the rule gives. `PAYMENT_INTEGRITY_BLOCKED` (ACTION): a draft that a check blocked and nobody has sent since; `PAYMENT_INTEGRITY_SIGNAL` (WATCH): a request that was sent with signals and is waiting for its approver;
 * `DISBURSEMENT_EXCEPTION_EXPIRING` (WATCH): an approved exception that lapses within the window (or has lapsed unused).
 */
export type IntegrityAlertType = 'PAYMENT_INTEGRITY_BLOCKED' | 'PAYMENT_INTEGRITY_SIGNAL' | 'DISBURSEMENT_EXCEPTION_EXPIRING';

export interface IntegrityAlertItem {
  alertType: IntegrityAlertType;
  /** The id the decisions of people name the item by: the request (blocked, signal) or the exception. */
  itemId: string;
  paymentRequestId: string;
  contractId: string;
  projectId: string | null;
  /** The day (Vietnamese time) it began: when the run was made, or the day the exception lapses. */
  since: string;
  detail: Record<string, unknown>;
}

const CONTRACT_JOINS = `join machvon.contract c on c.tenant_id = r.tenant_id and c.id = r.contract_id
  join machvon.project p on p.tenant_id = c.tenant_id and p.id = c.project_id
  join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
  left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id`;

export class PayIntegrityAlertSource {
  private readonly exceptions = new DisbursementExceptionStore();

  /**
   * What a reader with the scope has to do now: reads only (the alerts are facts of the tables, never a state of their own). A source that cannot be read throws, so the caller names it and never turns it into "no alert".
   * `windowDays` is how far back a blocked draft still counts and how far ahead an exception that lapses is shown. `only` asks for some of the three types (the alert centre reads them as sources of their own, each with its
   * own window and its own failure): the others are not read.
   */
  async items(tx: TenantTx, read: ScopeBuilder, today: string, windowDays: number, only: readonly IntegrityAlertType[] = ['PAYMENT_INTEGRITY_BLOCKED', 'PAYMENT_INTEGRITY_SIGNAL', 'DISBURSEMENT_EXCEPTION_EXPIRING']): Promise<IntegrityAlertItem[]> {
    const predicate = read(3);
    const blocked = !only.includes('PAYMENT_INTEGRITY_BLOCKED') ? [] : await tx.query<{ id: string; contract_id: string; project_id: string; day: string; codes: string[]; run_id: string }>(
      `select pr.id, r.contract_id, r.project_id, (r.created_at at time zone 'Asia/Ho_Chi_Minh')::date::text as day, r.id as run_id,
              array(select distinct f.code from machvon.payment_integrity_finding f where f.tenant_id = r.tenant_id and f.run_id = r.id and f.kind = 'INVARIANT' and not f.excused order by 1) as codes
         from machvon.payment_integrity_run r
         join machvon.payment_request pr on pr.tenant_id = r.tenant_id and pr.id = r.payment_request_id
         ${CONTRACT_JOINS}
        where r.outcome = 'BLOCKED' and pr.status = 'DRAFT' and r.created_at >= ($1::date - $2::int)
          and r.id = (select l.id from machvon.payment_integrity_run l where l.tenant_id = r.tenant_id and l.payment_request_id = r.payment_request_id order by l.created_at desc, l.id desc limit 1)
          and ${predicate.sql}
        order by r.created_at desc, r.id limit 500`,
      [today, windowDays, ...predicate.params],
    );
    const signals = !only.includes('PAYMENT_INTEGRITY_SIGNAL') ? [] : await tx.query<{ id: string; contract_id: string; project_id: string; day: string; codes: string[]; run_id: string }>(
      `select pr.id, r.contract_id, r.project_id, (r.created_at at time zone 'Asia/Ho_Chi_Minh')::date::text as day, r.id as run_id,
              array(select distinct f.code from machvon.payment_integrity_finding f where f.tenant_id = r.tenant_id and f.run_id = r.id and not f.excused order by 1) as codes
         from machvon.payment_integrity_run r
         join machvon.payment_request pr on pr.tenant_id = r.tenant_id and pr.id = r.payment_request_id
         ${CONTRACT_JOINS}
        where r.trigger_kind = 'SUBMIT' and r.signal_count > 0 and r.outcome <> 'BLOCKED' and pr.status = 'SUBMITTED'
          -- no day bound: a signal stays while its request waits for the approver ($1 and $2 are the shared parameters of the three reads)
          and $1::date is not null and $2::int >= 0
          and r.id = (select l.id from machvon.payment_integrity_run l where l.tenant_id = r.tenant_id and l.payment_request_id = r.payment_request_id order by l.created_at desc, l.id desc limit 1)
          and ${predicate.sql}
        order by r.created_at desc, r.id limit 500`,
      [today, windowDays, ...predicate.params],
    );
    const expiring = !only.includes('DISBURSEMENT_EXCEPTION_EXPIRING') ? [] : await this.exceptions.expiring(tx, read, today, windowDays);
    return [
      ...blocked.map((row): IntegrityAlertItem => ({ alertType: 'PAYMENT_INTEGRITY_BLOCKED', itemId: row.id, paymentRequestId: row.id, contractId: row.contract_id, projectId: row.project_id, since: row.day, detail: { run_id: row.run_id, codes: row.codes } })),
      ...signals.map((row): IntegrityAlertItem => ({ alertType: 'PAYMENT_INTEGRITY_SIGNAL', itemId: row.id, paymentRequestId: row.id, contractId: row.contract_id, projectId: row.project_id, since: row.day, detail: { run_id: row.run_id, codes: row.codes } })),
      ...expiring.map((item): IntegrityAlertItem => ({ alertType: 'DISBURSEMENT_EXCEPTION_EXPIRING', itemId: item.id, paymentRequestId: item.paymentRequestId, contractId: item.contractId, projectId: item.projectId, since: item.validTo, detail: { ceiling: item.ceiling, allowed_amount_vnd: item.allowedAmountVnd, days_left: item.daysLeft } })),
    ];
  }
}
