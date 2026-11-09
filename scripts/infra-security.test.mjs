import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMalwareScan, checkRansomwareCatalogue, checkRealmImport, ransomwareEvidencePaths } from './infra-security.mjs';
import { ARTEFACT_FINDING_CODES, checkArtefacts } from './infra-artefacts.mjs';
import { loadOnpremMessages } from './onprem-messages.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const yaml = createRequire(import.meta.url)('js-yaml');
const policy = JSON.parse(readFileSync(join(REPO_ROOT, 'infra/policies/artefacts.json'), 'utf8'));
const realmOf = () => JSON.parse(readFileSync(join(REPO_ROOT, policy.identity.realmFile), 'utf8'));
const composeOf = () => yaml.load(readFileSync(join(REPO_ROOT, policy.compose.file), 'utf8'));
const environmentOf = (compose) => new Set(Object.keys(compose.services.keycloak.environment));
const cleanups = [];
process.on('exit', () => cleanups.forEach((clean) => clean()));

// --- Keycloak realm import rules ---------------------------------------------------------------------------------------------------------------------------------------------

test('the realm export keeps the import rules of Keycloak 26 as far as they can be judged offline, and every placeholder has a value in the container', () => {
  assert.deepEqual(checkRealmImport(realmOf(), { environment: environmentOf(composeOf()) }), []);
});

test('realm import: each structure rule fails on a mutated copy', () => {
  const failing = (mutate, pattern, environment) => {
    const realm = realmOf();
    mutate(realm);
    assert.match(checkRealmImport(realm, { environment }).join(' | '), pattern);
  };
  failing((r) => { delete r.realm; }, /realm \(the realm name\)/);
  failing((r) => { r.enabled = 'yes'; }, /enabled must be a boolean/);
  failing((r) => { r.authenticationFlows.push({ ...r.authenticationFlows[0] }); }, /alias .* is repeated/);
  failing((r) => { r.authenticationFlows[0].authenticationExecutions[1].flowAlias = 'no such flow'; }, /sub flow no such flow is not defined/);
  failing((r) => { r.authenticationFlows[0].authenticationExecutions[0].requirement = 'MAYBE'; }, /requirement MAYBE/);
  failing((r) => { r.authenticationFlows[0].authenticationExecutions[0].authenticatorConfig = 'missing config'; }, /authenticator config missing config is not defined/);
  failing((r) => { r.authenticationFlows[0].authenticationExecutions[1].authenticator = 'auth-cookie'; }, /never both/);
  failing((r) => { r.authenticationFlows[0].authenticationExecutions[1].priority = r.authenticationFlows[0].authenticationExecutions[0].priority; }, /same priority/);
  failing((r) => { r.browserFlow = 'not a flow'; }, /browserFlow names not a flow/);
  failing((r) => { r.authenticationFlows.push({ alias: 'orphan', providerId: 'basic-flow', topLevel: false, authenticationExecutions: [] }); }, /no flow uses it/);
  failing((r) => { r.authenticationFlows[0].providerId = 'strange-flow'; }, /providerId must be basic-flow/);
  failing((r) => { r.roles.realm.push({ ...r.roles.realm[0] }); }, /realm role .* is repeated/);
  failing((r) => { r.groups[0].realmRoles.push('NoSuchRole'); }, /role NoSuchRole is not a realm role/);
  failing((r) => { r.clients.push({ ...r.clients[0] }); }, /clientId .* is repeated/);
  failing((r) => { r.clients[0].defaultClientScopes = ['made-up-scope']; }, /client scope made-up-scope/);
  failing((r) => { r.clients[0].protocolMappers.push({ ...r.clients[0].protocolMappers[0] }); }, /protocol mapper .* is repeated/);
  failing((r) => { delete r.clients[0].protocolMappers[0].protocolMapper; }, /needs protocol, protocolMapper and config/);
  failing((r) => { r.clients[0].attributes.count = 3; }, /every attribute value must be a string/);
  failing((r) => { r.requiredActions.push({ ...r.requiredActions[0] }); }, /required action .* is repeated/);
  failing((r) => { const ldap = r.components['org.keycloak.storage.UserStorageProvider'][0]; ldap.config.connectionUrl = '${LDAP_URL}'; }, /connectionUrl must be a list of strings/);
  failing((r) => { r.components['org.keycloak.storage.UserStorageProvider'][0].subComponents['org.keycloak.storage.ldap.mappers.LDAPStorageMapper'].push({ ...r.components['org.keycloak.storage.UserStorageProvider'][0].subComponents['org.keycloak.storage.ldap.mappers.LDAPStorageMapper'][0] }); }, /mappers.LDAPStorageMapper username is repeated|LDAPStorageMapper username is repeated/);
  failing((r) => { r.attributes.limit = 5; }, /every realm attribute value must be a string/);
  failing((r) => { r.displayName = '${A_VARIABLE_NOBODY_SETS}'; }, /placeholder \$\{A_VARIABLE_NOBODY_SETS\} has no value/, environmentOf(composeOf()));
  assert.deepEqual(checkRealmImport('nonsense'), ['the realm file is not a JSON object']);
});

