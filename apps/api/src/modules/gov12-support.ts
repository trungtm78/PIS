import { DomainError, activeGrants, asUuid, holdsPermission, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { holdsOnWholeTenant } from './adm/tenant-authority';

/** The helpers the controllers of lane GOV-12 share: the whole-tenant right, the paging of a list, an id in a path or a query, and the Vietnam day. */

/** These records belong to no unit (a monitoring file, a transmittal, the portal, the whistle channel): only a grant on the whole tenant reaches them. */
export function assertWholeTenant(access: EffectiveAccess, permission: string): void {
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
}

/** Whether the caller holds the permission through any active grant (a recipient of a transmittal needs only the right to answer, on whatever scope). */
export function holdsAnywhere(access: EffectiveAccess, permission: string): boolean {
  return activeGrants(access, new Date()).some((grant) => holdsPermission(new Set(grant.permissions), permission));
}

export interface Page {
  limit: number;
  offset: number;
}

/** `limit` (1 to 200, 50 by default) and `offset` (0 to 100000) of a list; anything else is VALIDATION_FAILED naming the parameter. */
export function pageOf(limit: unknown, offset: unknown): Page {
  const take = limit === undefined ? 50 : Number(limit);
  const skip = offset === undefined ? 0 : Number(offset);
  if (!Number.isInteger(take) || take < 1 || take > 200) throw new DomainError('VALIDATION_FAILED', 422, 'limit');
  if (!Number.isInteger(skip) || skip < 0 || skip > 100_000) throw new DomainError('VALIDATION_FAILED', 422, 'offset');
  return { limit: take, offset: skip };
}

/** A query parameter that must be one of a list. */
export function oneOfQuery<T extends string>(value: unknown, allowed: readonly T[], name: string): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw new DomainError('VALIDATION_FAILED', 422, name);
  return value as T;
}

export function uuidQuery(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  const id = asUuid(value)?.toLowerCase();
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, name);
  return id;
}

export const booleanQuery = (value: unknown, name: string): boolean => {
  if (value === undefined) return false;
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  throw new DomainError('VALIDATION_FAILED', 422, name);
};

/** The business day in Vietnam. */
export const todayOf = (now: Date): string => vietnamDateOf(now);

/** The text of an optional field of a body, or null. */
export const textOrNull = (value: string | undefined | null): string | null => (value === undefined || value === null ? null : value);
