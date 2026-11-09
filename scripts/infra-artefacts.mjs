import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { checkBackupPolicy } from './backup-verify.mjs';
import { checkNativeDeps } from './native-deps-check.mjs';
import { checkEgressScript, checkMalwareScan, checkRansomwareCatalogue, checkRealmImport } from './infra-security.mjs';

const POLICY_FILE = 'infra/policies/artefacts.json';
const DIGEST = /@sha256:[0-9a-f]{64}$/;
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const URL_CREDENTIALS = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@$]+:[^@\s/$]+@/i;
const SECRET_PLACEHOLDER = /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::[?-][^}]*)?\}$/;
const SECRET_FILE_PATH = /^\/run\/secrets\/[a-z0-9_]+$/;
const VALUE_OPTIONS = new Set(['-v', '--volume', '-w', '--workdir', '-e', '--env', '-u', '--user', '--name', '--entrypoint', '--network', '--platform', '-p', '--publish']);

export const ARTEFACT_FINDING_CODES = [
  'ARTEFACT_MISSING',
  'IMAGE_FLOATING',
  'IMAGE_DIGEST_MISSING',
  'IMAGE_PIN_DRIFT',
  'IMAGE_ARCH',
  'ARM_LEG_MISSING',
  'COMPOSE_INVALID',
  'COMPOSE_HEALTHCHECK',
  'COMPOSE_LIMITS',
  'COMPOSE_HARDENING',
  'COMPOSE_PORTS',
  'SECRET_LITERAL',
  'SECRET_LIST_DRIFT',
  'DOCKERFILE_RULE',
  'TLS_PROTOCOLS',
  'TLS_CIPHERS',
  'HEADERS_MISSING',
  'HEADERS_LOCATION',
  'HEADERS_API',
  'MFA_POLICY',
  'FEDERATION_PLACEHOLDER',
  'ROLE_MAP',
  'BACKUP_POLICY_VIOLATION',
  'SCAN_WORKFLOW',
  'WORKFLOW_FLOATING_ACTION',
  'NATIVE_DEPS',
  'MALWARE_SCAN',
  'EGRESS_RULES',
  'RANSOMWARE_CATALOGUE',
  'REALM_IMPORT',
];

const finding = (code, file, detail = '') => ({ code, file, detail });
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function readText(root, path) {
  const file = join(root, path);
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
}

