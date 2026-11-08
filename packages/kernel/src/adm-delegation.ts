import { activeGrants } from './effective-access.ts';
import type { EffectiveAccess } from './effective-access.ts';
import { DomainError } from './errors.ts';
import { permissionCovered } from './anti-escalation.ts';
import { scopeCovers } from './scope.ts';
import type { Scope } from './scope.ts';

/**
 * The time-boxed delegation of approval authority (ST-ADM-014, ADM 3.5, BR-ADM-06): what makes a request to delegate valid, and the life of a delegation by the clock. Whether the delegator holds what they pass on
 * (anti-escalation) and whether a chain is formed are judged on the grants by the command; this is the part that needs no data.
 */

/** A delegation lasts at most this many days (the table says so too). */
export const MAX_DELEGATION_DAYS = 90;
/** The scopes a delegation can have: the units, which is what the approval engine and the signing check match a delegation against. A project scope waits until they can match it. */
export const DELEGATION_SCOPE_KINDS = ['UNIT_SUBTREE', 'UNIT_ONLY'] as const;
/**
 * The permissions something reads a delegation for: `approval.decide` (the approval engine and the door of the decision) and `doc.outgoing.sign` (the signing authority check, ST-DOC-007). Another permission would be recorded and
 * never exercised, so it is refused until a consumer reads it.
 */
export const DELEGABLE_PERMISSIONS = ['approval.decide', 'doc.outgoing.sign'] as const;
/** The permissions of the administration of access and of the organisation are never delegated (BR-ADM-06 [working assumption]: only the business permissions are). */
const ADMINISTRATIVE_PREFIXES = ['iam.', 'adm.'] as const;
const DAY_MS = 86_400_000;
/** A start this far in the past is the clock of the client, not a delegation backdated. */
const START_SLACK_MS = 5 * 60_000;
const PERMISSION = /^[a-z][a-z0-9_]*(\.([a-z][a-z0-9_]*|\*))+$/;

export interface DelegationRequest {
  permissions: readonly string[];
  scopeKind: string;
  scopeRefIds: readonly string[];
  validFrom: Date;
  validUntil: Date;
}

export interface DelegationDefect {
  field: string;
  code: 'REQUIRED' | 'MALFORMED' | 'DUPLICATE' | 'WILDCARD' | 'ADMINISTRATIVE' | 'UNSUPPORTED' | 'BEFORE_START' | 'TOO_LONG' | 'IN_THE_PAST' | 'ALREADY_ENDED';
}

/** Every defect of a request to delegate, in the order of the fields; none when it is valid. */
export function validateDelegation(request: DelegationRequest, now: Date): DelegationDefect[] {
  const defects: DelegationDefect[] = [];
  const add = (field: string, code: DelegationDefect['code']): void => void defects.push({ field, code });
  const from = request.validFrom.getTime();
  const until = request.validUntil.getTime();
  if (from < now.getTime() - START_SLACK_MS) add('valid_from', 'IN_THE_PAST');
  if (until <= from) add('valid_until', 'BEFORE_START');
  else if (until - from > MAX_DELEGATION_DAYS * DAY_MS) add('valid_until', 'TOO_LONG');
  else if (until <= now.getTime()) add('valid_until', 'ALREADY_ENDED');
  defects.push(...validateDelegationContent(request));
  return defects;
}

/** The defects of what a delegation hands over, whatever its duration: the permissions and the scope. The time-boxed and the permanent delegation share it. */
export function validateDelegationContent(request: Pick<DelegationRequest, 'permissions' | 'scopeKind' | 'scopeRefIds'>): DelegationDefect[] {
  const defects: DelegationDefect[] = [];
  const add = (field: string, code: DelegationDefect['code']): void => void defects.push({ field, code });
  if (request.permissions.length === 0) add('permissions', 'REQUIRED');
  const seen = new Set<string>();
  request.permissions.forEach((permission, index) => {
    const field = `permissions[${index}]`;
    if (permission === '*') add(field, 'WILDCARD');
    else if (!PERMISSION.test(permission)) add(field, 'MALFORMED');
    else if (ADMINISTRATIVE_PREFIXES.some((prefix) => permission.startsWith(prefix))) add(field, 'ADMINISTRATIVE');
    else if (!(DELEGABLE_PERMISSIONS as readonly string[]).includes(permission)) add(field, 'UNSUPPORTED');
    else if (seen.has(permission)) add(field, 'DUPLICATE');
    seen.add(permission);
  });
  if (!(DELEGATION_SCOPE_KINDS as readonly string[]).includes(request.scopeKind)) add('scope_kind', 'UNSUPPORTED');
  if (request.scopeRefIds.length === 0) add('scope_ref_ids', 'REQUIRED');
  else if (new Set(request.scopeRefIds).size !== request.scopeRefIds.length) add('scope_ref_ids', 'DUPLICATE');
  return defects;
}

/** 422 `DELEGATION_INVALID` naming the first field, with every defect as a member of the problem. */
export function assertValidDelegation(request: DelegationRequest, now: Date): void {
  const defects = validateDelegation(request, now);
  if (defects.length > 0) throw new DomainError('DELEGATION_INVALID', 422, defects[0]?.field, { extensions: { defects } });
}

/** Where a delegation stands by the clock: before its first instant it is waiting, inside its window it is in force, from its last instant it is over. */
export function delegationAt(window: { validFrom: Date; validUntil: Date }, now: Date): 'Scheduled' | 'Active' | 'Ended' {
  if (now.getTime() >= window.validUntil.getTime()) return 'Ended';
  return now.getTime() >= window.validFrom.getTime() ? 'Active' : 'Scheduled';
}

/**
 * Whether the delegator holds, now, every permission they pass on over the scope they pass it on in (BR-ADM-06: the delegated authority is a subset of the delegator's own). Only the delegator's own grants count: what they
 * hold through a delegation they received is not theirs to pass on (no chain: DELEGATION_CHAIN_DENIED). A pattern is covered only by an equal or broader pattern.
 */
export function delegatorHolds(delegator: EffectiveAccess, permissions: readonly string[], scope: Scope, now: Date): boolean {
  const held = activeGrants(delegator, now)
    .filter((grant) => scopeCovers(grant.scope, scope))
    .flatMap((grant) => [...grant.permissions]);
  return permissions.every((permission) => permissionCovered(held, permission));
}
