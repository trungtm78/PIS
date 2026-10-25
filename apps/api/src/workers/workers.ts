import { AuditSealJob, AuditWriter, BASELINE_PACK, BidPetitionDue, CapAllocationExtensionStore, CapFiscalYearStore, CertificateStore, CtrGuaranteeExpiry, CtrRevisionEffective, DgvQualityRunJob, DisPeriodAutoclose, DisReopenExpiry, EntitlementOverrideStore, IdempotencyStore, IntegrationInboxProcessor, IssSlaJob, JOB_FAILED_ALERT, JOB_INTERVAL_SECONDS, JobRunner, LndStageLateJob, MasterStore, OutboxRelay, PayReconciliationOverdueJob, PmtPermitExpiry, PmtPermitTypeStore, PmtWaiverExpiry, RetentionJob, SubscriptionStore, applyBaseline, registeredTenantIds, standardJobs } from '@machvon/db';
import type { ControlDatabase, InboxHandlerRegistry, JobName, OutboxDelivery, PayloadRemover, TenantDatabase } from '@machvon/db';
import { IntervalScheduler, vietnamDateOf } from '@machvon/kernel';
import type { AlertSink, JobRunRecord, MetricsSink, TenantContext, TimerPort } from '@machvon/kernel';
import type { Pool } from 'pg';

export interface WorkersDeps {
  tenants: TenantDatabase;
  /** Lists the tenants the jobs visit. */
  control: ControlDatabase;
  /** Connects as `machvon_outbox_relay`: the only role that reads every tenant's outbox. */
  relayPool: Pool;
  /** Holds the advisory lock of a running job on a connection of its own; any role will do, advisory locks need no privilege. */
  lockPool: Pool;
  /** Signs the worker context of every delivery; the consumers verify with the same key. */
  signingKey: Buffer;
  /** The one alert sink of the process: the relay, the seal job and the job runner raise through it. */
  alerts: AlertSink;
  /** Delivers one outbox event to its consumers (`createOutboxPublisher`). */
  publish: (delivery: OutboxDelivery) => Promise<void>;
  /** The access cache of this process: its lapsed entries are dropped every minute. */
  accessCache: { expire(): number };
  /** Receives the gauges of the jobs (`mdm_change_pending_gauge`); default: dropped until the exporter exists (KERNEL-050). */
  metrics?: MetricsSink;
  /** Removes the stored payload files of the inbox events that the retention job purges (the object store of the FILES module). */
  payloads?: PayloadRemover;
  /** The adapters that process inbound provider events, by provider; without any, the inbox job is not scheduled (ST-ADM-018). */
  inboxHandlers?: InboxHandlerRegistry;
  /** Sends the due notifications and reconciles the lost results (ST-NOT-002); without it the delivery jobs are not scheduled. */
  notificationDelivery?: { dispatchDue(ctx: TenantContext): Promise<unknown>; reconcile(ctx: TenantContext): Promise<unknown> };
}

export interface WorkersOptions {
  /** The clock; tests turn it by hand. */
  timers?: TimerPort;
  /** Replaces the documented interval of a job (the end-to-end stack polls its relay faster). */
  intervalSeconds?: Partial<Record<JobName, number>>;
  /** Where one JSON line per failed tick goes; defaults to standard error. */
  log?: (line: string) => void;
}

export interface RunningWorkers {
  /** The scheduled jobs, in the order of `JOB_INTERVAL_SECONDS`. */
  readonly jobs: readonly string[];
  /** The runs this process made (SKIPPED when another process held the job), oldest first; one job's or all. */
  history(name?: string): readonly JobRunRecord[];
  /** Stops the timers and resolves once the ticks in flight have ended. Safe to call twice. */
  stop(): Promise<void>;
}

const stderrLine = (line: string): void => void process.stderr.write(`${line}\n`);

// Only the class name is logged: messages can carry connection strings, personal data or SQL text.
const errorClassOf = (error: unknown): string => (error instanceof Error ? error.constructor.name : 'UnknownError');

function isJobName(name: string): name is JobName {
  return Object.hasOwn(JOB_INTERVAL_SECONDS, name);
}

/**
 * Starts the background work of the API process: the scheduler (kernel timer adapter) runs the standard jobs through the
 * job runner, so every job has one owner at a time wherever several processes run. The outbox relay is one of the jobs,
 * every 5 seconds. A tick never takes the process down: the runner records a failed run and raises JOB_FAILED, and a
 * failure that still escapes it is logged by error class and raised the same way.
 */