// --- malware scan wiring -----------------------------------------------------------------------------------------------------------------------------------------------------

test('the compose set wires the malware scan: a clamav service on the app network only, and the API and the workers told to use it', () => {
  assert.deepEqual(checkMalwareScan(composeOf(), policy.security.malwareScan), []);
});

test('malware scan wiring: each rule fails on a mutated copy', () => {
  const failing = (mutate, pattern) => {
    const compose = composeOf();
    mutate(compose);
    assert.match(checkMalwareScan(compose, policy.security.malwareScan).join(' | '), pattern);
  };
  failing((c) => { delete c.services.clamav; }, /no clamav service/);
  failing((c) => { c.services.clamav.networks.push('egress'); }, /app network only/);
  failing((c) => { c.services.clamav.ports = ['3310:3310']; }, /app network only/);
  failing((c) => { c.services.clamav.networks = ['data']; }, /must join the app network/);
  failing((c) => { c.services.api.environment.MACHVON_SCAN_ADAPTER = 'mock'; }, /api: MACHVON_SCAN_ADAPTER must be clamav/);
  failing((c) => { delete c.services.workers.environment.MACHVON_PORTAL_SCAN; }, /workers: MACHVON_PORTAL_SCAN must be CLAMAV/);
  failing((c) => { c.services.api.environment.MACHVON_CLAMD_HOST = 'somewhere-else'; }, /MACHVON_CLAMD_HOST must be clamav/);
  failing((c) => { c.services.api.environment.MACHVON_CLAMD_PORT = '9999'; }, /MACHVON_CLAMD_PORT must be 3310/);
  failing((c) => { c.services.api.networks = ['data']; }, /api cannot reach clamav/);
});

// --- ransomware catalogue ----------------------------------------------------------------------------------------------------------------------------------------------------

const CATALOGUE = policy.security.ransomware.catalogue;
const COPIED = ['infra', '.zap', '.gitleaks.toml', '.github/workflows', 'docs/runbooks/infra', 'docs/security', 'supply-chain.json', 'package.json', 'package-lock.json', 'apps/api/src/security/security-headers.ts', 'apps/api/src/bootstrap.ts', 'apps/api/scripts/ts-loader.mjs', 'apps/api/package.json', 'db/migrations/V001__roles_and_grants.sql'];
const PLACEHOLDERS = ['scripts/onprem-bundle.mjs', 'scripts/backup-verify.mjs', 'scripts/restore-drill.mjs', 'scripts/native-deps-check.mjs', 'scripts/infra-security.mjs', 'apps/api/src/modules/files/clamd-scan.ts'];

function scratch(edit) {
  const root = mkdtempSync(join(tmpdir(), 'machvon-ransom-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const path of [...COPIED, ...ransomwareEvidencePaths(JSON.parse(readFileSync(join(REPO_ROOT, CATALOGUE), 'utf8')))]) {
    if (existsSync(join(root, path))) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(REPO_ROOT, path), join(root, path), { recursive: true });
  }
  for (const path of PLACEHOLDERS) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), 'x');
  }
  edit?.({
    root,
    catalogue(change) {
      const file = join(root, CATALOGUE);
      const value = JSON.parse(readFileSync(file, 'utf8'));
      change(value);
      writeFileSync(file, JSON.stringify(value, null, 2));
    },
    text(path, change) {
      writeFileSync(join(root, path), change(readFileSync(join(root, path), 'utf8')));
    },
  });
  return root;
}

test('the ransomware catalogue covers every required vector with controls, evidence and tests that exist, and the pentest pack points at it', () => {
  assert.deepEqual(checkRansomwareCatalogue(REPO_ROOT, policy.security.ransomware), []);
  const catalogue = JSON.parse(readFileSync(join(REPO_ROOT, CATALOGUE), 'utf8'));
  const vectors = new Set(catalogue.scenarios.map((scenario) => scenario.vector));
  for (const vector of ['file-upload-exec', 'rce', 'injection', 'privilege-escalation', 'session-takeover', 'password-guessing', 'third-party-cve', 'direct-db-backup-access']) assert.ok(vectors.has(vector), vector);
  assert.match(readFileSync(join(REPO_ROOT, 'docs/security/pentest-readiness.md'), 'utf8'), /ransomware-scenarios/);
});

