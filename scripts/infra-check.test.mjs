import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FINDING_CODES, infraCheck, main } from './infra-check.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The tiny plan knows every story the real components name, plus two of its own.
const REAL_STORIES = readdirSync(join(REPO_ROOT, 'infra', 'components')).flatMap((file) => JSON.parse(readFileSync(join(REPO_ROOT, 'infra', 'components', file), 'utf8')).firstStories);
const PLAN = { stories: [...new Set([...REAL_STORIES, 'ST-A', 'ST-B'])].map((id) => ({ id })) };

const cleanups = [];

// A scratch repository: the real infra/ and its runbooks, a tiny plan, and the edits of one case applied on top.
function scratch(edit = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'machvon-infra-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(REPO_ROOT, 'infra'), join(root, 'infra'), { recursive: true });
  if (existsSync(join(REPO_ROOT, 'docs', 'runbooks', 'infra'))) {
    cpSync(join(REPO_ROOT, 'docs', 'runbooks', 'infra'), join(root, 'docs', 'runbooks', 'infra'), { recursive: true });
  }
  const planPath = join(root, 'plan.json');
  writeFileSync(planPath, JSON.stringify(PLAN));
  const api = {
    root,
    planPath,
    json(path, change) {
      const file = join(root, path);
      const value = JSON.parse(readFileSync(file, 'utf8'));
      const next = change(value) ?? value;
      writeFileSync(file, JSON.stringify(next, null, 2));
    },
    text(path, change) {
      const file = join(root, path);
      writeFileSync(file, change(readFileSync(file, 'utf8')));
    },
    write(path, content) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    },
  };
  edit(api);
  return api;
}

process.on('exit', () => cleanups.forEach((clean) => clean()));

const codesOf = (result) => result.findings.map((entry) => entry.code);
const run = (s) => infraCheck(s.root, { planPath: s.planPath });

test('the real infra directory passes and every component is planned, none entered', () => {
  const result = infraCheck(REPO_ROOT);
  assert.deepEqual(result.findings, []);
  assert.equal(result.components.length, 8);
  assert.ok(result.components.every((component) => component.state === 'PLANNED' && component.entered === false));
});

test('a resource outside Vietnam is reported with the resource and its environment (AC-ST-KERNEL-011-1)', () => {
  const s = scratch((api) => api.json('infra/environments/production.json', (env) => { env.resources[0].region = 'SG-1'; }));
  const result = run(s);
  assert.deepEqual(codesOf(result), ['RESIDENCY_REGION']);
  assert.match(result.findings[0].detail, /pg-primary/);
  assert.match(result.findings[0].file, /production\.json$/);
});

test('a replica, a log sink and a telemetry endpoint outside Vietnam are each reported (AC-ST-KERNEL-011-1)', () => {
  const s = scratch((api) =>
    api.json('infra/environments/staging.json', (env) => {
      env.resources.find((r) => r.id === 'objects').replicaRegion = 'US-EAST-1';
      env.resources.find((r) => r.id === 'log-sink').region = 'EU-WEST-1';
      env.resources.find((r) => r.id === 'telemetry').region = 'AP-SOUTH-1';
    }),
  );
  const details = run(s).findings.map((entry) => entry.detail).join(' ');
  assert.match(details, /objects/);
  assert.match(details, /log-sink/);
  assert.match(details, /telemetry/);
});

test('a backup target in the same region as the primary, or none at all, is a missing second site', () => {
  const same = scratch((api) => api.json('infra/environments/production.json', (env) => { env.resources.find((r) => r.id === 'pg-wal-archive').region = 'VN-HAN-1'; }));
  assert.deepEqual(codesOf(run(same)), ['SECOND_SITE_MISSING']);
  const none = scratch((api) => api.json('infra/environments/dr.json', (env) => { env.resources = env.resources.filter((r) => r.role !== 'backup-target'); }));
  assert.deepEqual(codesOf(run(none)), ['SECOND_SITE_MISSING']);
});

