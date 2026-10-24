import { WORKER_MEMBERSHIP_ID } from './consumer-inbox.ts';
import type { AuditSealJob } from './audit-seal-job.ts';
import type { ControlDatabase } from './control-database.ts';
import { PLATFORM_TENANT_ID } from './control-database.ts';
import type { IdempotencyStore } from './idempotency-store.ts';
import type { JobHandler } from './job-runner.ts';
import { NOOP_METRICS } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';

/** The scheduled jobs of the platform (ADM section 9: seal every 5 minutes, verify and purge hourly, the cache every minute). */
export const JOB_INTERVAL_SECONDS = {
  'audit-seal': 300,
  'audit-verify': 3600,
  'outbox-relay': 5,
  'idempotency-purge': 3600,
  'certificate-expiry': 86400,
  // Hourly, so a version whose date has come is in force within the hour; the pass is idempotent.
  'master-activation': 3600,
  // Every six hours: a baseline that the platform publishes reaches a tenant within the shift; the pass is idempotent.
  'master-baseline-sync': 21600,
  'access-cache-expiry': 60,
} as const;

export type JobName = keyof typeof JOB_INTERVAL_SECONDS;

/** The jobs that need only the database, so a command line can run them on their own. */
export const DATABASE_JOBS: readonly JobName[] = ['audit-seal', 'audit-verify', 'idempotency-purge'];

/** One or more tenants failed in a job that visits them all; the others were still processed. */
export class TenantJobsFailed extends Error {
  readonly failed: number;
  /** The error classes seen (never messages: they can carry personal data), sorted. */
  readonly errorClasses: readonly string[];

  constructor(failed: number, errorClasses: readonly string[]) {
    super(`${failed} tenant(s) failed: ${errorClasses.join(', ')}`);
    this.name = 'TenantJobsFailed';
    this.failed = failed;
    this.errorClasses = errorClasses;
  }
}

/** The audit chain of at least one tenant did not verify (the AUDIT_CHAIN_BROKEN alert names which). */
export class AuditChainBroken extends Error {
  constructor(broken: number) {
    super(`${broken} tenant(s) with a broken audit chain`);
    this.name = 'AuditChainBroken';
  }
}

export interface StandardJobDeps {
  /** Every tenant whose rows the jobs visit. */
  tenantIds(): Promise<readonly string[]>;
  seal: Pick<AuditSealJob, 'seal' | 'verify'>;
  idempotency: Pick<IdempotencyStore, 'purgeExpired'>;
  /** One pass of the outbox relay; only the API process, which owns the broker adapter, has it. */
  relay?: { runOnce(): Promise<unknown> };
  /** Makes the stored status of the signing certificates whose validity has ended Expired (ST-ADM-008); the API process has the store. */
  certificates?: { expireDue(ctx: { tenantId: string; membershipId: string; scopeVersion: number }): Promise<number> };
  /**
   * Puts the master data versions whose date has come in force and retires the records whose retirement date has come
   * (ST-MDM-001); also tells how many change requests of the tenant wait for a reviewer, for the gauge below.
   */
  masterData?: { activateDue(ctx: { tenantId: string; membershipId: string; scopeVersion: number }): Promise<{ changed: number; pendingReviews: number }> };
  /** Applies the baseline pack of the platform to the tenant (ST-MDM-003): the catalogues and the rule data every tenant starts from. */
  masterBaseline?: { apply(ctx: { tenantId: string; membershipId: string; scopeVersion: number }): Promise<unknown> };
  /** Receives `mdm_change_pending_gauge`, the number of master data change requests that wait for a reviewer in all tenants. */
  metrics?: MetricsSink;
  /** Drops the lapsed entries of the access cache of this process. */
  accessCache?: { expire(): number };
}

const workerContext = (tenantId: string): { tenantId: string; membershipId: string; scopeVersion: number } => ({
  tenantId,
  membershipId: WORKER_MEMBERSHIP_ID,
  scopeVersion: 0,
});

/** Runs `work` for every tenant, one failure not stopping the others, then reports how many failed. */
async function eachTenant(tenantIds: readonly string[], work: (tenantId: string) => Promise<void>): Promise<void> {
  let failed = 0;
  const classes = new Set<string>();
  for (const tenantId of tenantIds) {
    try {
      await work(tenantId);
    } catch (error) {
      failed += 1;
      classes.add(error instanceof Error ? error.constructor.name : 'UnknownError');
    }
  }
  if (failed > 0) throw new TenantJobsFailed(failed, [...classes].sort());
}

/** The tenants of the registry plus the platform tenant that holds the audit rows of control-plane commands. */
export async function registeredTenantIds(control: ControlDatabase): Promise<string[]> {
  const rows = await control.withControl((tx) => tx.query<{ id: string }>('select id from machvon.tenant order by id'));
  return [...rows.map((row) => row.id), PLATFORM_TENANT_ID];
}

/** The handlers of the jobs `deps` can serve, in the order of JOB_INTERVAL_SECONDS. */
export function standardJobs(deps: StandardJobDeps): JobHandler[] {
  const handlers: JobHandler[] = [
    { name: 'audit-seal', run: async () => eachTenant(await deps.tenantIds(), async (tenantId) => void (await deps.seal.seal(workerContext(tenantId)))) },
    {
      name: 'audit-verify',
      run: async () => {
        let broken = 0;
        let failure: unknown;
        try {
          await eachTenant(await deps.tenantIds(), async (tenantId) => {
            if (!(await deps.seal.verify(workerContext(tenantId))).ok) broken += 1;
          });
        } catch (error) {
          failure = error;
        }
        // A broken chain is the more important signal; the tenants that could not be checked come second.
        if (broken > 0) throw new AuditChainBroken(broken);
        if (failure !== undefined) throw failure;
      },
    },
  ];
  const { relay, accessCache, certificates, masterData, masterBaseline } = deps;
  if (relay !== undefined) handlers.push({ name: 'outbox-relay', run: async () => void (await relay.runOnce()) });
  handlers.push({
    name: 'idempotency-purge',
    run: async () => eachTenant(await deps.tenantIds(), async (tenantId) => void (await deps.idempotency.purgeExpired(workerContext(tenantId)))),
  });
  if (certificates !== undefined) {
    handlers.push({ name: 'certificate-expiry', run: async () => eachTenant(await deps.tenantIds(), async (tenantId) => void (await certificates.expireDue(workerContext(tenantId)))) });
  }
  if (masterData !== undefined) {
    handlers.push({
      name: 'master-activation',
      run: async () => {
        const metrics = deps.metrics ?? NOOP_METRICS;
        let pending = 0;
        try {
          await eachTenant(await deps.tenantIds(), async (tenantId) => {
            pending += (await masterData.activateDue(workerContext(tenantId))).pendingReviews;
          });
        } finally {
          // The tenants that could be read still count: a failing tenant must not blank the gauge for the others.
          metrics.gauge('mdm_change_pending_gauge', pending);
        }
      },
    });
  }
  if (masterBaseline !== undefined) {
    handlers.push({ name: 'master-baseline-sync', run: async () => eachTenant(await deps.tenantIds(), async (tenantId) => void (await masterBaseline.apply(workerContext(tenantId)))) });
  }
  if (accessCache !== undefined) handlers.push({ name: 'access-cache-expiry', run: async () => void accessCache.expire() });
  return handlers;
}
