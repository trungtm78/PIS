import { randomUUID } from 'node:crypto';
import type { AuditWriter } from './audit-writer.ts';
import { enqueueOutbox } from './outbox.ts';
import type { TenantTx } from './tenant-database.ts';

export const MEMBERSHIP_EXPIRED_EVENT = 'iam.membership.expired.v1';
const RESOURCE_TYPE = 'membership';

interface LapsedRow {
  id: string;
  membership_type: string;
  organization_id: string;
  version: string;
}

export interface InvitationExpiryResult {
  /** The memberships that went from Invited to Expired in this pass. */
  expired: number;
}

// The membership is locked first and the invitation second, the order of an acceptance and of ending a membership, so the three cannot wait for each other.
// An Invited membership whose every Pending invitation has run out is the one that lapses; one that has been invited again (a live invitation) is left alone.
const LAPSED_SQL = `select m.id, m.membership_type, m.organization_id, m.version::text as version
    from machvon.membership m
   where m.status = 'Invited'
     and exists (select 1 from machvon.membership_invitation i where i.membership_id = m.id and i.status = 'Pending' and i.expires_at <= $1::timestamptz)
     and not exists (select 1 from machvon.membership_invitation live where live.membership_id = m.id and live.status = 'Pending' and live.expires_at > $1::timestamptz)
   order by m.id
     for update of m skip locked`;

/**
 * ST-ADM-006, the hourly invitation expiry: an invitation nobody accepted before its day runs out, and with it the membership it was for (Invited -> Expired), so the
 * person can be invited again and the seat count is not held by someone who never came. An invitation is otherwise expired only when someone opens it (AC-ST-ADM-006-2);
 * this pass makes the state true without waiting for that. One audit row and one `iam.membership.expired.v1` for each membership; neither carries the e-mail or the token.
 * A second pass finds nothing. It runs for the tenant of the transaction.
 */
export class InvitationExpiryJob {
  private readonly audit: Pick<AuditWriter, 'recordInTx'>;

  constructor(audit: Pick<AuditWriter, 'recordInTx'>) {
    this.audit = audit;
  }

  async run(tx: TenantTx, actor: string, now: Date): Promise<InvitationExpiryResult> {
    const correlationId = randomUUID();
    const [tenant] = await tx.query<{ tenant_id: string | null }>("select nullif(current_setting('app.tenant_id', true), '')::uuid::text as tenant_id");
    if (tenant?.tenant_id === undefined || tenant.tenant_id === null) throw new Error('the job ran outside a tenant');
    const lapsed = await tx.query<LapsedRow>(LAPSED_SQL, [now]);
    let expired = 0;
    for (const member of lapsed) {
      await tx.query(`update machvon.membership_invitation set status = 'Expired' where membership_id = $1::uuid and status = 'Pending' and expires_at <= $2::timestamptz`, [member.id, now]);
      const [updated] = await tx.query<{ version: string }>(`update machvon.membership set status = 'Expired', version = version + 1 where id = $1::uuid and status = 'Invited' returning version::text as version`, [member.id]);
      if (updated === undefined) continue;
      expired += 1;
      await this.audit.recordInTx(tx, actor, {
        action: 'membership.invitation_expired',
        resourceType: RESOURCE_TYPE,
        resourceId: member.id,
        classification: 'INTERNAL',
        diff: { organization_unit_id: member.organization_id, membership_type: member.membership_type },
        correlationId,
        requestId: randomUUID(),
      });
      await enqueueOutbox(tx, {
        aggregateType: RESOURCE_TYPE,
        aggregateId: member.id,
        aggregateVersion: Number(updated.version),
        type: MEMBERSHIP_EXPIRED_EVENT,
        schemaVersion: 1,
        payload: { membership_id: member.id, type: member.membership_type, unit_id: member.organization_id },
        eventKey: `${MEMBERSHIP_EXPIRED_EVENT}:${member.id}:${updated.version}`,
        correlationId,
      });
    }
    return { expired };
  }
}
