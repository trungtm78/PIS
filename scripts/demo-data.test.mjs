// The demo data of the public edition (the province of Cà Mau) and the way it is loaded on an installation without the development session.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { localizer, rewriteDeep, roundTripFaults } from '../apps/web/e2e/hdsd/seed/localize.ts';
import { INVITATION_GRANT_LIMIT, newDemoPassword as demoPassword, inputProblems, ownerOf, provision } from '../infra/onprem-windows/tools/demo-tenant.mjs';
import { TOKEN_MARGIN_SECONDS, brokerOf, credentialProblems, readCredentials } from './clip-seed-auth.mjs';
import { ApiReader } from './clip-seed-client.mjs';
import { DEFAULT_DEMO_DATASET, FUNDED, buildPlan, checkPlan, localizeFaults, planDigest, planForSeeds } from './clip-seed-lib.mjs';
import { baselineReady, installationInfo, loadDataset, main as clipSeed, requiredPeople, stateDirectoryOf, tolerated, waitForBaseline } from './clip-seed.mjs';
import { buildStackEnv, buildWebEnv, parseArgs as demoArgs } from './demo-public.mjs';
import { PERMISSION_NAME, ROLES_FILE, ROLE_PERMISSION_LIMIT, buildTenantInput, grantsOf, roleParts, splitName } from './demo-tenant-input.mjs';
import { toolFiles } from './demo-tools-pack.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const camau = () => loadDataset('camau');
const people = () => JSON.parse(readFileSync(join(HERE, '..', 'apps', 'web', 'e2e', 'support', 'docs-people.json'), 'utf8'));
const roles = () => JSON.parse(readFileSync(ROLES_FILE, 'utf8')).roles;
const stringsOf = (value, out = []) => {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => stringsOf(item, out));
  else if (typeof value === 'object' && value !== null) Object.values(value).forEach((item) => stringsOf(item, out));
  return out;
};

// ---- the words of a dataset ------------------------------------------------------------------------------------------------------------

test('a rewrite is one pass: the longest pair wins, what a pair wrote is not rewritten, and the way back undoes the way there', () => {
  const words = localizer([
    ['Cao Bằng', 'Cà Mau'],
    ['Nà Rạc', 'tiểu vùng III Bắc Cà Mau'],
    ['Phường Sông Hiến', 'Xã Gành Hào'],
    ['Sông Hiến', 'Gành Hào'],
  ]);
  assert.equal(words.forward('thủy lợi Nà Rạc, tỉnh Cao Bằng'), 'thủy lợi tiểu vùng III Bắc Cà Mau, tỉnh Cà Mau');
  assert.equal(words.forward('Phường Sông Hiến và kè Sông Hiến'), 'Xã Gành Hào và kè Gành Hào');
  assert.equal(words.backward('thủy lợi tiểu vùng III Bắc Cà Mau, tỉnh Cà Mau'), 'thủy lợi Nà Rạc, tỉnh Cao Bằng');
  assert.equal(words.active, true);
  assert.deepEqual(rewriteDeep({ 'Cao Bằng': ['Cao Bằng', 3, null, { a: 'x Cao Bằng' }] }, words.forward), { 'Cao Bằng': ['Cà Mau', 3, null, { a: 'x Cà Mau' }] });
  assert.deepEqual(roundTripFaults({ a: 'tỉnh Cà Mau', b: ['còn Cao Bằng'] }, words), ['còn Cao Bằng']);
});

test('no pair means no rewrite, and a pair with an empty side or a quote is refused', () => {
  const none = localizer(undefined);
  assert.equal(none.active, false);
  assert.equal(none.forward('Cao Bằng'), 'Cao Bằng');
  assert.equal(localizer([]).backward('x'), 'x');
  assert.throws(() => localizer([['a', '']]), /empty side/u);
  assert.throws(() => localizer([['a"b', 'c']]), /quote/u);
  // Two words of the guide may become one word of the dataset: the way back takes the first.
  const words = localizer([
    ['Sở Kế hoạch và Đầu tư', 'Sở Tài chính'],
    ['Sở KHĐT', 'Sở Tài chính'],
  ]);
  assert.equal(words.backward('Sở Tài chính'), 'Sở Kế hoạch và Đầu tư');
});

// ---- the dataset -----------------------------------------------------------------------------------------------------------------------

test('the demo data of the public edition is the dataset of Cà Mau, a dataset of the public kind with forty-five named projects', () => {
  assert.equal(DEFAULT_DEMO_DATASET.public, 'camau');
  const dataset = camau();
  assert.equal(dataset.dataset, 'public');
  assert.equal(dataset.variant, 'camau');
  assert.match(dataset.illustrative, /minh họa/u);
  const plan = buildPlan(dataset);
  assert.deepEqual(checkPlan(plan), []);
  assert.equal(plan.expect.projectsTotal, 45);
  assert.equal(plan.projects.length, 32);
  assert.equal(new Set(plan.projects.map((project) => project.code)).size, 32);
  assert.equal(new Set(plan.projects.map((project) => project.name)).size, 32);
  assert.equal(plan.expect.sectors, 8);
  assert.ok(plan.expect.packages >= 40);
  assert.deepEqual(plan.expect.extraStageCounts, dataset.stageMix);
  // The three groups of projects are there (A from 2,300 billion, B from 120), and the plan is the same at every run.
  assert.deepEqual([...new Set(plan.projects.map((project) => project.group))].sort(), ['A', 'B', 'C']);
  assert.equal(planDigest(plan), planDigest(buildPlan(camau())));
  for (const project of plan.projects) {
    assert.equal(FUNDED.has(project.target), project.planBillions !== undefined, project.code);
    if (project.planBillions !== undefined) assert.ok(project.planBillions <= project.totalBillions, project.code);
  }
});

