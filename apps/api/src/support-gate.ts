import { MODULES, OPERATIONS, PERMISSIONS, PLANES, STEP_UP } from '@machvon/contracts';
import { SupportAccessStore } from '@machvon/db';
import type { SupportGrantRow, TenantDatabase } from '@machvon/db';
import { reachesResource, supportPermissions } from '@machvon/kernel';
import type { EffectiveAccess, SupportOperation, TenantContext } from '@machvon/kernel';
import type { SupportClaim } from './principal';

/** Every operation of the contract as the scope of a support access grant sees it. */
export const SUPPORT_OPERATIONS: readonly SupportOperation[] = Object.keys(PERMISSIONS).map((id) => ({
  id,
  permission: (PERMISSIONS as Readonly<Record<string, string>>)[id] as string,
  module: (MODULES as Readonly<Record<string, string>>)[id],
  method: (OPERATIONS as Readonly<Record<string, { method: string }>>)[id]?.method ?? 'post',
  plane: (PLANES as Readonly<Record<string, string>>)[id] ?? 'tenant',
  stepUp: Object.hasOwn(STEP_UP, id),
}));

const BY_ID: ReadonlyMap<string, SupportOperation> = new Map(SUPPORT_OPERATIONS.map((operation) => [operation.id, operation]));

/** What the guard needs of a grant in force. */
export interface SupportDoor {
  grant: SupportGrantRow;
  access: EffectiveAccess;
}

/**
 * The door of a support token (ST-SAS-015, BR-SAS-16): the token says `act=support` and names a grant; the gate asks the database, on every request, whether the grant lets that operator in now (approved by everybody
 * it needs, not revoked, inside its window), and builds the access of the request from the grant alone: the permissions of the operations of the modules it names (reads only for a read-only grant), the
 * whole tenant as the scope. A request outside the modules, or outside the resources the grant names, is out of reach whatever permission the operation asks for.
 */
export class SupportGate {
  private readonly store = new SupportAccessStore();

  constructor(
    private readonly database: TenantDatabase,
    private readonly operations: readonly SupportOperation[] = SUPPORT_OPERATIONS,
  ) {}

  /** The door for this request, or undefined when the grant does not let the operator in. */
  async open(tenant: TenantContext, support: SupportClaim, now: Date): Promise<SupportDoor | undefined> {
    const grant = await this.database.withTenant(tenant, (tx) => this.store.liveGrant(tx, support.grantId, support.operatorId, now));
    if (grant === undefined) return undefined;
    const permissions = supportPermissions(this.operations, grant.modules, grant.accessMode);
    return {
      grant,
      access: {
        membershipId: tenant.membershipId,
        scopeVersion: tenant.scopeVersion,
        membershipActive: permissions.length > 0,
        grants: [{ roleCode: 'SUPPORT_ACCESS', rank: 0, permissions, scope: { kind: 'TENANT' }, status: 'Active', effectiveFrom: grant.startsAt ?? now, effectiveUntil: grant.expiresAt }],
      },
    };
  }

  /** Whether the grant reaches this operation and this path: the operation belongs to one of its modules, and the path names one of its resources when it names any. */
  reaches(door: SupportDoor, operationId: string, path: string): boolean {
    const operation = BY_ID.get(operationId);
    if (operation === undefined || operation.module === undefined) return false;
    const modules = door.grant.modules.map((module) => module.toLowerCase());
    if (!modules.includes(operation.module.toLowerCase())) return false;
    if (door.grant.accessMode === 'READ_ONLY' && operation.method.toUpperCase() !== 'GET') return false;
    return reachesResource(path, door.grant.resourceIds);
  }
}