test('an egress endpoint outside Vietnam is refused unless it carries only PUBLIC data and an approved transfer assessment (AC-ST-KERNEL-011-2)', () => {
  const internal = scratch((api) => api.json('infra/environments/production.json', (env) => { env.egress.push({ id: 'ai', host: 'api.openai.com', dataClasses: ['INTERNAL'] }); }));
  assert.deepEqual(codesOf(run(internal)), ['EGRESS_HOST']);
  const publicOnly = scratch((api) => api.json('infra/environments/production.json', (env) => { env.egress.push({ id: 'ai', host: 'api.example.com', dataClasses: ['PUBLIC'] }); }));
  assert.deepEqual(codesOf(run(publicOnly)), ['EGRESS_HOST']);
  const assessed = scratch((api) => api.json('infra/environments/production.json', (env) => { env.egress.push({ id: 'ai', host: 'api.example.com', dataClasses: ['PUBLIC'], transferAssessment: 'TA-2026-001' }); }));
  assert.deepEqual(codesOf(run(assessed)), []);
});

test('foreign egress needs a stated classification: a missing or empty list is not "PUBLIC only"', () => {
  for (const dataClasses of [undefined, [], 'PUBLIC']) {
    const s = scratch((api) =>
      api.json('infra/environments/production.json', (env) => {
        env.egress.push({ id: 'ai', host: 'api.example.com', transferAssessment: 'TA-2026-001', ...(dataClasses === undefined ? {} : { dataClasses }) });
      }),
    );
    assert.deepEqual(codesOf(run(s)), ['EGRESS_HOST'], JSON.stringify(dataClasses));
  }
});

test('credentials, key and realm names must not be shared by two environments (AC-ST-KERNEL-011-3)', () => {
  for (const key of ['credentials', 'kmsKey', 'keycloakRealm']) {
    const s = scratch((api) => {
      const staging = JSON.parse(readFileSync(join(api.root, 'infra/environments/staging.json'), 'utf8'));
      api.json('infra/environments/production.json', (env) => { env[key] = staging[key]; });
    });
    const result = run(s);
    assert.ok(codesOf(result).includes('ENV_SHARED'), key);
    assert.match(result.findings.find((f) => f.code === 'ENV_SHARED').detail, new RegExp(key));
  }
});

test('real data below production is refused, masked refreshes need the masked flag (AC-ST-KERNEL-011-3)', () => {
  const real = scratch((api) => api.json('infra/environments/staging.json', (env) => { env.dataClass = 'real'; }));
  assert.deepEqual(codesOf(run(real)), ['PRODUCTION_DATA_BELOW']);
  const unmasked = scratch((api) => api.json('infra/environments/staging.json', (env) => { env.maskedRefresh.masked = false; }));
  assert.deepEqual(codesOf(run(unmasked)), ['PRODUCTION_DATA_BELOW']);
});

function entered(api, name, change = () => {}) {
  api.json(`infra/components/${name}.json`, (component) => {
    component.state = 'IN_USE';
    component.restoreEvidence = { path: `docs/runbooks/infra/evidence/${name}.md`, verifiedVersion: component.version, restoredAt: '2026-10-24' };
    change(component);
  });
  api.write(`docs/runbooks/infra/evidence/${name}.md`, '# Restore evidence\n');
}

test('the entry gate passes when the runbook, the restore evidence and the alerts all exist (AC-ST-KERNEL-015-1, AC-ST-KERNEL-040-3)', () => {
  const s = scratch((api) => entered(api, 'postgres'));
  const result = run(s);
  assert.deepEqual(result.findings, []);
  assert.equal(result.components.find((c) => c.name === 'postgres').entered, true);
});

