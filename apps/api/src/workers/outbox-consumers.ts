import { NotificationPreferenceStore, NotificationStore } from '@machvon/db';
import type { AuthzCache, ConsumeSecurity, ControlDatabase, DeliveryEngine, EffectiveAccessStore, EntitlementCache, TenantDatabase } from '@machvon/db';
import { EntitlementChangedConsumer, ENTITLEMENT_CONSUMER } from '../entitlements/entitlement-consumer';
import { InProcessEntitlementPush } from '../entitlements/entitlement-push';
import type { EntitlementPushPort } from '../entitlements/entitlement-push';
import { TenantStatusChangedConsumer, TENANT_STATUS_CONSUMER } from '../modules/sas/tenant-status-consumer';
import { DatasetBuildConsumer } from '../modules/bi/dataset.consumer';
import { DGV_SNAPSHOT_FROZEN_CONSUMER, SnapshotFrozenConsumer } from '../modules/dgv/snapshot-frozen.consumer';
import { DIS_RANKING_COMPUTE_CONSUMER, RankingComputeConsumer } from '../modules/dis/ranking-compute.consumer';
import { DIS_REGISTRATION_CONSUMER, RegistrationConsumer } from '../modules/dis/registration.consumer';
import { ExplanationAutoConsumer, PRJ_EXPLANATION_AUTO_CONSUMER } from '../modules/prj/explanation-auto.consumer';
import { DIS_WARNING_EVALUATE_CONSUMER, WarningEvaluateConsumer } from '../modules/dis/warning-evaluate.consumer';
import { ISS_INTAKE_CONSUMER, IssIntakeConsumer } from '../modules/iss/intake.consumer';
import { PlanPublishedConsumer, PRJ_PLAN_PUBLISHED_CONSUMER } from '../modules/prj/plan-published.consumer';
import { AcceptanceLedgerConsumer, PAY_ACCEPTANCE_LEDGER_CONSUMER } from '../modules/pay/acceptance-ledger.consumer';
import { CAP_PAYMENT_LEDGER_CONSUMER, PaymentLedgerConsumer } from '../modules/cap/payment-ledger.consumer';
import { ADM_GUEST_CONTRACT_CONSUMER, GuestContractClosedConsumer } from '../modules/adm/guest-contract-closed.consumer';
import { AUD_PAY_RECOVERY_CONSUMER, PayRecoveryConsumer } from '../modules/aud/pay-recovery.consumer';
import { AUD_REPORT_CONSUMER, ReportConsumer } from '../modules/aud/report.consumer';
import { BID_REPORT_CONSUMER, BidReportConsumer } from '../modules/bid/report.consumer';
import { MNE_REPORT_CONSUMER, MneReportConsumer } from '../modules/mne/report.consumer';
import { CacheTenantStateEffects } from '../modules/sas/tenant-state-effects';
import { NOTIFICATION_CONSUMER, NotificationConsumer } from '../notifications/consumer';
import { ControlEventTypeCatalog, PayloadValidator } from '../notifications/payload-validator';
import { CHANNEL_VERIFICATION_CONSUMER, ChannelVerificationConsumer } from '../omni/channel-verification.consumer';
import type { ChannelVerificationDeps } from '../omni/channel-verification.consumer';
import { SILENT_PUSH_CONSUMER, SilentPushConsumer } from '../notifications/push/silent-push';
import type { SilentPushDeps } from '../notifications/push/silent-push';
import { PermissionResourceAccess } from '../notifications/resource-access-port';
import { PROVISIONING_CONSUMER } from '../provisioning/provisioning.consumer';
import type { ProvisioningConsumer } from '../provisioning/provisioning.consumer';
import type { TenantRuntimeSource } from '../session/tenant-runtime';
import { RegisteredEventConsumer } from './outbox-publisher';
import type { OutboxConsumer } from './outbox-publisher';

export interface OutboxConsumersDeps {
  tenants: TenantDatabase;
  control: ControlDatabase;
  /** Loads the access a notification recipient holds now. */
  access: EffectiveAccessStore;
  /** The caches of this process: a consumed event drops what they hold. */
  entitlementCache: EntitlementCache;
  authzCache: AuthzCache;
  tenantRuntime: TenantRuntimeSource;
  /** Key and alert sink of the signed delivery context; the relay signs with the same key. */
  security: ConsumeSecurity;
  provisioning: ProvisioningConsumer;
  /** Starts the delivery of the external channels of a notification (ST-NOT-002); without it notifications are delivered in the application only. */
  delivery?: DeliveryEngine;
  /** Tells connected clients that entitlements changed; defaults to the in-process transport. */
  push?: EntitlementPushPort;
  /** The consumer of the issue-request events of the source modules (DOC, ST-DOC-008); without it those events are not served. */
  docIssue?: OutboxConsumer;
  /** The silent push to the devices when entitlements or access change (ST-NOT-007); without it those events wake no device. */
  silentPush?: Omit<SilentPushDeps, 'database' | 'security'>;
  /** The verifier of the channel accounts (ST-OMNI-001); without it verification is asked for and never answered. */
  channelVerification?: Omit<ChannelVerificationDeps, 'database' | 'security'>;
}

/**
 * Every consumer of the outbox that exists: tenant provisioning (`sas.tenant.requested.v1`), the cache invalidations of a
 * changed entitlement and of a changed tenant status, and the notification consumer for the event types registered in the
 * catalogue. Each verifies the signed context of the delivery before it touches the database and runs once per event.
 */
