import { randomUUID } from 'node:crypto';
import {
  AuditWriter,
  ControlDatabase,
  EffectiveAccessStore,
  EntitlementStore,
  InMemoryAuthzCache,
  InMemoryEntitlementCache,
  LicenseStore,
  TenantBootstrapStore,
  TenantDatabase,
  TenantRegistry,
  ThemeStore,
  WORKER_MEMBERSHIP_ID,
} from '@machvon/db';
import type { OutboxDelivery } from '@machvon/db';
import { signTenantContext } from '@machvon/kernel';
import { Pool } from 'pg';
import { MockInvitationMailer } from '../../src/modules/adm/invitation-mailer';
import { ENTITLEMENT_CONSUMER } from '../../src/entitlements/entitlement-consumer';
import { EnvironmentLicenseKeyStore } from '../../src/modules/sas/license-signer';
import { ISS_INTAKE_CONSUMER } from '../../src/modules/iss/intake.consumer';
import { ADM_GUEST_CONTRACT_CONSUMER } from '../../src/modules/adm/guest-contract-closed.consumer';
import { AUD_PAY_RECOVERY_CONSUMER } from '../../src/modules/aud/pay-recovery.consumer';
import { AUD_REPORT_CONSUMER } from '../../src/modules/aud/report.consumer';
import { DIS_RANKING_COMPUTE_CONSUMER } from '../../src/modules/dis/ranking-compute.consumer';
import { DIS_WARNING_EVALUATE_CONSUMER } from '../../src/modules/dis/warning-evaluate.consumer';
import { DGV_SNAPSHOT_FROZEN_CONSUMER } from '../../src/modules/dgv/snapshot-frozen.consumer';
import { PRJ_PLAN_PUBLISHED_CONSUMER } from '../../src/modules/prj/plan-published.consumer';
import { CAP_PAYMENT_LEDGER_CONSUMER } from '../../src/modules/cap/payment-ledger.consumer';
import { PAY_ACCEPTANCE_LEDGER_CONSUMER } from '../../src/modules/pay/acceptance-ledger.consumer';
import { TENANT_STATUS_CONSUMER } from '../../src/modules/sas/tenant-status-consumer';
import { NOTIFICATION_CONSUMER } from '../../src/notifications/consumer';
import { MockProvisioningPorts } from '../../src/provisioning/mock-ports';
import { PROVISIONING_CONSUMER } from '../../src/provisioning/provisioning.consumer';
import { createProvisioningConsumer } from '../../src/provisioning/provisioning-wiring';
import { DatabaseTenantRuntime } from '../../src/session/tenant-runtime';
import { createOutboxConsumers } from '../../src/workers/outbox-consumers';
import { createOutboxPublisher } from '../../src/workers/outbox-publisher';

// Nothing listens here: a consumer that reached the database would fail with a connection error, not with the verdict we expect.
const UNREACHABLE = 'postgres://nobody:nothing@127.0.0.1:1/none';
const TENANT = '00000000-0000-4000-8000-00000000000a';
const KEY = Buffer.alloc(32, 5);
const OTHER_KEY = Buffer.alloc(32, 6);

