import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// INT-2 (HSKT TH.02): the rules of the OPT-IN read-only port of the database for BI tools in the offline install bundle. The port must be CLOSED by default and, when the operator switches it on,
// narrow: one named listen address (never 0.0.0.0), TLS 1.2 or newer, SCRAM only, an allowlist of source addresses in two independent places (pg_hba.conf and the host firewall), the BI
// group role the only role reachable from outside, a limit on the connections of one source, and an audit trail (pgaudit in object mode, connections logged) that is shipped off the host.
// `checkBiPort` returns a list of plain detail strings; scripts/infra-artefacts.mjs turns them into BI_PORT findings, the tests call it on mutated copies.

const SETTING_PAIR = /^([a-z_.]+)=(.*)$/s;
const LISTEN_ENTRY = /^\$\{BI_LISTEN_ADDRESS:\?[^}]+\}:\$\{BI_PORT\}:5432$/;
const SECRET_FILE = /^\$\{MACHVON_SECRETS_DIR\}\/([a-z0-9_]+)$/;

function read(root, path) {
  const file = join(root, path);
  return existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : undefined;
}

/** The `-c name=value` pairs of a postgres command list, as a Map (a name set twice keeps its last value, as the server does). */
export function settingsOf(command) {
  const settings = new Map();
  const list = Array.isArray(command) ? command.map(String) : [];
  for (let index = 0; index < list.length; index += 1) {
    if (list[index] !== '-c') continue;
    const match = SETTING_PAIR.exec(list[index + 1] ?? '');
    if (match !== null) settings.set(match[1], match[2]);
  }
  return settings;
}