test('the catalogue is checked: a reserved code, an unknown area, sector or stage, and a count that differs from the stage mix are refused by name', () => {
  const dataset = camau();
  const withFirst = (change) => ({ ...dataset, projectCatalogue: [{ ...dataset.projectCatalogue[0], ...change }, ...dataset.projectCatalogue.slice(1)] });
  assert.throws(() => buildPlan(withFirst({ code: dataset.reservedProjectCodes[0] })), /reserved code/u);
  assert.throws(() => buildPlan(withFirst({ area: 'CM-NOWHERE' })), /unknown area/u);
  assert.throws(() => buildPlan(withFirst({ sector: 'SPACE' })), /unknown sector/u);
  assert.throws(() => buildPlan(withFirst({ target: 'BUDGETED' })), /stageMix says/u);
  assert.throws(() => buildPlan({ ...dataset, projectCatalogue: dataset.projectCatalogue.slice(1) }), /extraProjects says/u);
  assert.throws(() => buildPlan({ ...dataset, funding: { ...dataset.funding, appropriationOverrides: { NSTW: 71, NSDP: 87, SUPPORT: 31 }, extraAppropriations: [{ ...dataset.funding.extraAppropriations[0], billions: 1 }] } }), /no room left/u);
});

test('nothing of the province of the guide is left in the plan of Cà Mau, and its own words come back unchanged from the seed process', () => {
  const plan = buildPlan(camau());
  const { localize, ...rest } = plan;
  for (const text of stringsOf(rest)) assert.doesNotMatch(text, /Cao Bằng|Thục Phán|Nùng Trí Cao|Sông Hiến|Bản Giốc|Kế hoạch và Đầu tư/u, text);
  assert.deepEqual(localizeFaults(plan), []);
  // The seed groups are given the words of the guide (they send them through the same pairs), but the tenant and the pairs as they are.
  const seeds = planForSeeds(plan);
  assert.deepEqual(seeds.localize, localize);
  assert.deepEqual(seeds.tenant, plan.tenant);
  assert.equal(seeds.disbursement.office.name, 'Kho bạc Nhà nước khu vực Cao Bằng');
  assert.equal(seeds.areas.find((area) => area.key === 'CM-SONG-DOC').name, 'Xã Sông Đốc');
  const words = localizer(localize.pairs);
  assert.deepEqual(rewriteDeep({ ...seeds, localize: undefined, tenant: undefined }, words.forward), { ...rest, localize: undefined, tenant: undefined });
  // A dataset whose own words hold a word of the guide is reported by checkPlan.
  const faulty = { ...plan, texts: { ...plan.texts, projectNote: 'Dự án của tỉnh Cao Bằng' } };
  assert.match(checkPlan(faulty).join('\n'), /change on their way through the seeds: "Dự án của tỉnh Cao Bằng"/u);
  // A plan without pairs (the two older datasets) goes to the seed process as it is.
  const older = buildPlan(loadDataset('public'));
  assert.equal(planForSeeds(older), older);
  assert.deepEqual(localizeFaults(older), []);
});

test('the pairs send every key and name of the guide the seeds hold in their code to a key and a name of Cà Mau', () => {
  const words = localizer(camau().localize.pairs);
  assert.equal(words.forward('CAO-BANG'), 'CA-MAU');
  assert.equal(words.forward('CB-SKHDT-QLDA'), 'CM-BQLDAXD');
  assert.equal(words.forward('07/BC-SKHDT'), '07/BC-STC');
  assert.equal(words.forward('CB-THUC-PHAN'), 'CM-TAN-THANH');
  assert.equal(words.backward('CM-GANH-HAO'), 'CB-SONG-HIEN');
  assert.equal(words.forward('Cải tạo, nâng cấp đường tỉnh 205, đoạn Km0 - Km12'), 'Cải tạo, nâng cấp đường ven biển phía Đông, đoạn Km0 - Km12');
  assert.equal(words.forward('Kè chống sạt lở bờ sông Hiến, đoạn qua phường Sông Hiến'), 'Kè chống sạt lở bờ biển Đông, đoạn qua xã Gành Hào');
  assert.equal(words.forward('Ban Quản lý dự án, Sở Kế hoạch và Đầu tư Cao Bằng'), 'Ban Quản lý dự án xây dựng tỉnh Cà Mau');
  assert.equal(words.forward('Ủy ban nhân dân tỉnh Cao Bằng'), 'Ủy ban nhân dân tỉnh Cà Mau');
  assert.equal(words.forward('UY BAN NHAN DAN TINH CAO BANG'), 'UY BAN NHAN DAN TINH CA MAU');
  // The areas the base groups publish (their keys are in the code of the groups) are the existing areas of the dataset.
  const dataset = camau();
  for (const key of ['CB-THUC-PHAN', 'CB-NUNG-TRI-CAO', 'CB-TAN-GIANG', 'CB-HOP-GIANG', 'CB-SONG-HIEN', 'CB-QUANG-HOA', 'CB-BAN-GIOC', 'CB-TAM-KIM']) {
    assert.ok(dataset.existingAreas.some((area) => area.key === words.forward(key)), key);
  }
});

test('the tenant of the dataset: one root, the five units the seeds ask for by key, the departments and boards of the province, and an account for every member', () => {
  const tenant = camau().tenant;
  assert.equal(tenant.name, 'UBND tỉnh Cà Mau');
  assert.equal(tenant.province, 'CA-MAU');
  assert.deepEqual(tenant.units.filter((unit) => unit.key !== undefined).map((unit) => unit.key).sort(), ['CB-HQ', 'CB-SKHDT', 'CB-SKHDT-QLDA', 'CB-SKHDT-VP', 'CB-STC']);
  assert.equal(tenant.units.filter((unit) => unit.parent === undefined).length, 1);
  const names = tenant.units.map((unit) => unit.name);
  for (const name of ['Sở Tài chính', 'Sở Xây dựng', 'Sở Nông nghiệp và Môi trường', 'Sở Khoa học và Công nghệ', 'Sở Y tế', 'Sở Giáo dục và Đào tạo']) assert.ok(names.includes(name), name);
  assert.equal(tenant.units.filter((unit) => unit.type === 'PROJECT_MANAGEMENT_BOARD').length, 3);
  assert.ok(tenant.units.filter((unit) => unit.type === 'COMMUNE').length >= 6);
  // No department of before the reorganisation of 2025 is named.
  assert.ok(names.every((name) => !/Kế hoạch và Đầu tư|Giao thông vận tải|Tài nguyên và Môi trường|huyện|thị trấn/iu.test(name)));
  const members = people().filter((person) => person.plane === undefined).map((person) => person.key);
  assert.deepEqual(requiredPeople(camau()).sort(), members.sort());
  assert.equal(tenant.accounts.find((account) => account.username === 'demo').person, 'owner');
  assert.ok(tenant.accounts.filter((account) => account.sample === true).length >= 5);
  // The dataset holds no secret.
  assert.doesNotMatch(JSON.stringify(camau()), /api[_-]?key|secret(?!ariat)|password|bearer|totp/iu);
});