test('the entry gate fails naming the missing runbook, restore test or alert, one at a time (AC-ST-KERNEL-015-1)', () => {
  const noRunbook = scratch((api) => entered(api, 'postgres', (c) => { c.runbook = 'docs/runbooks/infra/absent.md'; }));
  assert.deepEqual(codesOf(run(noRunbook)), ['COMPONENT_RUNBOOK_MISSING']);
  const noEvidence = scratch((api) => entered(api, 'postgres', (c) => { c.restoreEvidence = null; }));
  assert.deepEqual(codesOf(run(noEvidence)), ['COMPONENT_RESTORE_MISSING']);
  const missingFile = scratch((api) => entered(api, 'postgres', (c) => { c.restoreEvidence.path = 'docs/runbooks/infra/evidence/nope.md'; }));
  assert.deepEqual(codesOf(run(missingFile)), ['COMPONENT_RESTORE_MISSING']);
  // Evidence is a file: a version number alone, an empty path and a directory are not.
  for (const evidence of [{ verifiedVersion: '18' }, { path: '', verifiedVersion: '18' }, { path: 'docs/runbooks/infra', verifiedVersion: '18' }, { path: 42, verifiedVersion: '18' }]) {
    const notAFile = scratch((api) => entered(api, 'postgres', (c) => { c.restoreEvidence = evidence; }));
    assert.deepEqual(codesOf(run(notAFile)), ['COMPONENT_RESTORE_MISSING'], JSON.stringify(evidence));
    assert.equal(run(notAFile).components.find((c) => c.name === 'postgres').entered, false);
  }
  const noAlert = scratch((api) => entered(api, 'postgres', (c) => { c.alerts = [...c.alerts, 'pg-does-not-exist']; }));
  assert.deepEqual(codesOf(run(noAlert)), ['COMPONENT_ALERT_MISSING']);
  const noAlerts = scratch((api) => entered(api, 'postgres', (c) => { c.alerts = []; }));
  assert.deepEqual(codesOf(run(noAlerts)), ['COMPONENT_ALERT_MISSING']);
});

test('LiteLLM and Langfuse enter use only with a runbook, a successful restore test and an alert (AC-ST-LLM-002-3, UAT-NFR-OPERABILITY-01)', () => {
  const name = 'litellm-langfuse';
  const planned = run(scratch());
  assert.equal(planned.components.find((c) => c.name === name).entered, false);
  const ready = run(scratch((api) => entered(api, name)));
  assert.deepEqual(ready.findings, []);
  assert.equal(ready.components.find((c) => c.name === name).entered, true);
  const noRunbook = scratch((api) => entered(api, name, (c) => { c.runbook = 'docs/runbooks/infra/absent.md'; }));
  assert.deepEqual(codesOf(run(noRunbook)), ['COMPONENT_RUNBOOK_MISSING']);
  const noRestore = scratch((api) => entered(api, name, (c) => { c.restoreEvidence = null; }));
  assert.deepEqual(codesOf(run(noRestore)), ['COMPONENT_RESTORE_MISSING']);
  const noAlert = scratch((api) => entered(api, name, (c) => { c.alerts = []; }));
  assert.deepEqual(codesOf(run(noAlert)), ['COMPONENT_ALERT_MISSING']);
  const unknownAlert = scratch((api) => entered(api, name, (c) => { c.alerts = ['llm-cost-spike', 'llm-does-not-exist']; }));
  assert.deepEqual(codesOf(run(unknownAlert)), ['COMPONENT_ALERT_MISSING']);
  // The alerts the component names are the real cost and route alerts of this slice.
  const ids = readdirSync(join(REPO_ROOT, 'infra', 'alerts')).flatMap((file) => JSON.parse(readFileSync(join(REPO_ROOT, 'infra', 'alerts', file), 'utf8')).map((rule) => rule.id));
  const component = JSON.parse(readFileSync(join(REPO_ROOT, 'infra', 'components', `${name}.json`), 'utf8'));
  assert.deepEqual(component.alerts.filter((alert) => !ids.includes(alert)), []);
  assert.ok(component.alerts.includes('llm-cost-spike') && component.alerts.includes('llm-route-errors'));
});

