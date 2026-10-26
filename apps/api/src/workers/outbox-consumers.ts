import { NotificationPreferenceStore, NotificationStore } from '@machvon/db';
import type { AuthzCache, ConsumeSecurity, ControlDatabase, DeliveryEngine, EffectiveAccessStore, EntitlementCache, TenantDatabase } from '@machvon/db';
import { EntitlementChangedConsumer, ENTITLEMENT_CONSUMER } from '../entitlements/entitlement-consumer';
import { InProcessEntitlementPush } from '../entitlements/entitlement-push';
import type { EntitlementPushPort } from '../entitlements/entitlement-push';
import { TenantStatusChangedConsumer, TENANT_STATUS_CONSUMER } from '../modules/sas/tenant-status-consumer';
import { DGV_SNAPSHOT_FROZEN_CONSUMER, SnapshotFrozenConsumer } from '../modules/dgv/snapshot-frozen.consumer';
import { ISS_INTAKE_CONSUMER, IssIntakeConsumer } from '../modules/iss/intake.consumer';
import { PlanPublishedConsumer, PRJ_PLAN_PUBLISHED_CONSUMER } from '../modules/prj/plan-published.consumer';
import { AcceptanceLedgerConsumer, PAY_ACCEPTANCE_LEDGER_CONSUMER } from '../modules/pay/acceptance-ledger.consumer';
import { CAP_PAYMENT_LEDGER_CONSUMER, PaymentLedgerConsumer } from '../modules/cap/payment-ledger.consumer';
import { ADM_GUEST_CONTRACT_CONSUMER, GuestContractClosedConsumer } from '../modules/adm/guest-contract-closed.consumer';
import { CacheTenantStateEffects } from '../modules/sas/tenant-state-effects';
import { NOTIFICATION_CONSUMER, NotificationConsumer } from '../notifications/consumer';
import { ControlEventTypeCatalog, PayloadValidator } from '../notifications/payload-validator';
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
  const guestContracts = new GuestContractClosedConsumer({ database: tenants, security });
  return [
    { name: PROVISIONING_CONSUMER, handle: (delivery) => deps.provisioning.handle(delivery) },
    { name: ENTITLEMENT_CONSUMER, handle: (delivery) => entitlements.handle(delivery) },
    { name: TENANT_STATUS_CONSUMER, handle: (delivery) => tenantStatus.handle(delivery) },
    { name: PRJ_PLAN_PUBLISHED_CONSUMER, handle: (delivery) => planPublished.handle(delivery) },
    { name: PAY_ACCEPTANCE_LEDGER_CONSUMER, handle: (delivery) => acceptanceLedger.handle(delivery) },
    { name: CAP_PAYMENT_LEDGER_CONSUMER, handle: (delivery) => paymentLedger.handle(delivery) },
    { name: ISS_INTAKE_CONSUMER, handle: (delivery) => issIntake.handle(delivery) },
    { name: DGV_SNAPSHOT_FROZEN_CONSUMER, handle: (delivery) => snapshotFrozen.handle(delivery) },
    { name: ADM_GUEST_CONTRACT_CONSUMER, handle: (delivery) => guestContracts.handle(delivery) },
    ...(deps.docIssue === undefined ? [] : [deps.docIssue]),
    new RegisteredEventConsumer(NOTIFICATION_CONSUMER, catalog, { name: NOTIFICATION_CONSUMER, handle: (delivery) => notifications.handle(delivery) }),
  ];
}
