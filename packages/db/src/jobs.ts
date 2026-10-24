import { WORKER_MEMBERSHIP_ID } from './consumer-inbox.ts';
import { DGV_NOT_ASSESSED_GAUGE } from './dgv-quality-run-job.ts';
import type { AuditSealJob } from './audit-seal-job.ts';
import type { ControlDatabase } from './control-database.ts';
import { PLATFORM_TENANT_ID } from './control-database.ts';
import type { IdempotencyStore } from './idempotency-store.ts';
import type { JobHandler } from './job-runner.ts';
import { OPEN_ISSUES_GAUGE, PENDING_ESCALATIONS_GAUGE } from './iss-sla-job.ts';
import type { SlaPassResult } from './iss-sla-job.ts';
import { SLA_SEVERITIES } from './iss-sla-policy-store.ts';
import { RETENTION_PENDING_GAUGE } from './retention-job.ts';
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
  // Every 15 minutes: a period is soft closed within a quarter of an hour after its deadline; the pass is idempotent (ST-DIS-001).
  'dis-period-autoclose': 900,
  // Every 5 minutes: the end of a reopening window is stored (EXPIRED) and audited within 5 minutes of its last instant. The rule itself never waits for this run: the submit guard and the reads judge the window by the clock (ST-DIS-002); the pass is idempotent.
  'dis-reopen-expiry': 300,
  // Hourly tick that works only in the 01:00 hour of Vietnam time, so the retention run happens once a night at a fixed hour wherever the process started (ST-ADM-017).
  'retention-purge': 3600,
  // Hourly tick that works only in the 06:00 hour of Vietnam time, so the guarantee reminders and expiries run once a morning wherever the process started; the pass is idempotent (ST-CTR-003).
  'guarantee-expiry': 3600,
  // Every minute: an event of the integration inbox waits at most a minute after its time has come (1, 5, 30 minutes between attempts, ST-ADM-018); the pass is idempotent.
  // Every 15 minutes: an issue that reaches 100 or 150 percent of its SLA is escalated within a quarter of an hour; the pass is idempotent (ST-ISS-004).
  'issue-sla': 900,
  'integration-inbox': 60,
  // Every 5 seconds, like the outbox relay: a retry on the schedule of 30 seconds is taken up within seconds of its time (ST-NOT-002, BR-NOT-03); the pass is idempotent.
  'notification-dispatch': 5,
  // Every 5 minutes: a send whose result was lost is found, and an Unknown one is asked about at its provider for a day (BR-NOT-04).
  'notification-reconcile': 300,
  // Every 10 seconds: a requested quality run is executed within seconds of its request; a run is executed once, whoever asks and however often (ST-DGV-002).
  'dgv-quality-run': 10,
  'access-cache-expiry': 60,
} as const;

export type JobName = keyof typeof JOB_INTERVAL_SECONDS;

/** The hour of the night, in Vietnam time (UTC+7, no daylight saving), in which the retention run works (ADM 3.12: daily at 01:00). */
export const RETENTION_HOUR = 1;
const VIETNAM_UTC_OFFSET_HOURS = 7;
/** The hour of the morning, in Vietnam time, in which the guarantee reminders and expiries run (CTR 3.5: 06:00). */
export const GUARANTEE_EXPIRY_HOUR = 6;
/** The gauges of the guarantee job: the ACTIVE guarantees within `days` days of their expiry, and the advance guarantees at risk with an advance still owed. */
export const GUARANTEE_EXPIRING_GAUGE = 'ctr_guarantee_expiring';
export const ADVANCE_GUARANTEE_AT_RISK_GAUGE = 'ctr_advance_guarantee_at_risk';