// ---- the input of the tenant tool ------------------------------------------------------------------------------------------------------

test('a role longer than createCustomRole takes is made in parts, and a name is split into the given name and the rest', () => {
  const role = { code: 'R', name: 'Vai', rank: 40, permissions: Array.from({ length: 450 }, (_unused, index) => `a.p${index}`) };
  const parts = roleParts(role);
  assert.deepEqual(parts.map((part) => [part.code, part.permissions.length]), [['R', 200], ['R_2', 200], ['R_3', 50]]);
  assert.equal(parts[1].name, 'Vai (phần 2)');
  assert.equal(ROLE_PERMISSION_LIMIT, 200);
  assert.deepEqual(roleParts({ ...role, permissions: ['a.b'] }).map((part) => part.code), ['R']);
  // The realm shows `firstName lastName`: the family name comes first, as a Vietnamese name is written.
  assert.deepEqual(splitName('Nguyễn Văn An'), { firstName: 'Nguyễn Văn', lastName: 'An' });
  assert.deepEqual(splitName('An'), { firstName: 'An', lastName: 'An' });
  assert.ok(PERMISSION_NAME.test('project.read') && PERMISSION_NAME.test('iam.*') && !PERMISSION_NAME.test('open.project-codes.read'));
});

test('a person gets the grants the docs stack gives, and the role of a member on top', () => {
  const all = people();
  const of = (key) => grantsOf(all.find((person) => person.key === key));
  assert.deepEqual(of('capApprover'), [{ role: 'LANH_DAO_SO', scope: 'TENANT' }, { role: 'LEADER', scope: 'TENANT' }, { role: 'STAFF_MEMBER', scope: 'TENANT' }, { role: 'MEMBER', scope: 'TENANT' }]);
  assert.deepEqual(of('unitAdmin'), [{ role: 'UNIT_ADMIN', scope: 'UNIT_SUBTREE' }, { role: 'STAFF_MEMBER', scope: 'TENANT' }, { role: 'MEMBER', scope: 'TENANT' }]);
  assert.deepEqual(of('nobody'), [{ role: 'MEMBER', scope: 'TENANT' }]);
  assert.deepEqual(of('projectViewer'), [{ role: 'STAFF_MEMBER', scope: 'TENANT' }, { role: 'MEMBER', scope: 'TENANT' }]);
  assert.deepEqual(of('auditor').map((grant) => grant.role), ['AUDITOR', 'STAFF_MEMBER', 'THANH_TRA_KIEM_TOAN', 'MEMBER']);
});

test('the input of the tenant tool: units with their parents first, roles in parts inside the limit, ten people, one owner, no secret', () => {
  const input = buildTenantInput(camau(), people(), roles());
  assert.equal(input.schema, 'demo-tenant-input/1');
  assert.equal(input.units.length, camau().tenant.units.length);
  const seen = new Set();
  for (const unit of input.units) {
    if (unit.parent !== undefined) assert.ok(seen.has(unit.parent), unit.code);
    seen.add(unit.code);
  }
  assert.ok(input.roles.every((role) => role.permissions.length >= 1 && role.permissions.length <= ROLE_PERMISSION_LIMIT && role.permissions.every((permission) => PERMISSION_NAME.test(permission))));
  assert.ok(input.roles.some((role) => role.code === 'CAN_BO_BAN_QLDA_2'));
  assert.equal(input.roles.find((role) => role.code === 'LANH_DAO_SO').name, 'Lãnh đạo đơn vị');
  assert.deepEqual(input.droppedPermissions, roles().flatMap((role) => role.permissions).filter((permission, index, list) => !PERMISSION_NAME.test(permission) && list.indexOf(permission) === index).sort());
  assert.equal(input.people.length, 10);
  const owner = input.people.filter((person) => person.owner);
  assert.deepEqual(owner.map((person) => [person.username, person.unit, person.grants.length]), [['demo', 'CM-UBND', 0]]);
  const officer = input.people.find((person) => person.person === 'projectManager');
  assert.equal(officer.unit, 'CM-BQLDAXD');
  assert.equal(officer.email, 'canbo.qlda@demo-camau.example');
  // A role made in parts is granted whole.
  assert.deepEqual(officer.grants.filter((grant) => grant.role.startsWith('CAN_BO_BAN_QLDA')).map((grant) => grant.role), input.roles.filter((role) => role.code.startsWith('CAN_BO_BAN_QLDA')).map((role) => role.code));
  assert.doesNotMatch(JSON.stringify(input), /password|totp|secret(?!ariat)/iu);
});

test('a dataset that cannot make a tenant is refused by name', () => {
  const dataset = camau();
  const change = (tenant) => ({ ...dataset, tenant: { ...dataset.tenant, ...tenant } });
  assert.throws(() => buildTenantInput({ ...dataset, tenant: undefined }, people(), roles()), /names no tenant/u);
  assert.throws(() => buildTenantInput(change({ units: [...dataset.tenant.units].reverse() }), people(), roles()), /before its parent/u);
  assert.throws(() => buildTenantInput(change({ units: [...dataset.tenant.units, { code: 'bad code', name: 'x' }] }), people(), roles()), /not one createOrganizationUnit takes/u);
  assert.throws(() => buildTenantInput(change({ units: [...dataset.tenant.units, dataset.tenant.units[1]] }), people(), roles()), /used twice/u);
  assert.throws(() => buildTenantInput(change({ accounts: [...dataset.tenant.accounts, { person: 'ghost', username: 'ghost' }] }), people(), roles()), /unknown person ghost/u);
  assert.throws(() => buildTenantInput(change({ accounts: [...dataset.tenant.accounts, { person: 'platformOperator', username: 'operator' }] }), people(), roles()), /not a member of the tenant/u);
  assert.throws(() => buildTenantInput(change({ accounts: [...dataset.tenant.accounts, { person: 'nobody', username: 'demo' }] }), people(), roles()), /used twice/u);
  assert.throws(() => buildTenantInput(change({ accounts: dataset.tenant.accounts.filter((account) => account.person !== 'owner') }), people(), roles()), /exactly one account must be the tenant owner/u);
});

