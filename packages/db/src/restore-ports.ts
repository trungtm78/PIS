import { isProductionEnvironment, recoveryWindowEndingAt } from '@machvon/kernel';
import type { Measurement, RecoveryWindow, RestoreTarget, RestoredCopy } from '@machvon/kernel';
import type { TenantDatabase } from './tenant-database.ts';
import { TenantRestoreStore } from './tenant-restore-store.ts';

/** The membership under which the mock reads the tenant it measures: no person, the platform's own. */
const MOCK_ENGINE_MEMBERSHIP_ID = '00000000-0000-4000-8000-000000000000';

/** What the engine is asked to restore. */
export interface RestoreJob {
  tenantId: string;
  restoreId: string;
  recoveryPoint: Date;
  target: RestoreTarget;
}

/** What the engine made: the instant it stopped at, where the copy is (a sandbox restore), what the backup recorded for the recovery point and what the restored copy holds. */
export interface RestoreOutcome {
  restoredTo: Date;
  /** The placement of the copy; null for a restore over the data of the tenant. */
  placement: string | null;
  expected: Measurement;
  restored: RestoredCopy;
}

/**
 * The port to the backup and restore of the platform (WAL archive, daily full backup, point-in-time recovery of 35 days on the domestic cloud; the infrastructure spike measures it, D10). It restores only the tenant it is
 * given and measures the copy the way `TenantRestoreStore.measure` does, against what the backup recorded for the recovery point.
 */
export interface TenantRestoreEngine {
  /** The recovery points the backups hold for the tenant, or undefined when they hold none (nothing can then be restored). */
  window(tenantId: string, now: Date): Promise<RecoveryWindow | undefined>;
  restore(job: RestoreJob): Promise<RestoreOutcome>;
}

export class RestoreEngineUnreachable extends Error {
  constructor() {
    super('the restore engine is not reachable');
    this.name = 'RestoreEngineUnreachable';
  }
}

export class RestoreEngineUnbound extends Error {
  constructor() {
    super('no restore engine is bound');
    this.name = 'RestoreEngineUnbound';
  }
}

/** The engine of an environment that holds real data until a real one is bound: it holds no recovery point, so no restore is asked for and none is claimed to have been made. */
export class UnboundRestoreEngine implements TenantRestoreEngine {
  window(): Promise<RecoveryWindow | undefined> {
    return Promise.resolve(undefined);
  }

  restore(): Promise<RestoreOutcome> {
    return Promise.reject(new RestoreEngineUnbound());
  }
}

/**
 * The MOCK of the restore engine, for environments that hold no real data: it has no backups, so its "restore" is a measure of the tenant as it is now, taken in one snapshot and used for both the backup and the copy (a copy that
 * matches by construction unless a test tampers with it). It places a sandbox copy nowhere. It proves the flow around the engine (the request, the decision, the worker, the verification, the report), not a backup.
 */
export class MockRestoreEngine implements TenantRestoreEngine {
  private tenants: TenantDatabase | undefined;
  private readonly store = new TenantRestoreStore();
  private failures = 0;
  private tamper: ((copy: RestoredCopy) => RestoredCopy) | undefined;
  private stopsBefore = 0;
  private windowFor: ((tenantId: string, now: Date) => RecoveryWindow | undefined) | undefined;
  readonly restored: RestoreJob[] = [];

  /** Where the tenants to measure are read from. */
  bind(tenants: TenantDatabase): this {
    this.tenants = tenants;
    return this;
  }

  /** The next `times` restores fail, as an engine that is down. */
  failNext(times: number): void {
    this.failures = times;
  }

  /** The restored copies are changed by `change` before they are reported (a table that lost a row, a row of another tenant). */
  tamperWith(change: ((copy: RestoredCopy) => RestoredCopy) | undefined): void {
    this.tamper = change;
  }

  /** The copies stop this many seconds before the recovery point asked for. */
  stopBefore(seconds: number): void {
    this.stopsBefore = seconds;
  }

  /** Replaces the window of the recovery points the mock holds (the 35 days to now by default). */
  holdOnly(window: ((tenantId: string, now: Date) => RecoveryWindow | undefined) | undefined): void {
    this.windowFor = window;
  }

  reset(): void {
    this.failures = 0;
    this.tamper = undefined;
    this.stopsBefore = 0;
    this.windowFor = undefined;
    this.restored.length = 0;
  }

  window(tenantId: string, now: Date): Promise<RecoveryWindow | undefined> {
    return Promise.resolve(this.windowFor === undefined ? recoveryWindowEndingAt(now) : this.windowFor(tenantId, now));
  }

  async restore(job: RestoreJob): Promise<RestoreOutcome> {
    if (this.tenants === undefined) throw new RestoreEngineUnbound();
    if (this.failures > 0) {
      this.failures -= 1;
      throw new RestoreEngineUnreachable();
    }
    const database = this.tenants;
    const measured = await database.withSnapshot({ tenantId: job.tenantId, membershipId: MOCK_ENGINE_MEMBERSHIP_ID, scopeVersion: 1 }, (tx) => this.store.measure(tx));
    this.restored.push(job);
    const copy: RestoredCopy = { ...measured, foreignRows: 0 };
    return {
      restoredTo: new Date(job.recoveryPoint.getTime() - this.stopsBefore * 1000),
      placement: job.target === 'SANDBOX' ? `mock-sandbox/${job.restoreId}` : null,
      expected: measured,
      restored: this.tamper === undefined ? copy : this.tamper(copy),
    };
  }
}

let shared: MockRestoreEngine | undefined;

/** One MOCK engine for the process: the commands that ask which recovery points exist and the worker that restores see the same one until a real engine is bound. */
export function sharedMockRestoreEngine(): MockRestoreEngine {
  shared ??= new MockRestoreEngine();
  return shared;
}

/** The engine of an environment: the MOCK where no real data is held, and none where it is (a restore is never claimed to have been made by an engine that made nothing). */
export function defaultRestoreEngine(tenants: TenantDatabase, environment: string | undefined): TenantRestoreEngine {
  return isProductionEnvironment(environment) ? new UnboundRestoreEngine() : sharedMockRestoreEngine().bind(tenants);
}