export function startWorkers(deps: WorkersDeps, options: WorkersOptions = {}): RunningWorkers {
  const { alerts } = deps;
  const log = options.log ?? stderrLine;
  const runner = new JobRunner(deps.lockPool, { alerts });
  const relay = new OutboxRelay(deps.relayPool, deps.publish, { signingKey: deps.signingKey, alerts });
  const certificates = new CertificateStore();
  const masterData = new MasterStore();
  const audit = new AuditWriter(deps.tenants);
  const disPeriods = new DisPeriodAutoclose(audit, deps.metrics === undefined ? {} : { metrics: deps.metrics });
  const disReopens = new DisReopenExpiry(audit, deps.metrics === undefined ? {} : { metrics: deps.metrics });
  const permitTypes = new PmtPermitTypeStore();
  const guaranteeExpiry = new CtrGuaranteeExpiry(audit);
  const revisionEffective = new CtrRevisionEffective(audit);
  const petitionDue = new BidPetitionDue(audit);
  const permitExpiry = new PmtPermitExpiry(audit);
  const waiverExpiry = new PmtWaiverExpiry(audit);
  const issueSla = new IssSlaJob(audit, deps.metrics === undefined ? {} : { metrics: deps.metrics });
  const dgvQuality = new DgvQualityRunJob(deps.tenants, audit, deps.metrics === undefined ? {} : { metrics: deps.metrics });
  const subscriptions = new SubscriptionStore();
  const overrides = new EntitlementOverrideStore();
  const extensions = new CapAllocationExtensionStore();
  const fiscalYears = new CapFiscalYearStore();
  const stageLate = new LndStageLateJob(audit);
  const reconciliationOverdue = new PayReconciliationOverdueJob(audit, deps.metrics);
  const retention = new RetentionJob(deps.tenants, { ...(deps.metrics === undefined ? {} : { metrics: deps.metrics }), ...(deps.payloads === undefined ? {} : { payloads: deps.payloads }) });
  const inbox = deps.inboxHandlers === undefined ? undefined : new IntegrationInboxProcessor(deps.tenants, deps.inboxHandlers, { alerts, ...(deps.metrics === undefined ? {} : { metrics: deps.metrics }) });
  const handlers = standardJobs({
    tenantIds: () => registeredTenantIds(deps.control),
    seal: new AuditSealJob(deps.tenants, { alerts }),
    idempotency: new IdempotencyStore(deps.tenants),
    relay,
    certificates: { expireDue: (ctx) => deps.tenants.withTenant(ctx, (tx) => certificates.expireDue(tx)) },
    masterData: {
      activateDue: (ctx) =>
        deps.tenants.withTenant(ctx, async (tx) => ({ changed: await masterData.activateDue(tx, ctx.membershipId), pendingReviews: await masterData.pendingReviews(tx) })),
    },
    masterBaseline: {
      apply: async (ctx) => {
        const applied = await deps.tenants.withTenant(ctx, (tx) => applyBaseline(tx, BASELINE_PACK, ctx.membershipId));
        // The permit type catalogue starts from its working assumptions (ST-PMT-001); a code the tenant already has is left alone. A separate transaction: one cannot undo the other.
        await deps.tenants.withTenant(ctx, (tx) => permitTypes.seedWorkingAssumptions(tx, ctx.membershipId, audit));
        return applied;
      },
    },
    disPeriods: { autoclose: (ctx) => deps.tenants.withTenant(ctx, (tx) => disPeriods.run(tx, ctx.membershipId, new Date())) },
    disReopens: { expire: (ctx) => deps.tenants.withTenant(ctx, (tx) => disReopens.run(tx, ctx.membershipId, new Date())) },
    retention: { run: (ctx, now) => retention.run(ctx, now) },
    guaranteeExpiry: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => guaranteeExpiry.run(tx, ctx.membershipId, now)) },
    revisionEffective: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => revisionEffective.run(tx, ctx.membershipId, now)) },
    petitionDue: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => petitionDue.run(tx, ctx.membershipId, now)) },
    permitExpiry: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => permitExpiry.run(tx, ctx.membershipId, now)) },
    gateWaiverExpiry: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => waiverExpiry.run(tx, ctx.membershipId, now)) },
    issueSla: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => issueSla.run(tx, ctx.membershipId, now)) },
    ...(inbox === undefined ? {} : { inbox }),
    ...(deps.notificationDelivery === undefined ? {} : { notificationDelivery: deps.notificationDelivery }),
    ...(deps.metrics === undefined ? {} : { metrics: deps.metrics }),
    dgvQuality: { run: (ctx) => dgvQuality.runPending(ctx) },
    // The plans are control-plane tables, so the pass of a tenant runs through the control role acting as that tenant.
    subscriptionCycle: { run: (ctx, now) => deps.control.withTenantOf(ctx.tenantId, (tx) => subscriptions.runCycle(tx, now)) },
    // A year whose reopening has ended is locked by the job, which is a person of its own: the worker membership.
    fiscalYearRelock: { run: async (ctx, now) => ({ years: (await deps.tenants.withTenant(ctx, (tx) => fiscalYears.relockDue(tx, now, ctx.membershipId))).years }) },
    extensionLapse: { run: async (ctx, now) => ({ lapsed: await deps.tenants.withTenant(ctx, (tx) => extensions.lapseDue(tx, vietnamDateOf(now), ctx.membershipId)) }) },
    // An override and the entitlement version it ends in belong to the tenant: the pass runs through the control role acting as that tenant, like the subscription cycle.
    stageLate: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => stageLate.run(tx, ctx.membershipId, now)) },
    reconciliationOverdue: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => reconciliationOverdue.run(tx, ctx.membershipId, now)) },
    overrideExpiry: { run: (ctx, now) => deps.control.withTenantOf(ctx.tenantId, (tx) => overrides.expireDue(tx, now)) },
    accessCache: deps.accessCache,
  });

  const onError = (job: string, error: unknown): void => {
    const errorClass = errorClassOf(error);
    log(JSON.stringify({ level: 'error', message: 'worker tick failed', job, errorClass }));
    try {
      alerts.raise(JOB_FAILED_ALERT, { job, errorClass });
    } catch (raising) {
      log(JSON.stringify({ level: 'error', message: 'worker alert not raised', job, errorClass: errorClassOf(raising) }));
    }
  };
  const scheduler = new IntervalScheduler({ onError, ...(options.timers === undefined ? {} : { timers: options.timers }) });
  for (const handler of handlers) {
    if (!isJobName(handler.name)) throw new Error(`job ${handler.name} has no documented interval`);
    runner.register(handler);
    scheduler.register(runner.scheduled(handler.name, options.intervalSeconds?.[handler.name] ?? JOB_INTERVAL_SECONDS[handler.name]));
  }
  scheduler.start();

  let stopping: Promise<void> | undefined;
  return {
    jobs: runner.names(),
    history: (name) => runner.history(name),
    stop: () => (stopping ??= scheduler.stop()),
  };
}