function readJson(root, path) {
  const text = readText(root, path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** js-yaml is a development dependency: where it is not installed (the deploy preflight installs nothing) the checks that read YAML are skipped, never failed. */
function yamlParser() {
  try {
    return createRequire(import.meta.url)('js-yaml');
  } catch {
    return undefined;
  }
}

function parseYaml(yaml, text) {
  try {
    return yaml.load(text);
  } catch {
    return undefined;
  }
}

const canonicalName = (name) => name.replace(/^docker\.io\//, '').replace(/^library\//, '');

/** The pieces of an image reference: `registry/name`, tag, digest. */
export function splitImage(reference) {
  const digest = DIGEST.exec(reference)?.[0].slice(1);
  const rest = digest === undefined ? reference : reference.slice(0, -digest.length - 1);
  const slash = rest.lastIndexOf('/');
  const colon = rest.lastIndexOf(':');
  const tag = colon > slash ? rest.slice(colon + 1) : undefined;
  return { name: tag === undefined ? rest : rest.slice(0, colon), tag, digest };
}

/** Judges one image reference: a floating or missing tag, and (for a third-party image) a missing digest. `first-party` images carry the release version variable. */
function judgeImage(reference, { file, policy, firstParty }, findings) {
  if (typeof reference !== 'string' || reference === '') return;
  const versioned = new RegExp(`:\\$\\{${policy.images.productVersionVariable}:\\?[^}]*\\}$`).test(reference);
  if (firstParty) {
    if (!versioned) findings.push(finding('IMAGE_FLOATING', file, `${reference}: a product image must be tagged :\${${policy.images.productVersionVariable}:?...} (required, no default)`));
    return;
  }
  const { tag, digest } = splitImage(reference);
  if (tag === undefined || policy.images.floatingTags.includes(tag.toLowerCase())) findings.push(finding('IMAGE_FLOATING', file, reference));
  else if (digest === undefined) findings.push(finding('IMAGE_DIGEST_MISSING', file, reference));
}

/** The base images of a Dockerfile: the references after FROM that are not an earlier stage, a variable or scratch. */
export function dockerfileImages(text) {
  const stages = new Set();
  const images = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*FROM\s+((?:--\S+\s+)*)(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (match === null) continue;
    const [, options, reference, alias] = match;
    if (alias !== undefined) stages.add(alias.toLowerCase());
    if (reference.toLowerCase() === 'scratch' || reference.includes('$') || stages.has(reference.toLowerCase())) continue;
    images.push({ reference, options: options.trim() });
  }
  return images;
}

/** The images that `docker run` commands of a workflow start: the first argument that is not an option or the value of one. */
export function workflowDockerImages(text) {
  const found = [];
  const joined = text.replace(/\\\r?\n\s*/g, ' ');
  for (const line of joined.split(/\r?\n/)) {
    const at = line.indexOf('docker run');
    if (at === -1) continue;
    const tokens = line.slice(at + 'docker run'.length).trim().split(/\s+/);
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token.startsWith('-')) {
        if (VALUE_OPTIONS.has(token)) index += 1;
        continue;
      }
      if (token.startsWith('"') || token.startsWith('$') || token.startsWith("'")) continue;
      found.push(token);
      break;
    }
  }
  return found;
}

function checkRequired(root, policy, findings) {
  for (const path of [...policy.required, ...policy.repositoryRequired]) {
    if (!existsSync(join(root, path))) findings.push(finding('ARTEFACT_MISSING', path));
  }
}

function checkImages(root, policy, yaml, findings) {
  const images = readJson(root, 'infra/onprem/images.json');
  const pins = new Map();
  if (images !== undefined) {
    const platforms = Array.isArray(images.platforms) ? images.platforms : [];
    for (const platform of policy.images.platforms) if (!platforms.includes(platform)) findings.push(finding('IMAGE_ARCH', 'infra/onprem/images.json', `no ${platform}`));
    for (const image of images.thirdParty ?? []) {
      judgeImage(`${image.reference}:${image.tag}${typeof image.digest === 'string' ? `@${image.digest}` : ''}`, { file: 'infra/onprem/images.json', policy }, findings);
      pins.set(`${canonicalName(image.reference)}:${image.tag}`, image.digest);
    }
  }
  const dockerDir = 'infra/onprem/docker';
  const dockerfiles = existsSync(join(root, dockerDir)) ? readdirSync(join(root, dockerDir)).filter((name) => name.endsWith('.Dockerfile')) : [];
  for (const name of dockerfiles) {
    const file = `${dockerDir}/${name}`;
    for (const { reference, options } of dockerfileImages(readText(root, file))) {
      judgeImage(reference, { file, policy }, findings);
      if (/--platform=/.test(options)) findings.push(finding('IMAGE_ARCH', file, `${reference}: a stage pinned to one platform (${options})`));
      const { name: base, tag, digest } = splitImage(reference);
      const known = pins.get(`${canonicalName(base)}:${tag}`);
      if (images !== undefined && tag !== undefined && (known === undefined || known !== digest)) findings.push(finding('IMAGE_PIN_DRIFT', file, `${reference} is not the pin of infra/onprem/images.json`));
    }
  }
  if (yaml !== undefined) {
    const compose = parseYaml(yaml, readText(root, policy.compose.file) ?? '');
    for (const [service, definition] of Object.entries(compose?.services ?? {})) {
      const reference = definition?.image;
      const firstParty = typeof reference === 'string' && reference.startsWith('machvon/');
      judgeImage(reference, { file: policy.compose.file, policy, firstParty }, findings);
      if (!firstParty && typeof reference === 'string' && images !== undefined) {
        const { name, tag, digest } = splitImage(reference);
        const known = pins.get(`${canonicalName(name)}:${tag}`);
        if (known === undefined || known !== digest) findings.push(finding('IMAGE_PIN_DRIFT', policy.compose.file, `${service}: ${reference} is not the pin of infra/onprem/images.json`));
      }
    }
  }
}

function secretKey(policy) {
  return new RegExp(policy.compose.secretNamePattern, 'i');
}

function checkCompose(root, policy, yaml, findings) {
  const file = policy.compose.file;
  const text = readText(root, file);
  if (text === undefined) return;
  if (PEM.test(text) || URL_CREDENTIALS.test(text)) findings.push(finding('SECRET_LITERAL', file, 'a key or a URL with credentials is written in the file'));
  if (yaml === undefined) return;
  const compose = parseYaml(yaml, text);
  if (!isObject(compose) || !isObject(compose.services)) {
    findings.push(finding('COMPOSE_INVALID', file, 'the file is not a compose document'));
    return;
  }
  const secrets = Object.keys(compose.secrets ?? {});
  const declared = readJson(root, 'infra/onprem/secrets.json')?.secrets?.map((entry) => entry.name) ?? [];
  for (const [name, secret] of Object.entries(compose.secrets ?? {})) {
    if (!isObject(secret) || typeof secret.file !== 'string' || !/^\$\{MACHVON_SECRETS_DIR\}\/[a-z0-9_]+$/.test(secret.file)) findings.push(finding('SECRET_LITERAL', file, `secret ${name} must be a file under \${MACHVON_SECRETS_DIR}`));
  }
  for (const name of secrets) if (!declared.includes(name)) findings.push(finding('SECRET_LIST_DRIFT', file, `${name} is a compose secret that infra/onprem/secrets.json does not list`));
  for (const name of declared) if (!secrets.includes(name)) findings.push(finding('SECRET_LIST_DRIFT', 'infra/onprem/secrets.json', `${name} is listed but the compose file has no such secret`));
  const pattern = secretKey(policy);
  const used = new Set();
  for (const [service, definition] of Object.entries(compose.services)) {
    const tools = Array.isArray(definition.profiles) && definition.profiles.includes(policy.compose.toolsProfile);
    const environment = isObject(definition.environment) ? definition.environment : {};
    for (const [key, raw] of Object.entries(environment)) {
      const value = String(raw);
      const isFileVariable = key.endsWith('_FILE') || key.endsWith('_PATH');
      if (isFileVariable) {
        if (key.endsWith('_FILE') && !SECRET_FILE_PATH.test(value)) findings.push(finding('SECRET_LITERAL', file, `${service}.${key} must name a /run/secrets file`));
        const name = /\/run\/secrets\/([a-z0-9_]+)$/.exec(value)?.[1];
        if (name !== undefined) {
          used.add(name);
          if (!secrets.includes(name) || !(definition.secrets ?? []).includes(name)) findings.push(finding('SECRET_LIST_DRIFT', file, `${service} reads /run/secrets/${name} but the service is not given that secret`));
        }
      } else if (pattern.test(key) && value !== '' && !SECRET_PLACEHOLDER.test(value)) findings.push(finding('SECRET_LITERAL', file, `${service}.${key}`));
      if (PEM.test(value) || URL_CREDENTIALS.test(value)) findings.push(finding('SECRET_LITERAL', file, `${service}.${key}`));
    }
    if (!tools) {
      if (!isObject(definition.healthcheck) || !Array.isArray(definition.healthcheck.test)) findings.push(finding('COMPOSE_HEALTHCHECK', file, service));
    }
    const limits = definition.deploy?.resources?.limits;
    if (!isObject(limits) || limits.cpus === undefined || limits.memory === undefined) findings.push(finding('COMPOSE_LIMITS', file, service));
    if (!(definition.security_opt ?? []).includes('no-new-privileges:true') || !(definition.cap_drop ?? []).includes('ALL')) findings.push(finding('COMPOSE_HARDENING', file, service));
    const groupVariable = `\${${policy.compose.secretsGroupVariable}}`;
    if ((definition.secrets ?? []).length > 0 && !(definition.group_add ?? []).map(String).includes(groupVariable)) findings.push(finding('COMPOSE_HARDENING', file, `${service} reads secret files but does not join the secrets group (group_add ${groupVariable}): its user cannot read them`));
    const egress = policy.compose.egress;
    if ((definition.networks ?? []).includes(egress.network) !== egress.services.includes(service)) findings.push(finding('COMPOSE_PORTS', file, `${service}: only ${egress.services.join(', ')} may join the ${egress.network} network (the one route out)`));
    if (service === 'web' && definition.read_only === true && !(definition.tmpfs ?? []).some((entry) => String(entry).startsWith(`${policy.compose.webTemplateDirectory}:`))) findings.push(finding('COMPOSE_HARDENING', file, `web renders its nginx configuration at start: ${policy.compose.webTemplateDirectory} must be a tmpfs when the root is read-only`));
    const publishes = Array.isArray(definition.ports) && definition.ports.length > 0;
    if (publishes && !policy.compose.publishingServices.includes(service)) findings.push(finding('COMPOSE_PORTS', file, `${service} publishes a port`));
    if (!publishes && policy.compose.publishingServices.includes(service)) findings.push(finding('COMPOSE_PORTS', file, `${service} must publish the edge ports`));
  }
  for (const name of ['app', 'data']) if (compose.networks?.[name]?.internal !== true) findings.push(finding('COMPOSE_PORTS', file, `network ${name} must be internal`));
  const egressNetwork = compose.networks?.[policy.compose.egress.network];
  if (egressNetwork === undefined || egressNetwork.internal === true || !(egressNetwork.ipam?.config ?? []).some((entry) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(String(entry.subnet)))) findings.push(finding('COMPOSE_PORTS', file, `network ${policy.compose.egress.network} must exist with a fixed subnet so that the host firewall can limit it (infra/onprem/config/egress-firewall.sh)`));
  for (const name of secrets) if (!used.has(name) && !Object.values(compose.services).some((service) => (service.secrets ?? []).includes(name))) findings.push(finding('SECRET_LIST_DRIFT', file, `${name} is declared but no service uses it`));

  const env = readText(root, 'infra/onprem/compose/env.template');
  if (env !== undefined) {
    for (const line of env.split(/\r?\n/)) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (match === null) continue;
      if (pattern.test(match[1]) && match[2] !== '') findings.push(finding('SECRET_LITERAL', 'infra/onprem/compose/env.template', match[1]));
      if (URL_CREDENTIALS.test(match[2]) || /^(latest|stable)$/.test(match[2])) findings.push(finding('SECRET_LITERAL', 'infra/onprem/compose/env.template', match[1]));
    }
  }
}

