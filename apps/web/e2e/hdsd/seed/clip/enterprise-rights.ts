import type { Obj, SeedContext } from '../context.ts';
import { PERMISSIONS } from '../../../../../../packages/contracts/src/permissions.generated.ts';
import TEXTS from '../data/enterprise-rights.json' with { type: 'json' };

/**
 * Full rights for the demo leaders, so that a presenter can CREATE anything live on an empty screen.
 *
 * The owner already holds every tenant-plane permission (TENANT_OWNER), so only the approving leader needs help: LANH_DAO_SO + LEADER carry the deciding and the reading
 * rights but none of the maker ones. The maker rights are handed out through the product's own IAM commands (create role, grant role): one custom role that holds every
 * permission of the project-board role (CAN_BO_BAN_QLDA, the full maker set) which the owner is allowed to hand out (anti-escalation: a role may not hold what its grantor
 * does not). Approval semantics stay intact: approving rights are untouched and a maker still cannot approve his own record (SELF_APPROVAL_DENIED is per account).
 */

/** The role schema allows 200 permissions per role (RoleCreate.maxItems), the project-board role holds ~600: the maker set is handed out as a few roles of that size. */
const ROLE_PREFIX = 'LAP_HO_SO_DAY_DU';
const CHUNK = 200;
/** The name shape the API accepts in a role (a name with a hyphen, such as open.project-codes.read, cannot be put in a role; the owner holds it through open.*). */
const PERMISSION_NAME = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*(\.\*)?$/;
/** The permission names a role may carry: the catalogue of the contract (assertKnownPermissions of the API). */
const CATALOGUE = new Set<string>(Object.values(PERMISSIONS));
const ROLE_RANK = 45;
/** Leaders who get the maker role; the owner holds everything already. */
const RECEIVERS = ['capApprover'];

/** Whether the held permissions cover `wanted`: an exact name, or a `prefix.*` pattern (a pattern is covered only by an equal or broader pattern). */
function covered(held: readonly string[], wanted: string): boolean {
  return held.some((permission) => permission === wanted || (permission.endsWith('.*') && wanted.startsWith(permission.slice(0, -1))));
}

/**
 * Creates the role with the chunk; when the API refuses a name (422 on permissions: the running API knows a catalogue that differs from the contract file by a few names), the
 * role is made with one safe permission and the unknown names are found by bisection with PUT (a refused PUT changes nothing) and left out.
 */
async function createRoleWith(ctx: SeedContext, code: string, name: string, names: string[]): Promise<string> {
  const first = await ctx.call('owner', 'POST', '/roles', { code, name, permissions: names, rank: ROLE_RANK });
  if (first.ok) return String((first.json as Obj).resource_id);
  if (first.status !== 422) ctx.expectOk(first);
  const made = await ctx.command('owner', '/roles', { code, name, permissions: ['home.read'], rank: ROLE_RANK });
  const roleId = String(made.resource_id);
  let version = Number(made.resource_version);
  const accepts = async (list: string[]): Promise<boolean> => {
    const reply = await ctx.call('owner', 'PUT', `/roles/${roleId}`, { permissions: list, reason: TEXTS['grant.reason'] }, { version });
    if (reply.ok) {
      version = Number((reply.json as Obj).resource_version);
      return true;
    }
    if (reply.status !== 422) ctx.expectOk(reply);
    return false;
  };
  const unknown = async (list: string[]): Promise<string[]> => {
    if (await accepts(list)) return [];
    if (list.length === 1) return list;
    const middle = Math.ceil(list.length / 2);
    return [...(await unknown(list.slice(0, middle))), ...(await unknown(list.slice(middle)))];
  };
  const bad = await unknown(names);
  ctx.warn(`${code}: ${bad.length} permission names are unknown to the running API and were left out: ${bad.join(', ')}`);
  if (!(await accepts(names.filter((permission) => !bad.includes(permission))))) throw new Error(`${code}: the role could not be filled`);
  return roleId;
}

async function ensureMakerRoles(ctx: SeedContext): Promise<string[]> {
  const roles = await ctx.list('owner', '/resources/role_definition');
  const owner = roles.find((row: Obj) => row.code === 'TENANT_OWNER');
  const maker = roles.find((row: Obj) => row.code === 'CAN_BO_BAN_QLDA');
  if (owner === undefined || maker === undefined) throw new Error('TENANT_OWNER or CAN_BO_BAN_QLDA is missing from the role catalogue');
  const held = owner.permissions as string[];
  const permissions = (maker.permissions as string[]).filter((permission) => !permission.startsWith('system.') && CATALOGUE.has(permission) && PERMISSION_NAME.test(permission) && covered(held, permission)).sort();
  ctx.log(`  maker roles: ${permissions.length} of ${(maker.permissions as string[]).length} permissions are grantable by the owner`);
  const ids: string[] = [];
  const parts = Math.ceil(permissions.length / CHUNK);
  for (let part = 0; part < parts; part += 1) {
    const code = `${ROLE_PREFIX}_${part + 1}`;
    const existing = roles.find((row: Obj) => row.code === code);
    if (existing !== undefined) {
      ids.push(String(existing.id));
      continue;
    }
    ids.push(await createRoleWith(ctx, code, `${TEXTS['role.name']} (${part + 1}/${parts})`, permissions.slice(part * CHUNK, (part + 1) * CHUNK)));
  }
  return ids;
}

export async function seedClipEnterpriseRights(ctx: SeedContext): Promise<void> {
  // Granting a role asks for a second factor: the development token of the seed carries a fresh aal2 claim (context.ts).
  const roleIds = await ctx.step('IAM', 'maker roles with every project-board permission', () => ensureMakerRoles(ctx));
  for (const person of RECEIVERS) {
    for (const roleId of roleIds) {
      await ctx.step('IAM', `grant of a maker role to ${person}`, async () => {
        const membershipId = ctx.person(person).membershipId;
        const granted = await ctx.find('owner', '/resources/role_grant', (row: Obj) => row.membership_id === membershipId && row.role_id === roleId && String(row.status).toUpperCase() === 'ACTIVE');
        if (granted === undefined) await ctx.command('owner', '/role-grants', { membership_id: membershipId, role_id: roleId, scope_kind: 'TENANT', reason: TEXTS['grant.reason'] });
      });
    }
  }
}