// ---- the tenant tool -------------------------------------------------------------------------------------------------------------------

/** A product that answers the commands of the tool from memory: units, roles, invitations, grants. */
function fakeProduct({ rootCode = 'ROOT', ownerHolds = ['a.*', 'iam.*'] } = {}) {
  const units = [{ id: 'u-root', code: rootCode, name: 'Gốc', parent_id: null, version: 3, valid_from: '2026-01-01' }];
  const roles = [{ id: 'r-owner', code: 'TENANT_OWNER', permissions: ownerHolds }, ...['MEMBER', 'STAFF_MEMBER', 'LEADER', 'UNIT_ADMIN', 'AUDITOR', 'COMMITTEE_HEAD', 'SECURITY_ADMIN'].map((code) => ({ id: `r-${code}`, code, permissions: [] }))];
  const calls = [];
  const invitations = new Map();
  const json = (status, body) => new Response(JSON.stringify(body), { status });
  const api = async (path, { token, method = 'GET', body, key, ifMatch } = {}) => {
    calls.push({ path, method, body, token, key, ifMatch });
    if (method === 'GET' && path.startsWith('/resources/organization_unit')) return json(200, { items: units });
    if (method === 'GET' && path.startsWith('/resources/role_definition')) return json(200, { items: roles });
    if (method === 'PUT' && path.startsWith('/org-units/')) {
      Object.assign(units[0], body);
      return json(200, { resource_id: units[0].id });
    }
    if (method === 'POST' && path === '/org-units') {
      const id = `u-${units.length}`;
      units.push({ id, ...body });
      return json(201, { resource_id: id });
    }
    if (method === 'POST' && path === '/roles') {
      if (body.permissions.some((permission) => !ownerHolds.some((pattern) => permission.startsWith(pattern.slice(0, -1))))) return json(403, { code: 'ROLE_ESCALATION_DENIED' });
      roles.push({ id: `r-${body.code}`, ...body });
      return json(201, { resource_id: `r-${body.code}` });
    }
    if (method === 'POST' && path === '/memberships/invitations') {
      invitations.set(body.email, { invitation_id: `i-${invitations.size}`, token: `t-${body.email}`, body });
      return json(201, { resource_id: 'x' });
    }
    if (method === 'POST' && /^\/memberships\/invitations\/i-\d+\/accept$/u.test(path)) return json(200, { membership_id: MEMBERSHIP_OF[token] ?? '' });
    if (method === 'POST' && path === '/role-grants') return json(201, { resource_id: 'g' });
    return json(404, { code: 'RESOURCE_NOT_FOUND' });
  };
  return { api, calls, units, roles, invitations };
}

const MEMBERSHIP_OF = { 'id-canbo': '00000000-0000-4000-8000-0000000000c7' };
const OWNER = { origin: 'https://demo.example:8443', username: 'demo', password: 'p', totpSecret: '12345678901234567890', tenantId: '00000000-0000-4000-8000-00000000000a', membershipId: '00000000-0000-4000-8000-0000000000e1' };
const smallInput = () => ({
  schema: 'demo-tenant-input/1',
  units: [{ code: 'CM-UBND', name: 'UBND tỉnh', type: 'OTHER' }, { code: 'CM-BAN', name: 'Ban', type: 'PROJECT_MANAGEMENT_BOARD', parent: 'CM-UBND', investor: true }],
  roles: [{ code: 'CAN_BO', name: 'Cán bộ', rank: 45, permissions: ['a.read', 'a.write', 'webhook.provider'] }],
  people: [
    { person: 'owner', username: 'demo', email: 'demo@d.example', displayName: 'Chủ', firstName: 'Chủ', lastName: 'Sở', unit: 'CM-UBND', owner: true, grants: [], sample: true, title: 'Chủ sở hữu' },
    { person: 'projectManager', username: 'canbo', email: 'canbo@d.example', displayName: 'Phạm Quốc Dũng', firstName: 'Dũng', lastName: 'Phạm Quốc', unit: 'CM-BAN', grants: ['CAN_BO', 'STAFF_MEMBER', 'MEMBER', 'LEADER', 'AUDITOR', 'COMMITTEE_HEAD'].map((role) => ({ role, scope: 'TENANT' })).concat([{ role: 'UNIT_ADMIN', scope: 'UNIT_SUBTREE' }]), title: 'Cán bộ' },
  ],
});

function run(input, product, state = {}, demoPassword = undefined) {
  const lines = [];
  const created = [];
  const passwords = [];
  return provision({
    input,
    owner: { ...OWNER, ...(state.people?.owner?.password === undefined ? {} : { password: state.people.owner.password }) },
    state,
    save: () => {},
    api: product.api,
    ownerToken: async () => 'owner-token',
    identityToken: async (person) => `id-${person.username}`,
    admin: { createUser: async (user) => void created.push(user), setPassword: async (username, password) => void passwords.push([username, password]) },
    ownerPasswordChanged: (password) => passwords.push(['written back', password]),
    invitationFor: async (email) => product.invitations.get(email),
    say: (line) => lines.push(line),
    publicHost: 'demo.example:8443',
    demoPassword,
  }).then((result) => ({ result, lines, created, passwords }));
}