/** The hour of the day, 0 to 23, in Vietnam. */
export const vietnamHourOf = (instant: Date): number => (instant.getUTCHours() + VIETNAM_UTC_OFFSET_HOURS) % 24;

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
  /** Soft-closes the reporting periods past their deadline and locks them three working days later, by the same moves as the commands (ST-DIS-001). */
  disPeriods?: { autoclose(ctx: { tenantId: string; membershipId: string; scopeVersion: number }): Promise<unknown> };
  /** Stores the end of the reopening windows of locked periods that have ended (APPROVED to EXPIRED) and audits it (ST-DIS-002). */
  disReopens?: { expire(ctx: { tenantId: string; membershipId: string; scopeVersion: number }): Promise<unknown> };
  /**
   * The nightly retention run of a tenant (ST-ADM-017): removes the technical data that has outlived its period and puts the expired business
   * records on the review list, never deleting them; tells how many items wait, for the gauge below. Only the 01:00 hour of Vietnam time works.
   */
  retention?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<{ pending: number }> };
  /**
   * The daily pass over the guarantees of a tenant (ST-CTR-003): the reminders at 30, 15, 7 and 0 days and the expiry of the ones past their day;
   * tells how many guarantees are within each threshold, for the gauges. Only the 06:00 hour of Vietnam time works.
   */
  guaranteeExpiry?: {
    run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<{ expiring: Readonly<Record<number, number>>; advanceAtRisk: number }>;
  };
  /**
   * The pass over the issues of a tenant that are being worked (ST-ISS-004): writes the day an issue became overdue and raises the escalations whose threshold the
   * working time has reached; tells how many issues are open and how many escalations wait, for the gauges.
   */
  issueSla?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<SlaPassResult> };
  /** Takes up the inbound provider events that are due and have an adapter, and retries the failed ones when their wait is over (ST-ADM-018). */
  inbox?: { processDue(ctx: { tenantId: string; membershipId: string; scopeVersion: number }): Promise<unknown> };
  /** Sends the notifications that are due on each channel, and reconciles the sends whose result was lost (ST-NOT-002); the API process has the adapters. */
  notificationDelivery?: {
    dispatchDue(ctx: { tenantId: string; membershipId: string; scopeVersion: number }): Promise<unknown>;
    reconcile(ctx: { tenantId: string; membershipId: string; scopeVersion: number }): Promise<unknown>;
  };
  /** Executes the quality runs that are waiting (ST-DGV-002); tells how many datasets of the tenant have no finished run, for the gauge. */
  dgvQuality?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }): Promise<{ notAssessed: number }> };
  /** The clock of the jobs that depend on the time of day; default: the system clock. */
  clock?: () => Date;
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
  const { relay, accessCache, certificates, masterData, masterBaseline, disPeriods, disReopens, retention, inbox } = deps;
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
  if (disPeriods !== undefined) {
    handlers.push({ name: 'dis-period-autoclose', run: async () => eachTenant(await deps.tenantIds(), async (tenantId) => void (await disPeriods.autoclose(workerContext(tenantId)))) });
  }
  if (disReopens !== undefined) {
    handlers.push({ name: 'dis-reopen-expiry', run: async () => eachTenant(await deps.tenantIds(), async (tenantId) => void (await disReopens.expire(workerContext(tenantId)))) });
  }
  if (retention !== undefined) {
    handlers.push({
      name: 'retention-purge',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        if (vietnamHourOf(now) !== RETENTION_HOUR) return;
        const metrics = deps.metrics ?? NOOP_METRICS;
        let pending = 0;
        try {
          await eachTenant(await deps.tenantIds(), async (tenantId) => {
            pending += (await retention.run(workerContext(tenantId), now)).pending;
          });
        } finally {
          // The tenants that could be read still count: a failing tenant must not blank the gauge for the others.
          metrics.gauge(RETENTION_PENDING_GAUGE, pending);
        }
      },
    });
  }
  const guarantees = deps.guaranteeExpiry;
  if (guarantees !== undefined) {
    handlers.push({
      name: 'guarantee-expiry',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        if (vietnamHourOf(now) !== GUARANTEE_EXPIRY_HOUR) return;
        const metrics = deps.metrics ?? NOOP_METRICS;
        const expiring: Record<number, number> = { 0: 0, 7: 0, 15: 0, 30: 0 };
        let atRisk = 0;
        try {
          await eachTenant(await deps.tenantIds(), async (tenantId) => {
            const pass = await guarantees.run(workerContext(tenantId), now);
            for (const [days, count] of Object.entries(pass.expiring)) expiring[Number(days)] = (expiring[Number(days)] ?? 0) + count;
            atRisk += pass.advanceAtRisk;
          });
        } finally {
          // The tenants that could be read still count: a failing tenant must not blank the gauges for the others.
          for (const [days, count] of Object.entries(expiring)) metrics.gauge(GUARANTEE_EXPIRING_GAUGE, count, { days });
          metrics.gauge(ADVANCE_GUARANTEE_AT_RISK_GAUGE, atRisk);
        }
      },
    });
  }
  const sla = deps.issueSla;
  if (sla !== undefined) {
    handlers.push({
      name: 'issue-sla',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        const metrics = deps.metrics ?? NOOP_METRICS;
        const open: Record<string, number> = Object.fromEntries(SLA_SEVERITIES.map((severity) => [severity, 0]));
        let pending = 0;
        try {
          await eachTenant(await deps.tenantIds(), async (tenantId) => {
            const pass = await sla.run(workerContext(tenantId), now);
            for (const [severity, count] of Object.entries(pass.open)) open[severity] = (open[severity] ?? 0) + count;
            pending += pass.pending;
          });
        } finally {
          // The tenants that could be read still count: a failing tenant must not blank the gauges for the others.
          for (const [severity, count] of Object.entries(open)) metrics.gauge(OPEN_ISSUES_GAUGE, count, { severity });
          metrics.gauge(PENDING_ESCALATIONS_GAUGE, pending);
        }
      },
    });
  }
  if (inbox !== undefined) {
    handlers.push({ name: 'integration-inbox', run: async () => eachTenant(await deps.tenantIds(), async (tenantId) => void (await inbox.processDue(workerContext(tenantId)))) });
  }
  const delivery = deps.notificationDelivery;
  if (delivery !== undefined) {
    handlers.push({ name: 'notification-dispatch', run: async () => eachTenant(await deps.tenantIds(), async (tenantId) => void (await delivery.dispatchDue(workerContext(tenantId)))) });
    handlers.push({ name: 'notification-reconcile', run: async () => eachTenant(await deps.tenantIds(), async (tenantId) => void (await delivery.reconcile(workerContext(tenantId)))) });
  }
  const dgvQuality = deps.dgvQuality;
  if (dgvQuality !== undefined) {
    handlers.push({
      name: 'dgv-quality-run',
      run: async () => {
        const metrics = deps.metrics ?? NOOP_METRICS;
        let notAssessed = 0;
        try {
          await eachTenant(await deps.tenantIds(), async (tenantId) => {
            notAssessed += (await dgvQuality.run(workerContext(tenantId))).notAssessed;
          });
        } finally {
          // The tenants that could be read still count: a failing tenant must not blank the gauge for the others.
          metrics.gauge(DGV_NOT_ASSESSED_GAUGE, notAssessed);
        }
      },
    });
  }
  if (accessCache !== undefined) handlers.push({ name: 'access-cache-expiry', run: async () => void accessCache.expire() });
  return handlers;
}
