import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Offline checks for HSKT YCK.07 (security): the Keycloak realm import rules, the egress allowlist, the ransomware scenario catalogue and the malware scan wiring.
// Every function returns a list of plain detail strings; scripts/infra-artefacts.mjs turns them into findings, the tests call them on mutated copies.

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const REQUIREMENTS = new Set(['REQUIRED', 'ALTERNATIVE', 'DISABLED', 'CONDITIONAL']);
const FLOW_PROVIDERS = new Set(['basic-flow', 'client-flow']);
/** The scopes Keycloak 26 creates in every realm; a client of an import may name them without the file defining them. */
const BUILT_IN_CLIENT_SCOPES = new Set(['profile', 'email', 'roles', 'web-origins', 'acr', 'basic', 'address', 'phone', 'offline_access', 'microprofile-jwt', 'organization', 'service_account']);
/** The authentication flow references of a realm: the realm attribute that names a flow by its alias. */
const FLOW_REFERENCES = ['browserFlow', 'registrationFlow', 'directGrantFlow', 'resetCredentialsFlow', 'clientAuthenticationFlow', 'dockerAuthenticationFlow', 'firstBrokerLoginFlow'];
const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_.]*)(?::[^}]*)?\}/g;

function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) (seen.has(value) ? repeated : seen).add(value);
  return [...repeated];
}

function groupNames(groups, path = '') {
  return (groups ?? []).flatMap((group) => [{ path: `${path}/${group.name}`, group }, ...groupNames(group.subGroups, `${path}/${group.name}`)]);
}

/**
 * The structure rules Keycloak 26 applies when it imports a realm file (`start --import-realm`), as far as they can be judged without a server: required fields, unique names and aliases,
 * every reference (flows, executions, authenticator configs, roles, groups, client scopes) resolves inside the file, LDAP component values are string lists, and every `${NAME}` placeholder
 * has a value in the environment of the Keycloak container (`environment` is the set of variable names the container gets, `NAME` or `NAME_FILE`). Not judged here: anything that needs the
 * server (provider availability, the directory itself, the real import); that is the lab checklist.
 */