test('the tenant tool names the root unit, makes the units and the roles, creates the person with a one-time password, invites with five roles and grants the rest', async () => {
  const product = fakeProduct();
  const { result, lines, created, passwords } = await run(smallInput(), product);
  assert.deepEqual(product.units.map((unit) => [unit.code, unit.name]), [['CM-UBND', 'UBND tỉnh'], ['CM-BAN', 'Ban']]);
  const rename = product.calls.find((call) => call.method === 'PUT');
  assert.equal(rename.ifMatch, '"3"');
  assert.deepEqual(product.units[1], { id: 'u-1', code: 'CM-BAN', name: 'Ban', parent_id: 'u-root', unit_type: 'PROJECT_MANAGEMENT_BOARD', valid_from: '2026-01-01', is_investor: true });
  // The permission the owner does not hold is left out of the role and said.
  assert.deepEqual(product.roles.find((role) => role.code === 'CAN_BO').permissions, ['a.read', 'a.write']);
  assert.match(lines.join('\n'), /1 permissions are not of the tenant plane and were left out of the roles: webhook\.provider/u);
  assert.equal(created.length, 1);
  assert.equal(created[0].username, 'canbo');
  assert.match(created[0].totpSecret, /^[A-Za-z0-9]{20}$/u);
  const invitation = product.invitations.get('canbo@d.example').body;
  assert.equal(invitation.organization_unit_id, 'u-1');
  assert.equal(invitation.initial_grants.length, INVITATION_GRANT_LIMIT);
  assert.deepEqual(invitation.initial_grants[0], { role_id: 'r-CAN_BO', scope_kind: 'TENANT' });
  const grants = product.calls.filter((call) => call.path === '/role-grants').map((call) => call.body);
  assert.deepEqual(grants.map((grant) => [grant.role_id, grant.scope_kind, grant.scope_ref_ids, grant.membership_id]), [['r-COMMITTEE_HEAD', 'TENANT', undefined, MEMBERSHIP_OF['id-canbo']], ['r-UNIT_ADMIN', 'UNIT_SUBTREE', ['u-1'], MEMBERSHIP_OF['id-canbo']]]);
  assert.ok(grants.every((grant) => grant.reason.length >= 10));
  // Every command carries an idempotency key and the owner's token; the acceptance carries the token of the person.
  assert.ok(product.calls.filter((call) => call.method !== 'GET').every((call) => typeof call.key === 'string' && call.key.length > 10));
  assert.equal(product.calls.find((call) => call.path.endsWith('/accept')).token, 'id-canbo');
  // The credentials: the owner as given, the person with what was made for them.
  assert.equal(result.origin, OWNER.origin);
  assert.equal(result.tenantId, OWNER.tenantId);
  assert.equal(result.people.owner.membershipId, OWNER.membershipId);
  // The owner got a password of the demonstration, set in the realm and written back to the file of the account; the new person has one from the start.
  assert.match(result.people.owner.password, /^[a-km-zA-HJ-NP-Z2-9]{13}$/u);
  assert.deepEqual(passwords, [['demo', result.people.owner.password], ['written back', result.people.owner.password]]);
  assert.match(created[0].password, /^[a-km-zA-HJ-NP-Z2-9]{13}$/u);
  assert.equal(result.people.projectManager.membershipId, MEMBERSHIP_OF['id-canbo']);
  assert.match(result.people.projectManager.otpauth, /^otpauth:\/\/totp\//u);
  assert.equal(credentialProblems(result, ['owner', 'projectManager']).length, 0);
});

test('a second run of the tenant tool does nothing twice', async () => {
  const product = fakeProduct();
  const first = await run(smallInput(), product);
  const before = product.calls.length;
  const second = await run(smallInput(), product, first.result);
  assert.equal(second.created.length, 0);
  assert.deepEqual(second.passwords, []);
  assert.equal(second.result.people.owner.password, first.result.people.owner.password);
  assert.deepEqual(product.calls.slice(before).filter((call) => call.method !== 'GET'), []);
  assert.equal(second.result.people.projectManager.password, first.result.people.projectManager.password);
});

test('the tenant tool stops, naming it, on a role the tenant does not have, and refuses an input or an owner account that cannot be used', async () => {
  const product = fakeProduct();
  const input = smallInput();
  input.people[1].grants.push({ role: 'NO_SUCH_ROLE', scope: 'TENANT' });
  await assert.rejects(() => run(input, product), /the tenant has no role NO_SUCH_ROLE/u);
  assert.deepEqual(inputProblems(smallInput(), OWNER), []);
  assert.match(inputProblems({ schema: 'x' }, OWNER).join('\n'), /not a demo-tenant-input\/1/u);
  assert.match(inputProblems(smallInput(), { ...OWNER, username: 'other' }).join('\n'), /the owner of the input is demo, the owner account is other/u);
  assert.match(inputProblems(smallInput(), { ...OWNER, totpSecret: '' }).join('\n'), /no totpSecret/u);
});

// ---- the people of an installation -----------------------------------------------------------------------------------------------------

const CREDENTIALS = { origin: 'https://demo.example:8443', tenantId: OWNER.tenantId, people: { owner: { username: 'demo', password: 'p', totpSecret: 's', membershipId: OWNER.membershipId } } };

test('the credentials are checked field by field and read from a file or the standard input, a banner before the JSON dropped', () => {
  assert.deepEqual(credentialProblems(CREDENTIALS, ['owner']), []);
  assert.deepEqual(credentialProblems(null), ['the credentials are not a JSON object']);
  assert.match(credentialProblems(CREDENTIALS, ['owner', 'capApprover']).join('\n'), /the person capApprover has no account/u);
  assert.match(credentialProblems({ ...CREDENTIALS, origin: 'https://demo.example:8443/api' }).join('\n'), /origin must be/u);
  assert.match(credentialProblems({ ...CREDENTIALS, tenantId: 'x', people: { owner: { username: 'demo' } } }).join('\n'), /tenantId is missing[\s\S]*people\.owner\.password is missing[\s\S]*people\.owner\.membershipId is missing/u);
  const seen = [];
  const read = (path) => {
    seen.push(path);
    return `Welcome to the server\n${JSON.stringify(CREDENTIALS)}`;
  };
  assert.deepEqual(readCredentials('-', read), CREDENTIALS);
  assert.deepEqual(seen, ['-']);
});

test('the broker signs a person in once, keeps the token until it is about to end, shares it through the cache file, and never tries a failed sign-in again', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'demo-data-test-'));
  try {
    const cacheFile = join(directory, 'tokens.json');
    let clock = 1_000_000;
    const signIns = [];
    const signIn = async (account) => {
      signIns.push(account.username);
      return { tenant: `token-${signIns.length}`, expiresIn: 300 };
    };
    const broker = brokerOf(CREDENTIALS, { cacheFile, signIn, now: () => clock });
    assert.equal(await broker.token('owner'), 'token-1');
    assert.equal(await broker.token('owner'), 'token-1');
    // Another process of the same run reads the cache and does not sign in.
    const other = brokerOf(CREDENTIALS, { cacheFile, signIn, now: () => clock });
    assert.equal(await other.token('owner'), 'token-1');
    assert.deepEqual(signIns, ['demo']);
    // The cache holds tokens, never the password or the secret.
    assert.doesNotMatch(readFileSync(cacheFile, 'utf8'), /"p"|totpSecret|password/u);
    // Inside the margin of the end a new token is taken.
    clock += (300 - TOKEN_MARGIN_SECONDS + 1) * 1000;
    assert.equal(await broker.token('owner'), 'token-2');
    // The token the API refused is forgotten, here and in the cache.
    broker.forget('owner');
    assert.equal(await other.token('owner'), 'token-3');
    await assert.rejects(() => broker.token('ghost'), /has no account/u);
    let attempts = 0;
    const failing = brokerOf(CREDENTIALS, {
      signIn: async () => {
        attempts += 1;
        throw new Error('Invalid username or password');
      },
      now: () => clock,
    });
    await assert.rejects(() => failing.token('owner'), /the sign-in of owner \(demo\) failed: Invalid username/u);
    await assert.rejects(() => failing.token('owner'), /is not tried again/u);
    assert.equal(attempts, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the reader of an installation asks the broker for the token of the person', async () => {
  const seen = [];
  const reader = new ApiReader({
    base: 'https://demo.example:8443/api/',
    tokenOf: async (person) => `tenant-token-of-${person}`,
    fetchImpl: async (url, init) => {
      seen.push([url, init.headers.authorization]);
      return new Response(JSON.stringify({ items: [{ id: 1 }] }), { status: 200 });
    },
  });
  assert.deepEqual(await reader.list('capApprover', '/resources/project'), [{ id: 1 }]);
  assert.deepEqual(seen, [['https://demo.example:8443/api/resources/project?limit=200', 'Bearer tenant-token-of-capApprover']]);
});

