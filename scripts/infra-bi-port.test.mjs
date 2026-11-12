import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBiPort, settingsOf } from './infra-bi-port.mjs';

// INT-2 (TH.02): the opt-in read-only BI port of the database in the offline bundle. Two kinds of test. The static rules are run on mutated copies of the real files: each mutation opens the port wider
// than the rules allow (or removes a lock) and must be reported. The scripts that decide something (bi-render.sh, bi-firewall.sh, bi-audit-ship.sh) are RUN with a POSIX shell, with the negative
// cases first: a wrong setting stops them and nothing is written, a source that is not on the allowlist is dropped, a log file that was not shipped is never removed.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(REPO_ROOT, 'infra', 'onprem', 'config');
const RULE = JSON.parse(readFileSync(join(REPO_ROOT, 'infra', 'policies', 'artefacts.json'), 'utf8')).biPort;
const yaml = createRequire(import.meta.url)('js-yaml');
const parse = (text) => {
  try {
    return yaml.load(text);
  } catch {
    return undefined;
  }
};
const cleanups = [];
process.on('exit', () => cleanups.forEach((clean) => clean()));

const temp = (prefix) => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};

/** A scratch repository holding what the BI rules read, and the edits of one case. An edit that changes nothing fails the case: it would otherwise pass without testing anything. */
function scratch(edit = () => {}) {
  const root = temp('machvon-bi-port-');
  cpSync(join(REPO_ROOT, 'infra', 'onprem'), join(root, 'infra', 'onprem'), { recursive: true });
  const api = {
    root,
    text(path, change) {
      const file = join(root, path);
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
  };
  edit(api);
  return api;
}

const problemsOf = (api) => checkBiPort(api.root, RULE, parse);
const found = (api, pattern) => {
  const problems = problemsOf(api);
  assert.ok(problems.some((detail) => pattern.test(detail)), `no problem matched ${pattern}: ${JSON.stringify(problems)}`);
};

const OVERRIDE = 'infra/onprem/compose/compose.bi.yaml';
const BASE = 'infra/onprem/compose/compose.yaml';
const ENV = 'infra/onprem/compose/env.template';
const HBA = 'infra/onprem/config/pg_hba-bi.conf.template';
const FIREWALL = 'infra/onprem/config/bi-firewall.sh';
const SETUP = 'infra/onprem/config/bi-audit-setup.sql';
const SHIP = 'infra/onprem/config/bi-audit-ship.sh';
const INSTALL = 'infra/onprem/bundle/install.sh';
const DOCKERFILE = 'infra/onprem/docker/db.Dockerfile';

// ---- the static rules --------------------------------------------------------------------------------------------------------------------------------------------------------------------

test('the real files keep every rule of the BI port: closed by default, narrow when on', () => {
  assert.deepEqual(problemsOf(scratch()), []);
});

test('the settings of a postgres command list are read as the server reads them, the last value of a name winning', () => {
  const settings = settingsOf(['postgres', '-c', 'ssl=off', '-c', 'archive_command=pgbackrest --stanza=machvon archive-push %p', '-c', 'ssl=on']);
  assert.equal(settings.get('ssl'), 'on');
  assert.equal(settings.get('archive_command'), 'pgbackrest --stanza=machvon archive-push %p');
  assert.equal(settingsOf(undefined).size, 0);
});

test('the port is published only by the override, on one required address, and never on every address', () => {
  found(scratch((s) => s.text(OVERRIDE, (t) => t.replace(/- "\$\{BI_LISTEN_ADDRESS:\?[^"]*"/, '- "0.0.0.0:${BI_PORT}:5432"'))), /exactly one port/);
  found(scratch((s) => s.text(OVERRIDE, (t) => t.replace(/- "\$\{BI_LISTEN_ADDRESS:\?[^"]*"/, '- "${BI_LISTEN_ADDRESS:-0.0.0.0}:${BI_PORT}:5432"'))), /exactly one port/);
  found(scratch((s) => s.text(OVERRIDE, (t) => t.replace(/- "\$\{BI_LISTEN_ADDRESS:\?[^"]*"/, '- "${BI_LISTEN_ADDRESS:?x}:${BI_PORT}:5432/udp"'))), /exactly one port/);
  found(scratch((s) => s.text(OVERRIDE, (t) => t.replace(/- "\$\{BI_LISTEN_ADDRESS:\?[^"]*"/, '- "${BI_LISTEN_ADDRESS:?x}:${BI_PORT}:5432"\n      - "5432:5432"'))), /exactly one port/);
  found(scratch((s) => s.text(BASE, (t) => t.replace('    networks: [data, egress]\n    entrypoint: ["/usr/local/bin/secret-env", "docker-entrypoint.sh"]', '    networks: [data, egress]\n    ports:\n      - "5432:5432"\n    entrypoint: ["/usr/local/bin/secret-env", "docker-entrypoint.sh"]'))), /db publishes a port/);
  found(scratch((s) => s.text(BASE, (t) => `${t}\n# ports: "\${BI_LISTEN_ADDRESS}:5433:5432"\n`)), /declared only in/);
});

test('the override touches the database only and adds no privilege', () => {
  found(scratch((s) => s.text(OVERRIDE, (t) => t.replace('services:\n  db:', 'services:\n  web:\n    ports: ["8443:8443"]\n  db:'))), /only the database may be touched/);
  found(scratch((s) => s.text(OVERRIDE, (t) => t.replace('  db:\n    # compose merges', '  db:\n    privileged: true\n    # compose merges'))), /db\.privileged must not be set/);
  found(scratch((s) => s.text(OVERRIDE, (t) => t.replace('  db:\n    # compose merges', '  db:\n    cap_add: [NET_ADMIN]\n    # compose merges'))), /db\.cap_add must not be set/);
  found(scratch((s) => s.text(OVERRIDE, (t) => t.replace('  db:\n    # compose merges', '  db:\n    network_mode: host\n    # compose merges'))), /db\.network_mode/);
});

test('TLS: on, 1.2 or newer, ECDHE suites only, the files bi-tls-prepare writes', () => {
  found(scratch((s) => s.text(OVERRIDE, (t) => t.replace('      - ssl=on', '      - ssl=off'))), /set ssl to on/);
  found(scratch((s) => s.text(OVERRIDE, (t) => t.replace('ssl_min_protocol_version=TLSv1.2', 'ssl_min_protocol_version=TLSv1.1'))), /ssl_min_protocol_version/);
  found(scratch((s) => s.text(OVERRIDE, (t) => t.replace('ECDHE-ECDSA-AES256-GCM-SHA384:', 'ECDHE-RSA-AES256-SHA:ECDHE-ECDSA-AES256-GCM-SHA384:'))), /ECDHE suites only/);
  found(scratch((s) => s.text(OVERRIDE, (t) => t.replace('ECDHE-ECDSA-AES256-GCM-SHA384:', 'AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:'))), /ECDHE suites only/);
  found(scratch((s) => s.text(OVERRIDE, (t) => t.replace('ssl_key_file=/run/machvon-bi-tls/server.key', 'ssl_key_file=/etc/ssl/private/site.key'))), /bi-tls-prepare writes/);
  found(scratch((s) => s.text(OVERRIDE, (t) => t.replace('entrypoint: ["/usr/local/bin/secret-env", "/usr/local/bin/bi-tls-prepare", "docker-entrypoint.sh"]', 'entrypoint: ["/usr/local/bin/secret-env", "docker-entrypoint.sh"]'))), /bi-tls-prepare/);
  found(scratch((s) => s.text(OVERRIDE, (t) => t.replace('    tmpfs:\n      - /run/machvon-bi-tls:size=1m,mode=0700\n', ''))), /must be a tmpfs/);
});

test('authentication: SCRAM only, the rendered pg_hba file, a short time to authenticate', () => {
  found(scratch((s) => s.text(OVERRIDE, (t) => t.replace('password_encryption=scram-sha-256', 'password_encryption=md5'))), /password_encryption/);
  found(scratch((s) => s.text(OVERRIDE, (t) => t.replace('      - hba_file=/etc/machvon-bi/pg_hba.conf\n', '      - hba_file=/var/lib/postgresql/pg_hba.conf\n'))), /hba_file/);
  found(scratch((s) => s.text(OVERRIDE, (t) => t.replace('authentication_timeout=10s', 'authentication_timeout=1min'))), /authentication_timeout/);
  found(scratch((s) => s.text(OVERRIDE, (t) => t.replace(':/etc/machvon-bi/pg_hba.conf:ro"', ':/etc/machvon-bi/pg_hba.conf"'))), /read-only/);
});

test('audit: pgaudit preloaded by the base file and in object mode on the audit role, connections logged, a daily file in the audit volume', () => {
  found(scratch((s) => s.text(BASE, (t) => t.replace('      - shared_preload_libraries=pgaudit\n', ''))), /preload pgaudit/);
  found(scratch((s) => s.text(OVERRIDE, (t) => t.replace('shared_preload_libraries=pgaudit', 'shared_preload_libraries=pg_stat_statements'))), /shared_preload_libraries/);
  found(scratch((s) => s.text(OVERRIDE, (t) => t.replace('pgaudit.role=machvon_bi_auditor', 'pgaudit.role=machvon_owner'))), /pgaudit\.role/);
  found(scratch((s) => s.text(OVERRIDE, (t) => t.replace('log_connections=on', 'log_connections=off'))), /log_connections/);
  found(scratch((s) => s.text(OVERRIDE, (t) => t.replace('log_disconnections=on', 'log_disconnections=off'))), /log_disconnections/);
  found(scratch((s) => s.text(OVERRIDE, (t) => t.replace('logging_collector=on', 'logging_collector=off'))), /logging_collector/);
  found(scratch((s) => s.text(OVERRIDE, (t) => t.replace('log_rotation_age=1d', 'log_rotation_age=7d'))), /log_rotation_age/);
  found(scratch((s) => s.text(OVERRIDE, (t) => t.replace('      - dbaudit:/var/log/machvon-audit\n', ''))), /dbaudit volume/);
});

test('the override repeats every setting of the base command: a drift is reported', () => {
  found(scratch((s) => s.text(OVERRIDE, (t) => t.replace('archive_timeout=60s', 'archive_timeout=10min'))), /archive_timeout differs/);
  found(scratch((s) => s.text(BASE, (t) => t.replace('      - max_replication_slots=10\n', '      - max_replication_slots=10\n      - -c\n      - synchronous_commit=on\n'))), /synchronous_commit differs/);
});

test('the TLS files are secrets of the override only, the same list everywhere, never in secrets.json', () => {
  found(scratch((s) => s.text(OVERRIDE, (t) => t.replace('    secrets:\n      - db_tls_cert\n      - db_tls_key\n', '    secrets:\n      - db_tls_cert\n'))), /same list/);
  found(scratch((s) => s.text(OVERRIDE, (t) => t.replace('file: ${MACHVON_SECRETS_DIR}/db_tls_key', 'file: /etc/ssl/private/site.key'))), /db_tls_key must be the file/);
  found(scratch((s) => s.json('infra/onprem/secrets-bi.json', (d) => { d.secrets.push({ name: 'forgotten', purpose: 'x', readers: ['db'], generate: 'x', rotationDays: 90, reference: 'secret://onprem/forgotten' }); })), /same list/);
  found(scratch((s) => s.json('infra/onprem/secrets.json', (d) => { d.secrets.push({ name: 'db_tls_cert', purpose: 'x', readers: ['db'], generate: 'x', rotationDays: 90, reference: 'secret://onprem/db_tls_cert' }); })), /also in secrets\.json/);
});

test('the environment template ships the port closed: off, no address, no source, no sink, a retention of a year or more', () => {
  found(scratch((s) => s.text(ENV, (t) => t.replace('MACHVON_BI=off', 'MACHVON_BI=on'))), /MACHVON_BI must be off/);
  found(scratch((s) => s.text(ENV, (t) => t.replace('BI_LISTEN_ADDRESS=\n', 'BI_LISTEN_ADDRESS=0.0.0.0\n'))), /BI_LISTEN_ADDRESS must be empty/);
  found(scratch((s) => s.text(ENV, (t) => t.replace('BI_ALLOWED_CIDRS=\n', 'BI_ALLOWED_CIDRS=0.0.0.0/0\n'))), /BI_ALLOWED_CIDRS must be empty/);
  found(scratch((s) => s.text(ENV, (t) => t.replace('BI_AUDIT_SINK=\n', 'BI_AUDIT_SINK=directory:/mnt/logs\n'))), /BI_AUDIT_SINK must be empty/);
  found(scratch((s) => s.text(ENV, (t) => t.replace('BI_AUDIT_RETENTION_DAYS=400', 'BI_AUDIT_RETENTION_DAYS=30'))), /at least 365/);
  found(scratch((s) => s.text(ENV, (t) => t.replace('BI_PORT=5433', 'BI_PORT=80'))), /BI_PORT/);
  found(scratch((s) => s.text(ENV, (t) => t.replace('BI_MAX_CONNECTIONS_PER_ADDRESS=20', 'BI_MAX_CONNECTIONS_PER_ADDRESS=0'))), /BI_MAX_CONNECTIONS_PER_ADDRESS/);
});

test('pg_hba: the BI group over TLS from the allowed addresses only, everyone else from the compose networks, nothing trusted but the local socket, a rejecting last line', () => {
  found(scratch((s) => s.text(HBA, (t) => t.replace('host        all        all                  all               reject\n', ''))), /last line must reject/);
  found(scratch((s) => s.text(HBA, (t) => t.replace('host        all        +machvon_bi_reader   all               reject\n', ''))), /must be rejected before any other rule/);
  found(scratch((s) => s.text(HBA, (t) => t.replace('host        all        all                  samenet           scram-sha-256', 'host        all        all                  0.0.0.0/0         scram-sha-256'))), /0\.0\.0\.0\/0 allows every address/);
  found(scratch((s) => s.text(HBA, (t) => t.replace('host        all        all                  samenet           scram-sha-256', 'host        all        all                  samenet           trust'))), /only scram-sha-256 or reject/);
  found(scratch((s) => s.text(HBA, (t) => t.replace('host        all        all                  samenet           scram-sha-256', 'host        all        all                  samenet           md5'))), /only scram-sha-256 or reject/);
  found(scratch((s) => s.text(HBA, (t) => t.replace('local       all        all                                    trust', 'local       all        all                                    md5'))), /local socket is trusted/);
  found(scratch((s) => s.text(HBA, (t) => t.replace('@BI_HOSTSSL_LINES@\n', '@BI_HOSTSSL_LINES@\nhostnossl   machvon    +machvon_bi_reader   10.0.0.0/24       scram-sha-256\n'))), /without TLS/);
  found(scratch((s) => s.text(HBA, (t) => t.replace('@BI_HOSTSSL_LINES@\n', ''))), /marker/);
  found(scratch((s) => s.text(HBA, (t) => t.replace('host        all        all                  samenet           scram-sha-256\nhost        all        all                  all               reject', 'host        all        all                  all               scram-sha-256'))), /every address|samenet/);
  found(scratch((s) => s.text(HBA, (t) => t.replace('@BI_HOSTSSL_LINES@\nhost        all        +machvon_bi_reader   all               reject', 'host        all        +machvon_bi_reader   all               reject\n@BI_HOSTSSL_LINES@'))), /order must be/);
});

test('the firewall script: every ACCEPT names a source with a connection limit before it, no source is open, the chain ends in DROP and hooks DOCKER-USER for the original port', () => {
  found(scratch((s) => s.text(FIREWALL, (t) => t.replace('echo "iptables -A MACHVON-BI -j DROP"', 'echo "iptables -A MACHVON-BI -j ACCEPT"'))), /must end in -j DROP/);
  found(scratch((s) => s.text(FIREWALL, (t) => t.replace(/ {4}echo "iptables -A MACHVON-BI -s \$\{cidr\} -p tcp -m connlimit[^\n]*\n/, ''))), /connlimit/);
  found(scratch((s) => s.text(FIREWALL, (t) => t.replace('echo "iptables -A MACHVON-BI -s ${cidr} -p tcp -j ACCEPT"', 'echo "iptables -A MACHVON-BI -s 0.0.0.0/0 -p tcp -j ACCEPT"'))), /every source/);
  found(scratch((s) => s.text(FIREWALL, (t) => t.replace('echo "iptables -A MACHVON-BI -s ${cidr} -p tcp -j ACCEPT"', 'echo "iptables -A MACHVON-BI -p tcp -j ACCEPT"'))), /names no source/);
  found(scratch((s) => s.text(FIREWALL, (t) => t.replace(/--ctorigdstport \$\{PORT\}/g, ''))), /hooked into DOCKER-USER/);
  found(scratch((s) => s.text(FIREWALL, (t) => t.replace(/bi-render.sh/g, 'validate.sh'))), /validated by bi-render/);
});

test('the audit role: created NOLOGIN, granted SELECT on the views of machvon_bi only and to nobody else', () => {
  found(scratch((s) => s.text(SETUP, (t) => t.replace('CREATE ROLE machvon_bi_auditor NOLOGIN', 'CREATE ROLE machvon_bi_auditor LOGIN'))), /NOLOGIN/);
  found(scratch((s) => s.text(SETUP, (t) => `${t}\nGRANT SELECT ON machvon.period_snapshot TO PUBLIC;\n`)), /PUBLIC/);
  found(scratch((s) => s.text(SETUP, (t) => `${t}\nGRANT SELECT ON ALL TABLES IN SCHEMA machvon TO machvon_bi_auditor;\n`)), /more than SELECT on the views/);
  found(scratch((s) => s.text(SETUP, (t) => `${t}\nGRANT SELECT ON machvon_bi.%I TO machvon_app;\n`)), /a grant to machvon_app/);
  found(scratch((s) => s.text(SETUP, (t) => t.replace('ALTER DEFAULT PRIVILEGES FOR ROLE machvon_owner IN SCHEMA machvon_bi GRANT SELECT ON TABLES TO machvon_bi_auditor;\n', ''))), /present and future/);
});

test('the shipping script removes only what is shipped and past its retention, and refuses a short retention', () => {
  found(scratch((s) => s.text(SHIP, (t) => t.replace('if before "${day}" "${LIMIT}" && [ -f "${LEDGER}/${name}.shipped" ]; then', 'if before "${day}" "${LIMIT}"; then'))), /AND is in the ledger/);
  found(scratch((s) => s.text(SHIP, (t) => t.replace('-ge 365', '-ge 30'))), /below 365/);
});

test('install.sh adds the override only under --with-bi, starts with the port off, and checks the settings, the firewall chain, the TLS secrets and the audit role', () => {
  found(scratch((s) => s.text(INSTALL, (t) => t.replace('COMPOSE="docker compose --env-file ${ENV_FILE} -f ${BUNDLE}/infra/onprem/compose/compose.yaml"', 'COMPOSE="docker compose --env-file ${ENV_FILE} -f ${BUNDLE}/infra/onprem/compose/compose.yaml -f ${BUNDLE}/infra/onprem/compose/compose.bi.yaml"'))), /base COMPOSE command must not include/);
  found(scratch((s) => s.text(INSTALL, (t) => t.replace('WITH_BI=0', 'WITH_BI=1'))), /default to off/);
  found(scratch((s) => s.text(INSTALL, (t) => t.replace('iptables -S MACHVON-BI', 'iptables -S INPUT'))), /iptables -S MACHVON-BI/);
  found(scratch((s) => s.text(INSTALL, (t) => t.replace('bi-render.sh --check', 'bi-render.sh'))), /bi-render\.sh --check/);
});

test('the database image installs pgaudit and carries the TLS preparation step', () => {
  found(scratch((s) => s.text(DOCKERFILE, (t) => t.replace(' postgresql-18-pgaudit', ''))), /must install postgresql-18-pgaudit/);
  found(scratch((s) => s.text(DOCKERFILE, (t) => t.replace(/COPY[^\n]*bi-tls-prepare[^\n]*\n/, ''))), /carry bi-tls-prepare/);
});

test('a compose file that is not a document is reported, not a crash', () => {
  found(scratch((s) => s.text(OVERRIDE, (t) => `${t}\n  : : [`)), /not readable as compose documents/);
});

// ---- the scripts, run --------------------------------------------------------------------------------------------------------------------------------------------------------------------

const shell = (script, args, options = {}) => spawnSync('sh', [script, ...args], { encoding: 'utf8', ...options });

test('a POSIX shell is available and the BI scripts parse', () => {
  const probe = spawnSync('sh', ['-c', 'exit 0']);
  assert.equal(probe.status, 0, 'these tests need a POSIX shell (Git Bash on Windows)');
  for (const file of ['config/bi-render.sh', 'config/bi-firewall.sh', 'config/bi-audit-ship.sh', 'docker/bi-tls-prepare.sh', 'bundle/install.sh', 'bundle/rollback.sh']) {
    const result = shell('-n', [join(REPO_ROOT, 'infra', 'onprem', file)]);
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});

const GOOD = {
  BI_LISTEN_ADDRESS: '10.20.30.5',
  BI_PORT: '5433',
  BI_ALLOWED_CIDRS: '10.20.30.40/32, 10.50.0.0/24',
  BI_MAX_CONNECTIONS_PER_ADDRESS: '20',
  BI_CONFIG_DIR: '/etc/machvon/bi',
  BI_AUDIT_SINK: 'directory:/mnt/siem',
  BI_AUDIT_RETENTION_DAYS: '400',
};

/** An environment file of the shape install.sh reads (CRLF when asked, as a file edited on Windows would be). */
function envFile(values, crlf = false) {
  const directory = temp('machvon-bi-env-');
  const file = join(directory, 'compose.env');
  const eol = crlf ? '\r\n' : '\n';
  writeFileSync(file, `${Object.entries(values).map(([name, value]) => `${name}=${value}`).join(eol)}${eol}`);
  return { directory, file };
}

const render = (values, extra = [], crlf = false) => {
  const env = envFile(values, crlf);
  const out = join(env.directory, 'out');
  const result = shell(join(CONFIG, 'bi-render.sh'), ['--env-file', env.file, '--out', out, ...extra]);
  return { ...result, out, written: existsSync(join(out, 'pg_hba.conf')) };
};

test('bi-render writes a pg_hba.conf with one hostssl line per allowed address, before the rejection of the BI group and the internal rule', () => {
  for (const crlf of [false, true]) {
    const result = render(GOOD, [], crlf);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.written);
    const text = readFileSync(join(result.out, 'pg_hba.conf'), 'utf8');
    assert.ok(!text.includes('\r'), 'the file is written with LF line ends whatever the template had');
    const lines = text.split('\n').filter((line) => line !== '' && !line.startsWith('#'));
    assert.deepEqual(lines.map((line) => line.split(/\s+/).slice(0, 5).join(' ')), [
      'local all all trust',
      'hostssl machvon +machvon_bi_reader 10.20.30.40/32 scram-sha-256',
      'hostssl machvon +machvon_bi_reader 10.50.0.0/24 scram-sha-256',
      'host all +machvon_bi_reader all reject',
      'host all all samenet scram-sha-256',
      'host all all all reject',
    ]);
    assert.ok(!text.includes('@BI_HOSTSSL_LINES@'));
  }
});

test('bi-render --check validates and writes nothing', () => {
  const result = render(GOOD, ['--check']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.written, false);
  assert.match(result.stdout, /valid \(2 allowed source/);
});

test('bi-render refuses every setting that would open the port wider than the rules allow, and writes nothing', () => {
  const refused = [
    [{ BI_LISTEN_ADDRESS: '' }, /BI_LISTEN_ADDRESS is empty/],
    [{ BI_LISTEN_ADDRESS: '0.0.0.0' }, /never 0\.0\.0\.0/],
    [{ BI_LISTEN_ADDRESS: '224.0.0.1' }, /unicast IPv4/],
    [{ BI_LISTEN_ADDRESS: '300.1.1.1' }, /unicast IPv4/],
    [{ BI_LISTEN_ADDRESS: 'db.example.vn' }, /unicast IPv4/],
    [{ BI_LISTEN_ADDRESS: '::' }, /unicast IPv4/],
    [{ BI_PORT: '80' }, /BI_PORT/],
    [{ BI_PORT: 'abc' }, /BI_PORT/],
    [{ BI_PORT: '70000' }, /BI_PORT/],
    [{ BI_ALLOWED_CIDRS: '' }, /BI_ALLOWED_CIDRS is empty/],
    [{ BI_ALLOWED_CIDRS: '0.0.0.0/0' }, /prefix must be from \/16 to \/32/],
    [{ BI_ALLOWED_CIDRS: '10.0.0.0/8' }, /prefix must be from \/16 to \/32/],
    [{ BI_ALLOWED_CIDRS: '10.20.30.41/24' }, /host bits/],
    [{ BI_ALLOWED_CIDRS: '10.20.30.40' }, /not an IPv4 CIDR/],
    [{ BI_ALLOWED_CIDRS: '10.20.30.40/32,' }, /empty entry/],
    [{ BI_ALLOWED_CIDRS: '10.20.30.40/32,any' }, /not an IPv4 CIDR/],
    [{ BI_ALLOWED_CIDRS: '10.20.300.0/24' }, /not an IPv4 CIDR/],
    [{ BI_MAX_CONNECTIONS_PER_ADDRESS: '0' }, /BI_MAX_CONNECTIONS_PER_ADDRESS/],
    [{ BI_MAX_CONNECTIONS_PER_ADDRESS: '5000' }, /BI_MAX_CONNECTIONS_PER_ADDRESS/],
    [{ BI_AUDIT_SINK: '' }, /BI_AUDIT_SINK/],
    [{ BI_AUDIT_SINK: 'ftp://logs' }, /BI_AUDIT_SINK/],
    [{ BI_AUDIT_SINK: 'directory:relative/path' }, /BI_AUDIT_SINK/],
    [{ BI_AUDIT_RETENTION_DAYS: '30' }, /at least 365/],
    [{ BI_AUDIT_RETENTION_DAYS: '' }, /at least 365/],
  ];
  for (const [change, pattern] of refused) {
    const result = render({ ...GOOD, ...change });
    assert.equal(result.status, 1, JSON.stringify(change));
    assert.match(result.stderr, pattern, JSON.stringify(change));
    assert.equal(result.written, false, `${JSON.stringify(change)}: a refused setting must not write a file`);
  }
});

test('bi-render reads the environment of the shell without an environment file, and rejects an unknown argument', () => {
  const out = join(temp('machvon-bi-out-'), 'out');
  const fromShell = spawnSync('sh', [join(CONFIG, 'bi-render.sh'), '--out', out], { encoding: 'utf8', env: { ...process.env, ...GOOD } });
  assert.equal(fromShell.status, 0, fromShell.stderr);
  assert.ok(existsSync(join(out, 'pg_hba.conf')));
  const closed = spawnSync('sh', [join(CONFIG, 'bi-render.sh'), '--check'], { encoding: 'utf8', env: { ...process.env, BI_LISTEN_ADDRESS: '', BI_ALLOWED_CIDRS: '' } });
  assert.equal(closed.status, 1, 'with nothing set the port stays closed');
  assert.equal(shell(join(CONFIG, 'bi-render.sh'), ['--nope']).status, 2);
});

/** The verdict of the printed chain for a NEW connection from `source`: the first rule that matches decides; a connection-limit rule only matches above its limit, so it is skipped for a fresh one. */
function chainVerdict(printed, source) {
  const rules = printed.split('\n').map((line) => /^iptables -A MACHVON-BI (.*)$/.exec(line.trim())?.[1]).filter(Boolean);
  const octets = (ip) => ip.split('.').reduce((total, part) => total * 256 + Number(part), 0);
  for (const rule of rules) {
    if (rule.includes('--ctstate')) continue;
    if (rule.includes('connlimit')) continue;
    const from = /-s (\S+)/.exec(rule)?.[1];
    if (from !== undefined) {
      const [network, bits = '32'] = from.split('/');
      const mask = Number(bits) === 0 ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0;
      if (((octets(network) & mask) >>> 0) !== ((octets(source) & mask) >>> 0)) continue;
    }
    return rule.split('-j ')[1];
  }
  return 'NO_MATCH';
}

test('bi-firewall accepts the allowed sources, limits their connections, and drops every other source; nothing changes without --apply', () => {
  const env = envFile(GOOD);
  const printed = shell(join(CONFIG, 'bi-firewall.sh'), ['--env-file', env.file]);
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(chainVerdict(printed.stdout, '10.20.30.40'), 'ACCEPT');
  assert.equal(chainVerdict(printed.stdout, '10.50.0.7'), 'ACCEPT');
  assert.equal(chainVerdict(printed.stdout, '10.20.30.41'), 'DROP', 'a neighbour of an allowed host is not allowed');
  assert.equal(chainVerdict(printed.stdout, '10.50.1.7'), 'DROP');
  assert.equal(chainVerdict(printed.stdout, '203.0.113.9'), 'DROP');
  assert.equal(chainVerdict(printed.stdout, '127.0.0.1'), 'DROP');
  assert.match(printed.stdout, /-s 10\.20\.30\.40\/32 -p tcp -m connlimit --connlimit-above 20 --connlimit-mask 32 -j DROP/);
  assert.match(printed.stdout, /--ctorigdst 10\.20\.30\.5 --ctorigdstport 5433 -j MACHVON-BI/);
  assert.match(printed.stdout, /iptables -I DOCKER-USER 1/);
  assert.equal(printed.stdout.trim().split('\n').filter((line) => line.startsWith('iptables -A MACHVON-BI')).at(-1), 'iptables -A MACHVON-BI -j DROP');
});

test('bi-firewall prints nothing and fails when the settings are not valid or the port is closed', () => {
  for (const change of [{ BI_LISTEN_ADDRESS: '0.0.0.0' }, { BI_ALLOWED_CIDRS: '' }, { BI_ALLOWED_CIDRS: '0.0.0.0/0' }, { BI_AUDIT_SINK: '' }]) {
    const result = shell(join(CONFIG, 'bi-firewall.sh'), ['--env-file', envFile({ ...GOOD, ...change }).file]);
    assert.equal(result.status, 1, JSON.stringify(change));
    assert.equal(result.stdout, '', JSON.stringify(change));
  }
  assert.equal(shell(join(CONFIG, 'bi-firewall.sh'), ['--nope']).status, 2);
});

// ---- shipping the audit trail ----------------------------------------------------------------------------------------------------------------------------------------------------

function auditHost() {
  const base = temp('machvon-bi-audit-');
  const directory = join(base, 'volume');
  const sink = join(base, 'sink');
  const ledger = join(base, 'ledger');
  mkdirSync(directory);
  mkdirSync(sink);
  const write = (name, content) => writeFileSync(join(directory, name), content);
  return { base, directory, sink, ledger, write };
}

const ship = (host, values, today = '2026-11-12') => {
  const env = envFile({ BI_AUDIT_SINK: `directory:${host.sink}`, BI_AUDIT_RETENTION_DAYS: '400', ...values });
  return shell(join(CONFIG, 'bi-audit-ship.sh'), ['--env-file', env.file, '--directory', host.directory, '--ledger', host.ledger, '--today', today]);
};

test('bi-audit-ship sends every completed day to the sink, checks the copy, records it, and leaves today and a second run alone', () => {
  const host = auditHost();
  host.write('db-2026-11-10.log', 'AUDIT: OBJECT,1,1,READ,SELECT,VIEW,machvon_bi.v_dataset_catalogue\n');
  host.write('db-2026-11-11.log', 'AUDIT: OBJECT,1,1,READ,SELECT,VIEW,machvon_bi.v_disbursement_lines\n');
  host.write('db-2026-11-12.log', 'still being written\n');
  host.write('notes.txt', 'not an audit file\n');
  const first = ship(host, {});
  assert.equal(first.status, 0, first.stderr + first.stdout);
  assert.deepEqual(readdirSync(host.sink).sort(), ['db-2026-11-10.log', 'db-2026-11-11.log']);
  assert.equal(readFileSync(join(host.sink, 'db-2026-11-11.log'), 'utf8'), readFileSync(join(host.directory, 'db-2026-11-11.log'), 'utf8'));
  assert.deepEqual(readdirSync(host.ledger).sort(), ['db-2026-11-10.log.shipped', 'db-2026-11-11.log.shipped']);
  assert.match(readFileSync(join(host.ledger, 'db-2026-11-11.log.shipped'), 'utf8'), /^[0-9a-f]{64} {2}db-2026-11-11\.log\n$/);
  assert.ok(existsSync(join(host.directory, 'db-2026-11-11.log')), 'inside the retention nothing is removed from the host');
  const second = ship(host, {});
  assert.equal(second.status, 0);
  assert.doesNotMatch(second.stdout, /shipped db-/, 'a shipped file is not shipped twice');
});

test('bi-audit-ship never removes a file that was not shipped: a sink that fails keeps everything, the next run ships and then removes the old one', () => {
  const host = auditHost();
  host.write('db-2024-01-01.log', 'old line\n');
  host.write('db-2026-11-11.log', 'new line\n');
  const brokenSink = join(host.base, 'not-there');
  const failed = ship(host, { BI_AUDIT_SINK: `directory:${brokenSink}` });
  assert.equal(failed.status, 1);
  assert.ok(existsSync(join(host.directory, 'db-2024-01-01.log')), 'older than the retention but not shipped: it stays');
  assert.ok(existsSync(join(host.directory, 'db-2026-11-11.log')));
  assert.equal(existsSync(host.ledger) ? readdirSync(host.ledger).length : 0, 0, 'nothing is recorded as shipped');
  const mended = ship(host, {});
  assert.equal(mended.status, 0, mended.stderr);
  assert.deepEqual(readdirSync(host.sink).sort(), ['db-2024-01-01.log', 'db-2026-11-11.log']);
  assert.equal(existsSync(join(host.directory, 'db-2024-01-01.log')), false, 'shipped and past the retention: removed');
  assert.ok(existsSync(join(host.directory, 'db-2026-11-11.log')), 'shipped but inside the retention: kept');
  assert.match(mended.stdout, /removed db-2024-01-01\.log/);
});

test('bi-audit-ship refuses a missing sink, a retention under a year, an unknown sink kind and a directory that is not there', () => {
  const host = auditHost();
  host.write('db-2026-11-11.log', 'line\n');
  assert.match(ship(host, { BI_AUDIT_SINK: '' }).stderr, /nowhere to ship/);
  assert.match(ship(host, { BI_AUDIT_RETENTION_DAYS: '30' }).stderr, /at least 365/);
  assert.match(ship(host, { BI_AUDIT_RETENTION_DAYS: 'x' }).stderr, /must be a number/);
  const unknown = ship(host, { BI_AUDIT_SINK: 'ftp://logs' });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stdout, /neither directory: nor syslog:/);
  const env = envFile({ BI_AUDIT_SINK: `directory:${host.sink}`, BI_AUDIT_RETENTION_DAYS: '400' });
  assert.match(shell(join(CONFIG, 'bi-audit-ship.sh'), ['--env-file', env.file, '--directory', join(host.base, 'nope'), '--ledger', host.ledger]).stderr, /not a directory/);
  assert.equal(shell(join(CONFIG, 'bi-audit-ship.sh'), ['--nope']).status, 2);
  assert.equal(readdirSync(host.sink).length, 0, 'a refused run ships nothing');
});