function checkDockerfiles(root, policy, findings) {
  const dir = 'infra/onprem/docker';
  for (const name of policy.dockerfiles.healthcheckRequired) {
    const file = `${dir}/${name}.Dockerfile`;
    const text = readText(root, file);
    if (text === undefined) continue;
    if (!/^HEALTHCHECK\s/m.test(text)) findings.push(finding('DOCKERFILE_RULE', file, 'HEALTHCHECK is required'));
    if (/^ADD\s+https?:/m.test(text) || /curl[^\n]*\|\s*(?:ba)?sh/.test(text)) findings.push(finding('DOCKERFILE_RULE', file, 'no download piped into a shell and no ADD from a URL'));
    if (/^ENV\s+[^\n]*(PASSWORD|SECRET|TOKEN|PRIVATE_KEY)\s*=/im.test(text)) findings.push(finding('DOCKERFILE_RULE', file, 'no secret in ENV'));
    if (policy.dockerfiles.nonRootRequired.includes(name)) {
      const users = [...text.matchAll(/^USER\s+(\S+)/gm)].map((match) => match[1]);
      if (users.length === 0 || ['root', '0'].includes(users[users.length - 1])) findings.push(finding('DOCKERFILE_RULE', file, 'the image must run as a non-root user'));
    }
    const flat = text.replace(/\\\r?\n/g, ' ');
    if (policy.dockerfiles.productionInstall.images.includes(name)) {
      const missing = policy.dockerfiles.productionInstall.mustContain.filter((needle) => !flat.includes(needle));
      if (missing.length > 0 || /--omit=optional/.test(flat)) findings.push(finding('DOCKERFILE_RULE', file, `production dependencies only, with the optional platform binaries kept (@swc/core needs one): ${policy.dockerfiles.productionInstall.mustContain.join(' and ')}; not --omit=optional`));
    }
    const copies = flat.split('\n').filter((line) => /^\s*COPY\s/.test(line));
    for (const needle of policy.dockerfiles.requiredCopies[name] ?? []) if (!copies.some((line) => line.includes(needle))) findings.push(finding('DOCKERFILE_RULE', file, `the image must carry ${needle} (the migration job and the API read it)`));
  }
}