test('the stack info of an installation maps the units of the dataset by the key the seeds ask for, and names the units that are missing', () => {
  const dataset = camau();
  const units = dataset.tenant.units.map((unit, index) => ({ id: `id-${index}`, code: unit.code }));
  const info = installationInfo(dataset, CREDENTIALS, units);
  assert.equal(info.tenants.A, CREDENTIALS.tenantId);
  assert.equal(info.units.A['CB-HQ'], 'id-0');
  assert.equal(info.units.A['CB-SKHDT-QLDA'], units.find((unit) => unit.code === 'CM-BQLDAXD').id);
  assert.equal(info.units.A['CM-SXD'], units.find((unit) => unit.code === 'CM-SXD').id);
  assert.throws(() => installationInfo(dataset, CREDENTIALS, units.filter((unit) => unit.code !== 'CM-STC' && unit.code !== 'CM-SXD')), /has no unit CM-STC, CM-SXD/u);
});

test('the baseline of the platform is waited for: the province of the dataset must be in force in the master catalogue of the tenant', async () => {
  const dataset = camau();
  let answers = [[], [{ business_key: 'CA-MAU', status: 'DRAFT' }], [{ business_key: 'AN-GIANG', status: 'EFFECTIVE' }, { business_key: 'CA-MAU', status: 'EFFECTIVE' }]];
  const asked = [];
  const fetchImpl = async (url, init) => {
    asked.push([url, init.headers.authorization]);
    return new Response(JSON.stringify({ items: answers.length > 1 ? answers.shift() : answers[0] }), { status: 200 });
  };
  const broker = { token: async (person) => `t-${person}` };
  assert.equal(await baselineReady('https://h/api', broker, dataset, fetchImpl), false);
  assert.deepEqual(asked[0], ['https://h/api/master-records?limit=200&master_type=AREA', 'Bearer t-owner']);
  const slept = [];
  const lines = [];
  assert.equal(await waitForBaseline('https://h/api', broker, dataset, 5, { fetchImpl, sleep: async (ms) => void slept.push(ms), log: (line) => lines.push(line) }), true);
  assert.deepEqual(slept, [60_000]);
  assert.match(lines[0], /no province CA-MAU yet/u);
  answers = [[]];
  assert.equal(await waitForBaseline('https://h/api', broker, dataset, 2, { fetchImpl, sleep: async () => {}, log: () => {} }), false);
  // A dataset without a tenant has nothing to wait for.
  assert.equal(await baselineReady('https://h/api', broker, loadDataset('public'), fetchImpl), true);
});

test('a check of verify is tolerated only by its exact name, and a name that matches no check is an error', () => {
  const verdict = { ok: false, results: [{ name: 'a', ok: true, detail: '1' }, { name: 'late steps', ok: false, detail: '0 is below 1' }] };
  assert.equal(tolerated(verdict, []).ok, false);
  const waived = tolerated(verdict, ['late steps']);
  assert.equal(waived.ok, true);
  assert.equal(waived.results[1].tolerated, true);
  assert.throws(() => tolerated(verdict, ['late step']), /names no check: late step/u);
  assert.equal(tolerated({ ok: false, results: [] }, []).ok, false);
});