test('restore evidence older than the component version is stale (AC-ST-KERNEL-015-2)', () => {
  const s = scratch((api) => entered(api, 'postgres', (c) => { c.restoreEvidence.verifiedVersion = '17'; }));
  assert.deepEqual(codesOf(run(s)), ['EVIDENCE_STALE']);
});

test('a planned component may lack evidence but its stories are listed as blocked; unknown stories are findings', () => {
  const s = scratch((api) => {
    api.json('infra/components/postgres.json', (c) => { c.firstStories = ['ST-A', 'ST-GONE']; });
  });
  const result = run(s);
  assert.deepEqual(codesOf(result), ['STORY_UNKNOWN']);
  assert.deepEqual(result.blockedStories.filter((entry) => entry.component === 'postgres'), [{ story: 'ST-A', component: 'postgres', missing: 'restore test' }]);
});

test('--require-entered fails for a planned component and names what is missing, and passes once entered (AC-ST-KERNEL-002-3)', () => {
  const planned = scratch();
  const lines = [];
  assert.equal(main(['--root', planned.root, '--plan', planned.planPath, '--require-entered', 'postgres'], { log: (line) => lines.push(line) }), 1);
  assert.ok(lines.some((line) => /restore/i.test(line)));
  const ready = scratch((api) => entered(api, 'postgres'));
  assert.equal(main(['--root', ready.root, '--plan', ready.planPath, '--require-entered', 'postgres'], { log: () => undefined }), 0);
  assert.equal(main(['--root', ready.root, '--plan', ready.planPath, '--require-entered', 'nonexistent'], { log: () => undefined }), 2);
});

test('secrets: an inline value, a bad reference, a long rotation and a missing reference are findings', () => {
  const inline = scratch((api) => api.json('infra/environments/staging.json', (env) => { env.databasePassword = 'Sup3rS3cretValue'; }));
  assert.ok(codesOf(run(inline)).includes('SECRET_INLINE'));
  const url = scratch((api) => api.json('infra/environments/staging.json', (env) => { env.databaseUrl = 'postgres://admin:hunter2hunter2@db.internal:5432/app'; }));
  assert.ok(codesOf(run(url)).includes('SECRET_INLINE'));
  const bad = scratch((api) => api.json('infra/secrets/references.json', (file) => { file.secrets[0].ref = 'vault:abc'; }));
  assert.ok(codesOf(run(bad)).includes('SECRET_REF_INVALID'));
  const rotation = scratch((api) => api.json('infra/secrets/references.json', (file) => { file.secrets[0].rotationDays = 365; }));
  assert.ok(codesOf(run(rotation)).includes('SECRET_ROTATION'));
  const missing = scratch((api) => api.json('infra/environments/production.json', (env) => { env.credentials = 'secret://production/not-listed'; }));
  assert.ok(codesOf(run(missing)).includes('SECRET_REF_MISSING'));
});

test('pipelines: production needs an approval, a canary by cohort that starts small, and a fast rollback', () => {
  const noApproval = scratch((api) => api.json('infra/pipelines/production.json', (p) => { p.approval.required = false; }));
  assert.deepEqual(codesOf(run(noApproval)), ['PIPELINE_APPROVAL']);
  const noCohorts = scratch((api) => api.json('infra/pipelines/production.json', (p) => { p.canary.cohorts = ['all']; }));
  assert.deepEqual(codesOf(run(noCohorts)), ['PIPELINE_CANARY']);
  const bigFirstStep = scratch((api) => api.json('infra/pipelines/production.json', (p) => { p.canary.stepsPercent = [50, 100]; }));
  assert.deepEqual(codesOf(run(bigFirstStep)), ['PIPELINE_CANARY']);
  const slowRollback = scratch((api) => api.json('infra/pipelines/production.json', (p) => { p.rollback.maxMinutes = 60; }));
  assert.deepEqual(codesOf(run(slowRollback)), ['PIPELINE_ROLLBACK']);
  const noCanaryAtAll = scratch((api) => api.json('infra/pipelines/production.json', (p) => { delete p.canary; }));
  assert.deepEqual(codesOf(run(noCanaryAtAll)), ['PIPELINE_CANARY']);
});