export function createOutboxConsumers(deps: OutboxConsumersDeps): OutboxConsumer[] {
  const { tenants, control, security } = deps;
  const catalog = new ControlEventTypeCatalog(control);
  const notifications = new NotificationConsumer({
    database: tenants,
    store: new NotificationStore(),
    validator: new PayloadValidator(catalog),
    loadAccess: (ctx) => deps.access.load(ctx),
    resourceAccess: new PermissionResourceAccess(),
    security,
    ...(deps.delivery === undefined ? {} : { delivery: deps.delivery }),
    preferences: new NotificationPreferenceStore(),
  });
  const entitlements = new EntitlementChangedConsumer({
    database: tenants,
    cache: deps.entitlementCache,
    authzCache: deps.authzCache,
    push: deps.push ?? new InProcessEntitlementPush(),
    security,
  });
  const tenantStatus = new TenantStatusChangedConsumer({
    database: tenants,
    effects: new CacheTenantStateEffects({ runtime: deps.tenantRuntime, entitlementCache: deps.entitlementCache, authzCache: deps.authzCache }),
    security,
  });
  const planPublished = new PlanPublishedConsumer({ database: tenants, security });
  const acceptanceLedger = new AcceptanceLedgerConsumer({ database: tenants, security });
  const paymentLedger = new PaymentLedgerConsumer({ database: tenants, security });
  const issIntake = new IssIntakeConsumer({ database: tenants, security });
  const snapshotFrozen = new SnapshotFrozenConsumer({ database: tenants, security });
  const datasetBuild = new DatasetBuildConsumer({ database: tenants, security });
  const warningEvaluate = new WarningEvaluateConsumer({ database: tenants, security });
  const rankingCompute = new RankingComputeConsumer({ database: tenants, security });
  const registration = new RegistrationConsumer({ database: tenants, security });
  const explanationAuto = new ExplanationAutoConsumer({ database: tenants, security });
  const guestContracts = new GuestContractClosedConsumer({ database: tenants, security });
  const payRecoveries = new PayRecoveryConsumer({ database: tenants, security });
  const auditReports = new ReportConsumer({ database: tenants, security });
  const mneReports = new MneReportConsumer({ database: tenants, security });
  const bidReports = new BidReportConsumer({ database: tenants, security });
  return [
    { name: PROVISIONING_CONSUMER, handle: (delivery) => deps.provisioning.handle(delivery) },
    { name: ENTITLEMENT_CONSUMER, handle: (delivery) => entitlements.handle(delivery) },
    { name: TENANT_STATUS_CONSUMER, handle: (delivery) => tenantStatus.handle(delivery) },
    { name: PRJ_PLAN_PUBLISHED_CONSUMER, handle: (delivery) => planPublished.handle(delivery) },
    { name: PAY_ACCEPTANCE_LEDGER_CONSUMER, handle: (delivery) => acceptanceLedger.handle(delivery) },
    { name: CAP_PAYMENT_LEDGER_CONSUMER, handle: (delivery) => paymentLedger.handle(delivery) },
    { name: ISS_INTAKE_CONSUMER, handle: (delivery) => issIntake.handle(delivery) },
    { name: DGV_SNAPSHOT_FROZEN_CONSUMER, handle: (delivery) => snapshotFrozen.handle(delivery) },
    { name: datasetBuild.name, handle: (delivery) => datasetBuild.handle(delivery) },
    { name: DIS_WARNING_EVALUATE_CONSUMER, handle: (delivery) => warningEvaluate.handle(delivery) },
    { name: DIS_RANKING_COMPUTE_CONSUMER, handle: (delivery) => rankingCompute.handle(delivery) },
    { name: DIS_REGISTRATION_CONSUMER, handle: (delivery) => registration.handle(delivery) },
    { name: PRJ_EXPLANATION_AUTO_CONSUMER, handle: (delivery) => explanationAuto.handle(delivery) },
    { name: ADM_GUEST_CONTRACT_CONSUMER, handle: (delivery) => guestContracts.handle(delivery) },
    { name: AUD_PAY_RECOVERY_CONSUMER, handle: (delivery) => payRecoveries.handle(delivery) },
    { name: AUD_REPORT_CONSUMER, handle: (delivery) => auditReports.handle(delivery) },
    { name: MNE_REPORT_CONSUMER, handle: (delivery) => mneReports.handle(delivery) },
    { name: BID_REPORT_CONSUMER, handle: (delivery) => bidReports.handle(delivery) },
    ...(deps.docIssue === undefined ? [] : [deps.docIssue]),
    ...(deps.silentPush === undefined ? [] : [{ name: SILENT_PUSH_CONSUMER, handle: (delivery: Parameters<SilentPushConsumer['handle']>[0]) => new SilentPushConsumer({ ...deps.silentPush, database: tenants, security } as SilentPushDeps).handle(delivery) }]),
    ...(deps.channelVerification === undefined
      ? []
      : [{ name: CHANNEL_VERIFICATION_CONSUMER, handle: (delivery: Parameters<ChannelVerificationConsumer['handle']>[0]) => new ChannelVerificationConsumer({ ...deps.channelVerification, database: tenants, security } as ChannelVerificationDeps).handle(delivery) }]),
    new RegisteredEventConsumer(NOTIFICATION_CONSUMER, catalog, { name: NOTIFICATION_CONSUMER, handle: (delivery) => notifications.handle(delivery) }),
  ];
}