test('on an installation the command line needs the credentials of every member, and a dataset without a tenant cannot be loaded there', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'demo-data-test-'));
  try {
    const file = join(directory, 'credentials.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, JSON.stringify(CREDENTIALS));
    await assert.rejects(() => clipSeed(['apply', '--dataset', 'camau', '--api', 'https://demo.example:8443/api', '--credentials', file]), /the person capApprover has no account/u);
    await assert.rejects(() => clipSeed(['verify', '--dataset', 'public', '--api', 'https://demo.example:8443/api', '--credentials', file]), /names no tenant/u);
    await assert.rejects(() => clipSeed(['preflight', '--dataset', 'camau', '--api', 'https://demo.example:8443/api']), /--credentials/u);
    assert.equal(await clipSeed(['plan', '--dataset', 'camau']), 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// ---- the launcher and the tools directory ----------------------------------------------------------------------------------------------

test('the launcher of the public demo loads Cà Mau unless told otherwise, and gives the stack the tenant of the dataset without touching the name of the product', () => {
  const options = demoArgs([]);
  assert.equal(options.dataset, 'camau');
  assert.equal(options.seed, true);
  assert.deepEqual(demoArgs(['--dataset', 'public', '--web-port', '5190', '--no-seed']).ports.web, 5190);
  assert.throws(() => demoArgs(['--dataset', 'enterprise']), /not one of the public edition/u);
  assert.throws(() => demoArgs(['--web-port', '80']), /must be a port/u);
  assert.throws(() => demoArgs(['--what']), /unknown argument/u);
  assert.throws(() => demoArgs(['--dir']), /needs a value/u);
  const stack = buildStackEnv({ ports: options.ports, sessionKey: 'k', infoPath: 'i', profilePath: 'p.json' });
  assert.equal(stack.E2E_SEED, 'docs');
  assert.equal(stack.E2E_TENANT_PROFILE, 'p.json');
  assert.equal(stack.MACHVON_EDITION, undefined);
  assert.equal(buildStackEnv({ ports: options.ports, sessionKey: 'k', infoPath: 'i' }).E2E_TENANT_PROFILE, undefined);
  const web = buildWebEnv({ ports: options.ports, sessionKey: 'k', devUsers: [], tenantName: 'UBND tỉnh Cà Mau' });
  assert.equal(web.VITE_DEV_TENANT_NAME, 'UBND tỉnh Cà Mau');
  assert.equal(web.VITE_EDITION, undefined);
  // The profile of the stack (the tenant part of the dataset) names the tenant and its units only: nothing of the product's own name.
  assert.deepEqual(Object.keys(camau().tenant).sort(), ['accounts', 'code', 'emailDomain', 'name', 'province', 'roles', 'rootUnitName', 'subdomain', 'units']);
});

test('the tools directory holds the tools of the Windows deployment and the scripts they import, at the paths of the image', () => {
  const files = toolFiles().map(([, target]) => target.replaceAll('\\', '/'));
  assert.ok(files.includes('infra/onprem-windows/tools'));
  assert.ok(files.includes('scripts/onprem-first-tenant.mjs') && files.includes('scripts/onprem-smoke/keycloak-login.mjs'));
  // demo-tenant.mjs imports nothing outside that directory.
  const source = readFileSync(join(HERE, '..', 'infra', 'onprem-windows', 'tools', 'demo-tenant.mjs'), 'utf8');
  const imports = [...source.matchAll(/from '(\.[^']+)'/gu)].map((match) => match[1]);
  for (const path of imports.filter((entry) => entry.startsWith('../../../'))) assert.ok(files.includes(path.replace('../../../', '')), path);
});

test('the host scripts of the demo ask for an explicit confirmation before a wipe, back up first, and never print a secret', () => {
  const reset = readFileSync(join(HERE, '..', 'infra', 'onprem-windows', 'host', 'demo-reset.ps1'), 'utf8');
  assert.match(reset, /\$Confirm -cne 'RESET-DEMO-DATA'/u);
  // The backup is taken and checked before anything is removed.
  assert.ok(reset.indexOf("backup.ps1') -Label 'before-demo-reset'") < reset.indexOf('DROP DATABASE'));
  assert.ok(reset.indexOf('nothing was changed') < reset.indexOf('Move-Item'));
  assert.ok(reset.indexOf('Move-Item') < reset.indexOf('DROP DATABASE'));
  assert.doesNotMatch(reset, /DROP DATABASE IF EXISTS keycloak/u);
  const tenant = readFileSync(join(HERE, '..', 'infra', 'onprem-windows', 'host', 'demo-tenant.ps1'), 'utf8');
  assert.match(tenant, /Assert-Administrator/u);
  assert.match(tenant, /demo-credentials\.json/u);
  assert.doesNotMatch(`${reset}\n${tenant}`, /Write-Output \$.*password|Get-Content .*password/iu);
});

// ---- the seed context on an installation (the real class, in a process of its own) ---------------------------------------------------------

test('the seed context of an installation sends the token of the broker, the words of the dataset, and reads the answer back in the words of the guide', async () => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');
  const directory = mkdtempSync(join(tmpdir(), 'demo-data-test-'));
  const seen = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      seen.push({ method: request.method, url: decodeURIComponent(request.url), authorization: request.headers.authorization, body });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ items: [{ business_key: 'CA-MAU', label: 'Phường Tân Thành, tỉnh Cà Mau' }], echoed: 'Sở Tài chính' }));
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const port = server.address().port;
    const credentials = { origin: `http://127.0.0.1:${port}`, tenantId: OWNER.tenantId, people: Object.fromEntries(requiredPeople(camau()).map((person, index) => [person, { username: `u${index}`, password: 'never-sent', totpSecret: 'never-sent', membershipId: `00000000-0000-4000-8000-0000000000${String(10 + index)}` }])) };
    writeFileSync(join(directory, 'stack-info.json'), JSON.stringify(installationInfo(camau(), credentials, camau().tenant.units.map((unit, index) => ({ id: `unit-${index}`, code: unit.code })))));
    writeFileSync(join(directory, 'plan.json'), JSON.stringify(planForSeeds(buildPlan(camau()))));
    writeFileSync(join(directory, 'tokens.json'), JSON.stringify({ owner: { token: 'kept-token-of-the-owner', expiresAt: Date.now() + 250_000 } }));
    const script = `
      const { SeedContext } = await import(${JSON.stringify(new URL('../apps/web/e2e/hdsd/seed/context.ts', import.meta.url).href)});
      const ctx = new SeedContext();
      const reply = await ctx.call('owner', 'POST', '/master-records', { business_key: 'CB-THUC-PHAN', label: 'Phường Thục Phán', note: 'Ủy ban nhân dân tỉnh Cao Bằng', n: 3 }, { query: { q: 'Cao Bằng' } });
      console.log(JSON.stringify({ json: reply.json, unit: ctx.unitId('CB-SKHDT-QLDA'), member: ctx.person('capApprover').membershipId, operator: ctx.person('platformOperator').membershipId }));
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, E2E_SESSION_KEY: '', CLIP_CREDENTIALS: JSON.stringify(credentials), CLIP_TOKEN_CACHE: join(directory, 'tokens.json'), E2E_STACK_INFO: join(directory, 'stack-info.json'), CLIP_PLAN_FILE: join(directory, 'plan.json'), CLIP_API_URL: `http://127.0.0.1:${port}/api` } });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    const code = await new Promise((done) => child.on('exit', done));
    assert.equal(code, 0, err);
    const result = JSON.parse(out.trim().split('\n').at(-1));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].authorization, 'Bearer kept-token-of-the-owner');
    assert.equal(seen[0].url, '/api/master-records?q=Cà Mau');
    assert.deepEqual(JSON.parse(seen[0].body), { business_key: 'CM-TAN-THANH', label: 'Phường Tân Thành', note: 'Ủy ban nhân dân tỉnh Cà Mau', n: 3 });
    // The answer comes back in the words the seed groups compare with.
    assert.deepEqual(result.json, { items: [{ business_key: 'CAO-BANG', label: 'Phường Thục Phán, tỉnh Cao Bằng' }], echoed: 'Sở Kế hoạch và Đầu tư' });
    assert.equal(result.unit, `unit-${camau().tenant.units.findIndex((unit) => unit.key === 'CB-SKHDT-QLDA')}`);
    assert.equal(result.member, credentials.people.capApprover.membershipId);
    // A person of the control plane has no account on an installation and is not asked for one.
    assert.equal(result.operator, '');
    assert.doesNotMatch(JSON.stringify(seen), /never-sent/u);
  } finally {
    await new Promise((done) => server.close(done));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a password of the demonstration is thirteen letters and digits a person can type, and the owner is found in the output of the first accounts', () => {
  for (let index = 0; index < 50; index += 1) {
    const password = demoPassword();
    assert.match(password, /^[a-km-zA-HJ-NP-Z2-9]{13}$/u);
    assert.ok(/[a-z]/u.test(password) && /[A-Z]/u.test(password) && /[2-9]/u.test(password));
  }
  assert.notEqual(demoPassword(), demoPassword());
  const first = { origin: 'https://h:8443', tenantId: 't', people: { sysadmin: { username: 'sysadmin', password: 'a' }, demo: { username: 'demo', password: 'b', totpSecret: 'c', membershipId: 'm', otpauth: 'otpauth://x' } } };
  assert.deepEqual(ownerOf(first, smallInput()), { origin: 'https://h:8443', tenantId: 't', username: 'demo', password: 'b', totpSecret: 'c', membershipId: 'm', otpauth: 'otpauth://x' });
  assert.deepEqual(ownerOf(OWNER, smallInput()), OWNER);
  // An output of the first accounts without the owner of the input gives an account the checks refuse.
  assert.match(inputProblems(smallInput(), ownerOf({ origin: 'o', tenantId: 't', people: {} }, smallInput())).join('; '), /the owner account has no username/u);
});