/** What the images need beyond their files: a PostgreSQL package for each extension the migrations create, and the runtime dependencies of the loader that starts the API. */
function checkRuntimeNeeds(root, policy, findings) {
  const migration = readText(root, 'db/migrations/V001__roles_and_grants.sql');
  const database = readText(root, 'infra/onprem/docker/db.Dockerfile');
  if (migration !== undefined && database !== undefined) {
    for (const match of migration.matchAll(/CREATE EXTENSION IF NOT EXISTS (\w+)/g)) {
      const needed = policy.dockerfiles.extensionPackages[match[1]];
      const installs = database.replace(/\\\r?\n/g, ' ').split('\n').filter((line) => /apt-get install/.test(line));
      if (needed !== undefined && !installs.some((line) => line.includes(needed))) findings.push(finding('DOCKERFILE_RULE', 'infra/onprem/docker/db.Dockerfile', `the migrations create the ${match[1]} extension: the image must install ${needed}`));
    }
  }
  for (const rule of policy.dockerfiles.runtimeDependencies) {
    const loader = readText(root, rule.loader);
    const manifest = readJson(root, rule.manifest);
    if (loader === undefined || manifest === undefined) continue;
    for (const name of rule.imports) if (loader.includes(`'${name}'`) && manifest.dependencies?.[name] === undefined) findings.push(finding('DOCKERFILE_RULE', rule.manifest, `${rule.loader} imports ${name} at start: it must be a dependency, not a dev dependency, or the production image cannot start`));
  }
}

function directives(text, name) {
  return [...text.matchAll(new RegExp(`^\\s*${name}\\s+([^;]+);`, 'gm'))].map((match) => match[1].trim());
}

