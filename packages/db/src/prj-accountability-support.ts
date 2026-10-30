import { DomainError, activeGrants, asUuid, effectivePermissions, holdsPermission } from '@machvon/kernel';
import type { EffectiveAccess, ResourceRef, Scope } from '@machvon/kernel';
import { MyAccessStore } from './my-access-store.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import { invalid } from './prj-stage-support.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * What the commands of ST-PRJ-005 have in common: the member behind an id, the question whether that member can see a project or sit in a task force,
 * and the text and the id as they are stored. A member of another tenant is invisible to the row-level security, so it does not exist (404).
 */

/** The permission that makes a member able to follow a project: whoever answers for a project must be able to read it. */
export const PROJECT_READ_PERMISSION = 'project.read';

const MEMBER_SQL = `select (status = 'Active' and valid_from <= now() and (valid_until is null or valid_until > now())) as active,
    membership_type = 'STAFF' as staff
  from machvon.membership where id = $1::uuid`;

const LINE_BREAKS: readonly number[] = [0x0a, 0x0d];

/** Whether the text holds a control character; a line break is one unless `lineBreaks` lets it through. */
function hasControl(text: string, lineBreaks: boolean): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if ((code < 0x20 || code === 0x7f) && !(lineBreaks && LINE_BREAKS.includes(code))) return true;
  }
  return false;
}

export interface MemberStanding {
  id: string;
  /** The membership is in force today. */
  active: boolean;
  /** A member of the staff: a contractor invited to one contract, or a service account, is neither a leader nor a member of a task force. */
  staff: boolean;
}

/** The id as the lower-case text the database writes; anything else is a fault of the request named by `field`. */
export function idOf(value: unknown, field: string): string {
  const id = asUuid(value);
  if (id === undefined) throw invalid(field);
  return id;
}

/** A text as it is stored: trimmed, within its length, without control characters (`multiline` also lets line breaks through). */
export function textOf(value: unknown, field: string, limits: { min: number; max: number; multiline?: boolean }): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < limits.min || text.length > limits.max || hasControl(text, limits.multiline === true)) throw invalid(field);
  return text;
}

/** The member behind the id; a member of another tenant, or none, is not found. */
export async function memberStanding(tx: TenantTx, membershipId: string): Promise<MemberStanding> {
  const rows = await tx.query<{ active: boolean; staff: boolean }>(MEMBER_SQL, [membershipId]);
  const row = rows[0];
  if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
  return { id: membershipId, active: row.active, staff: row.staff };
}

/** The access of a member as the policy decision point sees it today: what they hold, and where. */
export async function accessOf(tx: TenantTx, member: MemberStanding): Promise<EffectiveAccess> {
  const grants = member.active && member.staff ? await new MyAccessStore().grants(tx, member.id) : [];
  return { membershipId: member.id, scopeVersion: 0, membershipActive: member.active && member.staff, grants: grants.map((grant) => grant.view) };
}

/** Whether a member holds the permission over the resource through a grant that is in force. */
export function holdsOver(access: EffectiveAccess, permission: string, place: ResourceRef, now: Date): boolean {
  return holdsPermission(effectivePermissions(access, now, place), permission);
}

/**
 * Whether a member can follow a project: they are in force, on the staff, and hold `project.read` over the unit that owns the project or the one that invests in it.
 * A project that is not in the tenant is not found.
 */
export async function canFollowProject(tx: TenantTx, member: MemberStanding, projectId: string, now: Date): Promise<boolean> {
  const places = await tx.query<{ owner_id: string; owner_path: string; investor_id: string | null; investor_path: string | null }>(
    `select ou.id as owner_id, ou.path as owner_path, iu.id as investor_id, iu.path as investor_path from ${SCOPE_FROM} where p.id = $1::uuid`,
    [projectId],
  );
  const place = places[0];
  if (place === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
  if (!member.active || !member.staff) return false;
  const access = await accessOf(tx, member);
  const refs: ResourceRef[] = [{ ownerUnitId: place.owner_id, ownerUnitPath: place.owner_path, projectId }];
  if (place.investor_id !== null && place.investor_path !== null) refs.push({ ownerUnitId: place.investor_id, ownerUnitPath: place.investor_path, projectId });
  return refs.some((ref) => holdsOver(access, PROJECT_READ_PERMISSION, ref, now));
}

const closed = (path: string): string => (path.endsWith('/') ? path : `${path}/`);

/** Whether two unit paths lie on one branch of the tree: one is the other, or above it, or below it. */
const onOneBranch = (left: string, right: string): boolean => closed(left).startsWith(closed(right)) || closed(right).startsWith(closed(left));

/** Whether a unit lies in the subtree of another (or is it). */
export const withinSubtree = (path: string, rootPath: string): boolean => closed(path).startsWith(closed(rootPath));

/**
 * Whether a grant gives its holder something inside the subtree of a unit: the whole tenant does; a subtree on the same branch does (above it, it contains
 * the unit; below it, it is part of it); a single unit does when it is the unit or lies below it. A grant on a project or a contract is judged by the
 * units of those, which the caller passes (`reachedPaths`).
 */
export function grantTouchesSubtree(scope: Scope, unitPath: string, reachedPaths: readonly string[]): boolean {
  switch (scope.kind) {
    case 'TENANT':
      return true;
    case 'UNIT_SUBTREE':
      return (scope.paths ?? []).some((path) => onOneBranch(path, unitPath));
    case 'UNIT_ONLY':
      return (scope.paths ?? []).some((path) => withinSubtree(path, unitPath));
    case 'PROJECT':
      return reachedPaths.some((path) => withinSubtree(path, unitPath));
    case 'CONTRACT':
      return false;
  }
}

/**
 * Whether a member can take part in the work of the subtree of a unit: the membership is in force, is on the staff, and one of the grants in force reaches
 * into the subtree (BR: a task force member's scope must meet the scope of the force).
 */
export async function reachesSubtree(tx: TenantTx, member: MemberStanding, unit: { path: string }, now: Date): Promise<boolean> {
  if (!member.active || !member.staff) return false;
  const access = await accessOf(tx, member);
  const grants = activeGrants(access, now);
  const projectIds = [...new Set(grants.flatMap((grant) => (grant.scope.kind === 'PROJECT' ? grant.scope.refIds : [])))];
  const reachedPaths = projectIds.length === 0 ? [] : await projectUnitPaths(tx, projectIds);
  return grants.some((grant) => grantTouchesSubtree(grant.scope, unit.path, reachedPaths));
}

/** The paths of the units that own, or invest in, the projects. */
async function projectUnitPaths(tx: TenantTx, projectIds: readonly string[]): Promise<string[]> {
  const rows = await tx.query<{ path: string }>(
    `select ou.path from machvon.project p join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id where p.id = any($1::uuid[])
     union
     select iu.path from machvon.project p join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id where p.id = any($1::uuid[])`,
    [projectIds],
  );
  return rows.map((row) => row.path);
}