test('AC-ST-KERNEL-052-2 UAT-NFR-AVAILABILITY-01 pipelines: a spent error budget must stop feature releases, allow reliability and security fixes, and ask for a post-mortem within 5 working days', () => {
  const broken = (change) => scratch((api) => api.json('infra/pipelines/production.json', (p) => change(p.errorBudget)));
  assert.deepEqual(codesOf(run(broken((budget) => { budget.blockedKinds = []; }))), ['PIPELINE_ERROR_BUDGET']);
  assert.deepEqual(codesOf(run(broken((budget) => { budget.allowedKinds = ['reliability']; }))), ['PIPELINE_ERROR_BUDGET']);
  assert.deepEqual(codesOf(run(broken((budget) => { budget.allowedKinds = ['security']; }))), ['PIPELINE_ERROR_BUDGET']);
  assert.deepEqual(codesOf(run(broken((budget) => { budget.allowedKinds = ['reliability', 'security', 'feature']; }))), ['PIPELINE_ERROR_BUDGET']);
  assert.deepEqual(codesOf(run(broken((budget) => { budget.postMortemWorkingDays = 6; }))), ['PIPELINE_ERROR_BUDGET']);
  assert.deepEqual(codesOf(run(broken((budget) => { budget.postMortemWorkingDays = 0; }))), ['PIPELINE_ERROR_BUDGET']);
  assert.deepEqual(codesOf(run(broken((budget) => { budget.maxReportAgeMinutes = 0; }))), ['PIPELINE_ERROR_BUDGET']);
  const noPolicy = scratch((api) => api.json('infra/pipelines/production.json', (p) => { delete p.errorBudget; }));
  assert.ok(codesOf(run(noPolicy)).includes('PIPELINE_ERROR_BUDGET'));
  assert.deepEqual(codesOf(run(scratch(() => undefined))), []);
});

test('postgres: archive timeout, WAL level and recovery targets follow the design', () => {
  const timeout = scratch((api) => api.text('infra/postgres/postgresql.conf.tpl', (text) => text.replace('archive_timeout = 60s', 'archive_timeout = 300s')));
  assert.deepEqual(codesOf(run(timeout)), ['POSTGRES_ARCHIVE_TIMEOUT']);
  // Zero disables the forced WAL switch: it is not "below the maximum", it is no bound at all.
  for (const value of ['0', '0s', '0min']) {
    const disabled = scratch((api) => api.text('infra/postgres/postgresql.conf.tpl', (text) => text.replace('archive_timeout = 60s', `archive_timeout = ${value}`)));
    assert.deepEqual(codesOf(run(disabled)), ['POSTGRES_ARCHIVE_TIMEOUT'], value);
  }
  const level = scratch((api) => api.text('infra/postgres/postgresql.conf.tpl', (text) => text.replace('wal_level = logical', 'wal_level = replica')));
  assert.deepEqual(codesOf(run(level)), ['POSTGRES_WAL_LEVEL']);
  const rpo = scratch((api) => api.json('infra/postgres/backup.json', (b) => { b.rpoMinutes = 60; }));
  assert.deepEqual(codesOf(run(rpo)), ['BACKUP_TARGET']);
  const retention = scratch((api) => api.json('infra/postgres/backup.json', (b) => { b.pitrRetentionDays = 7; }));
  assert.deepEqual(codesOf(run(retention)), ['BACKUP_TARGET']);
});