test('one password for every account, when the operator gives one: the owner and the people already made get it, also on a later run', async () => {
  const product = fakeProduct();
  const first = await run(smallInput(), product);
  const again = await run(smallInput(), product, first.result, 'Demo#Pass2026');
  assert.deepEqual(again.passwords, [['demo', 'Demo#Pass2026'], ['written back', 'Demo#Pass2026'], ['canbo', 'Demo#Pass2026']]);
  assert.equal(again.result.people.owner.password, 'Demo#Pass2026');
  assert.equal(again.result.people.projectManager.password, 'Demo#Pass2026');
  // A third run with the same password changes nothing; a new installation creates the people with it.
  assert.deepEqual((await run(smallInput(), product, again.result, 'Demo#Pass2026')).passwords, []);
  const fresh = await run(smallInput(), fakeProduct(), {}, 'Demo#Pass2026');
  assert.equal(fresh.created[0].password, 'Demo#Pass2026');
  assert.equal(fresh.result.people.owner.password, 'Demo#Pass2026');
});

test('the memory of the seed groups of an installation stays between the runs, in a directory of that installation and tenant', () => {
  const home = join(tmpdir(), 'home-of-test');
  assert.equal(stateDirectoryOf({}, CREDENTIALS, home), join(home, '.clip-seed', `demo.example_8443-${CREDENTIALS.tenantId}`));
  assert.notEqual(stateDirectoryOf({}, { ...CREDENTIALS, tenantId: '00000000-0000-4000-8000-00000000000b' }, home), stateDirectoryOf({}, CREDENTIALS, home));
  assert.equal(stateDirectoryOf({ 'state-dir': join(home, 'x') }, CREDENTIALS, home), join(home, 'x'));
});

test('the stack info of an installation names the account of each membership, which a command that takes a user id needs', () => {
  const dataset = camau();
  const units = dataset.tenant.units.map((unit, index) => ({ id: `id-${index}`, code: unit.code }));
  const info = installationInfo(dataset, CREDENTIALS, units, [{ id: 'm-1', user_account_id: 'u-1' }, { id: 'm-2', user_id: 'u-2' }, { id: 'm-3' }]);
  assert.deepEqual(info.users, { 'm-1': 'u-1', 'm-2': 'u-2' });
  assert.deepEqual(installationInfo(dataset, CREDENTIALS, units).users, {});
});

test('the annual plan takes effect eighty days before the real day, at the first instant of that day in Vietnam', async () => {
  const { PLAN_EFFECTIVE_DAYS_AGO, planEffectiveAt } = await import('../apps/web/e2e/hdsd/seed/capital-plan.ts');
  assert.equal(PLAN_EFFECTIVE_DAYS_AGO, 80);
  assert.equal(planEffectiveAt(new Date('2026-11-16T02:00:00Z')), '2026-08-28T00:00:00+07:00');
  // Late in the evening in Vietnam is already the next day there.
  assert.equal(planEffectiveAt(new Date('2026-11-16T18:30:00Z')), '2026-08-29T00:00:00+07:00');
  assert.ok(new Date(planEffectiveAt()).getTime() < Date.now() - 79 * 86_400_000);
});