export function checkRealmImport(realm, { environment } = {}) {
  const problems = [];
  const problem = (detail) => problems.push(detail);
  if (!isObject(realm)) return ['the realm file is not a JSON object'];
  if (typeof realm.realm !== 'string' || realm.realm === '') problem('realm (the realm name) is required');
  if (typeof realm.enabled !== 'boolean') problem('enabled must be a boolean');

  const flows = Array.isArray(realm.authenticationFlows) ? realm.authenticationFlows : [];
  const configs = Array.isArray(realm.authenticatorConfig) ? realm.authenticatorConfig : [];
  const flowAliases = new Set(flows.map((flow) => flow.alias));
  const configAliases = new Set(configs.map((config) => config.alias));
  for (const alias of duplicates(flows.map((flow) => flow.alias))) problem(`authentication flow alias ${alias} is repeated`);
  for (const alias of duplicates(configs.map((config) => config.alias))) problem(`authenticator config alias ${alias} is repeated`);
  for (const config of configs) {
    if (typeof config.alias !== 'string' || !isObject(config.config)) problem(`authenticator config ${config.alias ?? '?'} needs an alias and a config object`);
    else if (Object.values(config.config).some((value) => typeof value !== 'string')) problem(`authenticator config ${config.alias}: every value must be a string`);
  }
  for (const flow of flows) {
    if (typeof flow.alias !== 'string' || flow.alias === '') problem('an authentication flow has no alias');
    if (!FLOW_PROVIDERS.has(flow.providerId)) problem(`flow ${flow.alias}: providerId must be basic-flow or client-flow`);
    if (typeof flow.topLevel !== 'boolean') problem(`flow ${flow.alias}: topLevel must be a boolean`);
    const priorities = [];
    for (const execution of flow.authenticationExecutions ?? []) {
      if ((execution.authenticator === undefined) === (execution.flowAlias === undefined)) problem(`flow ${flow.alias}: an execution names an authenticator or a sub flow, never both and never neither`);
      if (execution.flowAlias !== undefined && !flowAliases.has(execution.flowAlias)) problem(`flow ${flow.alias}: sub flow ${execution.flowAlias} is not defined`);
      if (execution.flowAlias !== undefined && execution.authenticatorFlow !== true) problem(`flow ${flow.alias}: the execution of sub flow ${execution.flowAlias} needs authenticatorFlow true`);
      if (!REQUIREMENTS.has(execution.requirement)) problem(`flow ${flow.alias}: requirement ${execution.requirement} is not one of ${[...REQUIREMENTS].join(', ')}`);
      if (execution.authenticatorConfig !== undefined && !configAliases.has(execution.authenticatorConfig)) problem(`flow ${flow.alias}: authenticator config ${execution.authenticatorConfig} is not defined`);
      if (execution.priority !== undefined) priorities.push(execution.priority);
    }
    if (duplicates(priorities).length > 0) problem(`flow ${flow.alias}: two executions have the same priority, so their order is not defined`);
  }
  for (const key of FLOW_REFERENCES) if (realm[key] !== undefined && flows.length > 0 && !flowAliases.has(realm[key])) problem(`${key} names ${realm[key]}, which is not a flow of the file`);
  const referenced = new Set(flows.flatMap((flow) => (flow.authenticationExecutions ?? []).map((execution) => execution.flowAlias)).filter(Boolean));
  for (const flow of flows) if (flow.topLevel === false && !referenced.has(flow.alias)) problem(`flow ${flow.alias} is not top level and no flow uses it`);

  const realmRoles = (realm.roles?.realm ?? []).map((role) => role.name);
  for (const name of duplicates(realmRoles)) problem(`realm role ${name} is repeated`);
  const roleSet = new Set(realmRoles);
  const clients = Array.isArray(realm.clients) ? realm.clients : [];
  for (const id of duplicates(clients.map((client) => client.clientId))) problem(`clientId ${id} is repeated`);
  for (const [name, list] of Object.entries(realm.roles?.client ?? {})) if (!clients.some((client) => client.clientId === name)) problem(`roles of client ${name}, which is not a client of the file (${list.length} roles)`);
  for (const role of realm.roles?.realm ?? []) {
    for (const composite of role.composites?.realm ?? []) if (!roleSet.has(composite)) problem(`role ${role.name}: composite ${composite} is not a realm role`);
  }
  const groups = groupNames(realm.groups);
  for (const path of duplicates(groups.map((entry) => entry.path))) problem(`group ${path} is repeated`);
  for (const { path, group } of groups) for (const role of group.realmRoles ?? []) if (!roleSet.has(role)) problem(`group ${path}: role ${role} is not a realm role`);

  const scopeNames = new Set([...BUILT_IN_CLIENT_SCOPES, ...(realm.clientScopes ?? []).map((scope) => scope.name)]);
  for (const client of clients) {
    if (typeof client.clientId !== 'string' || client.clientId === '') problem('a client has no clientId');
    for (const key of ['redirectUris', 'webOrigins']) if (client[key] !== undefined && !Array.isArray(client[key])) problem(`client ${client.clientId}: ${key} must be a list`);
    for (const scope of [...(client.defaultClientScopes ?? []), ...(client.optionalClientScopes ?? [])]) if (!scopeNames.has(scope)) problem(`client ${client.clientId}: client scope ${scope} is neither built in nor defined`);
    for (const name of duplicates((client.protocolMappers ?? []).map((mapper) => mapper.name))) problem(`client ${client.clientId}: protocol mapper ${name} is repeated`);
    for (const mapper of client.protocolMappers ?? []) if (typeof mapper.protocol !== 'string' || typeof mapper.protocolMapper !== 'string' || !isObject(mapper.config)) problem(`client ${client.clientId}: protocol mapper ${mapper.name} needs protocol, protocolMapper and config`);
    if (client.attributes !== undefined && Object.values(client.attributes).some((value) => typeof value !== 'string')) problem(`client ${client.clientId}: every attribute value must be a string`);
  }
  for (const name of duplicates((realm.requiredActions ?? []).map((action) => action.alias))) problem(`required action ${name} is repeated`);
  for (const action of realm.requiredActions ?? []) if (typeof action.providerId !== 'string') problem(`required action ${action.alias}: providerId is required`);
  if (realm.attributes !== undefined && Object.values(realm.attributes).some((value) => typeof value !== 'string')) problem('every realm attribute value must be a string');

  for (const [type, entries] of Object.entries(realm.components ?? {})) {
    for (const component of entries) {
      if (typeof component.name !== 'string' || typeof component.providerId !== 'string') problem(`component of ${type} needs a name and a providerId`);
      const lists = [component.config ?? {}, ...Object.values(component.subComponents ?? {}).flat().map((sub) => sub.config ?? {})];
      for (const config of lists) for (const [key, value] of Object.entries(config)) if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) problem(`component ${component.name}: ${key} must be a list of strings`);
      for (const [subType, subs] of Object.entries(component.subComponents ?? {})) for (const name of duplicates(subs.map((sub) => sub.name))) problem(`component ${component.name}: ${subType} ${name} is repeated`);
    }
  }

  if (environment !== undefined) {
    const names = new Set([...JSON.stringify(realm).matchAll(PLACEHOLDER)].map((match) => match[1]));
    for (const name of names) if (!environment.has(name) && !environment.has(`${name}_FILE`)) problem(`placeholder \${${name}} has no value in the environment of the Keycloak container`);
  }
  return problems;
}