function checkEdge(root, policy, findings) {
  const tls = readText(root, 'infra/onprem/nginx/snippets/tls.conf');
  const headers = readText(root, 'infra/onprem/nginx/snippets/security-headers.conf');
  const passthrough = readText(root, 'infra/onprem/nginx/snippets/security-headers-passthrough.conf') ?? '';
  const site = readText(root, 'infra/onprem/nginx/default.conf.template');
  if (tls !== undefined) {
    const protocols = (directives(tls, 'ssl_protocols')[0] ?? '').split(/\s+/).filter(Boolean);
    if (protocols.length === 0 || protocols.some((protocol) => !policy.tls.protocols.includes(protocol)) || !policy.tls.protocols.every((protocol) => protocols.includes(protocol))) findings.push(finding('TLS_PROTOCOLS', 'infra/onprem/nginx/snippets/tls.conf', protocols.join(' ') || 'none'));
    const ciphers = directives(tls, 'ssl_ciphers')[0] ?? '';
    const weak = policy.tls.forbiddenCipherTokens.filter((token) => ciphers.toUpperCase().includes(token.toUpperCase()));
    if (ciphers === '' || weak.length > 0 || ciphers.split(':').some((suite) => !suite.startsWith('ECDHE-'))) findings.push(finding('TLS_CIPHERS', 'infra/onprem/nginx/snippets/tls.conf', weak.join(', ') || 'only ECDHE suites are allowed'));
    if (directives(tls, 'ssl_session_tickets')[0] !== 'off') findings.push(finding('TLS_CIPHERS', 'infra/onprem/nginx/snippets/tls.conf', 'ssl_session_tickets must be off'));
    if (!/\/run\/secrets\/tls_cert/.test(tls) || !/\/run\/secrets\/tls_key/.test(tls)) findings.push(finding('TLS_PROTOCOLS', 'infra/onprem/nginx/snippets/tls.conf', 'the certificate and key must be secret files'));
  }
  if (headers !== undefined) {
    const present = new Map([...headers.matchAll(/^\s*add_header\s+([A-Za-z-]+)\s+"([^"]*)"/gm)].map((match) => [match[1].toLowerCase(), match[2]]));
    for (const name of policy.headers.web) if (!present.has(name.toLowerCase())) findings.push(finding('HEADERS_MISSING', 'infra/onprem/nginx/snippets/security-headers.conf', name));
    const hsts = Number(/max-age=(\d+)/.exec(present.get('strict-transport-security') ?? '')?.[1] ?? 0);
    if (hsts < policy.tls.minHstsSeconds) findings.push(finding('HEADERS_MISSING', 'infra/onprem/nginx/snippets/security-headers.conf', `Strict-Transport-Security max-age ${hsts} is below ${policy.tls.minHstsSeconds}`));
    const csp = present.get('content-security-policy') ?? '';
    for (const directive of policy.headers.contentSecurityPolicy) if (!csp.includes(directive)) findings.push(finding('HEADERS_MISSING', 'infra/onprem/nginx/snippets/security-headers.conf', `Content-Security-Policy lacks ${directive}`));
    if (/script-src[^;]*'unsafe-(inline|eval)'/.test(csp)) findings.push(finding('HEADERS_MISSING', 'infra/onprem/nginx/snippets/security-headers.conf', "script-src must not allow 'unsafe-inline' or 'unsafe-eval'"));
    if (present.get('x-content-type-options') !== 'nosniff') findings.push(finding('HEADERS_MISSING', 'infra/onprem/nginx/snippets/security-headers.conf', 'X-Content-Type-Options must be nosniff'));
    if (!/DENY|SAMEORIGIN/.test(present.get('x-frame-options') ?? '')) findings.push(finding('HEADERS_MISSING', 'infra/onprem/nginx/snippets/security-headers.conf', 'X-Frame-Options'));
  }
  if (!/^\s*add_header\s+Strict-Transport-Security/m.test(passthrough) || !/nosniff/.test(passthrough)) findings.push(finding('HEADERS_MISSING', 'infra/onprem/nginx/snippets/security-headers-passthrough.conf', 'the proxied locations still need HSTS and nosniff'));
  if (site !== undefined) {
    if (directives(site, 'server_tokens')[0] !== 'off') findings.push(finding('HEADERS_MISSING', 'infra/onprem/nginx/default.conf.template', 'server_tokens must be off'));
    if (!/return 301 https:\/\//.test(site)) findings.push(finding('TLS_PROTOCOLS', 'infra/onprem/nginx/default.conf.template', 'plain HTTP must redirect to HTTPS'));
    for (const match of site.matchAll(/^\s*location\s+([^{]+)\{([\s\S]*?)^\s{4}\}/gm)) {
      const body = match[2];
      const serves = /try_files|proxy_pass|alias|root /.test(body) || /^\s*add_header/m.test(body);
      if (serves && !/include\s+\/etc\/nginx\/snippets\/security-headers(?:-passthrough)?\.conf;/.test(body)) findings.push(finding('HEADERS_LOCATION', 'infra/onprem/nginx/default.conf.template', `location ${match[1].trim()} sends no security header snippet`));
    }
    if (!/^\s*location\s+\/\s*\{[\s\S]*?security-headers\.conf/m.test(site)) findings.push(finding('HEADERS_LOCATION', 'infra/onprem/nginx/default.conf.template', 'location / must include the web header snippet'));
  }
}

function checkApiHeaders(root, policy, findings) {
  const text = readText(root, 'apps/api/src/security/security-headers.ts');
  if (text === undefined) return;
  for (const name of policy.headers.api) if (!new RegExp(`'${name}'\\s*:`).test(text)) findings.push(finding('HEADERS_API', 'apps/api/src/security/security-headers.ts', name));
  if (!/'x-content-type-options':\s*'nosniff'/.test(text) || !/frame-ancestors 'none'/.test(text) || !/default-src 'none'/.test(text)) findings.push(finding('HEADERS_API', 'apps/api/src/security/security-headers.ts', "nosniff, default-src 'none' and frame-ancestors 'none' are required"));
  if (!/strict-transport-security/.test(text)) findings.push(finding('HEADERS_API', 'apps/api/src/security/security-headers.ts', 'strict-transport-security behind TLS'));
  const bootstrap = readText(root, 'apps/api/src/bootstrap.ts');
  if (bootstrap !== undefined && !/app\.use\(securityHeaders\(\)\)/.test(bootstrap)) findings.push(finding('HEADERS_API', 'apps/api/src/bootstrap.ts', 'the middleware must be used by the application'));
}

function executionsOf(flows, alias, seen = new Set()) {
  if (seen.has(alias)) return [];
  seen.add(alias);
  const flow = flows.find((entry) => entry.alias === alias);
  return (flow?.authenticationExecutions ?? []).flatMap((execution) => [execution, ...(execution.flowAlias === undefined ? [] : executionsOf(flows, execution.flowAlias, seen))]);
}

function checkIdentity(root, policy, findings) {
  const rule = policy.identity;
  const realm = readJson(root, rule.realmFile);
  if (realm === undefined) return;
  const file = rule.realmFile;
  const problem = (detail) => findings.push(finding('MFA_POLICY', file, detail));
  if (realm.bruteForceProtected !== true || realm.permanentLockout !== false || realm.failureFactor !== rule.bruteForce.failureFactor || realm.maxDeltaTimeSeconds !== rule.bruteForce.lockSeconds || realm.waitIncrementSeconds !== rule.bruteForce.lockSeconds || realm.maxFailureWaitSeconds !== rule.bruteForce.lockSeconds) {
    problem(`${rule.bruteForce.failureFactor} failures must lock for ${rule.bruteForce.lockSeconds} seconds, temporarily`);
  }
  const template = readJson(root, 'infra/keycloak/realm-template.json')?.bruteForce;
  if (template !== undefined && (template.failureFactor !== realm.failureFactor || template.waitIncrementSeconds !== realm.waitIncrementSeconds || template.maxDeltaTimeSeconds !== realm.maxDeltaTimeSeconds || template.maxFailureWaitSeconds !== realm.maxFailureWaitSeconds)) problem('the lockout differs from infra/keycloak/realm-template.json');
  if (realm.sslRequired !== 'all' || realm.registrationAllowed !== false || realm.resetPasswordAllowed !== false) problem('TLS required for every request, no registration, no local password reset');
  if (realm.otpPolicyType !== rule.otp.type || realm.otpPolicyDigits !== rule.otp.digits || realm.otpPolicyPeriod !== rule.otp.periodSeconds || realm.otpPolicyCodeReusable !== false) problem('the one-time code policy must be TOTP, 6 digits, 30 seconds, not reusable');
  if (realm.webAuthnPolicyUserVerificationRequirement !== 'required') problem('WebAuthn must require user verification');
  const action = (realm.requiredActions ?? []).find((entry) => entry.alias === rule.requiredAction);
  if (action?.enabled !== true || action.defaultAction !== true) problem(`${rule.requiredAction} must be a default required action (mandatory second factor)`);
  const flows = realm.authenticationFlows ?? [];
  const top = flows.find((entry) => entry.alias === realm.browserFlow && entry.topLevel === true);
  if (top === undefined) problem('browserFlow must name a top-level flow of the export');
  else {
    const authenticators = executionsOf(flows, top.alias).map((execution) => execution.authenticator).filter(Boolean);
    for (const name of ['auth-username-password-form', 'auth-otp-form', 'webauthn-authenticator', 'conditional-level-of-authentication']) if (!authenticators.includes(name)) problem(`the browser flow lacks ${name}`);
    const unreachable = executionsOf(flows, top.alias).filter((execution) => execution.authenticator === 'auth-username-password-form' && execution.requirement !== 'REQUIRED');
    if (unreachable.length > 0) problem('the password form must be REQUIRED');
    const levels = (realm.authenticatorConfig ?? []).filter((entry) => entry.config?.['loa-condition-level'] !== undefined).map((entry) => entry.config['loa-condition-level']);
    if (!levels.includes('1') || !levels.includes('2')) problem('level 1 and level 2 of authentication must both be configured (aal2 after the second factor)');
    const platform = (realm.authenticatorConfig ?? []).some((entry) => entry.config?.condUserRole === rule.webauthnMarkerRole && entry.config?.negate === 'false');
    if (!platform) problem(`platform roles need a WebAuthn-only branch conditioned on ${rule.webauthnMarkerRole}`);
  }
  if (!/aal2/.test(String(realm.attributes?.['acr.loa.map']))) problem('acr.loa.map must map aal2 to level 2');
  if (realm.revokeRefreshToken !== true || realm.refreshTokenMaxReuse !== 0) problem('refresh tokens must rotate with no reuse');
  const clients = realm.clients ?? [];
  for (const client of clients) {
    if (client.publicClient !== true || client.implicitFlowEnabled !== false || client.directAccessGrantsEnabled !== false || client.attributes?.['pkce.code.challenge.method'] !== 'S256') problem(`client ${client.clientId}: public, PKCE S256, no implicit and no password grant`);
    if (client.attributes?.['minimum.acr.value'] !== 'aal2') problem(`client ${client.clientId}: minimum.acr.value must be aal2`);
    if (client.redirectUris?.some((uri) => uri === '*' || uri.endsWith('*') || uri.startsWith('http://'))) problem(`client ${client.clientId}: exact https redirect URIs only`);
  }
  const control = clients.find((client) => client.clientId === 'machvon-control');
  const audiences = (client) => (client?.protocolMappers ?? []).map((mapper) => mapper.config?.['included.client.audience']);
  if (control === undefined || !audiences(control).includes('machvon-control') || clients.some((client) => client !== control && audiences(client).includes('machvon-control'))) problem('the control-plane client needs its own audience');

  const ldap = realm.components?.['org.keycloak.storage.UserStorageProvider']?.find((entry) => entry.providerId === 'ldap');
  if (ldap === undefined) findings.push(finding('FEDERATION_PLACEHOLDER', file, 'no LDAP federation'));
  else {
    const config = ldap.config ?? {};
    for (const key of rule.federationPlaceholders) {
      if (!SECRET_PLACEHOLDER.test(String(config[key]?.[0] ?? ''))) findings.push(finding('FEDERATION_PLACEHOLDER', file, `${key} must be a \${VARIABLE} placeholder`));
    }
    if (config.editMode?.[0] !== 'READ_ONLY' || config.useTruststoreSpi?.[0] !== 'always') findings.push(finding('FEDERATION_PLACEHOLDER', file, 'federation must be READ_ONLY and trust the configured truststore'));
    if (!String(config.connectionUrl?.[0] ?? '').includes('LDAP_URL')) findings.push(finding('FEDERATION_PLACEHOLDER', file, 'connectionUrl must come from LDAP_URL'));
  }
  checkRoleMap(root, policy, realm, ldap, findings);
}

function checkRoleMap(root, policy, realm, ldap, findings) {
  const rule = policy.identity;
  const map = readJson(root, rule.roleMapFile);
  if (map === undefined) {
    findings.push(finding('ROLE_MAP', rule.roleMapFile, 'missing or malformed'));
    return;
  }
  const roles = new Set((realm.roles?.realm ?? []).map((role) => role.name));
  const groups = realm.groups ?? [];
  const mapped = new Map((map.mappings ?? []).map((entry) => [entry.adGroup, entry.roles ?? []]));
  const filter = String(map.groupFilter ?? '');
  const prefix = /^\(cn=([^*]+)\*\)$/.exec(filter)?.[1];
  if (prefix === undefined) findings.push(finding('ROLE_MAP', rule.roleMapFile, 'groupFilter must be a (cn=PREFIX*) filter so that other directory groups are never imported'));
  const mapperFilter = ldap?.subComponents?.['org.keycloak.storage.ldap.mappers.LDAPStorageMapper']?.find((entry) => entry.providerId === 'group-ldap-mapper')?.config?.['groups.ldap.filter']?.[0];
  if (mapperFilter !== filter) findings.push(finding('ROLE_MAP', rule.roleMapFile, 'the group mapper filter of the realm differs from groupFilter'));
  for (const [group, mappedRoles] of mapped) {
    if (prefix !== undefined && !group.startsWith(prefix)) findings.push(finding('ROLE_MAP', rule.roleMapFile, `${group} is outside the filter ${filter}`));
    const entry = groups.find((candidate) => candidate.name === group);
    const have = entry?.realmRoles ?? [];
    if (entry === undefined) findings.push(finding('ROLE_MAP', rule.roleMapFile, `${group} is not a group of the realm`));
    for (const role of mappedRoles) {
      if (!roles.has(role)) findings.push(finding('ROLE_MAP', rule.roleMapFile, `${group}: role ${role} is not a realm role`));
      if (entry !== undefined && !have.includes(role)) findings.push(finding('ROLE_MAP', rule.roleMapFile, `${group} does not grant ${role} in the realm`));
    }
    if (entry !== undefined && !have.includes(rule.webauthnMarkerRole)) findings.push(finding('ROLE_MAP', rule.roleMapFile, `${group} must also grant ${rule.webauthnMarkerRole}`));
    if (entry !== undefined && have.some((role) => !mappedRoles.includes(role) && role !== rule.webauthnMarkerRole)) findings.push(finding('ROLE_MAP', rule.roleMapFile, `${group} grants a role the map does not state`));
  }
  for (const group of groups) if (!mapped.has(group.name)) findings.push(finding('ROLE_MAP', rule.roleMapFile, `the realm group ${group.name} is not in the map`));
  const platformRoles = readJson(root, 'infra/keycloak/realm-template.json')?.realmRoles ?? [];
  const covered = new Set([...mapped.values()].flat());
  for (const role of platformRoles) if (!covered.has(role)) findings.push(finding('ROLE_MAP', rule.roleMapFile, `the platform role ${role} has no directory group`));
}

/** The checks of HSKT YCK.07 that read several artefacts at once: the malware scan wiring, the egress script, the ransomware catalogue and the Keycloak import rules. */
function checkSecurityEvidence(root, policy, yaml, findings) {
  const rule = policy.security;
  if (rule === undefined) return;
  const compose = yaml === undefined ? undefined : parseYaml(yaml, readText(root, policy.compose.file) ?? '');
  if (compose !== undefined) {
    for (const detail of checkMalwareScan(compose, rule.malwareScan)) findings.push(finding('MALWARE_SCAN', policy.compose.file, detail));
    const realm = readJson(root, policy.identity.realmFile);
    if (realm !== undefined) {
      const environment = new Set(Object.keys(compose.services?.[rule.realmImport.service]?.environment ?? {}));
      for (const detail of checkRealmImport(realm, { environment })) findings.push(finding('REALM_IMPORT', policy.identity.realmFile, detail));
    }
  }
  const script = readText(root, rule.egress.script);
  if (script !== undefined) {
    const subnet = compose?.networks?.[policy.compose.egress.network]?.ipam?.config?.[0]?.subnet;
    for (const detail of checkEgressScript(script, yaml === undefined ? rule.egress.subnet : subnet)) findings.push(finding('EGRESS_RULES', rule.egress.script, detail));
  }
  for (const detail of checkRansomwareCatalogue(root, rule.ransomware)) findings.push(finding('RANSOMWARE_CATALOGUE', rule.ransomware.catalogue, detail));
}

function checkWorkflows(root, policy, yaml, findings) {
  const workflowsDir = join(root, '.github', 'workflows');
  if (!existsSync(workflowsDir)) return;
  const rule = policy.workflows;
  const texts = new Map(readdirSync(workflowsDir).filter((name) => /\.ya?ml$/.test(name)).map((name) => [`.github/workflows/${name}`, readFileSync(join(workflowsDir, name), 'utf8')]));
  for (const [file, text] of texts) {
    for (const match of text.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
      const ref = match[1];
      if (!ref.startsWith('./') && /@(main|master|latest|head|dev)$/i.test(ref)) findings.push(finding('WORKFLOW_FLOATING_ACTION', file, ref));
    }
    for (const reference of workflowDockerImages(text)) {
      if (reference.startsWith('machvon/')) continue;
      judgeImage(reference, { file, policy }, findings);
    }
  }
  const scan = (detail, file = '.github/workflows') => findings.push(finding('SCAN_WORKFLOW', file, detail));
  const text = (file) => texts.get(file);
  for (const file of [rule.codeql.file, rule.imageScan.file, rule.dast.file, rule.armLeg.file]) if (text(file) === undefined) scan('the workflow file is missing', file);
  if (yaml === undefined) return;
  const jobsOf = (file) => parseYaml(yaml, text(file) ?? '')?.jobs ?? {};
  const codeql = jobsOf(rule.codeql.file)[rule.codeql.job];
  const codeqlSteps = JSON.stringify(codeql?.steps ?? []);
  if (codeql === undefined || !codeqlSteps.includes('codeql-action/init') || !codeqlSteps.includes('codeql-action/analyze') || !codeqlSteps.includes(rule.codeql.queries)) scan(`job ${rule.codeql.job}: CodeQL with the ${rule.codeql.queries} queries is required`, rule.codeql.file);
  if (!(codeql?.strategy?.matrix?.language ?? []).some((language) => String(language).startsWith('javascript'))) scan('CodeQL must analyse javascript-typescript', rule.codeql.file);
  const secrets = jobsOf(rule.secretScan.file)[rule.secretScan.job];
  const secretSteps = JSON.stringify(secrets?.steps ?? []);
  const wholeHistory = (secrets?.steps ?? []).some((step) => String(step.uses ?? '').startsWith('actions/checkout') && step.with?.['fetch-depth'] === 0);
  if (secrets === undefined || !secretSteps.includes('gitleaks') || !wholeHistory || !secretSteps.includes(rule.secretScan.configFile) || !existsSync(join(root, rule.secretScan.configFile))) scan('secret scanning over the whole history with a rules file is required', rule.secretScan.file);
  const images = jobsOf(rule.imageScan.file)[rule.imageScan.job];
  const imageSteps = JSON.stringify(images?.steps ?? []);
  const runners = JSON.stringify(images?.strategy?.matrix ?? {}) + JSON.stringify(images?.['runs-on'] ?? '');
  if (images === undefined || !imageSteps.includes('trivy') || !imageSteps.includes(rule.imageScan.policy) || !existsSync(join(root, rule.imageScan.policy))) scan('every image must be scanned with the Trivy policy file', rule.imageScan.file);
  for (const runner of rule.imageScan.requiredRunners) if (!runners.includes(runner)) scan(`images must be built natively on ${runner}`, rule.imageScan.file);
  const dast = jobsOf(rule.dast.file);
  for (const [job, script] of Object.entries(rule.dast.jobs)) {
    const steps = JSON.stringify(dast[job]?.steps ?? []);
    if (!steps.includes(script) || !steps.includes('rules.tsv')) scan(`job ${job}: an OWASP ZAP scan (${script}) with ${rule.dast.rules} is required`, rule.dast.file);
  }
  const arm = jobsOf(rule.armLeg.file)[rule.armLeg.job];
  const armSteps = JSON.stringify(arm?.steps ?? []);
  if (arm === undefined || arm['runs-on'] !== rule.armLeg.runner) findings.push(finding('ARM_LEG_MISSING', rule.armLeg.file, `job ${rule.armLeg.job} must run on ${rule.armLeg.runner}`));
  else for (const needed of rule.armLeg.mustRun) if (!armSteps.includes(needed)) findings.push(finding('ARM_LEG_MISSING', rule.armLeg.file, `the ARM leg must run ${needed}`));
  const trivy = parseYaml(yaml, readText(root, rule.imageScan.policy) ?? '');
  if (trivy !== undefined) {
    const severities = trivy?.severity ?? [];
    if (!policy.trivy.severity.every((level) => severities.includes(level)) || trivy.exit_code === 0 || trivy['exit-code'] !== policy.trivy.exitCode) scan(`the Trivy policy must fail on ${policy.trivy.severity.join(' and ')}`, rule.imageScan.policy);
  }
  const supply = readJson(root, 'supply-chain.json');
  if (supply !== undefined && (typeof supply.imageScan?.tool !== 'string' || typeof supply.imageScan?.failOn !== 'string')) scan('supply-chain.json needs the imageScan policy', 'supply-chain.json');
}

/**
 * The checks of the on-prem artefacts: required files, pinned images with digests and no floating tag, multi-arch, the compose rules (health checks, limits, hardening, ports, secrets only
 * as files), the Dockerfiles, TLS and the security headers of the edge and of the API, the identity configuration (mandatory MFA, lockout, federation placeholders, the directory group
 * to role map), the backup policy (immutability, encryption, schedule), the native dependencies and the security scanning workflows with the ARM leg. A root without the
 * policy file or without a repository marker (`package.json`) is not checked: an older release has none of these files, and a copy of `infra/` alone is not a repository.
 * Returns `{ checked, findings }`; `options.yaml` is the js-yaml module (null: none) (the checks that read YAML are then skipped).
 */
export function checkArtefacts(root, options = {}) {
  // `yaml: null` says the parser is not available (the tests use it to prove the skip); undefined means "load it".
  const yaml = options.yaml === undefined ? yamlParser() : (options.yaml ?? undefined);
  const policy = readJson(root, POLICY_FILE);
  if (policy === undefined || !existsSync(join(root, 'package.json'))) return { checked: false, yamlSkipped: false, findings: [] };
  const findings = [];
  checkRequired(root, policy, findings);
  checkImages(root, policy, yaml, findings);
  checkCompose(root, policy, yaml, findings);
  checkDockerfiles(root, policy, findings);
  checkRuntimeNeeds(root, policy, findings);
  checkEdge(root, policy, findings);
  checkApiHeaders(root, policy, findings);
  checkIdentity(root, policy, findings);
  for (const entry of checkBackupPolicy(root).findings) findings.push(finding('BACKUP_POLICY_VIOLATION', 'infra/backup/backup-policy.json', `${entry.code}: ${entry.detail}`));
  if (existsSync(join(root, 'package-lock.json')) && existsSync(join(root, 'infra', 'onprem', 'native-deps.json'))) {
    for (const entry of checkNativeDeps(root).findings) findings.push(finding('NATIVE_DEPS', 'infra/onprem/native-deps.json', `${entry.code}: ${entry.detail}`));
  }
  checkWorkflows(root, policy, yaml, findings);
  checkSecurityEvidence(root, policy, yaml, findings);
  return { checked: true, yamlSkipped: yaml === undefined, findings };
}
