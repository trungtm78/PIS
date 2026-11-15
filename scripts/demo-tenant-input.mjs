#!/usr/bin/env node
// Writes the input of infra/onprem-windows/tools/demo-tenant.mjs for a demo dataset: the units, the unit roles and the people of the tenant of the demo, as plain data
// with no secret in it. It is made on the development machine (the dataset, the people of the seed layer and the roles live in the repository, not in the released image)
// and copied to the server.
//
//   node scripts/demo-tenant-input.mjs --dataset camau --out demo-tenant.input.json
//
// The people are the ones of apps/web/e2e/support/docs-people.json who are members of the tenant: the seed commands of `clip-seed apply` run as these people, each with the
// role the docs stack gives them (apps/api/test/e2e-stack/serve.stack.ts, docsGrants). The permissions of the unit roles are the snapshot
// scripts/fixtures/clip-data/demo-roles.json, taken from the stack info file of a docs stack (`docsRoles`); `--roles-from <stack-info.json>` takes them again.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
export const ROLES_FILE = join(HERE, 'fixtures', 'clip-data', 'demo-roles.json');
/** createCustomRole takes at most this many permissions: a longer role is made in parts (CODE, CODE_2, ...), all granted together. */
export const ROLE_PERMISSION_LIMIT = 200;
/** The units of the docs stack by number (docs-people.json names a unit by number), as the key the dataset names its unit by. */
export const UNIT_KEYS = { 1: 'CB-HQ', 2: 'CB-SKHDT', 3: 'CB-STC', 4: 'CB-SKHDT-VP', 5: 'CB-SKHDT-QLDA' };

/** The shape createCustomRole accepts for the name of a permission (apps/api/src/iam-dto.ts): a permission of another shape cannot be held by a role made through the product. */
export const PERMISSION_NAME = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*(\.\*)?$/;

/** A role of more than `limit` permissions as parts of at most `limit` (the first keeps the code). Pure. */
export function roleParts(role, limit = ROLE_PERMISSION_LIMIT) {
  const parts = [];
  for (let start = 0, part = 1; start < role.permissions.length; start += limit, part += 1) {
    parts.push({ code: part === 1 ? role.code : `${role.code}_${part}`, name: part === 1 ? role.name : `${role.name} (phần ${part})`, rank: role.rank, permissions: role.permissions.slice(start, start + limit) });
  }
  return parts;
}

/**
 * A Vietnamese full name for an account of the realm. The realm shows a person as `firstName lastName`, and a Vietnamese name is written family name first: the family and
 * middle names go to `firstName` and the given name to `lastName`, so that "Nguyễn Văn An" is shown as "Nguyễn Văn An" everywhere. Pure.
 */
export function splitName(name) {
  const words = name.trim().split(/\s+/u);
  return words.length === 1 ? { firstName: name.trim(), lastName: name.trim() } : { firstName: words.slice(0, -1).join(' '), lastName: words.at(-1) };
}

/** The grants the docs stack gives a person (serve.stack.ts, docsGrants), plus MEMBER (the role that holds `profile.self` on an installation). Pure. */
export function grantsOf(person) {
  const scope = person.kind ?? 'TENANT';
  const grants = [{ role: person.role ?? 'MEMBER', scope }];
  if (person.key === 'capApprover') grants.push({ role: 'LEADER', scope: 'TENANT' });
  if (person.key !== 'nobody' && person.role !== 'STAFF_MEMBER') grants.push({ role: 'STAFF_MEMBER', scope: 'TENANT' });
  for (const role of person.extraRoles ?? []) grants.push({ role, scope });
  if (!grants.some((grant) => grant.role === 'MEMBER')) grants.push({ role: 'MEMBER', scope: 'TENANT' });
  return grants;
}

