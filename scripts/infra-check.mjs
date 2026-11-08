import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkArtefacts } from './infra-artefacts.mjs';
import { loadOnpremMessages } from './onprem-messages.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_LOCALE = 'vi';
const DEFAULT_PLAN = 'Design/MACHVON_Design/03_Engineering/implementation_plan.json';
const CONTROL_AUDIENCE = 'machvon-control';
const PRODUCTION_LIKE = new Set(['production', 'dr']);
const SECRET_KEY = /(password|passwd|secret|api[_-]?key|token|private[_-]?key)$/i;
const TEMPLATE_VALUE = /^\$\{[^}]*\}$/;
const URL_CREDENTIALS = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@/i;
const TEXT_SECRET = /^\s*[A-Za-z_]*(?:password|passwd|secret|token)\s*=\s*(?!\$\{)\S+/im;
const MISSING_LABEL = { runbook: 'runbook', restore: 'restore test', alert: 'alert' };

export const FINDING_CODES = [
  'INFRA_FILE_INVALID',
  'RESIDENCY_REGION',
  'SECOND_SITE_MISSING',
  'EGRESS_HOST',
  'ENV_SHARED',
  'PRODUCTION_DATA_BELOW',
  'COMPONENT_UNKNOWN',
  'COMPONENT_RUNBOOK_MISSING',
  'COMPONENT_RESTORE_MISSING',
  'COMPONENT_ALERT_MISSING',
  'EVIDENCE_STALE',
  'STORY_UNKNOWN',
  'SECRET_INLINE',
  'SECRET_REF_INVALID',
  'SECRET_REF_MISSING',
  'SECRET_ROTATION',
  'PIPELINE_APPROVAL',
  'PIPELINE_CANARY',
  'PIPELINE_ROLLBACK',
  'PIPELINE_ERROR_BUDGET',
  'POSTGRES_ARCHIVE_TIMEOUT',
  'POSTGRES_WAL_LEVEL',
  'BACKUP_TARGET',
  'KEYCLOAK_CONTROL_CLIENT',
  'ALERT_CHANNEL',
  'ALERT_OWNER',
  'ALERT_RUNBOOK',
];

function loadMessages(locale) {
  return JSON.parse(readFileSync(join(SCRIPT_DIR, 'messages', `${locale}.json`), 'utf8'));
}

function format(template, params) {
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

const finding = (code, file, detail = '') => ({ code, file, detail });

function* jsonFiles(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* jsonFiles(path);
    else if (entry.name.endsWith('.json')) yield path;
  }
}

// Reads every JSON file under infra/ once; a file that does not parse is a finding and is left out of the maps.
function readInfra(root, findings) {
  const files = new Map();
  for (const path of jsonFiles(join(root, 'infra'))) {
    const rel = relative(root, path).split(sep).join('/');
    try {
      files.set(rel, JSON.parse(readFileSync(path, 'utf8')));
    } catch (error) {
      findings.push(finding('INFRA_FILE_INVALID', rel, error instanceof Error ? error.message : 'unreadable'));
    }
  }
  return files;
}

const filesIn = (files, prefix) => [...files].filter(([rel]) => rel.startsWith(prefix));
const isString = (value) => typeof value === 'string' && value.trim() !== '';
const isVietnamese = (host, policy) =>
  policy.egress.allowedHosts.includes(host) || policy.egress.allowedHostSuffixes.some((suffix) => host.endsWith(suffix));

function hostOf(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return String(value);
  }
}

