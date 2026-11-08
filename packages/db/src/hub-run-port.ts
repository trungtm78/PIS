import { connectorDescriptor, hubRunOf, registerBuiltInConnectors } from '@machvon/kernel';
import type { HubRunRecord, RunKind, RunOutcome } from '@machvon/kernel';
import { HubStore } from './hub-store.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The shared port through which a connector that keeps its own import path or its own history tells the Integration Hub about a run (HUB-2). The connector calls `report` in the transaction of its own work, after it
 * has done it: the hub run log gets one row (the connector's behaviour does not change; a failure here is a defect, not an answer to the caller). A run with a source reference is recorded once, so a retry of the
 * connector's own step cannot count twice. Runs that already pass through the file import framework must NOT be reported: the hub reads those from the framework itself.
 */
export interface HubRunReport {
  kind: RunKind;
  outcome: RunOutcome;
  startedAt: Date;
  finishedAt: Date;
  layoutCode?: string | undefined;
  layoutVersion?: string | undefined;
  rowsTotal?: number | undefined;
  rowsApplied?: number | undefined;
  rowsRejected?: number | undefined;
  /** A stable upper case code of why the run failed; anything else (free text of the other side) is replaced by `RUN_FAILED`. */
  errorCode?: string | null | undefined;
  /** The identity of the thing the run was about (`hpm-push:<id>:<attempt>`, `master-import:<batch>`): the run is recorded once per reference. */
  sourceRef: string;
}

const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,79}$/;
const TO_COUNT = (value: number | undefined): number => (value === undefined || !Number.isInteger(value) || value < 0 ? 0 : value);

export class HubRunPort {
  private readonly hub = new HubStore();

  /**
   * Writes the run of a connector to the hub run log; returns whether it is new. The built-in connectors are registered first. A process that did not load the descriptor of the connector (the unit test of a store
   * alone, a process of another edition) has no hub for it: nothing is written and the answer is null.
   */
  async report(tx: TenantTx, connectorCode: string, run: HubRunReport, actor: string): Promise<{ id: string; duplicate: boolean } | null> {
    registerBuiltInConnectors();
    if (connectorDescriptor(connectorCode) === undefined) return null;
    const failed = run.outcome === 'FAILED';
    const total = TO_COUNT(run.rowsTotal);
    const applied = Math.min(TO_COUNT(run.rowsApplied), total);
    const rejected = Math.min(TO_COUNT(run.rowsRejected), total - applied);
    const record: HubRunRecord = hubRunOf(
      {
        kind: run.kind,
        outcome: run.outcome,
        started_at: run.startedAt.toISOString(),
        finished_at: run.finishedAt.toISOString(),
        layout_code: run.layoutCode ?? null,
        layout_version: run.layoutVersion ?? null,
        rows_total: total,
        rows_applied: applied,
        rows_rejected: rejected,
        error_code: failed ? (run.errorCode !== undefined && run.errorCode !== null && ERROR_CODE.test(run.errorCode) ? run.errorCode : 'RUN_FAILED') : null,
        source_ref: run.sourceRef,
      },
      new Date(Math.max(run.finishedAt.getTime(), run.startedAt.getTime())),
    );
    return this.hub.recordRun(tx, connectorCode, record, actor);
  }
}
