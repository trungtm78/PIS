import { NumberRegisterStore } from '@machvon/db';
import type { RegisterRecord, TenantTx } from '@machvon/db';
import { NOOP_ALERTS, NOOP_METRICS, vietnamYearOf } from '@machvon/kernel';
import type { AlertSink, MetricsSink } from '@machvon/kernel';

export const REGISTER_GAP_ALERT = 'DOC_REGISTER_GAP';
const PAGE = 200;

export interface RegisterJobDeps {
  store?: NumberRegisterStore;
  metrics?: MetricsSink;
  alerts?: AlertSink;
}

/**
 * BR-DOC-02: opens the registers of the new year for the tenant of the transaction, from the open registers of the
 * year before. Run at 00:00 on 1 January (Asia/Ho_Chi_Minh) by the platform scheduler, once per tenant; running it
 * again opens nothing more. Returns the registers it opened.
 */
export async function rolloverRegisters(tx: TenantTx, now: Date, actor: string, deps: RegisterJobDeps = {}): Promise<RegisterRecord[]> {
  const opened = await (deps.store ?? new NumberRegisterStore()).rollover(tx, { fromYear: vietnamYearOf(now) - 1, actor });
  (deps.metrics ?? NOOP_METRICS).increment('doc_register_rollover_total', { opened: String(opened.length) });
  return opened;
}

export interface RegisterGap {
  registerId: string;
  registerCode: string;
  year: number;
  numbers: number[];
}

/**
 * BR-DOC-03: looks for numbers missing from 1..last_number of every register of the tenant. A gap is a serious error:
 * each one raises `DOC_REGISTER_GAP` and the counter `doc_register_gap_total`. Returns the registers that have gaps.
 */
export async function auditRegisterGaps(tx: TenantTx, deps: RegisterJobDeps = {}): Promise<RegisterGap[]> {
  const store = deps.store ?? new NumberRegisterStore();
  const metrics = deps.metrics ?? NOOP_METRICS;
  const alerts = deps.alerts ?? NOOP_ALERTS;
  const found: RegisterGap[] = [];
  for (let after: { code: string; id: string } | undefined; ; ) {
    const page = await store.listRegisters(tx, { limit: PAGE, after });
    for (const register of page) {
      const numbers = await store.gaps(tx, register.id);
      if (numbers.length === 0) continue;
      found.push({ registerId: register.id, registerCode: register.registerCode, year: register.year, numbers });
      metrics.increment('doc_register_gap_total', { register_code: register.registerCode });
      alerts.raise(REGISTER_GAP_ALERT, { register_id: register.id, register_code: register.registerCode, year: register.year, missing: numbers });
    }
    const last = page[page.length - 1];
    if (page.length < PAGE || last === undefined) return found;
    after = { code: last.registerCode, id: last.id };
  }
}

export interface RegisterVoids {
  registerId: string;
  registerCode: string;
  year: number;
  numbers: number[];
}

/**
 * ST-DOC-012: the numbers that were voided, per register of the tenant. A voided number keeps its place in the ledger, so it is not a gap and raises nothing;
 * the audit lists them next to the gaps so that nobody mistakes a voided number for a missing one. Returns the registers that have any.
 */
export async function auditRegisterVoids(tx: TenantTx, deps: Pick<RegisterJobDeps, 'store'> = {}): Promise<RegisterVoids[]> {
  const store = deps.store ?? new NumberRegisterStore();
  const found: RegisterVoids[] = [];
  for (let after: { code: string; id: string } | undefined; ; ) {
    const page = await store.listRegisters(tx, { limit: PAGE, after });
    for (const register of page) {
      const numbers = await store.voidedNumbers(tx, register.id);
      if (numbers.length > 0) found.push({ registerId: register.id, registerCode: register.registerCode, year: register.year, numbers });
    }
    const last = page[page.length - 1];
    if (page.length < PAGE || last === undefined) return found;
    after = { code: last.registerCode, id: last.id };
  }
}