test('keycloak: the control-plane client needs its own audience and WebAuthn for the platform roles (AC-ST-KERNEL-042-2)', () => {
  const noWebauthn = scratch((api) => api.json('infra/keycloak/realm-template.json', (r) => { r.clients[1].requiredWebAuthnRealmRoles = []; }));
  assert.deepEqual(codesOf(run(noWebauthn)), ['KEYCLOAK_CONTROL_CLIENT']);
  const sameAudience = scratch((api) => api.json('infra/keycloak/realm-template.json', (r) => { r.clients[1].audience = 'machvon-api'; }));
  assert.deepEqual(codesOf(run(sameAudience)), ['KEYCLOAK_CONTROL_CLIENT']);
  const noClient = scratch((api) => api.json('infra/keycloak/realm-template.json', (r) => { r.clients = r.clients.slice(0, 1); }));
  assert.deepEqual(codesOf(run(noClient)), ['KEYCLOAK_CONTROL_CLIENT']);
});

test('keycloak: five wrong passwords within 15 minutes lock the account for 15 minutes, and the lock is temporary (AC-ST-IAM-002-1, UAT-AC124)', () => {
  const { bruteForce } = JSON.parse(readFileSync(join(REPO_ROOT, 'infra', 'keycloak', 'realm-template.json'), 'utf8'));
  const FIFTEEN_MINUTES = 15 * 60;
  assert.equal(bruteForce.failureFactor, 5);
  assert.equal(bruteForce.maxDeltaTimeSeconds, FIFTEEN_MINUTES, 'the failures count within a window of 15 minutes');
  assert.equal(bruteForce.waitIncrementSeconds, FIFTEEN_MINUTES, 'the first lock lasts 15 minutes');
  assert.equal(bruteForce.maxFailureWaitSeconds, FIFTEEN_MINUTES, 'repeated locks do not grow beyond 15 minutes');
  assert.equal(bruteForce.permanentLockout, false);
});

test('alerts: the channel must be independent of the product, each rule needs an owner and an existing runbook', () => {
  const channel = scratch((api) => api.json('infra/alerts/postgres.json', (rules) => { rules[0].channel = 'notification-center'; }));
  assert.deepEqual(codesOf(run(channel)), ['ALERT_CHANNEL']);
  const owner = scratch((api) => api.json('infra/alerts/postgres.json', (rules) => { rules[0].owner = ''; }));
  assert.deepEqual(codesOf(run(owner)), ['ALERT_OWNER']);
  const runbook = scratch((api) => api.json('infra/alerts/postgres.json', (rules) => { rules[0].runbook = 'docs/runbooks/infra/missing.md#x'; }));
  assert.deepEqual(codesOf(run(runbook)), ['ALERT_RUNBOOK']);
});

// The rule as the repository declares it, and the runbook heading its anchor points at.
function declaredRule(id) {
  for (const file of readdirSync(join(REPO_ROOT, 'infra', 'alerts'))) {
    const found = JSON.parse(readFileSync(join(REPO_ROOT, 'infra', 'alerts', file), 'utf8')).find((rule) => rule.id === id);
    if (found !== undefined) return found;
  }
  throw new Error(`no alert rule ${id}`);
}

