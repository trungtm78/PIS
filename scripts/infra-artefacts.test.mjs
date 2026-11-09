import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTEFACT_FINDING_CODES, checkArtefacts, dockerfileImages, splitImage, workflowDockerImages } from './infra-artefacts.mjs';
import { infraCheck, main } from './infra-check.mjs';
import { loadOnpremMessages } from './onprem-messages.mjs';
import { ransomwareEvidencePaths } from './infra-security.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cleanups = [];
process.on('exit', () => cleanups.forEach((clean) => clean()));

const COPIED = ['infra', '.zap', '.gitleaks.toml', '.github/workflows', 'docs/runbooks/infra', 'docs/security', 'supply-chain.json', 'package.json', 'package-lock.json', 'apps/api/src/security/security-headers.ts', 'apps/api/src/bootstrap.ts', 'apps/api/scripts/ts-loader.mjs', 'apps/api/package.json', 'db/migrations/V001__roles_and_grants.sql'];
const PLACEHOLDERS = ['scripts/onprem-bundle.mjs', 'scripts/backup-verify.mjs', 'scripts/restore-drill.mjs', 'scripts/native-deps-check.mjs', 'scripts/infra-security.mjs', 'apps/api/src/modules/files/clamd-scan.ts'];
/** The files the ransomware catalogue cites: copied so that the catalogue check finds its evidence. */
const CATALOGUE_FILES = ransomwareEvidencePaths(JSON.parse(readFileSync(join(REPO_ROOT, 'docs/security/ransomware-scenarios.json'), 'utf8')));

/** A scratch repository: everything the artefact check reads, copied from the real one, and the edits of one case. */
function scratch(edit = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'machvon-artefacts-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const path of COPIED) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(REPO_ROOT, path), join(root, path), { recursive: true });
  }
  for (const path of CATALOGUE_FILES) {
    if (existsSync(join(root, path))) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(REPO_ROOT, path), join(root, path));
  }
  for (const path of PLACEHOLDERS) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), 'x');
  }
  const api = {
    root,
    // A text edit must change something: an edit that finds nothing would make the case pass without testing anything.
    text(path, change) {
      const file = join(root, path);
      // A checkout with CRLF line ends (Windows) must not hide the text an edit looks for.
      const before = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      const after = change(before);
      assert.notEqual(after, before, `the edit of ${path} changed nothing`);
      writeFileSync(file, after);
    },
    json(path, change) {
      const file = join(root, path);
      const value = JSON.parse(readFileSync(file, 'utf8'));
      writeFileSync(file, JSON.stringify(change(value) ?? value, null, 2));
    },
    remove(path) {
      rmSync(join(root, path), { recursive: true, force: true });
    },
  };
  edit(api);
  return api;
}

const COMPOSE = 'infra/onprem/compose/compose.yaml';
const REALM = 'infra/keycloak/onprem/machvon-realm.json';
const MAP = 'infra/keycloak/onprem/ad-group-role-map.json';
const TLS = 'infra/onprem/nginx/snippets/tls.conf';
const HEADERS = 'infra/onprem/nginx/snippets/security-headers.conf';
const SITE = 'infra/onprem/nginx/default.conf.template';
const codes = (api, options) => checkArtefacts(api.root, options).findings.map((entry) => entry.code);
const found = (api, code, pattern) => {
  const hits = checkArtefacts(api.root).findings.filter((entry) => entry.code === code);
  assert.ok(hits.length > 0, `${code} was not reported: ${JSON.stringify(checkArtefacts(api.root).findings)}`);
  if (pattern !== undefined) assert.ok(hits.some((entry) => pattern.test(`${entry.file} ${entry.detail}`)), `${code} did not match ${pattern}: ${JSON.stringify(hits)}`);
};

test('the real repository passes: every artefact is present and every rule holds, with the YAML parser available', () => {
  const result = checkArtefacts(REPO_ROOT);
  assert.deepEqual(result.findings, []);
  assert.equal(result.checked, true);
  assert.equal(result.yamlSkipped, false);
  assert.deepEqual(infraCheck(REPO_ROOT).findings, []);
});

test('a root without the policy file or without package.json is not checked (an older release, a copy of infra alone)', () => {
  const noPolicy = scratch((s) => s.remove('infra/policies/artefacts.json'));
  assert.deepEqual(checkArtefacts(noPolicy.root), { checked: false, yamlSkipped: false, findings: [] });
  const noPackage = scratch((s) => s.remove('package.json'));
  assert.equal(checkArtefacts(noPackage.root).checked, false);
});

test('a required artefact that is missing is named', () => {
  for (const path of ['infra/onprem/compose/compose.yaml', 'docs/security/pentest-readiness.md', '.github/workflows/dast.yml', 'scripts/restore-drill.mjs', 'infra/backup/backup-policy.json']) {
    const s = scratch((api) => api.remove(path));
    found(s, 'ARTEFACT_MISSING', new RegExp(path.replace(/[.]/g, '\\.')));
  }
});