function checkEnvironments(files, policy, findings) {
  const shared = { credentials: new Map(), kmsKey: new Map(), keycloakRealm: new Map() };
  const environments = filesIn(files, 'infra/environments/');
  for (const [rel, env] of environments) {
    const local = policy.localEnvironments.includes(env.name);
    for (const resource of env.resources ?? []) {
      for (const field of ['region', 'replicaRegion']) {
        const region = resource[field];
        if (region === undefined) continue;
        const allowed = policy.allowedRegions.includes(region) || (local && region === policy.localRegion);
        if (!allowed) findings.push(finding('RESIDENCY_REGION', rel, `${resource.id}: ${field} ${region}`));
      }
      if (resource.endpoint !== undefined && !isVietnamese(hostOf(resource.endpoint), policy)) {
        findings.push(finding('RESIDENCY_REGION', rel, `${resource.id}: endpoint ${resource.endpoint}`));
      }
    }
    if (policy.secondSiteEnvironments.includes(env.name)) {
      const primary = (env.resources ?? []).find((r) => r.component === 'postgres' && r.role === 'primary');
      const second = (env.resources ?? []).some((r) => r.role === 'backup-target' && primary !== undefined && r.region !== primary.region);
      if (!second) findings.push(finding('SECOND_SITE_MISSING', rel, env.name));
    }
    for (const endpoint of env.egress ?? []) {
      if (isVietnamese(endpoint.host, policy)) continue;
      // "Only PUBLIC" must be stated: no classification is not the same as nothing sensitive.
      const publicOnly = Array.isArray(endpoint.dataClasses) && endpoint.dataClasses.length > 0 && endpoint.dataClasses.every((cls) => cls === 'PUBLIC');
      const assessed = !policy.egress.foreignRequiresTransferAssessment || isString(endpoint.transferAssessment);
      if (!(publicOnly && assessed)) findings.push(finding('EGRESS_HOST', rel, `${endpoint.id}: ${endpoint.host}`));
    }
    if (env.dataClass === 'real' && !PRODUCTION_LIKE.has(env.name)) findings.push(finding('PRODUCTION_DATA_BELOW', rel, `${env.name}: real data`));
    const refresh = env.maskedRefresh;
    if (refresh?.source === 'production' && !(refresh.masked === true && isString(refresh.approvedBy))) {
      findings.push(finding('PRODUCTION_DATA_BELOW', rel, `${env.name}: refresh from production without masking and approval`));
    }
    for (const key of Object.keys(shared)) {
      if (env[key] === undefined) continue;
      shared[key].set(env[key], [...(shared[key].get(env[key]) ?? []), { env: env.name, rel }]);
    }
  }
  for (const [key, values] of Object.entries(shared)) {
    for (const [value, users] of values) {
      if (users.length > 1) findings.push(finding('ENV_SHARED', users[1].rel, `${key} ${value} is used by ${users.map((u) => u.env).join(', ')}`));
    }
  }
  return environments;
}

function walkStrings(value, path, visit) {
  if (typeof value === 'string') visit(path, value);
  else if (Array.isArray(value)) value.forEach((item, index) => walkStrings(item, `${path}[${index}]`, visit));
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) walkStrings(item, path === '' ? key : `${path}.${key}`, visit);
  }
}

function checkInlineSecrets(root, files, findings) {
  for (const [rel, content] of files) {
    walkStrings(content, '', (path, value) => {
      const key = path.split('.').pop()?.replace(/\[\d+\]$/, '') ?? '';
      const keyed = SECRET_KEY.test(key) && value !== '' && !value.startsWith('secret://') && !TEMPLATE_VALUE.test(value);
      if (keyed || URL_CREDENTIALS.test(value)) findings.push(finding('SECRET_INLINE', rel, path));
    });
  }
  const conf = join(root, 'infra', 'postgres', 'postgresql.conf.tpl');
  if (existsSync(conf) && TEXT_SECRET.test(readFileSync(conf, 'utf8'))) findings.push(finding('SECRET_INLINE', 'infra/postgres/postgresql.conf.tpl', 'a secret value'));
}

function checkSecrets(files, operations, environments, findings) {
  const rel = 'infra/secrets/references.json';
  const listed = new Set();
  const pattern = new RegExp(operations.secrets.reference);
  for (const secret of files.get(rel)?.secrets ?? []) {
    listed.add(secret.ref);
    if (!pattern.test(String(secret.ref))) findings.push(finding('SECRET_REF_INVALID', rel, String(secret.ref)));
    if (!Number.isInteger(secret.rotationDays) || secret.rotationDays < 1 || secret.rotationDays > operations.secrets.maxRotationDays) {
      findings.push(finding('SECRET_ROTATION', rel, `${secret.name}: ${secret.rotationDays}`));
    }
  }
  for (const [envRel, env] of environments) {
    if (!pattern.test(String(env.credentials))) findings.push(finding('SECRET_REF_INVALID', envRel, String(env.credentials)));
    else if (!listed.has(env.credentials)) findings.push(finding('SECRET_REF_MISSING', envRel, env.credentials));
  }
}