function runbookHasHeading(runbookWithAnchor) {
  const [path, anchor] = runbookWithAnchor.split('#');
  const headings = readFileSync(join(REPO_ROOT, path), 'utf8').split(/\r?\n/).filter((line) => line.startsWith('#')).map((line) => line.replace(/^#+\s*/, '').trim().toLowerCase().replace(/\s+/g, '-'));
  return headings.includes(anchor);
}

test('replication delayed by 120 seconds pages the on-call channel within 5 minutes, with an owner and a runbook that has its section (AC-ST-KERNEL-045-2, UAT-NFR-OBSERVABILITY-02)', () => {
  const rule = declaredRule('powersync-sync-lag');
  const threshold = /above (\d+) s\b/.exec(rule.expr);
  assert.ok(threshold !== null, `the expression names a lag threshold in seconds: ${rule.expr}`);
  const FAULT_SECONDS = 120;
  assert.ok(FAULT_SECONDS > Number(threshold[1]), 'a lag of 120 seconds is above the threshold');
  assert.ok(rule.forMinutes > 0 && rule.forMinutes <= 5, 'the rule fires after at most 5 minutes above the threshold');
  assert.equal(rule.channel, 'ops-pager');
  assert.ok(typeof rule.owner === 'string' && rule.owner.trim() !== '');
  assert.ok(runbookHasHeading(rule.runbook), `the runbook ${rule.runbook} has the section the alert links to`);
  // The rule is what the component names, and the whole check finds nothing wrong with it.
  assert.ok(JSON.parse(readFileSync(join(REPO_ROOT, 'infra', 'components', 'powersync.json'), 'utf8')).alerts.includes('powersync-sync-lag'));
  assert.deepEqual(infraCheck(REPO_ROOT).findings, []);
  // A rule that loses its owner or its channel is a finding.
  const noOwner = scratch((api) => api.json('infra/alerts/powersync.json', (rules) => { rules[0].owner = ''; }));
  assert.deepEqual(codesOf(run(noOwner)), ['ALERT_OWNER']);
  const notThePager = scratch((api) => api.json('infra/alerts/powersync.json', (rules) => { rules[0].channel = 'notification-center'; }));
  assert.deepEqual(codesOf(run(notThePager)), ['ALERT_CHANNEL']);
});

test('the cost alert rule has an owner, the on-call channel and a runbook with its section (AC-ST-KERNEL-046-3, UAT-NFR-AI-03)', () => {
  const rule = declaredRule('llm-cost-spike');
  assert.ok(typeof rule.owner === 'string' && rule.owner.trim() !== '');
  assert.equal(rule.channel, 'ops-pager');
  assert.ok(runbookHasHeading(rule.runbook), `the runbook ${rule.runbook} has the section the alert links to`);
  const noOwner = scratch((api) => api.json('infra/alerts/litellm-langfuse.json', (rules) => { rules[0].owner = ' '; }));
  assert.deepEqual(codesOf(run(noOwner)), ['ALERT_OWNER']);
  const noRunbook = scratch((api) => api.json('infra/alerts/litellm-langfuse.json', (rules) => { rules[0].runbook = 'docs/runbooks/infra/absent.md#cost'; }));
  assert.deepEqual(codesOf(run(noRunbook)), ['ALERT_RUNBOOK']);
});

test('a malformed JSON file is a finding, not a crash', () => {
  const s = scratch((api) => api.write('infra/environments/broken.json', '{ not json'));
  assert.ok(codesOf(run(s)).includes('INFRA_FILE_INVALID'));
});

test('every finding code has a message in both languages and main reports them with the file', () => {
  for (const locale of ['vi', 'en']) {
    const messages = JSON.parse(readFileSync(join(REPO_ROOT, 'scripts', 'messages', `${locale}.json`), 'utf8'));
    for (const code of FINDING_CODES) assert.ok(messages[`infra.${code}`], `${locale} ${code}`);
    for (const key of ['infra.summary.pass', 'infra.summary.fail', 'infra.component.pending', 'infra.story.blocked', 'infra.usage']) assert.ok(messages[key], `${locale} ${key}`);
  }
  const s = scratch((api) => api.json('infra/environments/production.json', (env) => { env.resources[0].region = 'SG-1'; }));
  const lines = [];
  assert.equal(main(['--root', s.root, '--plan', s.planPath, '--locale', 'en'], { log: (line) => lines.push(line) }), 1);
  assert.ok(lines.some((line) => line.includes('production.json') && line.includes('pg-primary')));
});

test('main exits 2 on an unknown option and 0 on the real repository', () => {
  assert.equal(main(['--bogus'], { log: () => undefined }), 2);
  assert.equal(main(['--root', REPO_ROOT], { log: () => undefined }), 0);
});