/**
 * The rules `egress-firewall.sh` prints, as data. Each line is `iptables <op> <chain> ...`; only the appended rules of the MACHVON-EGRESS chain are returned, in order.
 * An ACCEPT with no destination or a destination of 0.0.0.0/0 is kept as `destination: undefined` so that the allowlist test sees it.
 */
export function parseEgressRules(output) {
  const rules = [];
  for (const line of String(output).split(/\r?\n/)) {
    const match = /^iptables -A MACHVON-EGRESS (.*)$/.exec(line.trim());
    if (match === null) continue;
    const tokens = match[1].split(/\s+/);
    const option = (name) => tokens[tokens.indexOf(name) + 1];
    const destination = tokens.includes('-d') ? option('-d') : undefined;
    const target = option('-j');
    rules.push({ destination: destination === '0.0.0.0/0' ? undefined : destination, protocol: tokens.includes('-p') ? option('-p') : undefined, port: tokens.includes('--dport') ? Number(option('--dport')) : undefined, conntrack: tokens.includes('--ctstate'), target });
  }
  return rules;
}

const ipToNumber = (ip) => ip.split('.').reduce((total, part) => total * 256 + Number(part), 0);

function covers(destination, address) {
  if (destination === undefined) return true;
  const [network, bits] = destination.split('/');
  const prefix = bits === undefined ? 32 : Number(bits);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((ipToNumber(network) & mask) >>> 0) === ((ipToNumber(address) & mask) >>> 0);
}

/**
 * What the chain does with a new connection from the egress network to `address:port` over TCP: the first rule that matches decides (the ESTABLISHED rule does not match a new
 * connection), and a chain without a match would fall through, which is reported as `DROP` only when the chain ends in a DROP rule; otherwise `NO_MATCH` (the traffic would be
 * judged by the rest of the host firewall).
 */
export function egressVerdict(rules, address, port) {
  for (const rule of rules) {
    if (rule.conntrack) continue;
    if (rule.protocol !== undefined && rule.protocol !== 'tcp') continue;
    if (rule.port !== undefined && rule.port !== port) continue;
    if (!covers(rule.destination, address)) continue;
    return rule.target;
  }
  return 'NO_MATCH';
}

/**
 * The static rules of the egress script: it ends its chain in DROP, every ACCEPT names a destination (or is the conntrack rule for answers), nothing allows all destinations,
 * the destinations come from the arguments, and the subnet is the one of the egress network of the compose file.
 */
export function checkEgressScript(text, composeSubnet) {
  const problems = [];
  const accepts = [...text.matchAll(/echo "iptables -A MACHVON-EGRESS ([^"]*)-j ACCEPT"/g)].map((match) => match[1]);
  for (const accept of accepts) if (!/(-d |--ctstate)/.test(accept)) problem(problems, `an ACCEPT rule names no destination: ${accept.trim()}`);
  if (accepts.some((accept) => /-d (0\.0\.0\.0\/0|any)\b/.test(accept))) problem(problems, 'an ACCEPT rule allows every destination');
  const appended = [...text.matchAll(/echo "iptables -A MACHVON-EGRESS ([^"]*)"/g)].map((match) => match[1].trim());
  if (appended.at(-1) !== '-j DROP') problem(problems, 'the chain must end in -j DROP');
  if (!/DOCKER-USER/.test(text)) problem(problems, 'the chain must be hooked into DOCKER-USER, which Docker never rewrites');
  const subnet = /^SUBNET=(\S+)$/m.exec(text)?.[1];
  if (subnet === undefined || subnet !== composeSubnet) problem(problems, `the subnet of the script (${subnet ?? 'none'}) differs from the egress network of the compose file (${composeSubnet ?? 'none'})`);
  if (!/getent ahostsv4/.test(text) || !/exit 1|return 1/.test(text)) problem(problems, 'destinations must be resolved, and an unresolvable one must stop the script before any rule is written');
  return problems;
}

function problem(list, detail) {
  list.push(detail);
}

/** Every file the catalogue cites as evidence or as a test (the tests of this repository copy them into a scratch repository). */
export function ransomwareEvidencePaths(catalogue) {
  return [...new Set((catalogue.scenarios ?? []).flatMap((scenario) => [...(scenario.controls ?? []).flatMap((control) => (control.evidence ?? []).map((item) => item.path)), ...(scenario.tests ?? [])]))];
}