function checkPipelines(files, operations, findings) {
  const rel = 'infra/pipelines/production.json';
  const pipeline = files.get(rel);
  if (pipeline === undefined) return;
  const rules = operations.pipelines;
  if (rules.productionRequiresApproval && pipeline.approval?.required !== true) findings.push(finding('PIPELINE_APPROVAL', rel, 'production deploys without an approval'));
  const canary = pipeline.canary;
  const steps = canary?.stepsPercent ?? [];
  if (canary === undefined || (canary.cohorts ?? []).length < rules.minCanaryCohorts || steps[0] > rules.maxFirstCanaryPercent || steps[steps.length - 1] !== 100) {
    findings.push(finding('PIPELINE_CANARY', rel, 'a canary by tenant cohort that starts small and ends at 100 percent is required'));
  }
  if (!(pipeline.rollback?.maxMinutes <= rules.maxRollbackMinutes)) findings.push(finding('PIPELINE_ROLLBACK', rel, `rollback within ${rules.maxRollbackMinutes} minutes`));
  checkErrorBudget(rel, pipeline.errorBudget, rules, findings);
}

// A spent error budget stops feature releases and lets reliability and security fixes through (ST-KERNEL-052).
function checkErrorBudget(rel, policy, rules, findings) {
  const kinds = (list) => (Array.isArray(list) ? list : []);
  const blocked = kinds(policy?.blockedKinds);
  const allowed = kinds(policy?.allowedKinds);
  const problems = [];
  if (!blocked.includes('feature')) problems.push('feature releases must be blocked');
  if (!['reliability', 'security'].every((kind) => allowed.includes(kind))) problems.push('reliability and security fixes must be allowed');
  if (blocked.some((kind) => allowed.includes(kind))) problems.push('a kind cannot be both blocked and allowed');
  if (!(Number.isInteger(policy?.postMortemWorkingDays) && policy.postMortemWorkingDays >= 1 && policy.postMortemWorkingDays <= rules.maxPostMortemWorkingDays)) {
    problems.push(`the post-mortem is due within ${rules.maxPostMortemWorkingDays} working days`);
  }
  if (!(Number.isInteger(policy?.maxReportAgeMinutes) && policy.maxReportAgeMinutes >= 1)) problems.push('the budget report needs a maximum age in minutes');
  for (const problem of problems) findings.push(finding('PIPELINE_ERROR_BUDGET', rel, problem));
}

function seconds(value) {
  const match = /^(\d+)\s*(s|min|ms)?$/.exec(String(value).trim());
  if (match === null) return Number.NaN;
  const amount = Number(match[1]);
  return match[2] === 'min' ? amount * 60 : match[2] === 'ms' ? amount / 1000 : amount;
}

function checkPostgres(root, files, operations, findings) {
  const rules = operations.postgres;
  const confRel = 'infra/postgres/postgresql.conf.tpl';
  const conf = join(root, confRel);
  if (existsSync(conf)) {
    const settings = new Map();
    for (const line of readFileSync(conf, 'utf8').split(/\r?\n/)) {
      const match = /^\s*([a-z_]+)\s*=\s*(.+?)\s*$/.exec(line);
      if (match !== null && !line.trim().startsWith('#')) settings.set(match[1], match[2].replace(/^'|'$/g, ''));
    }
    // Zero turns the forced WAL switch off, so the timeout must be above zero as well as under the maximum.
    const archiveTimeout = seconds(settings.get('archive_timeout'));
    if (!(archiveTimeout > 0 && archiveTimeout <= rules.maxArchiveTimeoutSeconds)) findings.push(finding('POSTGRES_ARCHIVE_TIMEOUT', confRel, String(settings.get('archive_timeout'))));
    if (settings.get('wal_level') !== rules.walLevel) findings.push(finding('POSTGRES_WAL_LEVEL', confRel, String(settings.get('wal_level'))));
  }
  const backupRel = 'infra/postgres/backup.json';
  const backup = files.get(backupRel);
  if (backup === undefined) return;
  if (!(backup.rpoMinutes <= rules.maxRpoMinutes)) findings.push(finding('BACKUP_TARGET', backupRel, `rpoMinutes ${backup.rpoMinutes}`));
  if (!(backup.rtoHours <= rules.maxRtoHours)) findings.push(finding('BACKUP_TARGET', backupRel, `rtoHours ${backup.rtoHours}`));
  if (!(backup.pitrRetentionDays >= rules.pitrRetentionDays)) findings.push(finding('BACKUP_TARGET', backupRel, `pitrRetentionDays ${backup.pitrRetentionDays}`));
}

