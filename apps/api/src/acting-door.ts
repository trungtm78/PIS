import { ActingStore } from '@machvon/db';
import type { ActingRecord, EffectiveAccessStore, TenantDatabase } from '@machvon/db';
import { restrictAccessForActing } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';

/** The request header that carries the id of the acting grant a request is made under (IAM-2, ADM-26). */
export const ACTING_HEADER = 'x-acting-as';
/** Request property that the policy guard fills when the request is made under an acting grant: the interceptor of the commands reads it to put both identities on every audit row. */
export const ACTING_REQUEST_KEY = 'acting';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a request made under an acting grant is: the grant, and the person it acts for. */
export interface ActingClaim {
  grantId: string;
  subjectId: string;
}

/** The grant of an open door and the access the request is judged on while it lasts. */
export interface ActingOpening {
  grant: ActingRecord;
  /** The access of the person, narrowed to the permissions of the grant, carrying the scope version and the activity of the administrator's own membership so that the decision of the guard reads the token as it should. */
  access: EffectiveAccess;
}

/** The id of the acting grant a request names, or undefined when it names none; a header that is not an id is `null`, so the guard refuses it instead of ignoring it. */
export function actingIdOf(header: string | string[] | undefined): string | null | undefined {
  if (header === undefined) return undefined;
  if (typeof header !== 'string' || !UUID.test(header.trim())) return null;
  return header.trim().toLowerCase();
}

/**
 * The door of the acting grants (IAM-2). A request that names a grant is let through only when the grant is in force now (approved, inside its window, not revoked), was asked for by the caller, and the person acted for is still an
 * active member. The grant is read on every request, so the end of its window or a revocation stops it at once. The access the request is judged on is the person's own grants narrowed to the permissions of the grant (and its
 * periods): nothing of the administrator's own access is added, so that the grant cannot be combined with other rights, and the person's rights that the grant does not list are never reached.
 */
export class ActingDoor {
  private readonly store = new ActingStore();

  constructor(
    private readonly database: TenantDatabase,
    private readonly access: EffectiveAccessStore,
  ) {}

  async open(tenant: TenantContext, grantId: string, own: EffectiveAccess, now: Date): Promise<ActingOpening | undefined> {
    const grant = await this.database.withTenant(tenant, (tx) => this.store.liveFor(tx, grantId, tenant.membershipId, now));
    if (grant === undefined || !own.membershipActive) return undefined;
    const subject = await this.access.load({ ...tenant, membershipId: grant.subjectId });
    if (!subject.membershipActive) return undefined;
    const restricted = restrictAccessForActing(subject, grant.permissions, grant.periodCodes);
    return { grant, access: { ...restricted, membershipId: own.membershipId, scopeVersion: own.scopeVersion, membershipActive: own.membershipActive } };
  }
}