/** The input of the tool, from the dataset, the people of the seed layer and the unit roles. Throws, naming it, on a dataset that cannot make a tenant. Pure. */
export function buildTenantInput(dataset, people, roles) {
  const tenant = dataset.tenant;
  if (tenant === undefined) throw new Error('the dataset names no tenant');
  const unitByKey = new Map(tenant.units.filter((unit) => unit.key !== undefined).map((unit) => [unit.key, unit]));
  const codes = new Set();
  for (const unit of tenant.units) {
    if (!/^[A-Z0-9_.-]{2,40}$/.test(unit.code)) throw new Error(`the unit code ${unit.code} is not one createOrganizationUnit takes`);
    if (codes.has(unit.code)) throw new Error(`the unit code ${unit.code} is used twice`);
    if (unit.parent !== undefined && !codes.has(unit.parent)) throw new Error(`the unit ${unit.code} comes before its parent ${unit.parent}`);
    codes.add(unit.code);
  }
  const roots = tenant.units.filter((unit) => unit.parent === undefined);
  if (roots.length !== 1) throw new Error(`the dataset must name exactly one root unit (it names ${roots.length})`);
  // A permission whose name createCustomRole refuses is left out and named in the input (`droppedPermissions`), so that nobody thinks the role holds it.
  const dropped = [...new Set(roles.flatMap((role) => role.permissions.filter((permission) => !PERMISSION_NAME.test(permission))))].sort();
  const parts = roles.flatMap((role) => roleParts({ ...role, name: tenant.roles?.[role.code] ?? role.code, permissions: [...new Set(role.permissions)].filter((permission) => PERMISSION_NAME.test(permission)) }));
  const partCodes = (code) => {
    const found = parts.filter((part) => part.code === code || (part.code.startsWith(`${code}_`) && /^\d+$/.test(part.code.slice(code.length + 1)))).map((part) => part.code);
    return found.length === 0 ? [code] : found;
  };
  const usernames = new Set();
  const members = tenant.accounts.map((account) => {
    const person = people.find((candidate) => candidate.key === account.person);
    if (person === undefined) throw new Error(`the account ${account.username} names the unknown person ${account.person}`);
    if (person.plane !== undefined) throw new Error(`the person ${account.person} is not a member of the tenant (plane ${person.plane})`);
    if (!/^[a-z][a-z0-9._-]{2,40}$/.test(account.username) || usernames.has(account.username)) throw new Error(`the user name ${account.username} is not usable or is used twice`);
    usernames.add(account.username);
    const unit = unitByKey.get(UNIT_KEYS[person.unit]);
    if (unit === undefined) throw new Error(`the dataset has no unit for the key ${UNIT_KEYS[person.unit]} of ${account.person}`);
    return {
      person: person.key,
      username: account.username,
      email: `${account.username}@${tenant.emailDomain}`,
      displayName: person.name,
      ...splitName(person.name),
      unit: unit.code,
      owner: person.role === 'TENANT_OWNER',
      // The scope of a grant that is not of the whole tenant is the unit of the person.
      grants: person.role === 'TENANT_OWNER' ? [] : grantsOf(person).flatMap((grant) => partCodes(grant.role).map((role) => ({ role, scope: grant.scope }))),
      ...(account.sample === true ? { sample: true } : {}),
      title: account.title ?? '',
    };
  });
  if (members.filter((member) => member.owner).length !== 1) throw new Error('exactly one account must be the tenant owner (the person whose role is TENANT_OWNER)');
  return {
    schema: 'demo-tenant-input/1',
    dataset: dataset.variant ?? dataset.dataset,
    tenant: { code: tenant.code, name: tenant.name, rootUnitName: tenant.rootUnitName, subdomain: tenant.subdomain },
    units: tenant.units.map((unit) => ({ code: unit.code, name: unit.name, type: unit.type ?? 'OTHER', ...(unit.parent === undefined ? {} : { parent: unit.parent }), ...(unit.investor === true ? { investor: true } : {}) })),
    roles: parts,
    droppedPermissions: dropped,
    people: members,
  };
}

export function main(argv, { log = (line) => process.stdout.write(`${line}\n`), read = (path) => readFileSync(path, 'utf8'), write = (path, text) => writeFileSync(path, text, 'utf8') } = {}) {
  const { values } = parseArgs({ args: argv, options: { dataset: { type: 'string', default: 'camau' }, out: { type: 'string' }, 'roles-from': { type: 'string' } }, allowPositionals: false });
  if (typeof values['roles-from'] === 'string') {
    const roles = JSON.parse(read(values['roles-from'])).docsRoles;
    if (!Array.isArray(roles) || roles.length === 0) throw new Error('the stack info file names no docsRoles (it must be the one of a docs stack: E2E_SEED=docs)');
    write(ROLES_FILE, `${JSON.stringify({ schema: 'demo-roles/1', source: 'docsRoles of the stack info file of a docs stack of the public edition (apps/api/test/e2e-stack/serve.stack.ts)', roles: roles.map((role) => ({ code: role.code, rank: role.rank, permissions: [...role.permissions].sort() })) }, null, 2)}\n`);
    log(`demo-tenant-input: ${roles.length} roles written to ${ROLES_FILE}`);
    if (typeof values.out !== 'string') return 0;
  }
  if (typeof values.out !== 'string') {
    log('demo-tenant-input: --out <file> is required');
    return 2;
  }
  const dataset = JSON.parse(read(join(HERE, 'fixtures', 'clip-data', `${values.dataset}.json`)));
  const people = JSON.parse(read(join(ROOT, 'apps', 'web', 'e2e', 'support', 'docs-people.json')));
  const input = buildTenantInput(dataset, people, JSON.parse(read(ROLES_FILE)).roles);
  write(resolve(values.out), `${JSON.stringify(input, null, 2)}\n`);
  log(`demo-tenant-input: ${input.units.length} units, ${input.roles.length} roles, ${input.people.length} people written to ${resolve(values.out)}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`demo-tenant-input: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