function composeProblems(rule, base, override, secrets, problems) {
  const { requiredSettings } = rule;
  if (base !== undefined) {
    const preload = settingsOf(base.services?.db?.command).get('shared_preload_libraries');
    if (preload !== requiredSettings.shared_preload_libraries) problems.push(`${rule.base}: the database must preload pgaudit (shared_preload_libraries=${requiredSettings.shared_preload_libraries}), so that the audit of the BI port needs no rebuild`);
    for (const [name, service] of Object.entries(base.services ?? {})) {
      if (name !== 'web' && Array.isArray(service.ports) && service.ports.length > 0) problems.push(`${rule.base}: ${name} publishes a port: the BI port exists only in ${rule.override}`);
    }
  }
  if (override === undefined) return;
  const services = Object.keys(override.services ?? {});
  if (services.length !== 1 || services[0] !== 'db') problems.push(`${rule.override}: only the database may be touched by the override (found ${services.join(', ') || 'no service'})`);
  const db = override.services?.db ?? {};
  for (const key of ['privileged', 'network_mode', 'cap_add', 'pid', 'ipc', 'user']) if (db[key] !== undefined) problems.push(`${rule.override}: db.${key} must not be set by the override`);
  const ports = Array.isArray(db.ports) ? db.ports.map(String) : [];
  if (ports.length !== 1 || !LISTEN_ENTRY.test(ports[0])) problems.push(`${rule.override}: the database must publish exactly one port, on "\${BI_LISTEN_ADDRESS:?...}:\${BI_PORT}:5432" (a required address with no default, one port, TCP only); found ${JSON.stringify(ports)}`);
  if (ports.some((entry) => /(^|[:[])0\.0\.0\.0|\[::\]|::/.test(entry) || /\/udp$/.test(entry))) problems.push(`${rule.override}: the port is published on every address or over UDP`);
  if (!(Array.isArray(db.entrypoint) && db.entrypoint.includes('/usr/local/bin/bi-tls-prepare'))) problems.push(`${rule.override}: the entrypoint must run bi-tls-prepare (the TLS files are copied for the postgres user at start)`);

  const settings = settingsOf(db.command);
  for (const [name, expected] of Object.entries(requiredSettings)) {
    const value = settings.get(name);
    const allowed = Array.isArray(expected) ? expected : [expected];
    if (value === undefined || !allowed.includes(value)) problems.push(`${rule.override}: the database command must set ${name} to ${allowed.join(' or ')} (found ${value ?? 'nothing'})`);
  }
  const ciphers = settings.get('ssl_ciphers') ?? '';
  if (ciphers === '' || /(RC4|3DES|DES-CBC|NULL|aNULL|eNULL|MD5|EXPORT|CBC|:SHA(:|$)|AES256-SHA|AES128-SHA)/.test(ciphers) || ciphers.split(':').some((suite) => !/^ECDHE-/.test(suite))) problems.push(`${rule.override}: ssl_ciphers must list ECDHE suites only, with no weak token`);
  if (settings.get('ssl_cert_file') !== '/run/machvon-bi-tls/server.crt' || settings.get('ssl_key_file') !== '/run/machvon-bi-tls/server.key') problems.push(`${rule.override}: the TLS files must be the ones bi-tls-prepare writes under /run/machvon-bi-tls`);
  if (base !== undefined) {
    // A compose override replaces a command list, it does not extend it: every setting of the base file must be repeated with the same value, or the BI database would run with other settings.
    for (const [name, value] of settingsOf(base.services?.db?.command)) {
      if (settings.get(name) !== value) problems.push(`${rule.override}: the command repeats the settings of ${rule.base} and ${name} differs (${settings.get(name) ?? 'missing'} instead of ${value})`);
    }
  }
  const volumes = (db.volumes ?? []).map(String);
  if (!volumes.some((entry) => /pg_hba\.conf:\/etc\/machvon-bi\/pg_hba\.conf:ro"?$/.test(entry))) problems.push(`${rule.override}: pg_hba.conf must be mounted read-only at /etc/machvon-bi/pg_hba.conf`);
  if (!volumes.some((entry) => entry === 'dbaudit:/var/log/machvon-audit')) problems.push(`${rule.override}: the audit log must go to the dbaudit volume`);
  if (!(db.tmpfs ?? []).some((entry) => String(entry).startsWith('/run/machvon-bi-tls:'))) problems.push(`${rule.override}: /run/machvon-bi-tls must be a tmpfs (the key is never written to a volume)`);

  const declared = Object.keys(override.secrets ?? {}).sort();
  const listed = (secrets?.secrets ?? []).map((entry) => entry.name).sort();
  const used = [...(db.secrets ?? [])].sort();
  if (JSON.stringify(declared) !== JSON.stringify(listed) || JSON.stringify(used) !== JSON.stringify(listed)) problems.push(`${rule.override}: the secrets of the override, the secrets the db uses and ${rule.secrets} must be the same list (${JSON.stringify(declared)}, ${JSON.stringify(used)}, ${JSON.stringify(listed)})`);
  for (const [name, secret] of Object.entries(override.secrets ?? {})) if (SECRET_FILE.exec(String(secret?.file))?.[1] !== name) problems.push(`${rule.override}: secret ${name} must be the file \${MACHVON_SECRETS_DIR}/${name}`);
}

function envProblems(rule, text, problems) {
  if (text === undefined) return;
  const values = new Map(text.split('\n').map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line)).filter(Boolean).map((match) => [match[1], match[2]]));
  if (values.get('MACHVON_BI') !== 'off') problems.push(`${rule.env}: MACHVON_BI must be off in the template (the port is closed by default)`);
  for (const name of ['BI_LISTEN_ADDRESS', 'BI_ALLOWED_CIDRS', 'BI_AUDIT_SINK']) if (values.get(name) !== '') problems.push(`${rule.env}: ${name} must be empty in the template (an empty value keeps the port closed; the operator names it)`);
  const port = Number(values.get('BI_PORT'));
  if (!(Number.isInteger(port) && port >= 1024 && port <= 65535)) problems.push(`${rule.env}: BI_PORT must be a number from 1024 to 65535`);
  const perAddress = Number(values.get('BI_MAX_CONNECTIONS_PER_ADDRESS'));
  if (!(Number.isInteger(perAddress) && perAddress >= 1 && perAddress <= 1000)) problems.push(`${rule.env}: BI_MAX_CONNECTIONS_PER_ADDRESS must be a number from 1 to 1000`);
  const retention = Number(values.get('BI_AUDIT_RETENTION_DAYS'));
  if (!(Number.isInteger(retention) && retention >= rule.minRetentionDays)) problems.push(`${rule.env}: BI_AUDIT_RETENTION_DAYS must be at least ${rule.minRetentionDays}`);
  if (!(values.get('BI_CONFIG_DIR') ?? '').startsWith('/')) problems.push(`${rule.env}: BI_CONFIG_DIR must be an absolute path`);
}

/** pg_hba.conf template: the BI group over TLS from the allowed addresses only, every other role from the compose networks only, nothing trusted but the local socket, a rejecting last line. */
function hbaProblems(rule, text, problems) {
  if (text === undefined) return;
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));
  const fields = lines.map((line) => line.split(/\s+/));
  const marker = lines.filter((line) => line === '@BI_HOSTSSL_LINES@');
  if (marker.length !== 1) problems.push(`${rule.hba}: the marker @BI_HOSTSSL_LINES@ must appear once (found ${marker.length})`);
  for (const [type, , user, address, method] of fields) {
    if (type === '@BI_HOSTSSL_LINES@') continue;
    if (type === 'local') continue;
    if (/^(trust|md5|password|ident|peer|pam|ldap|radius|cert|gss|sspi)$/.test(String(method ?? address))) problems.push(`${rule.hba}: ${type} ${user} uses ${method ?? address}: only scram-sha-256 or reject is allowed off the local socket`);
    if (type === 'hostnossl') problems.push(`${rule.hba}: a hostnossl line is a connection without TLS`);
    if (address === '0.0.0.0/0' || address === '::/0') problems.push(`${rule.hba}: ${address} allows every address`);
  }
  const local = fields.filter(([type]) => type === 'local');
  if (local.some(([, , , method]) => method !== 'trust')) problems.push(`${rule.hba}: the local socket is trusted as in the image (the health check, install.sh and pgBackRest use it)`);
  const group = `+${rule.group}`;
  const reject = fields.findIndex(([type, database, user, address, method]) => type === 'host' && database === 'all' && user === group && address === 'all' && method === 'reject');
  const internal = fields.findIndex(([type, , , address, method]) => type === 'host' && address === 'samenet' && method === 'scram-sha-256');
  const markerAt = lines.indexOf('@BI_HOSTSSL_LINES@');
  if (reject === -1) problems.push(`${rule.hba}: a BI login that is not on the allowlist or not over TLS must be rejected before any other rule can accept it`);
  else if (!(markerAt !== -1 && markerAt < reject && (internal === -1 || reject < internal))) problems.push(`${rule.hba}: the order must be the allowed BI lines, then the rejection of the BI group, then the internal networks`);
  const last = fields.at(-1) ?? [];
  if (!(last[0] === 'host' && last[1] === 'all' && last[2] === 'all' && last[3] === 'all' && last[4] === 'reject')) problems.push(`${rule.hba}: the last line must reject everything else`);
  if (internal === -1) problems.push(`${rule.hba}: the other roles must be accepted from the networks of the compose set (samenet) only`);
  const outside = fields.filter(([type, , user, address]) => type === 'host' && address === 'all' && user !== group);
  if (outside.some(([, , , , method]) => method !== 'reject')) problems.push(`${rule.hba}: no role may be accepted from every address`);
}

