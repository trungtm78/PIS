import { AuditSealJob, CertificateStore, IdempotencyStore, JOB_FAILED_ALERT, JOB_INTERVAL_SECONDS, JobRunner, MasterStore, OutboxRelay, registeredTenantIds, standardJobs } from '@machvon/db';
import type { ControlDatabase, JobName, OutboxDelivery, TenantDatabase } from '@machvon/db';
import { IntervalScheduler } from '@machvon/kernel';
import type { AlertSink, JobRunRecord, MetricsSink, TimerPort } from '@machvon/kernel';
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
    ...(deps.metrics === undefined ? {} : { metrics: deps.metrics }),
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