function readJsonFile(root, path) {
  const file = join(root, path);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * The ransomware scenario catalogue (docs/security/ransomware-scenarios.json): the required attack vectors are all present, every scenario has a preventive control and a detective or recovery
 * control, every control cites evidence (a file, optionally with a text it must contain) that exists, every scenario names tests that exist, the markdown lists every scenario id and the
 * pentest readiness pack points at the catalogue.
 */
export function checkRansomwareCatalogue(root, rule) {
  const problems = [];
  const catalogue = readJsonFile(root, rule.catalogue);
  if (catalogue === undefined || !Array.isArray(catalogue.scenarios)) return [`${rule.catalogue} is missing or malformed`];
  const markdown = existsSync(join(root, rule.document)) ? readFileSync(join(root, rule.document), 'utf8') : undefined;
  if (markdown === undefined) problems.push(`${rule.document} is missing`);
  const pack = existsSync(join(root, rule.pentestPack)) ? readFileSync(join(root, rule.pentestPack), 'utf8') : '';
  if (!pack.includes('ransomware-scenarios')) problems.push(`${rule.pentestPack} does not refer to the ransomware scenario catalogue`);
  const vectors = new Set(catalogue.scenarios.map((scenario) => scenario.vector));
  for (const vector of rule.requiredVectors) if (!vectors.has(vector)) problems.push(`no scenario for the vector ${vector}`);
  for (const id of duplicates(catalogue.scenarios.map((scenario) => scenario.id))) problems.push(`scenario id ${id} is repeated`);
  for (const scenario of catalogue.scenarios) {
    const label = scenario.id ?? '?';
    if (markdown !== undefined && !markdown.includes(label)) problems.push(`${rule.document} does not list ${label}`);
    for (const key of ['title', 'attackerGoal', 'residualRisk']) if (typeof scenario[key] !== 'string' || scenario[key] === '') problems.push(`${label}: ${key} is required`);
    const controls = Array.isArray(scenario.controls) ? scenario.controls : [];
    if (!controls.some((control) => control.kind === 'preventive')) problems.push(`${label}: no preventive control`);
    if (!controls.some((control) => control.kind === 'detective' || control.kind === 'recovery')) problems.push(`${label}: no detective or recovery control`);
    for (const control of controls) {
      if (!['preventive', 'detective', 'recovery'].includes(control.kind) || typeof control.description !== 'string') problems.push(`${label}: a control needs a kind and a description`);
      const evidence = Array.isArray(control.evidence) ? control.evidence : [];
      if (evidence.length === 0) problems.push(`${label}: control "${control.description}" cites no evidence`);
      for (const item of evidence) {
        const file = join(root, String(item.path));
        if (!existsSync(file)) problems.push(`${label}: evidence ${item.path} does not exist`);
        else if (item.contains !== undefined && !readFileSync(file, 'utf8').includes(item.contains)) problems.push(`${label}: ${item.path} does not contain "${item.contains}"`);
      }
    }
    const tests = Array.isArray(scenario.tests) ? scenario.tests : [];
    if (tests.length === 0) problems.push(`${label}: no test`);
    for (const test of tests) if (!existsSync(join(root, String(test)))) problems.push(`${label}: test ${test} does not exist`);
  }
  return problems;
}

/**
 * The malware scan wiring of the compose file (HSKT YCK.07): the scanner service exists with a pinned image, sits on the app network only (never on the egress network), the API and the
 * workers are told to use ClamAV for the shared pipeline and for the portal, and the host the API reaches is the scanner service.
 */
export function checkMalwareScan(compose, rule) {
  const problems = [];
  const services = compose?.services ?? {};
  const scanner = services[rule.service];
  if (scanner === undefined) return [`the compose file has no ${rule.service} service`];
  const networks = Array.isArray(scanner.networks) ? scanner.networks : Object.keys(scanner.networks ?? {});
  if (networks.includes('egress') || networks.includes('edge') || scanner.ports !== undefined) problems.push(`${rule.service} must be reachable from the app network only (no egress, no edge, no published port)`);
  if (!networks.includes('app')) problems.push(`${rule.service} must join the app network`);
  for (const consumer of rule.consumers) {
    const environment = services[consumer]?.environment;
    if (!isObject(environment)) {
      problems.push(`${consumer}: no environment`);
      continue;
    }
    if (environment[rule.adapterVariable] !== rule.adapter) problems.push(`${consumer}: ${rule.adapterVariable} must be ${rule.adapter}`);
    if (environment[rule.portalVariable] !== rule.portalAdapter) problems.push(`${consumer}: ${rule.portalVariable} must be ${rule.portalAdapter}`);
    if (environment[rule.hostVariable] !== rule.service) problems.push(`${consumer}: ${rule.hostVariable} must be ${rule.service}`);
    if (String(environment[rule.portVariable]) !== String(rule.port)) problems.push(`${consumer}: ${rule.portVariable} must be ${rule.port}`);
    const consumerNetworks = Array.isArray(services[consumer].networks) ? services[consumer].networks : Object.keys(services[consumer].networks ?? {});
    if (!consumerNetworks.includes('app')) problems.push(`${consumer} cannot reach ${rule.service}: it is not on the app network`);
  }
  return problems;
}