function checkKeycloak(files, findings) {
  const rel = 'infra/keycloak/realm-template.json';
  const realm = files.get(rel);
  if (realm === undefined) return;
  const control = (realm.clients ?? []).find((client) => client.clientId === 'machvon-control');
  const others = (realm.clients ?? []).filter((client) => client !== control);
  const roles = control?.requiredWebAuthnRealmRoles ?? [];
  const broken =
    control === undefined ||
    control.audience !== CONTROL_AUDIENCE ||
    others.some((client) => client.audience === CONTROL_AUDIENCE) ||
    !roles.includes('SystemAdmin');
  if (broken) findings.push(finding('KEYCLOAK_CONTROL_CLIENT', rel, 'the control-plane client needs its own audience and WebAuthn for SystemAdmin'));
}

function checkAlerts(root, files, operations, findings) {
  const ids = new Set();
  for (const [rel, rules] of filesIn(files, 'infra/alerts/')) {
    for (const rule of Array.isArray(rules) ? rules : []) {
      ids.add(rule.id);
      if (rule.channel !== operations.alerts.requiredChannel || operations.alerts.forbiddenChannels.includes(rule.channel)) findings.push(finding('ALERT_CHANNEL', rel, `${rule.id}: ${rule.channel}`));
      if (!isString(rule.owner)) findings.push(finding('ALERT_OWNER', rel, String(rule.id)));
      const runbook = String(rule.runbook ?? '').split('#')[0];
      if (!isString(runbook) || !existsSync(join(root, runbook))) findings.push(finding('ALERT_RUNBOOK', rel, `${rule.id}: ${rule.runbook}`));
    }
  }
  return ids;
}

const major = (version) => {
  const match = /^(\d+)/.exec(String(version));
  return match === null ? undefined : Number(match[1]);
};

function evidenceStale(component) {
  const verified = component.restoreEvidence.verifiedVersion;
  if (verified === component.version) return false;
  const [a, b] = [major(verified), major(component.version)];
  return a === undefined || b === undefined || a < b;
}

/** Evidence is a file of the repository: a missing path, an empty one or a directory is no evidence. */
function isRegularFile(root, path) {
  if (!isString(path)) return false;
  const file = join(root, path);
  return existsSync(file) && statSync(file).isFile();
}

function checkComponents(root, files, operations, alertIds, plan, findings) {
  const result = [];
  const blockedStories = [];
  const stories = plan === undefined ? undefined : new Set(plan.stories.map((story) => story.id));
  for (const [rel, component] of filesIn(files, 'infra/components/')) {
    const inUse = component.state === 'IN_USE';
    if (!operations.entry.states.includes(component.state)) findings.push(finding('COMPONENT_UNKNOWN', rel, `state ${component.state}`));
    const missing = [];
    if (!isString(component.runbook) || !existsSync(join(root, component.runbook))) missing.push('runbook');
    const evidence = component.restoreEvidence;
    if (!isRegularFile(root, evidence?.path)) missing.push('restore');
    const alerts = component.alerts ?? [];
    const unknownAlerts = alerts.filter((id) => !alertIds.has(id));
    if (alerts.length === 0 || unknownAlerts.length > 0) missing.push('alert');
    for (const id of unknownAlerts) findings.push(finding('COMPONENT_ALERT_MISSING', rel, `${component.name}: alert ${id} is not defined`));
    const stale = evidence !== null && evidence !== undefined && !missing.includes('restore') && evidenceStale(component);
    if (inUse) {
      if (missing.includes('runbook')) findings.push(finding('COMPONENT_RUNBOOK_MISSING', rel, component.name));
      if (missing.includes('restore')) findings.push(finding('COMPONENT_RESTORE_MISSING', rel, component.name));
      if (alerts.length === 0) findings.push(finding('COMPONENT_ALERT_MISSING', rel, `${component.name}: no alert rule`));
      if (stale) findings.push(finding('EVIDENCE_STALE', rel, `${component.name}: evidence for ${evidence.verifiedVersion}, component ${component.version}`));
    }
    const entered = inUse && missing.length === 0 && !stale;
    result.push({ name: component.name, state: component.state, entered, missing: missing.map((item) => MISSING_LABEL[item]), stale });
    for (const story of component.firstStories ?? []) {
      if (stories !== undefined && !stories.has(story)) findings.push(finding('STORY_UNKNOWN', rel, `${component.name}: ${story}`));
      else if (!entered) blockedStories.push({ story, component: component.name, missing: MISSING_LABEL[missing[0] ?? 'restore'] });
    }
  }
  return { components: result, blockedStories };
}

