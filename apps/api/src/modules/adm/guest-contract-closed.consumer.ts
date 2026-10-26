import { randomUUID } from 'node:crypto';
import { AuditWriter, GuestAccessStore, MemberStore, WORKER_MEMBERSHIP_ID, bumpScopeVersion, consumeOnce, enqueueOutbox } from '@machvon/db';
import type { ConsumeSecurity, OutboxDelivery, TenantDatabase } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';

export const ADM_GUEST_CONTRACT_CONSUMER = 'adm-guest-contract';
export const CONTRACT_CLOSED_EVENT = 'ctr.contract.closed.v1';
export const CONTRACT_TERMINATED_EVENT = 'ctr.contract.terminated.v1';
const SESSIONS_REVOKED_REASON = 'MEMBERSHIP_CHANGED';
const ENDED_REASON = 'The last contract of the guest has ended.';

export interface GuestContractConsumerDeps {
  database: TenantDatabase;
  security: ConsumeSecurity;
}

type Delivery = Pick<OutboxDelivery, 'id' | 'tenantId' | 'tenantContext' | 'type' | 'payload'>;

/**
 * The system consumer of the end of a contract (ST-ADM-007, BR-IAM-08): when `ctr.contract.closed.v1` or `ctr.contract.terminated.v1` arrives, the guest grants on that contract expire
 * (or lose it, when they cover other contracts too), a guest with no grant left is ended with their sessions and pending invitations, and the access of everyone concerned is judged
 * again (scope version, `iam.access.changed.v1`), so the guest is out within the minute the relay and the access cache need. One audit row for each grant and each ended membership,
 * in the name of the system. Delivered again, it changes nothing (the inbox row is written with the changes).
 */
export class GuestContractClosedConsumer {
  private readonly access = new GuestAccessStore();
  private readonly members = new MemberStore();
  private readonly audit: AuditWriter;

  constructor(private readonly deps: GuestContractConsumerDeps) {
    this.audit = new AuditWriter(deps.database);
  }

  async handle(delivery: Delivery): Promise<'processed' | 'duplicate' | 'ignored'> {
    if (delivery.type !== CONTRACT_CLOSED_EVENT && delivery.type !== CONTRACT_TERMINATED_EVENT) return 'ignored';
    // The payload names the tenant too; a delivery whose payload disagrees with its signed tenant is not ours to act on.
    if (asUuid(delivery.payload.tenant_id) !== delivery.tenantId) return 'ignored';
    const contractId = asUuid(delivery.payload.contract_id);
    if (contractId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'payload');
    return consumeOnce(
      this.deps.database,
      delivery,
      ADM_GUEST_CONTRACT_CONSUMER,
      async (tx) => {
        const correlationId = randomUUID();
        const change = await this.access.endContractAccess(tx, contractId, ENDED_REASON);
        if (change.grants.length === 0) return;
        for (const grant of change.grants) {
          await this.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
            action: grant.outcome === 'Expired' ? 'role_grant.expired' : 'role_grant.narrowed',
            resourceType: 'role_grant',
            resourceId: grant.grantId,
            classification: 'INTERNAL',
            diff: { membership_id: grant.membershipId, contract_id: contractId, remaining_contracts: grant.remaining.length },
            correlationId,
            requestId: randomUUID(),
          });
        }
        for (const membershipId of change.endedMembershipIds) {
          await this.members.revokeSessions(tx, membershipId, SESSIONS_REVOKED_REASON);
          await this.members.revokePendingInvitations(tx, membershipId);
          await this.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
            action: 'membership.ended_with_contract',
            resourceType: 'membership',
            resourceId: membershipId,
            classification: 'INTERNAL',
            diff: { contract_id: contractId },
            correlationId,
            requestId: randomUUID(),
          });
          await enqueueOutbox(tx, {
            aggregateType: 'membership',
            aggregateId: membershipId,
            aggregateVersion: 1,
            type: 'iam.membership.ended.v1',
            schemaVersion: 1,
            payload: { membership_id: membershipId, type: 'GUEST_CONTRACTOR', contract_id: contractId },
            eventKey: `iam.membership.ended.v1:${membershipId}:contract:${contractId}`,
            correlationId,
            causationId: delivery.id,
          });
        }
        const concerned = [...new Set(change.grants.map((grant) => grant.membershipId))];
        await bumpScopeVersion(tx, concerned);
        await enqueueOutbox(tx, {
          aggregateType: 'membership',
          aggregateId: concerned[0] ?? contractId,
          aggregateVersion: 1,
          type: 'iam.access.changed.v1',
          schemaVersion: 1,
          payload: { tenant_id: delivery.tenantId, membership_ids: concerned },
          eventKey: `iam.access.changed.v1:contract:${contractId}:${delivery.id}`,
          correlationId,
          causationId: delivery.id,
        });
      },
      this.deps.security,
    );
  }
}