function firewallProblems(rule, text, problems) {
  if (text === undefined) return;
  const appended = [...text.matchAll(/echo "iptables -A MACHVON-BI ([^"]*)"/g)].map((match) => match[1].trim());
  if (appended.at(-1) !== '-j DROP') problems.push(`${rule.firewall}: the chain must end in -j DROP`);
  const accepts = appended.filter((entry) => entry.endsWith('-j ACCEPT'));
  for (const accept of accepts) if (!/(-s |--ctstate)/.test(accept)) problems.push(`${rule.firewall}: an ACCEPT rule names no source: ${accept}`);
  if (/-s (0\.0\.0\.0\/0|any)\b/.test(text)) problems.push(`${rule.firewall}: a rule allows every source`);
  if (!appended.some((entry) => /connlimit-above/.test(entry) && /-j DROP$/.test(entry))) problems.push(`${rule.firewall}: each allowed source needs a limit on its open connections (connlimit)`);
  if (!/DOCKER-USER/.test(text) || !/--ctorigdst \$\{LISTEN\} --ctorigdstport \$\{PORT\}/.test(text)) problems.push(`${rule.firewall}: the chain must be hooked into DOCKER-USER for the original address and port of the BI port`);
  if (!/bi-render\.sh/.test(text)) problems.push(`${rule.firewall}: the settings must be validated by bi-render.sh before a rule is printed`);
}