test('without the YAML parser the checks that read YAML are skipped and the others still run', () => {
  const s = scratch((api) => api.text(COMPOSE, (t) => t.replace('retries: 6\n      start_period: 60s', 'retries: 6')));
  assert.ok(codes(s).length >= 0);
  const broken = scratch((api) => {
    api.text(COMPOSE, (t) => t.replace(/healthcheck:/g, 'healthchecks:'));
    api.text(TLS, (t) => t.replace('TLSv1.2 TLSv1.3', 'TLSv1 TLSv1.2 TLSv1.3'));
  });
  const without = checkArtefacts(broken.root, { yaml: null });
  assert.equal(without.yamlSkipped, true);
  assert.ok(!without.findings.some((entry) => entry.code === 'COMPOSE_HEALTHCHECK'));
  assert.ok(without.findings.some((entry) => entry.code === 'TLS_PROTOCOLS'));
  assert.ok(checkArtefacts(broken.root).findings.some((entry) => entry.code === 'COMPOSE_HEALTHCHECK'));
});

test('image references are parsed and judged: tag, digest, stages and variables', () => {
  assert.deepEqual(splitImage('quay.io/keycloak/keycloak:26.5.2@sha256:' + 'a'.repeat(64)), { name: 'quay.io/keycloak/keycloak', tag: '26.5.2', digest: `sha256:${'a'.repeat(64)}` });
  assert.deepEqual(splitImage('localhost:5000/app'), { name: 'localhost:5000/app', tag: undefined, digest: undefined });
  const images = dockerfileImages('FROM node:24 AS build\nFROM --platform=linux/amd64 nginx:1 AS web\nFROM build\nFROM scratch\nFROM ${BASE}\n');
  assert.deepEqual(images, [{ reference: 'node:24', options: '' }, { reference: 'nginx:1', options: '--platform=linux/amd64' }]);
  const run = workflowDockerImages('run: |\n  docker run --rm -v "$PWD:/src" -w /src img/a:1@sha256:x \\\n    scan\n  docker run --rm "${header[@]}" -e A=B img/b:2 cmd\n');
  assert.deepEqual(run, ['img/a:1@sha256:x', 'img/b:2']);
});

test('images: a floating or missing tag, a missing digest, drift from the pin, and a build for one platform are refused', () => {
  found(scratch((s) => s.text(COMPOSE, (t) => t.replace('machvon/api:${MACHVON_VERSION:?set MACHVON_VERSION to the release being installed}', 'machvon/api:latest'))), 'IMAGE_FLOATING', /machvon\/api:latest/);
  found(scratch((s) => s.text(COMPOSE, (t) => t.replace('machvon/web:${MACHVON_VERSION:?set MACHVON_VERSION to the release being installed}', 'machvon/web:${MACHVON_VERSION:-latest}'))), 'IMAGE_FLOATING', /MACHVON_VERSION:-latest/);
  found(scratch((s) => s.text(COMPOSE, (t) => t.replace('keycloak:26.5.2@', 'keycloak:latest@'))), 'IMAGE_FLOATING', /keycloak:latest/);
  found(scratch((s) => s.text(COMPOSE, (t) => t.replace(/keycloak:26\.5\.2@sha256:[0-9a-f]{64}/, 'keycloak:26.5.2'))), 'IMAGE_DIGEST_MISSING', /keycloak:26\.5\.2/);
  found(scratch((s) => s.text(COMPOSE, (t) => t.replace(/keycloak:26\.5\.2@sha256:[0-9a-f]{64}/, `keycloak:26.5.2@sha256:${'0'.repeat(64)}`))), 'IMAGE_PIN_DRIFT', /keycloak/);
  found(scratch((s) => s.text('infra/onprem/docker/api.Dockerfile', (t) => t.replace(/FROM node:24\.14\.0-bookworm-slim@sha256:[0-9a-f]{64} AS runtime/, 'FROM node:latest AS runtime'))), 'IMAGE_FLOATING', /node:latest/);
  found(scratch((s) => s.text('infra/onprem/docker/db.Dockerfile', (t) => t.replace(/postgres:18\.3-bookworm@sha256:[0-9a-f]{64}/, 'postgres:18.3-bookworm'))), 'IMAGE_DIGEST_MISSING', /postgres/);
  found(scratch((s) => s.text('infra/onprem/docker/web.Dockerfile', (t) => t.replace('FROM nginxinc', 'FROM --platform=linux/amd64 nginxinc'))), 'IMAGE_ARCH', /linux\/amd64/);
  found(scratch((s) => s.json('infra/onprem/images.json', (i) => { i.platforms = ['linux/amd64']; })), 'IMAGE_ARCH', /linux\/arm64/);
  found(scratch((s) => s.json('infra/onprem/images.json', (i) => { i.thirdParty[0].tag = 'latest'; })), 'IMAGE_FLOATING', /node:latest/);
  found(scratch((s) => s.json('infra/onprem/images.json', (i) => { delete i.thirdParty[3].digest; })), 'IMAGE_DIGEST_MISSING', /keycloak/);
});