describe('the consumers of the outbox (ST-KERNEL-022)', () => {
  const pools: Pool[] = [];
  const raised: Array<{ code: string; context: Record<string, unknown> }> = [];

  const pool = (): Pool => {
    const made = new Pool({ connectionString: UNREACHABLE, max: 1 });
    made.on('error', () => undefined);
    pools.push(made);
    return made;
  };

  const consumersOnTheSharedSink = () => {
    const tenants = new TenantDatabase(pool());
    const control = new ControlDatabase(pool());
    const entitlementCache = new InMemoryEntitlementCache();
    const authzCache = new InMemoryAuthzCache();
    const entitlements = new EntitlementStore(tenants, entitlementCache);
    const security = { signingKey: KEY, alerts: { raise: (code: string, context: Record<string, unknown>) => void raised.push({ code, context }) } };
    const provisioning = createProvisioningConsumer({
      tenants,
      registry: new TenantRegistry(control),
      services: {
        control,
        entitlements,
        licenses: new LicenseStore(entitlements),
        keys: new EnvironmentLicenseKeyStore({ keyId: undefined, keyPath: undefined, retiredKeyId: undefined, retiredPublicKeyPath: undefined }),
        themes: new ThemeStore(),
        bootstrap: new TenantBootstrapStore(),
        audit: new AuditWriter(tenants),
        mailer: new MockInvitationMailer(),
      },
      ports: new MockProvisioningPorts(),
      security,
      delay: () => Promise.resolve(),
    });
    return createOutboxConsumers({
      tenants,
      control,
      access: new EffectiveAccessStore(tenants, authzCache),
      entitlementCache,
      authzCache,
      tenantRuntime: new DatabaseTenantRuntime(tenants),
      security,
      provisioning,
    });
  };

  const tamperedDelivery = (type: string, payload: Record<string, unknown>, signedWith: Buffer): OutboxDelivery => ({
    id: randomUUID(),
    tenantId: TENANT,
    tenantContext: signTenantContext({ tenantId: TENANT, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, signedWith),
    type,
    schemaVersion: 1,
    aggregateType: 'tenant',
    aggregateId: TENANT,
    aggregateVersion: 1,
    payload,
    eventKey: `tenant:${TENANT}:${randomUUID()}`,
    correlationId: randomUUID(),
    attempts: 0,
  });

  afterEach(async () => {
    raised.length = 0;
    await Promise.all(pools.splice(0).map((made) => made.end()));
  });

  it('names the consumers of the repository, one each', () => {
    expect(consumersOnTheSharedSink().map((consumer) => consumer.name)).toEqual([PROVISIONING_CONSUMER, ENTITLEMENT_CONSUMER, TENANT_STATUS_CONSUMER, PRJ_PLAN_PUBLISHED_CONSUMER, PAY_ACCEPTANCE_LEDGER_CONSUMER, CAP_PAYMENT_LEDGER_CONSUMER, ISS_INTAKE_CONSUMER, DGV_SNAPSHOT_FROZEN_CONSUMER, DIS_WARNING_EVALUATE_CONSUMER, DIS_RANKING_COMPUTE_CONSUMER, ADM_GUEST_CONTRACT_CONSUMER, AUD_PAY_RECOVERY_CONSUMER, AUD_REPORT_CONSUMER, NOTIFICATION_CONSUMER]);
  });

  it.each([
    ['sas.tenant.requested.v1', { attempt: 1 }],
    ['sas.entitlement.changed.v1', { tenant_id: TENANT, entitlements_hash: 'abc' }],
    ['sas.tenant.status_changed.v1', { tenant_id: TENANT, from: 'Active', to: 'Suspended' }],
  ])('raises OUTBOX_CONTEXT_TAMPERED through the shared alert sink for a %s delivery signed with another key (AC-ST-KERNEL-022-1)', async (type, payload) => {
    const delivery = tamperedDelivery(type, payload, OTHER_KEY);
    const publish = createOutboxPublisher(consumersOnTheSharedSink());
    await expect(publish(delivery)).rejects.toMatchObject({ code: 'TENANT_CONTEXT_INVALID' });
    expect(raised).toEqual([{ code: 'OUTBOX_CONTEXT_TAMPERED', context: { eventId: delivery.id, reason: 'INVALID_TOKEN' } }]);
  });

  it('does not touch the database for an event nobody consumes', async () => {
    const publish = createOutboxPublisher(consumersOnTheSharedSink().filter((consumer) => consumer.name !== NOTIFICATION_CONSUMER));
    await expect(publish(tamperedDelivery('iam.org_unit.created.v1', { id: TENANT }, KEY))).resolves.toBeUndefined();
    expect(raised).toEqual([]);
  });
});
