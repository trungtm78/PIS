import { DelegationLifecycleJob } from '../modules/adm/delegation-lifecycle';
import { SupportAccessJob } from '../modules/sas/support-access.job';
import { TenantDomainJob } from '../modules/sas/tenant-domain.job';
import { TenantRestoreJob } from '../modules/sas/tenant-restore.job';
import { TenantExportJob } from '../modules/sas/tenant-export.job';
import type { FileService } from '../modules/files/file.service';
import { UnboundProjectTransferPort } from '../modules/adm/unit-reorganization.port';
import { BillingJob } from '../modules/sas/billing.job';
import { effectsOf } from '../modules/sas/payment-effects';
import { UnitReorganizationJob } from '../modules/adm/unit-reorganization.job';
import { runAlertCoverage } from '../modules/home/alert-coverage.job';
import { runAlertEscalation } from '../modules/home/alert-escalation.job';
import { runWorkReminders } from '../modules/home/work-reminder.job';
import { runAlertLadders } from '../modules/home/alert-ladder.job';
import { runAlertObservation } from '../modules/home/alert-observe.job';
import { runRedFlagScan } from '../modules/aud/red-flag-scan.job';
import { runVendorLinkScan } from '../modules/bid/vendor-link-scan.job';
import { runVendorScreening } from '../modules/bid/vendor-screening.job';
import { runVendorPortalInvitationExpiry } from '../modules/bid/vendor-portal-invitation-expiry.job';
import { AdmMigrationJob } from '../modules/adm/migration.job';
import { MockEmbeddingPort, OcrDocumentTextPort } from '../modules/llm/knowledge-ports';
import type { AiEmbeddingPort } from '../modules/llm/knowledge-ports';
import { AiKnowledgeService } from '../modules/llm/knowledge.service';
import { expireExports, runExportSchedulesIn } from '../modules/bi/export-jobs';
import { expireQueryAnswers, runQueryJobsIn } from '../modules/bi/query-jobs';
import { remindHandoverDue } from '../modules/doc/handover-jobs';
import { markOverdueIncoming } from '../modules/doc/incoming-jobs';
import type { DocInteropSender } from '../modules/doc/interop-sender';
import { applyDueTransfers } from '../modules/prj/transfer-apply';
import {
  ApprovalSlaJob,
  AstClaimOverdueJob,
  AstEvaluationDueJob,
  defaultPlacementMover,
  sharedMockDomainPorts,
  defaultRestoreEngine,
  BillingPaymentStore,
  PLATFORM_TENANT_ID,
  PlacementMigrationRunner,
  WORKER_MEMBERSHIP_ID,
  AudRecoveryReconcileJob,
  AuditSealJob,
  AuditWriter,
  BASELINE_PACK,
  BidPetitionDue,
  CapAllocationExtensionStore,
  CapBalanceReconcileJob,
  CapFiscalYearStore,
  CertificateStore,
  CtrGuaranteeExpiry,
  CtrRetentionDue,
  CtrRevisionEffective,
  DgvIncidentSweepJob,
  DgvMaturityJob,
  DgvProductExpiryJob,
  QmsDiaryCoverageJob,
  CapReservationExpiryJob,
  DgvQualityRunJob,
  DisPeriodAutoclose,
  DisReopenExpiry,
  EntitlementOverrideStore,
  IdempotencyStore,
  IntegrationInboxProcessor,
  LlmFinopsStore,
  LlmKeySweepJob,
  InvitationExpiryJob,
  IssSlaJob,
  JOB_FAILED_ALERT,
  JOB_INTERVAL_SECONDS,
  JobRunner,
  LicenseStatusJob,
  LndStageLateJob,
  MasterStore,
  OutboxRelay,
  MneExportExpiryJob,
  NotificationCampaignStore,
  PayReconciliationOverdueJob,
  TreasuryDailyReconJob,
  EarlyWarningScoreJob,
  RiskRescoreJob,
  PayAdvanceOverdueJob,
  PaySettlementDeadlineJob,
  CtrSettlementClockStore,
  enqueueOutbox as enqueueSettlementClockEvent,
  PmtPermitExpiry,
  PmtPermitTypeStore,
  PmtWaiverExpiry,
  PrjExplanationOverdueJob,
  PrjTransferApplyJob,
  LogCapacityJob,
  RetentionJob,
  SubscriptionStore,
  applyBaseline,
  registeredTenantIds,
  sharedMockEInvoiceProvider,
  standardJobs,
} from '@machvon/db';
import type { ControlDatabase, DomainPorts, EInvoiceProviderPort, InboxHandlerRegistry, JobName, OutboxDelivery, PayloadRemover, PlacementMover, ReorganizationProjectPort, TenantDatabase, TenantRestoreEngine } from '@machvon/db';
import { IntervalScheduler, vietnamDateOf } from '@machvon/kernel';
import type { AlertSink, JobRunRecord, LiteLlmAdminPort, MetricsSink, SecretVaultPort, TenantContext, TimerPort } from '@machvon/kernel';
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
  /** Sends the messages of the LGSP that are due and asks about the ones the gateway took (ST-DOC-021); without it the job `doc-interop-send` is not scheduled. */
  docInterop?: Pick<DocInteropSender, 'runPass'>;
  /** The ports the virtual keys are kept through (ST-LLM-002): the sweep that revokes the old key of a rotation is scheduled only with them. */
  llmKeys?: { litellm: LiteLlmAdminPort; vault: SecretVaultPort };
  /** The port through which the reorganisation saga moves a project to the successor unit (XM-ADM-02); until the module that owns projects binds one, the saga stops at the first project. */
  reorganizationProjects?: ReorganizationProjectPort;
  /** The embedding model of the knowledge collections (ST-LLM-007); the stand-in of the process when none is given. */
  embeddings?: AiEmbeddingPort;
  /** The object store the exports of the data of a tenant are written to and the attachments are read from (ST-SAS-016); without it the export job is not scheduled. */
  exportFiles?: Pick<FileService, 'storeGenerated' | 'readStored' | 'listKind' | 'remove'>;
  /** The store of the document module: the files that rows refer to and the file service does not hold are read from it for the export. */
  documentFiles?: { get(key: string): Promise<{ bytes: Uint8Array } | undefined> };
  /** The DNS lookup and the certificate authority of the domains of the tenants (ST-SAS-017); the MOCK pair of the process when none is given. */
  domainPorts?: DomainPorts;
  /** The data path of the promotions of tenants to a silo (ST-SAS-018); the stand-in of the process outside production, none in production until the replication on the chosen cloud is confirmed (D02). */
  placementMover?: PlacementMover;
  /** The engine that restores one tenant to a recovery point (ST-SAS-019); the MOCK where no real data is held and none where it is, when none is given. */
  restoreEngine?: TenantRestoreEngine;
  /** The provider of e-invoices (ST-SAS-011); the MOCK when none is given. */
  einvoiceProvider?: EInvoiceProviderPort;
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
  const retentionDue = new CtrRetentionDue();
  const revisionEffective = new CtrRevisionEffective(audit);
  const petitionDue = new BidPetitionDue(audit);
  const permitExpiry = new PmtPermitExpiry(audit);
  const waiverExpiry = new PmtWaiverExpiry(audit);
  // The module that owns projects is not bound to the reorganisation saga yet (XM-ADM-02): until it is, the saga stops at the first project it has to move.
  const unitReorganization = new UnitReorganizationJob(deps.tenants, audit, deps.reorganizationProjects ?? new UnboundProjectTransferPort());
  const delegationLifecycle = new DelegationLifecycleJob(audit, deps.metrics === undefined ? {} : { metrics: deps.metrics });
  const supportAccessLifecycle = new SupportAccessJob(audit);
  const domains = new TenantDomainJob(audit, deps.domainPorts ?? sharedMockDomainPorts());
  const placementMigrations = new PlacementMigrationRunner({ control: deps.control, tenants: deps.tenants, mover: deps.placementMover ?? defaultPlacementMover(process.env.MACHVON_ENVIRONMENT), audit });
  const restores = new TenantRestoreJob(deps.tenants, audit, deps.restoreEngine ?? defaultRestoreEngine(deps.tenants, process.env.MACHVON_ENVIRONMENT));
  const approvalSla = new ApprovalSlaJob(audit, deps.metrics === undefined ? {} : { metrics: deps.metrics });
  const issueSla = new IssSlaJob(audit, deps.metrics === undefined ? {} : { metrics: deps.metrics });
  const dgvQuality = new DgvQualityRunJob(deps.tenants, audit, deps.metrics === undefined ? {} : { metrics: deps.metrics });
  const subscriptions = new SubscriptionStore();
  // The provider of e-invoices is the MOCK until a contract with a real one exists (D05/D06); the process shares one, as the commands do.
  const billing = new BillingJob(audit, deps.einvoiceProvider ?? sharedMockEInvoiceProvider());
  const payments = new BillingPaymentStore();
  const overrides = new EntitlementOverrideStore();
  const licenseStatus = new LicenseStatusJob(audit);
  const invitationExpiry = new InvitationExpiryJob(audit);
  const extensions = new CapAllocationExtensionStore();
  const fiscalYears = new CapFiscalYearStore();
  const stageLate = new LndStageLateJob(audit);
  const explanationOverdue = new PrjExplanationOverdueJob(audit, deps.metrics);
  const packageExpiry = new MneExportExpiryJob(audit);
  const transferApply = new PrjTransferApplyJob(audit, deps.metrics);
  const dgvIncidents = new DgvIncidentSweepJob(audit, deps.metrics);
  const dgvProducts = new DgvProductExpiryJob(audit, deps.metrics);
  const dgvMaturity = new DgvMaturityJob(audit, deps.metrics);
  const reconciliationOverdue = new PayReconciliationOverdueJob(audit, deps.metrics);
  const treasuryDailyRecon = new TreasuryDailyReconJob(audit, deps.metrics);
  const capitalBalances = new CapBalanceReconcileJob(audit, deps.metrics);
  const fundReservationExpiry = new CapReservationExpiryJob(audit, deps.metrics);
  const evaluationDue = new AstEvaluationDueJob(audit, deps.metrics);
  const claimOverdue = new AstClaimOverdueJob(audit, deps.metrics);
  const audRecoveries = new AudRecoveryReconcileJob(audit, deps.metrics);
  const settlementDeadlines = new PaySettlementDeadlineJob(audit, deps.metrics);
  const settlementClocks = new CtrSettlementClockStore();
  const advanceOverdue = new PayAdvanceOverdueJob(audit);
  const earlyWarningScore = new EarlyWarningScoreJob(audit);
  const riskRescore = new RiskRescoreJob(audit, deps.metrics);
  const diaryCoverage = new QmsDiaryCoverageJob(deps.metrics);
  const retention = new RetentionJob(deps.tenants, { ...(deps.metrics === undefined ? {} : { metrics: deps.metrics }), ...(deps.payloads === undefined ? {} : { payloads: deps.payloads }) });
  const logCapacity = new LogCapacityJob(deps.tenants, { ...(deps.metrics === undefined ? {} : { metrics: deps.metrics }), ...(deps.exportFiles === undefined ? {} : { archives: deps.exportFiles }) });
  const inbox =
    deps.inboxHandlers === undefined ? undefined : new IntegrationInboxProcessor(deps.tenants, deps.inboxHandlers, { alerts, ...(deps.metrics === undefined ? {} : { metrics: deps.metrics }) });
  const finops = new LlmFinopsStore();
  const interopSender = deps.docInterop;
  const keySweep = deps.llmKeys === undefined ? undefined : new LlmKeySweepJob(audit, deps.llmKeys.litellm, deps.llmKeys.vault, log);
  const campaigns = new NotificationCampaignStore();
  const handlers = standardJobs({
    tenantIds: () => registeredTenantIds(deps.control),
    seal: new AuditSealJob(deps.tenants, { alerts }),
    idempotency: new IdempotencyStore(deps.tenants),
    relay,
    certificates: { expireDue: (ctx) => deps.tenants.withTenant(ctx, (tx) => certificates.expireDue(tx)) },
    masterData: {
      activateDue: (ctx) => deps.tenants.withTenant(ctx, async (tx) => ({ changed: await masterData.activateDue(tx, ctx.membershipId), pendingReviews: await masterData.pendingReviews(tx) })),
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
    retention: {
      run: async (ctx, now) => {
        // The caps on the log classes run after the retention rule, in the same nightly pass; a failure of one does not hide the other (HT.06).
        const outcome = await retention.run(ctx, now).then(
          (done) => ({ done }),
          (error: unknown) => ({ error }),
        );
        await logCapacity.run(ctx, now).catch((error: unknown) => {
          if (!('error' in outcome)) throw error;
        });
        if ('error' in outcome) throw outcome.error;
        return outcome.done;
      },
    },
    guaranteeExpiry: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => guaranteeExpiry.run(tx, ctx.membershipId, now)) },
    retentionDue: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => retentionDue.run(tx, now)) },
    revisionEffective: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => revisionEffective.run(tx, ctx.membershipId, now)) },
    petitionDue: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => petitionDue.run(tx, ctx.membershipId, now)) },
    permitExpiry: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => permitExpiry.run(tx, ctx.membershipId, now)) },
    gateWaiverExpiry: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => waiverExpiry.run(tx, ctx.membershipId, now)) },
    issueSla: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => issueSla.run(tx, ctx.membershipId, now)) },
    unitReorganization: { run: (ctx, now) => unitReorganization.run(ctx, now) },
    // The conversion files are read from the same object store as the exports (ST-ADM-020).
    ...(deps.exportFiles === undefined ? {} : { admMigration: new AdmMigrationJob(deps.tenants, audit, deps.exportFiles, deps.metrics) }),
    // The knowledge of the AI gateway is indexed from the text the OCR recorded, stored in the same object store (ST-LLM-007).
    ...(deps.exportFiles === undefined
      ? {}
      : (() => {
          const knowledge = new AiKnowledgeService(deps.embeddings ?? new MockEmbeddingPort(), new OcrDocumentTextPort(deps.exportFiles), deps.exportFiles, audit);
          return { llmKnowledgeReindex: { run: (ctx: { tenantId: string; membershipId: string; scopeVersion: number }) => knowledge.reindexStale(deps.tenants, ctx, 20) } };
        })()),
    delegationLifecycle: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => delegationLifecycle.run(tx, ctx.membershipId, now)) },
    supportAccessLifecycle: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => supportAccessLifecycle.run(tx, ctx.membershipId, now)) },
    ...(deps.exportFiles === undefined ? {} : { tenantExport: new TenantExportJob(deps.tenants, deps.exportFiles, audit, deps.documentFiles) }),
    // The exports of BI are files too: the schedules are run, and the files are taken away after their days, with the same object store.
    ...(deps.exportFiles === undefined
      ? {}
      : {
          biExportRunner: {
            run: (ctx, now) =>
              runExportSchedulesIn(deps.tenants, ctx, now, {
                audit,
                files: deps.exportFiles as NonNullable<typeof deps.exportFiles>,
                ...(deps.metrics === undefined ? {} : { metrics: deps.metrics }),
              }),
          },
          biExportExpiry: {
            run: (ctx, now) =>
              deps.tenants.withTenant(ctx, (tx) =>
                expireExports(tx, ctx, now, { audit, files: deps.exportFiles as NonNullable<typeof deps.exportFiles>, ...(deps.metrics === undefined ? {} : { metrics: deps.metrics }) }),
              ),
          },
        }),
    // The heavy queries of BI are answered by the worker, for the person who asked, and what they kept is taken away after its hour.
    biQueryJobs: { run: (ctx, now) => runQueryJobsIn(deps.tenants, ctx, now, { audit, clock: () => new Date(), ...(deps.metrics === undefined ? {} : { metrics: deps.metrics }) }) },
    biQueryAnswerExpiry: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => expireQueryAnswers(tx, now)) },
    approvalSla: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => approvalSla.run(tx, ctx.membershipId, now)) },
    ...(inbox === undefined ? {} : { inbox }),
    ...(deps.notificationDelivery === undefined ? {} : { notificationDelivery: deps.notificationDelivery }),
    campaignProgress: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => campaigns.progress(tx, now)) },
    ...(deps.metrics === undefined ? {} : { metrics: deps.metrics }),
    dgvQuality: { run: (ctx) => dgvQuality.runPending(ctx) },
    // The plans are control-plane tables, so the pass of a tenant runs through the control role acting as that tenant.
    subscriptionCycle: { run: (ctx, now) => deps.control.withTenantOf(ctx.tenantId, (tx) => subscriptions.runCycle(tx, now)) },
    // The invoices are tenant rows and the plans are control-plane rows: the pass of a tenant runs through the control role acting as that tenant.
    einvoiceBilling: { run: (ctx, now) => deps.control.withTenantOf(ctx.tenantId, (tx) => billing.run(tx, ctx.membershipId, now)) },
    tenantDomain: { run: (ctx, now) => deps.control.withTenantOf(ctx.tenantId, (tx) => domains.run(tx, ctx.membershipId, now)) },
    // The migration is the tenant's own row and the placements are the control plane's: the pass of a tenant runs through the control role acting as that tenant.
    placementMigration: { run: (ctx, now) => placementMigrations.run(ctx, now) },
    // The restores are tenant rows, and the engine reads the tenant it restores: the pass runs as the worker of the tenant.
    tenantRestore: { run: (ctx, now) => restores.run(ctx, now) },
    // The payments that wait belong to the platform tenant and are matched with invoices of every tenant: one pass for the platform, through the control role.
    paymentReconciliation: {
      run: (now) =>
        payments.pass(
          (work) => deps.control.withTenantOf(PLATFORM_TENANT_ID, work),
          (tx) => effectsOf(audit, tx, WORKER_MEMBERSHIP_ID),
          { platformTenantId: PLATFORM_TENANT_ID, workerMembershipId: WORKER_MEMBERSHIP_ID, now },
        ),
    },
    // A year whose reopening has ended is locked by the job, which is a person of its own: the worker membership.
    fiscalYearRelock: { run: async (ctx, now) => ({ years: (await deps.tenants.withTenant(ctx, (tx) => fiscalYears.relockDue(tx, now, ctx.membershipId))).years }) },
    extensionLapse: { run: async (ctx, now) => ({ lapsed: await deps.tenants.withTenant(ctx, (tx) => extensions.lapseDue(tx, vietnamDateOf(now), ctx.membershipId)) }) },
    // An override and the entitlement version it ends in belong to the tenant: the pass runs through the control role acting as that tenant, like the subscription cycle.
    stageLate: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => stageLate.run(tx, ctx.membershipId, now)) },
    explanationOverdue: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => explanationOverdue.run(tx, ctx.membershipId, now)) },
    packageExpiry: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => packageExpiry.run(tx, ctx.membershipId, now)) },
    transferApply: { run: (ctx, now) => applyDueTransfers(deps.tenants, transferApply, ctx, now) },
    dgvIncidentSweep: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => dgvIncidents.run(tx, ctx.membershipId, now)) },
    dgvProductExpiry: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => dgvProducts.run(tx, ctx.membershipId, now)) },
    dgvMaturitySweep: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => dgvMaturity.run(tx, ctx.membershipId, now)) },
    incomingOverdue: {
      run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => markOverdueIncoming(tx, ctx.tenantId, now, { audit, ...(deps.metrics === undefined ? {} : { metrics: deps.metrics }) })),
    },
    handoverDue: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => remindHandoverDue(tx, ctx.tenantId, now, { audit, ...(deps.metrics === undefined ? {} : { metrics: deps.metrics }) })) },
    reconciliationOverdue: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => reconciliationOverdue.run(tx, ctx.membershipId, now)) },
    treasuryDailyRecon: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => treasuryDailyRecon.run(tx, ctx.membershipId, now)) },
    settlementDeadline: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => settlementDeadlines.run(tx, ctx.membershipId, now)) },
    advanceOverdue: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => advanceOverdue.run(tx, ctx.membershipId, now)) },
    workReminder: { run: (ctx, now) => runWorkReminders(deps.tenants, ctx, now, deps.metrics === undefined ? {} : { metrics: deps.metrics }) },
    alertEscalation: { run: (ctx, now) => runAlertEscalation(deps.tenants, ctx, now, deps.metrics === undefined ? {} : { metrics: deps.metrics }) },
    alertCoverage: { run: (ctx, now) => runAlertCoverage(deps.tenants, ctx, now, deps.metrics === undefined ? {} : { metrics: deps.metrics }) },
    alertObserve: { run: (ctx, now) => runAlertObservation(deps.tenants, ctx, now, deps.metrics === undefined ? {} : { metrics: deps.metrics }) },
    alertLadder: { run: (ctx, now) => runAlertLadders(deps.tenants, ctx, now, deps.metrics === undefined ? {} : { metrics: deps.metrics }) },
    redFlagScan: { run: (ctx, now) => runRedFlagScan(deps.tenants, ctx, now, deps.metrics === undefined ? {} : { metrics: deps.metrics }) },
    vendorLinkScan: { run: (ctx, now) => runVendorLinkScan(deps.tenants, ctx, now, deps.metrics === undefined ? {} : { metrics: deps.metrics }) },
    vendorScreening: { run: (ctx, now) => runVendorScreening(deps.tenants, ctx, now, deps.metrics === undefined ? {} : { metrics: deps.metrics }) },
    vendorPortalInvitationExpiry: { run: (ctx, now) => runVendorPortalInvitationExpiry(deps.tenants, ctx, now) },
    earlyWarningScore: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => earlyWarningScore.run(tx, ctx.membershipId, now)) },
    riskRescore: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => riskRescore.run(tx, ctx.membershipId, now)) },
    diaryCoverage: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => diaryCoverage.run(tx, now)) },
    capitalBalanceReconcile: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => capitalBalances.run(tx, ctx.membershipId, now)) },
    capitalReservationExpiry: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => fundReservationExpiry.run(tx, ctx.membershipId, now)) },
    astEvaluationDue: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => evaluationDue.run(tx, ctx.membershipId, now)) },
    astClaimOverdue: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => claimOverdue.run(tx, ctx.membershipId, now)) },
    audRecoveryReconcile: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => audRecoveries.run(tx, ctx.membershipId, now)) },
    // Licenses are control-plane rows too: the pass of a tenant runs through the control role acting as that tenant.
    licenseStatus: { run: (ctx, now) => deps.control.withTenantOf(ctx.tenantId, (tx) => licenseStatus.run(tx, ctx.membershipId, now)) },
    ...(interopSender === undefined ? {} : { docInteropSend: { run: (ctx: TenantContext, now: Date) => interopSender.runPass(deps.tenants, ctx, now) } }),
    ...(keySweep === undefined ? {} : { llmKeySweep: { run: (ctx: TenantContext, now: Date) => deps.tenants.withTenant(ctx, (tx) => keySweep.run(tx, ctx.membershipId, now)) } }),
    llmReservationExpiry: {
      run: (ctx, now) =>
        deps.tenants.withTenant(ctx, async (tx) => {
          const result = await finops.expireDue(tx, now);
          // The age of the oldest reservation still open, for the alert that a hold has been waiting too long.
          deps.metrics?.gauge('llm_budget_reservation_age_seconds', result.oldestAgeSeconds, { tenant_id: ctx.tenantId });
          return result;
        }),
    },
    invitationExpiry: { run: (ctx, now) => deps.tenants.withTenant(ctx, (tx) => invitationExpiry.run(tx, ctx.membershipId, now)) },
    overrideExpiry: { run: (ctx, now) => deps.control.withTenantOf(ctx.tenantId, (tx) => overrides.expireDue(tx, now)) },
    contractSettlementClock: {
      run: (ctx, now) =>
        deps.tenants.withTenant(ctx, (tx) =>
          settlementClocks.sync(tx, ctx.membershipId, audit, async (event) => void (await enqueueSettlementClockEvent(tx, { aggregateType: 'contract_settlement_clock', aggregateVersion: 1, schemaVersion: 1, ...event })), now),
        ),
    },
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