function loadPlan(root, planPath) {
  const path = planPath ?? join(root, DEFAULT_PLAN);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Checks the declarative infrastructure under infra/: residency and egress, second site, environment separation,
 * secrets as references only, pipelines, the PostgreSQL settings, the Keycloak realm template, the alert rules and the
 * entry gate of every component (runbook, restore evidence for the current version, alert rules: ST-KERNEL-015).
 */
export function infraCheck(root, options = {}) {
  const findings = [];
  const files = readInfra(root, findings);
  const residency = files.get('infra/policies/residency.json');
  const operations = files.get('infra/policies/operations.json');
  if (residency === undefined || operations === undefined) {
    findings.push(finding('INFRA_FILE_INVALID', 'infra/policies', 'residency.json and operations.json are required'));
    return { findings, components: [], blockedStories: [] };
  }
  const environments = checkEnvironments(files, residency, findings);
  checkInlineSecrets(root, files, findings);
  checkSecrets(files, operations, environments, findings);
  checkPipelines(files, operations, findings);
  checkPostgres(root, files, operations, findings);
  checkKeycloak(files, findings);
  // The on-prem artefacts (INFRA-1): images, compose, TLS and headers, identity, backups, scanning workflows (scripts/infra-artefacts.mjs, rules in infra/policies/artefacts.json).
  findings.push(...checkArtefacts(root).findings);
  const alertIds = checkAlerts(root, files, operations, findings);
  const plan = loadPlan(root, options.planPath);
  const { components, blockedStories } = checkComponents(root, files, operations, alertIds, plan, findings);
  return { findings, components, blockedStories };
}

export function main(argv, { log = console.log } = {}) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        root: { type: 'string', default: REPO_ROOT },
        plan: { type: 'string' },
        locale: { type: 'string', default: DEFAULT_LOCALE },
        'require-entered': { type: 'string' },
      },
    }));
  } catch {
    log(loadMessages(DEFAULT_LOCALE)['infra.usage']);
    return 2;
  }
  const messages = { ...loadMessages(values.locale), ...loadOnpremMessages(values.locale) };
  const result = infraCheck(resolve(values.root), { planPath: values.plan === undefined ? undefined : resolve(values.plan) });
  for (const entry of result.findings) log(`${entry.file}: ${format(messages[`infra.${entry.code}`], { detail: entry.detail })}`);
  for (const component of result.components.filter((item) => !item.entered)) {
    log(format(messages['infra.component.pending'], { component: component.name, missing: component.missing.join(', ') || component.state }));
  }
  for (const blocked of result.blockedStories) log(format(messages['infra.story.blocked'], blocked));
  let failures = result.findings.length;
  const required = values['require-entered'];
  if (required !== undefined) {
    const component = result.components.find((item) => item.name === required);
    if (component === undefined) {
      log(format(messages['infra.COMPONENT_UNKNOWN'], { detail: required }));
      return 2;
    }
    if (!component.entered) {
      failures += 1;
      log(format(messages['infra.component.notEntered'], { component: required, missing: component.missing.join(', ') || component.state }));
    }
  }
  log(failures === 0 ? messages['infra.summary.pass'] : format(messages['infra.summary.fail'], { count: failures }));
  return failures === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