function setupProblems(rule, text, problems) {
  if (text === undefined) return;
  const grants = [...text.matchAll(/GRANT\s+(.+?)\s+TO\s+([A-Za-z_]+)/g)].map((match) => ({ privileges: match[1].trim(), grantee: match[2] }));
  if (!/CREATE ROLE machvon_bi_auditor NOLOGIN/.test(text)) problems.push(`${rule.setup}: the audit role must be created NOLOGIN`);
  if (/PUBLIC/i.test(text)) problems.push(`${rule.setup}: nothing is granted to PUBLIC`);
  for (const { privileges, grantee } of grants) {
    if (grantee !== rule.auditRole) problems.push(`${rule.setup}: a grant to ${grantee}: the file grants to ${rule.auditRole} only`);
    if (!/^(SELECT ON machvon_bi\.%I|SELECT ON TABLES)$/i.test(privileges)) problems.push(`${rule.setup}: ${privileges} is more than SELECT on the views of machvon_bi`);
  }
  if (!/format\('GRANT SELECT ON machvon_bi\.%I TO machvon_bi_auditor'/.test(text) || !/ALTER DEFAULT PRIVILEGES FOR ROLE machvon_owner IN SCHEMA machvon_bi GRANT SELECT ON TABLES TO machvon_bi_auditor/.test(text)) problems.push(`${rule.setup}: every view of machvon_bi, present and future, must be granted to ${rule.auditRole}`);
}

function shipProblems(rule, text, problems) {
  if (text === undefined) return;
  if (!/BI_AUDIT_SINK/.test(text) || !/directory:/.test(text) || !/syslog:/.test(text)) problems.push(`${rule.ship}: the sink must be directory: or syslog:`);
  if (!/before "\$\{day\}" "\$\{LIMIT\}" && \[ -f "\$\{LEDGER\}\/\$\{name\}\.shipped" \]/.test(text)) problems.push(`${rule.ship}: a file may be removed only when it is older than the retention AND is in the ledger of shipped files`);
  if (!/-ge 365/.test(text)) problems.push(`${rule.ship}: the retention must be refused below 365 days`);
}

function installProblems(rule, text, problems) {
  if (text === undefined) return;
  const composeLine = /^COMPOSE="docker compose [^"]*"$/m.exec(text)?.[0] ?? '';
  if (/compose\.bi\.yaml/.test(composeLine)) problems.push(`${rule.install}: the base COMPOSE command must not include compose.bi.yaml: it is added only under --with-bi`);
  const opening = text.indexOf('if [ "${WITH_BI}" -eq 1 ]; then');
  const added = text.indexOf('compose.bi.yaml', opening);
  if (!/--with-bi\)/.test(text) || opening === -1 || added === -1) problems.push(`${rule.install}: compose.bi.yaml must be added only inside the --with-bi branch`);
  for (const needle of ['bi-render.sh --check', 'iptables -S MACHVON-BI', 'secrets-bi.json', 'bi-audit-setup.sql']) if (!text.includes(needle)) problems.push(`${rule.install}: the BI branch must run or check ${needle}`);
  if (!/WITH_BI=0/.test(text)) problems.push(`${rule.install}: the BI port must default to off (WITH_BI=0)`);
}

function dockerfileProblems(rule, text, problems) {
  if (text === undefined) return;
  const installs = text.replace(/\\\n/g, ' ').split('\n').filter((line) => /apt-get install/.test(line));
  if (!installs.some((line) => line.includes(rule.pgauditPackage))) problems.push(`${rule.dockerfile}: the database image must install ${rule.pgauditPackage} (the audit of the BI port)`);
  if (!/COPY[^\n]*bi-tls-prepare\.sh \/usr\/local\/bin\/bi-tls-prepare/.test(text)) problems.push(`${rule.dockerfile}: the image must carry bi-tls-prepare`);
}

/**
 * All the rules of the BI port. `parse` turns YAML text into a value (undefined when no parser is available: the compose rules are then not judged, the text rules still are).
 */
export function checkBiPort(root, rule, parse) {
  const problems = [];
  const baseText = read(root, rule.base);
  const overrideText = read(root, rule.override);
  if (baseText !== undefined && /BI_LISTEN_ADDRESS/.test(baseText)) problems.push(`${rule.base}: the BI port is declared only in ${rule.override}`);
  const secretsText = read(root, rule.secrets);
  let secrets;
  try {
    secrets = secretsText === undefined ? undefined : JSON.parse(secretsText);
  } catch {
    problems.push(`${rule.secrets}: malformed`);
  }
  const mainSecrets = (() => {
    try {
      return JSON.parse(read(root, 'infra/onprem/secrets.json') ?? '{}').secrets?.map((entry) => entry.name) ?? [];
    } catch {
      return [];
    }
  })();
  for (const entry of secrets?.secrets ?? []) if (mainSecrets.includes(entry.name)) problems.push(`${rule.secrets}: ${entry.name} is also in secrets.json: install.sh would then require it when the port is off`);
  if (parse !== undefined && baseText !== undefined && overrideText !== undefined) {
    const base = parse(baseText);
    const override = parse(overrideText);
    const isDocument = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
    if (!isDocument(base) || !isDocument(override)) problems.push(`${rule.override}: the compose files are not readable as compose documents`);
    else composeProblems(rule, base, override, secrets, problems);
  }
  envProblems(rule, read(root, rule.env), problems);
  hbaProblems(rule, read(root, rule.hba), problems);
  firewallProblems(rule, read(root, rule.firewall), problems);
  setupProblems(rule, read(root, rule.setup), problems);
  shipProblems(rule, read(root, rule.ship), problems);
  installProblems(rule, read(root, rule.install), problems);
  dockerfileProblems(rule, read(root, rule.dockerfile), problems);
  return problems;
}