test('ransomware catalogue: each rule fails on a mutated copy', () => {
  const check = (edit) => checkRansomwareCatalogue(scratch(edit), policy.security.ransomware).join(' | ');
  assert.match(check((s) => s.catalogue((c) => { c.scenarios = c.scenarios.filter((scenario) => scenario.vector !== 'rce'); })), /no scenario for the vector rce/);
  assert.match(check((s) => s.catalogue((c) => { c.scenarios[0].controls = c.scenarios[0].controls.filter((control) => control.kind !== 'preventive'); })), /RW-01: no preventive control/);
  assert.match(check((s) => s.catalogue((c) => { c.scenarios[0].controls = c.scenarios[0].controls.filter((control) => control.kind === 'preventive'); })), /RW-01: no detective or recovery control/);
  assert.match(check((s) => s.catalogue((c) => { c.scenarios[0].controls[0].evidence = [{ path: 'docs/security/no-such-file.md' }]; })), /evidence docs\/security\/no-such-file\.md does not exist/);
  assert.match(check((s) => s.catalogue((c) => { c.scenarios[0].controls[0].evidence = [{ path: 'packages/kernel/src/object-storage.ts', contains: 'a text that is not in the file' }]; })), /does not contain/);
  assert.match(check((s) => s.catalogue((c) => { c.scenarios[0].controls[0].evidence = []; })), /cites no evidence/);
  assert.match(check((s) => s.catalogue((c) => { c.scenarios[0].tests = []; })), /RW-01: no test/);
  assert.match(check((s) => s.catalogue((c) => { c.scenarios[0].tests = ['scripts/no-such.test.mjs']; })), /test scripts\/no-such\.test\.mjs does not exist/);
  assert.match(check((s) => s.catalogue((c) => { c.scenarios[1].id = 'RW-01'; })), /scenario id RW-01 is repeated/);
  assert.match(check((s) => s.catalogue((c) => { delete c.scenarios[0].residualRisk; })), /residualRisk is required/);
  assert.match(check((s) => s.text('docs/security/ransomware-scenarios.md', (t) => t.replaceAll('RW-03', 'RW-XX'))), /does not list RW-03/);
  assert.match(check((s) => s.text('docs/security/pentest-readiness.md', (t) => t.replaceAll('ransomware-scenarios', 'something'))), /does not refer to the ransomware scenario catalogue/);
  assert.deepEqual(checkRansomwareCatalogue(REPO_ROOT, { ...policy.security.ransomware, catalogue: 'docs/security/missing.json' }), ['docs/security/missing.json is missing or malformed']);
});

// --- wired into infra:check --------------------------------------------------------------------------------------------------------------------------------------------------

test('infra:check runs these rules: the real repository passes and a broken compose or catalogue is a finding with the named code', () => {
  assert.deepEqual(checkArtefacts(REPO_ROOT).findings, []);
  const compose = scratch((s) => s.text('infra/onprem/compose/compose.yaml', (t) => t.replace('MACHVON_SCAN_ADAPTER: clamav', 'MACHVON_SCAN_ADAPTER: mock')));
  assert.ok(checkArtefacts(compose).findings.some((entry) => entry.code === 'MALWARE_SCAN'));
  const egress = scratch((s) => s.text('infra/onprem/config/egress-firewall.sh', (t) => t.replace('-A MACHVON-EGRESS -j DROP', '-A MACHVON-EGRESS -j RETURN')));
  assert.ok(checkArtefacts(egress).findings.some((entry) => entry.code === 'EGRESS_RULES'));
  const catalogue = scratch((s) => s.catalogue((c) => { c.scenarios[0].tests = []; }));
  assert.ok(checkArtefacts(catalogue).findings.some((entry) => entry.code === 'RANSOMWARE_CATALOGUE'));
  const realm = scratch((s) => s.text('infra/keycloak/onprem/machvon-realm.json', (t) => t.replace('"alias": "machvon level 1"', '"alias": "machvon level 2"')));
  assert.ok(checkArtefacts(realm).findings.some((entry) => entry.code === 'REALM_IMPORT'));
  for (const code of ['MALWARE_SCAN', 'EGRESS_RULES', 'RANSOMWARE_CATALOGUE', 'REALM_IMPORT']) {
    assert.ok(ARTEFACT_FINDING_CODES.includes(code));
    for (const locale of ['vi', 'en']) assert.ok(loadOnpremMessages(locale)[`infra.${code}`], `${locale}: ${code}`);
  }
});

// --- sizing document ---------------------------------------------------------------------------------------------------------------------------------------------------------

test('the sizing document states the container limits of env.template and the sections a customer reads', () => {
  const doc = readFileSync(join(REPO_ROOT, 'docs/runbooks/infra/sizing-uat-prod.md'), 'utf8');
  const env = readFileSync(join(REPO_ROOT, 'infra/onprem/compose/env.template'), 'utf8');
  const limits = env.split(/\r?\n/).filter((line) => /^[A-Z]+_(CPUS|MEMORY)=/.test(line));
  assert.ok(limits.length >= 14);
  for (const line of limits) assert.ok(doc.includes(line), `the sizing document does not state ${line}`);
  for (const heading of ['## 1. ', '## 3. UAT', '## 4. Production', '## 5. Sao l', '## 7. ']) assert.ok(doc.includes(heading), heading);
  assert.match(doc, /RPO[^\n]*15 ph/);
  assert.match(doc, /09 /);
});