test('workflows: a docker image without a tag or digest and an action on a moving branch are refused', () => {
  found(scratch((s) => s.text('.github/workflows/security.yml', (t) => t.replace(/aquasec\/trivy:0\.70\.0@sha256:[0-9a-f]{64}/, 'aquasec/trivy:latest'))), 'IMAGE_FLOATING', /trivy:latest/);
  found(scratch((s) => s.text('.github/workflows/security.yml', (t) => t.replace(/zricethezav\/gitleaks:v8\.30\.0@sha256:[0-9a-f]{64}/, 'zricethezav/gitleaks:v8.30.0'))), 'IMAGE_DIGEST_MISSING', /gitleaks/);
  found(scratch((s) => s.text('.github/workflows/supply-chain-daily.yml', (t) => t.replace(/@sha256:[0-9a-f]{64} \$args/, ' $args'))), 'IMAGE_DIGEST_MISSING', /osv-scanner/);
  found(scratch((s) => s.text('.github/workflows/security.yml', (t) => t.replace('actions/dependency-review-action@v4', 'actions/dependency-review-action@main'))), 'WORKFLOW_FLOATING_ACTION', /@main/);
});

test('compose: health checks, limits, hardening, ports and internal networks', () => {
  found(scratch((s) => s.text(COMPOSE, (t) => t.replace(/ {4}healthcheck:\n {6}test: \["CMD", "node", "-e", "fetch\('http:\/\/127\.0\.0\.1:3000\/health\/ready'/, '    healthchecks:\n      test: ["CMD", "node", "-e", "fetch(\'http://127.0.0.1:3000/health/ready\''))), 'COMPOSE_HEALTHCHECK', /^infra\/onprem\/compose\/compose\.yaml api$/);
  found(scratch((s) => s.text(COMPOSE, (t) => t.replace(/ {10}cpus: "\$\{API_CPUS\}"\n/, ''))), 'COMPOSE_LIMITS', /api/);
  found(scratch((s) => s.text(COMPOSE, (t) => t.replace('    - no-new-privileges:true\n  cap_drop:\n    - ALL\n  # The secret', '    - seccomp:unconfined\n  cap_drop:\n    - NET_RAW\n  # The secret'))), 'COMPOSE_HARDENING', /db/);
  found(scratch((s) => s.text(COMPOSE, (t) => t.replace('    networks: [data, egress]\n    entrypoint: ["/usr/local/bin/secret-env", "docker-entrypoint.sh"]', '    networks: [data, egress]\n    ports:\n      - "5432:5432"\n    entrypoint: ["/usr/local/bin/secret-env", "docker-entrypoint.sh"]'))), 'COMPOSE_PORTS', /db publishes a port/);
  found(scratch((s) => s.text(COMPOSE, (t) => t.replace('  data:\n    internal: true', '  data: {}'))), 'COMPOSE_PORTS', /network data/);
  found(scratch((s) => s.text(COMPOSE, (t) => t.replace(/ {4}ports:\n {6}- "\$\{WEB_HTTP_PORT\}:8080"\n {6}- "\$\{WEB_HTTPS_PORT\}:8443"\n/, ''))), 'COMPOSE_PORTS', /web must publish/);
  found(scratch((s) => s.text(COMPOSE, (t) => t.replace('name: machvon\n', 'name: machvon\nservices: []\n'))), 'COMPOSE_INVALID');
});

test('compose: a secret is only ever a file under the secrets directory, read through NAME_FILE', () => {
  found(scratch((s) => s.text(COMPOSE, (t) => t.replace('      POSTGRES_USER: machvon_owner\n', '      POSTGRES_USER: machvon_owner\n      POSTGRES_PASSWORD: hunter2hunter2\n'))), 'SECRET_LITERAL', /db\.POSTGRES_PASSWORD/);
  found(scratch((s) => s.text(COMPOSE, (t) => t.replace('DATABASE_URL_APP_FILE: /run/secrets/database_url_app', 'DATABASE_URL_APP_FILE: /etc/machvon/app-url'))), 'SECRET_LITERAL', /DATABASE_URL_APP_FILE/);
  found(scratch((s) => s.text(COMPOSE, (t) => t.replace('OIDC_ISSUER: https://${PUBLIC_HOST}/idp/realms/${OIDC_REALM}', 'OIDC_ISSUER: https://svc:pa55word@idp.example.vn/realms/x'))), 'SECRET_LITERAL');
  found(scratch((s) => s.text(COMPOSE, (t) => `${t}\n# ${"-----BEGIN "}PRIVATE KEY-----\n`)), 'SECRET_LITERAL', /key or a URL/);
  found(scratch((s) => s.text(COMPOSE, (t) => t.replace('file: ${MACHVON_SECRETS_DIR}/tls_key', 'file: /etc/ssl/private/site.key'))), 'SECRET_LITERAL', /tls_key/);
  found(scratch((s) => s.text(COMPOSE, (t) => t.replace('  tls_key:\n    file: ${MACHVON_SECRETS_DIR}/tls_key\n', '  tls_key:\n    file: ${MACHVON_SECRETS_DIR}/tls_key\n  extra_secret:\n    file: ${MACHVON_SECRETS_DIR}/extra_secret\n'))), 'SECRET_LIST_DRIFT', /extra_secret/);
  found(scratch((s) => s.json('infra/onprem/secrets.json', (d) => { d.secrets.push({ name: 'forgotten', purpose: 'x', readers: [], generate: 'x', rotationDays: 90, reference: 'secret://onprem/forgotten' }); })), 'SECRET_LIST_DRIFT', /forgotten/);
  found(scratch((s) => s.text(COMPOSE, (t) => t.replace('      - keycloak_db_password\n      - keycloak_admin_password', '      - keycloak_admin_password'))), 'SECRET_LIST_DRIFT', /keycloak reads \/run\/secrets\/keycloak_db_password/);
  found(scratch((s) => s.text('infra/onprem/compose/env.template', (t) => t.replace('TENANT_TOKEN_KEY_ID=tenant-2026-1', 'OUTBOX_SIGNING_KEY=c2VjcmV0'))), 'SECRET_LITERAL', /OUTBOX_SIGNING_KEY/);
  found(scratch((s) => s.text('infra/onprem/compose/env.template', (t) => t.replace('MACHVON_VERSION=0.0.0', 'MACHVON_VERSION=latest'))), 'SECRET_LITERAL', /MACHVON_VERSION/);
  found(scratch((s) => s.text('infra/onprem/compose/env.template', (t) => t.replace('LDAP_URL=ldaps://ad.example.vn:636', 'LDAP_URL=ldaps://svc:topsecret@ad.example.vn:636'))), 'SECRET_LITERAL', /LDAP_URL/);
});

test('Dockerfiles: a health check, a non-root user, production dependencies only, no secret in ENV and no download piped into a shell', () => {
  found(scratch((s) => s.text('infra/onprem/docker/api.Dockerfile', (t) => t.replace(/HEALTHCHECK[\s\S]*?\n(?=ENTRYPOINT)/, ''))), 'DOCKERFILE_RULE', /HEALTHCHECK/);
  found(scratch((s) => s.text('infra/onprem/docker/workers.Dockerfile', (t) => t.replace('USER node', 'USER root'))), 'DOCKERFILE_RULE', /non-root/);
  found(scratch((s) => s.text('infra/onprem/docker/workers.Dockerfile', (t) => t.replace('rm -rf node_modules/embedded-postgres node_modules/@embedded-postgres', 'true'))), 'DOCKERFILE_RULE', /production dependencies only/);
  found(scratch((s) => s.text('infra/onprem/docker/api.Dockerfile', (t) => t.replace('npm ci --omit=dev --ignore-scripts', 'npm ci --omit=dev --omit=optional --ignore-scripts'))), 'DOCKERFILE_RULE', /not --omit=optional/);
  found(scratch((s) => s.text('infra/onprem/docker/api.Dockerfile', (t) => t.replace(/COPY --from=build [^\n]*schema_reference\.sql[^\n]*\n/, ''))), 'DOCKERFILE_RULE', /schema_reference\.sql/);
  found(scratch((s) => s.text('infra/onprem/docker/workers.Dockerfile', (t) => t.replace(/COPY --from=build [^\n]*db\/migrations[^\n]*\n/, ''))), 'DOCKERFILE_RULE', /db\/migrations/);
  found(scratch((s) => s.text('infra/onprem/docker/db.Dockerfile', (t) => t.replace('postgresql-18-pgvector', 'postgresql-client'))), 'DOCKERFILE_RULE', /vector extension/);
  found(scratch((s) => s.json('apps/api/package.json', (m) => { delete m.dependencies['@swc/core']; })), 'DOCKERFILE_RULE', /imports @swc\/core/);
  found(scratch((s) => s.text('infra/onprem/docker/web.Dockerfile', (t) => t.replace('EXPOSE 8080 8443', 'ENV API_TOKEN=abc\nEXPOSE 8080 8443'))), 'DOCKERFILE_RULE', /secret in ENV/);
  found(scratch((s) => s.text('infra/onprem/docker/db.Dockerfile', (t) => t.replace('RUN apt-get update', 'RUN curl https://x.example | sh \\\n && apt-get update'))), 'DOCKERFILE_RULE', /piped into a shell/);
});

test('compose: the secrets group, the one route out and the nginx template directory', () => {
  found(scratch((s) => s.text(COMPOSE, (t) => t.replace('  group_add:\n    - "${MACHVON_SECRETS_GID}"\n', ''))), 'COMPOSE_HARDENING', /secrets group/);
  found(scratch((s) => s.text(COMPOSE, (t) => t.replace('    networks: [app, data]\n    depends_on:\n      db:\n        condition: service_healthy\n      keycloak:', '    networks: [app, data, egress]\n    depends_on:\n      db:\n        condition: service_healthy\n      keycloak:'))), 'COMPOSE_PORTS', /api: only db, backup, keycloak/);
  found(scratch((s) => s.text(COMPOSE, (t) => t.replace('    networks: [data, egress]\n    entrypoint: ["/usr/local/bin/secret-env", "docker-entrypoint.sh"]', '    networks: [data]\n    entrypoint: ["/usr/local/bin/secret-env", "docker-entrypoint.sh"]'))), 'COMPOSE_PORTS', /db: only/);
  found(scratch((s) => s.text(COMPOSE, (t) => t.replace('        - subnet: 172.29.250.0/24\n', '        []\n'))), 'COMPOSE_PORTS', /fixed subnet/);
  found(scratch((s) => s.text(COMPOSE, (t) => t.replace('      - /etc/nginx/conf.d:size=1m,mode=1777\n', ''))), 'COMPOSE_HARDENING', /nginx configuration/);
});

test('TLS: only 1.2 and 1.3, only ECDHE suites without weak tokens, no session tickets, certificates as secret files, HTTP redirects', () => {
  found(scratch((s) => s.text(TLS, (t) => t.replace('TLSv1.2 TLSv1.3', 'TLSv1.1 TLSv1.2 TLSv1.3'))), 'TLS_PROTOCOLS', /TLSv1\.1/);
  found(scratch((s) => s.text(TLS, (t) => t.replace('ssl_protocols TLSv1.2 TLSv1.3;', 'ssl_protocols TLSv1.2;'))), 'TLS_PROTOCOLS');
  found(scratch((s) => s.text(TLS, (t) => t.replace('ECDHE-ECDSA-AES128-GCM-SHA256:', 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-RC4-SHA:'))), 'TLS_CIPHERS', /RC4/);
  found(scratch((s) => s.text(TLS, (t) => t.replace('ECDHE-ECDSA-AES128-GCM-SHA256:', 'AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:'))), 'TLS_CIPHERS', /ECDHE/);
  found(scratch((s) => s.text(TLS, (t) => t.replace('ssl_session_tickets off;', 'ssl_session_tickets on;'))), 'TLS_CIPHERS', /tickets/);
  found(scratch((s) => s.text(TLS, (t) => t.replace('/run/secrets/tls_key', '/etc/ssl/site.key'))), 'TLS_PROTOCOLS', /secret files/);
  found(scratch((s) => s.text(SITE, (t) => t.replace('return 301 https://${PUBLIC_HOST}$request_uri;', 'return 200;'))), 'TLS_PROTOCOLS', /redirect/);
});

test('headers: each required header with a strong value, in every location, and on every API response', () => {
  found(scratch((s) => s.text(HEADERS, (t) => t.replace(/add_header Strict-Transport-Security[^\n]*\n/, ''))), 'HEADERS_MISSING', /Strict-Transport-Security/);
  found(scratch((s) => s.text(HEADERS, (t) => t.replace('max-age=63072000', 'max-age=60'))), 'HEADERS_MISSING', /max-age 60/);
  found(scratch((s) => s.text(HEADERS, (t) => t.replace("frame-ancestors 'none'", "frame-ancestors 'self'"))), 'HEADERS_MISSING', /frame-ancestors/);
  found(scratch((s) => s.text(HEADERS, (t) => t.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"))), 'HEADERS_MISSING', /unsafe-inline/);
  found(scratch((s) => s.text(HEADERS, (t) => t.replace('"nosniff"', '"sniff"'))), 'HEADERS_MISSING', /nosniff/);
  found(scratch((s) => s.text(HEADERS, (t) => t.replace(/add_header X-Frame-Options[^\n]*\n/, ''))), 'HEADERS_MISSING', /X-Frame-Options/);
  found(scratch((s) => s.text(SITE, (t) => t.replace('server_tokens off;', 'server_tokens on;'))), 'HEADERS_MISSING', /server_tokens/);
  found(scratch((s) => s.text('infra/onprem/nginx/snippets/security-headers-passthrough.conf', (t) => t.replace(/add_header Strict-Transport-Security[^\n]*\n/, ''))), 'HEADERS_MISSING', /proxied/);
  found(scratch((s) => s.text(SITE, (t) => t.replace('location /assets/ {\n        include /etc/nginx/snippets/security-headers.conf;\n', 'location /assets/ {\n'))), 'HEADERS_LOCATION', /\/assets\//);
  found(scratch((s) => s.text(SITE, (t) => t.replace('        include /etc/nginx/snippets/proxy.conf;\n        include /etc/nginx/snippets/security-headers-passthrough.conf;\n        proxy_pass http://${API_UPSTREAM}/;', '        include /etc/nginx/snippets/proxy.conf;\n        proxy_pass http://${API_UPSTREAM}/;'))), 'HEADERS_LOCATION', /\/api\//);
  found(scratch((s) => s.text('apps/api/src/security/security-headers.ts', (t) => t.replace("  'referrer-policy': 'no-referrer',\n", ''))), 'HEADERS_API', /referrer-policy/);
  found(scratch((s) => s.text('apps/api/src/security/security-headers.ts', (t) => t.replace("frame-ancestors 'none'; ", ''))), 'HEADERS_API', /frame-ancestors/);
  found(scratch((s) => s.text('apps/api/src/bootstrap.ts', (t) => t.replace('securityHeaders()', 'noHeaders()'))), 'HEADERS_API', /bootstrap/);
});

test('identity: mandatory MFA, the lockout, assurance, sessions and the clients', () => {
  found(scratch((s) => s.json(REALM, (r) => { r.failureFactor = 10; })), 'MFA_POLICY', /5 failures/);
  found(scratch((s) => s.json(REALM, (r) => { r.permanentLockout = true; })), 'MFA_POLICY', /temporarily/);
  found(scratch((s) => s.json(REALM, (r) => { r.waitIncrementSeconds = 60; })), 'MFA_POLICY', /5 failures/);
  found(scratch((s) => s.json('infra/keycloak/realm-template.json', (r) => { r.bruteForce.maxDeltaTimeSeconds = 600; })), 'MFA_POLICY', /realm-template/);
  found(scratch((s) => s.json(REALM, (r) => { r.sslRequired = 'external'; })), 'MFA_POLICY', /TLS required/);
  found(scratch((s) => s.json(REALM, (r) => { r.registrationAllowed = true; })), 'MFA_POLICY', /no registration/);
  found(scratch((s) => s.json(REALM, (r) => { r.otpPolicyType = 'hotp'; })), 'MFA_POLICY', /TOTP/);
  found(scratch((s) => s.json(REALM, (r) => { r.otpPolicyCodeReusable = true; })), 'MFA_POLICY', /not reusable/);
  found(scratch((s) => s.json(REALM, (r) => { r.webAuthnPolicyUserVerificationRequirement = 'preferred'; })), 'MFA_POLICY', /user verification/);
  found(scratch((s) => s.json(REALM, (r) => { r.requiredActions[0].defaultAction = false; })), 'MFA_POLICY', /CONFIGURE_TOTP/);
  found(scratch((s) => s.json(REALM, (r) => { r.browserFlow = 'browser'; })), 'MFA_POLICY', /browserFlow/);
  found(scratch((s) => s.json(REALM, (r) => { for (const flow of r.authenticationFlows) flow.authenticationExecutions = flow.authenticationExecutions.filter((e) => e.authenticator !== 'auth-otp-form'); })), 'MFA_POLICY', /auth-otp-form/);
  found(scratch((s) => s.json(REALM, (r) => { for (const flow of r.authenticationFlows) flow.authenticationExecutions = flow.authenticationExecutions.filter((e) => e.authenticator !== 'webauthn-authenticator'); })), 'MFA_POLICY', /webauthn-authenticator/);
  found(scratch((s) => s.json(REALM, (r) => { for (const flow of r.authenticationFlows) for (const e of flow.authenticationExecutions) if (e.authenticator === 'auth-username-password-form') e.requirement = 'ALTERNATIVE'; })), 'MFA_POLICY', /password form must be REQUIRED/);
  found(scratch((s) => s.json(REALM, (r) => { r.authenticatorConfig = r.authenticatorConfig.filter((c) => c.config['loa-condition-level'] !== '2'); })), 'MFA_POLICY', /level 2/);
  found(scratch((s) => s.json(REALM, (r) => { r.authenticatorConfig = r.authenticatorConfig.filter((c) => c.config.negate !== 'false'); })), 'MFA_POLICY', /WebAuthn-only branch/);
  found(scratch((s) => s.json(REALM, (r) => { r.attributes['acr.loa.map'] = '{}'; })), 'MFA_POLICY', /acr\.loa\.map/);
  found(scratch((s) => s.json(REALM, (r) => { r.refreshTokenMaxReuse = 2; })), 'MFA_POLICY', /rotate/);
  found(scratch((s) => s.json(REALM, (r) => { r.clients[0].implicitFlowEnabled = true; })), 'MFA_POLICY', /machvon-web/);
  found(scratch((s) => s.json(REALM, (r) => { delete r.clients[1].attributes['pkce.code.challenge.method']; })), 'MFA_POLICY', /machvon-control/);
  found(scratch((s) => s.json(REALM, (r) => { r.clients[2].attributes['minimum.acr.value'] = 'aal1'; })), 'MFA_POLICY', /machvon-mobile: minimum/);
  found(scratch((s) => s.json(REALM, (r) => { r.clients[0].redirectUris = ['https://x.example/*']; })), 'MFA_POLICY', /redirect/);
  found(scratch((s) => s.json(REALM, (r) => { r.clients[0].protocolMappers[0].config['included.client.audience'] = 'machvon-control'; })), 'MFA_POLICY', /own audience/);
});

test('federation: every connection value is a placeholder, the federation is read-only and trusts the configured truststore', () => {
  const config = (r) => r.components['org.keycloak.storage.UserStorageProvider'][0].config;
  found(scratch((s) => s.json(REALM, (r) => { config(r).bindCredential = ['Passw0rd!']; })), 'FEDERATION_PLACEHOLDER', /bindCredential/);
  found(scratch((s) => s.json(REALM, (r) => { config(r).bindDn = ['CN=svc,DC=example,DC=vn']; })), 'FEDERATION_PLACEHOLDER', /bindDn/);
  found(scratch((s) => s.json(REALM, (r) => { config(r).connectionUrl = ['ldaps://ad.example.vn:636']; })), 'FEDERATION_PLACEHOLDER', /connectionUrl/);
  found(scratch((s) => s.json(REALM, (r) => { config(r).editMode = ['WRITABLE']; })), 'FEDERATION_PLACEHOLDER', /READ_ONLY/);
  found(scratch((s) => s.json(REALM, (r) => { config(r).useTruststoreSpi = ['never']; })), 'FEDERATION_PLACEHOLDER', /truststore/);
  found(scratch((s) => s.json(REALM, (r) => { delete r.components; })), 'FEDERATION_PLACEHOLDER', /no LDAP/);
});

test('the directory group to role map and the realm agree, and only the filtered groups are imported', () => {
  found(scratch((s) => s.json(MAP, (m) => { m.groupFilter = '(objectClass=group)'; })), 'ROLE_MAP', /groupFilter/);
  found(scratch((s) => s.json(MAP, (m) => { m.groupFilter = '(cn=MACHVON-X*)'; })), 'ROLE_MAP', /group mapper filter/);
  found(scratch((s) => s.json(MAP, (m) => { m.mappings[0].roles = ['SystemAdmin', 'Ghost']; })), 'ROLE_MAP', /Ghost/);
  found(scratch((s) => s.json(MAP, (m) => { m.mappings[1].adGroup = 'OTHER-OPERATORS'; })), 'ROLE_MAP', /OTHER-OPERATORS/);
  found(scratch((s) => s.json(REALM, (r) => { r.groups[0].realmRoles = ['mfa-webauthn-required']; })), 'ROLE_MAP', /does not grant SystemAdmin/);
  found(scratch((s) => s.json(REALM, (r) => { r.groups[1].realmRoles = ['PlatformOperator']; })), 'ROLE_MAP', /must also grant mfa-webauthn-required/);
  found(scratch((s) => s.json(REALM, (r) => { r.groups[2].realmRoles.push('SystemAdmin'); })), 'ROLE_MAP', /grants a role the map does not state/);
  found(scratch((s) => s.json(REALM, (r) => { r.groups.push({ name: 'MACHVON-EXTRA', path: '/MACHVON-EXTRA', realmRoles: [] }); })), 'ROLE_MAP', /MACHVON-EXTRA is not in the map/);
  found(scratch((s) => s.json(MAP, (m) => { m.mappings = m.mappings.slice(1); })), 'ROLE_MAP', /SystemAdmin has no directory group|MACHVON-SYSTEM-ADMINS/);
  found(scratch((s) => s.remove(MAP)), 'ARTEFACT_MISSING', /ad-group-role-map/);
});

test('the directory groups of a tenant pack stay inside the import filter and grant no realm role (ENT-3d)', () => {
  const groups = JSON.parse(readFileSync(join(REPO_ROOT, MAP), 'utf8')).tenantMappings;
  assert.ok(groups.length >= 20, 'the real map carries the groups of the PVFCCo template pack');
  found(scratch((s) => s.json(MAP, (m) => { m.tenantMappings[0].adGroup = 'OTHER-GROUP'; })), 'ROLE_MAP', /not a MACHVON- group/);
  found(scratch((s) => s.json(MAP, (m) => { m.tenantMappings[1].adGroup = m.tenantMappings[0].adGroup; })), 'ROLE_MAP', /named twice/);
  found(scratch((s) => s.json(MAP, (m) => { m.tenantMappings[0].adGroup = 'MACHVON-SYSTEM-ADMINS'; })), 'ROLE_MAP', /also a control-plane group/);
  found(scratch((s) => s.json(MAP, (m) => { m.tenantMappings[0].tenantRole = 'SystemAdmin'; })), 'ROLE_MAP', /names no tenant role/);
  found(scratch((s) => s.json(MAP, (m) => { m.tenantMappings[0].scopeKind = 'PROJECT'; })), 'ROLE_MAP', /scope a seat cannot have/);
  found(scratch((s) => s.json(MAP, (m) => { m.tenantMappings[0].unit = 'not a unit'; })), 'ROLE_MAP', /names no unit/);
  found(scratch((s) => s.json(MAP, (m) => { m.tenantMappings = 'x'; })), 'ROLE_MAP', /must be a list/);
  found(scratch((s) => s.json(REALM, (r) => { r.groups.push({ name: groups[0].adGroup, path: '/' + groups[0].adGroup, realmRoles: ['mfa-webauthn-required'] }); })), 'ROLE_MAP', /group of the realm; a tenant group grants no realm role/);
});

test('backups: the weakening of the policy is reported through the backup verifier', () => {
  found(scratch((s) => s.json('infra/backup/backup-policy.json', (p) => { p.immutability.objectLock.mode = 'GOVERNANCE'; })), 'BACKUP_POLICY_VIOLATION', /BACKUP_IMMUTABLE/);
  found(scratch((s) => s.json('infra/backup/backup-policy.json', (p) => { p.targets.rtoHours = 12; })), 'BACKUP_POLICY_VIOLATION', /BACKUP_TARGETS/);
  found(scratch((s) => s.text('infra/onprem/config/pgbackrest.conf', (t) => t.replace('aes-256-cbc', 'none'))), 'BACKUP_POLICY_VIOLATION', /BACKUP_ENCRYPTION/);
});

test('native dependencies: a gap that is not acknowledged is reported', () => {
  found(scratch((s) => s.json('infra/onprem/native-deps.json', (p) => { p.acknowledged = []; })), 'NATIVE_DEPS', /NATIVE_NO_ARM64_UNACKNOWLEDGED/);
});

test('scanning workflows: CodeQL with the extended queries, a secret scan of the history, a Trivy policy on every image, DAST, and the ARM leg', () => {
  found(scratch((s) => s.text('.github/workflows/security.yml', (t) => t.replace('queries: security-extended', 'queries: default'))), 'SCAN_WORKFLOW', /CodeQL/);
  found(scratch((s) => s.text('.github/workflows/security.yml', (t) => t.replace('language: [javascript-typescript, actions]', 'language: [actions]'))), 'SCAN_WORKFLOW', /javascript-typescript/);
  found(scratch((s) => s.text('.github/workflows/security.yml', (t) => t.replace('fetch-depth: 0', 'fetch-depth: 1'))), 'SCAN_WORKFLOW', /whole history/);
  found(scratch((s) => s.remove('.gitleaks.toml')), 'ARTEFACT_MISSING', /gitleaks/);
  found(scratch((s) => s.text('.github/workflows/images.yml', (t) => t.replace('--config infra/scan/trivy.yaml machvon/', 'machvon/'))), 'SCAN_WORKFLOW', /Trivy policy/);
  found(scratch((s) => s.text('.github/workflows/images.yml', (t) => t.replace('runner: ubuntu-24.04-arm', 'runner: ubuntu-24.04'))), 'SCAN_WORKFLOW', /natively on ubuntu-24\.04-arm/);
  found(scratch((s) => s.text('.github/workflows/dast.yml', (t) => t.replace(/zap-api-scan\.py/g, 'echo'))), 'SCAN_WORKFLOW', /job api/);
  found(scratch((s) => s.text('.github/workflows/dast.yml', (t) => t.replace(/rules\.tsv/g, 'other.tsv'))), 'SCAN_WORKFLOW', /job baseline/);
  found(scratch((s) => s.remove('.github/workflows/security.yml')), 'ARTEFACT_MISSING', /security\.yml/);
  found(scratch((s) => s.text('infra/scan/trivy.yaml', (t) => t.replace(/ {2}- HIGH\n/, ''))), 'SCAN_WORKFLOW', /Trivy policy must fail/);
  found(scratch((s) => s.text('infra/scan/trivy.yaml', (t) => t.replace('exit-code: 1', 'exit-code: 0'))), 'SCAN_WORKFLOW', /Trivy policy must fail/);
  found(scratch((s) => s.json('supply-chain.json', (p) => { delete p.imageScan; })), 'SCAN_WORKFLOW', /imageScan/);
});

test('the ARM leg: a job on ubuntu-24.04-arm that checks native dependencies and runs the unit tests', () => {
  found(scratch((s) => s.text('.github/workflows/ci.yml', (t) => t.replace('runs-on: ubuntu-24.04-arm', 'runs-on: ubuntu-latest'))), 'ARM_LEG_MISSING', /ubuntu-24\.04-arm/);
  found(scratch((s) => s.text('.github/workflows/ci.yml', (t) => t.replace('arm64:\n    name: ARM64 build and unit tests', 'arm64-removed:\n    name: ARM64 build and unit tests'))), 'ARM_LEG_MISSING', /job arm64/);
  found(scratch((s) => s.text('.github/workflows/ci.yml', (t) => t.replace('npm run native-deps:check -- --list --locale en', 'echo skipped'))), 'ARM_LEG_MISSING', /native-deps:check/);
  found(scratch((s) => s.text('.github/workflows/ci.yml', (t) => t.replace('          npm run typecheck\n          npm test\n\n      - name: Web build', '          npm run typecheck\n\n      - name: Web build'))), 'ARM_LEG_MISSING', /npm test/);
});

test('infra:check reports the artefact findings in both languages, and every code has a message', () => {
  for (const locale of ['vi', 'en']) {
    const messages = loadOnpremMessages(locale);
    for (const code of ARTEFACT_FINDING_CODES) assert.ok(messages[`infra.${code}`], `${locale}: ${code}`);
  }
  assert.deepEqual(Object.keys(loadOnpremMessages('vi')).sort(), Object.keys(loadOnpremMessages('en')).sort());
  const s = scratch((api) => api.text(COMPOSE, (t) => t.replace(/ {10}cpus: "\$\{API_CPUS\}"\n/, '')));
  assert.ok(infraCheck(s.root).findings.some((entry) => entry.code === 'COMPOSE_LIMITS'));
  for (const locale of ['en', 'vi']) {
    const lines = [];
    assert.equal(main(['--root', s.root, '--locale', locale], { log: (line) => lines.push(line) }), 1);
    assert.ok(lines.some((line) => line.startsWith('infra/onprem/compose/compose.yaml:') && line.includes('api')), lines.join('\n'));
  }
});

/** The repository paths a document names between backticks must exist: a runbook that points at a file that is gone is a broken runbook. */
function namedPaths(text) {
  const roots = ['apps/', 'packages/', 'scripts/', 'infra/', 'docs/', '.github/', 'Design/', '.zap/'];
  return [...text.matchAll(/`([^`\s]+)`/g)]
    .map((match) => match[1].replace(/[.,;:]+$/, ''))
    .filter((token) => roots.some((root) => token.startsWith(root)) && !/[<>*${}|()[\]]/.test(token) && !token.includes('://'));
}

test('the paths named by the runbooks and the security documents exist', () => {
  const documents = ['docs/security/pentest-readiness.md', 'docs/security/identity-test-plan.md', ...['onprem-install', 'onprem-upgrade-rollback', 'backup-immutable', 'restore-drill', 'tls-headers', 'security-scanning', 'keycloak', 'README'].map((name) => `docs/runbooks/infra/${name}.md`)];
  const missing = [];
  for (const document of documents) {
    for (const path of new Set(namedPaths(readFileSync(join(REPO_ROOT, document), 'utf8')))) {
      // A path with a trailing slash names a directory; evidence files are written by people after a real drill; the .env is made by the operator from the template.
      if (!existsSync(join(REPO_ROOT, path)) && !path.startsWith('docs/runbooks/infra/evidence') && path !== 'infra/onprem/compose/.env') missing.push(`${document}: ${path}`);
    }
  }
  assert.deepEqual(missing, []);
});
