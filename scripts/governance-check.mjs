// Checks the governance rules of the platform (G0-1, G0-3 of docs/governance-roadmap-10of10.md): every built-in default of every rule type carries the formula it is read by, the source it comes from, the day it
// was taken (as-of) and whether it was confirmed against the legal text or with the customer (legalStatus); every default passes the schema of its own type; every type is owned by a module; the CHECK of the
// table `governance_rule` accepts the names the kernel registers; and every kind of work and every source of the alert centre has an ALERT_TYPE (owner, expected action, consequence, response time).
// The registry is read from the kernel itself (packages/kernel/src/governance-rules.ts, loaded as TypeScript by Node), so there is no second list to keep.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..');
const KERNEL_RULES = 'packages/kernel/src/governance-rules.ts';
const MIGRATIONS = 'db/migrations';
const HOME_RULES = 'packages/db/src/home-work-rules.ts';
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const LEGAL_STATUSES = ['VERIFIED', 'UNVERIFIED'];

export const FINDING_CODES = [
  'GOV_REGISTRY_UNREADABLE',
  'GOV_TYPE_NAME_INVALID',
  'GOV_TYPE_OWNER_MISSING',
  'GOV_TYPE_PROVENANCE_MISSING',
  'GOV_TYPE_NO_DEFAULT',
  'GOV_DEFAULT_PROVENANCE_MISSING',
  'GOV_DEFAULT_AS_OF_IN_FUTURE',
  'GOV_DEFAULT_LEGAL_FLAG',
  'GOV_DEFAULT_PARAMS_INVALID',
  'GOV_TABLE_PATTERN_MISMATCH',
  'GOV_ALERT_TYPE_MISSING',
];

const isDay = (value) => {
  if (typeof value !== 'string') return false;
  const match = DAY.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};
/** The business day in Vietnam (UTC+7), the day every as-of of the registry is written in. */
const vietnamToday = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const nextDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const present = (value, min) => typeof value === 'string' && value.trim().length >= min;

/** The kernel module, loaded as TypeScript (Node strips the types). */
export async function loadKernel(root = DEFAULT_ROOT) {
  return import(pathToFileURL(join(root, KERNEL_RULES)).href);
}

/** The pattern the migrations put on `rule_type` (`rule_type ~ '...'`), taken from the last migration that says one. */
function tablePattern(root) {
  const directory = join(root, MIGRATIONS);
  if (!existsSync(directory)) return undefined;
  let found;
  for (const name of readdirSync(directory).filter((entry) => /^V\d+__.*\.sql$/.test(entry)).sort()) {
    const match = /rule_type\s*~\s*'([^']+)'/.exec(readFileSync(join(directory, name), 'utf8'));
    if (match !== null) found = { pattern: match[1], file: name };
  }
  return found;
}

/** The keys of `CONSEQUENCES` and the values of `WORK_SOURCES` of the alert centre, read from its rules file when there is one. */
function alertCentreNames(root) {
  const path = join(root, HOME_RULES);
  if (!existsSync(path)) return { consequenceKeys: [], sources: [] };
  const text = readFileSync(path, 'utf8');
  const sources = /WORK_SOURCES\s*=\s*\[([^\]]*)\]/.exec(text);
  const consequences = /CONSEQUENCES[^=]*=\s*\{([\s\S]*?)\n\};/.exec(text);
  return {
    sources: sources === null ? [] : [...sources[1].matchAll(/'([A-Z0-9_]+)'/g)].map((match) => match[1]),
    consequenceKeys: consequences === null ? [] : [...consequences[1].matchAll(/^\s{2}([A-Z0-9_]+):/gm)].map((match) => match[1]),
  };
}

/**
 * Runs the checks and returns `{ findings, warnings, summary }`. `kernel` may be given (a module with `ruleTypeDefinitions`, `validateRuleParams`, `RULE_TYPE_PATTERN`); `today` is the day an as-of is
 * compared with. A warning does not fail the check (an alert type whose review day has passed is for a person to look at; it must not stop an unrelated change).
 */
export async function checkGovernance({ root = DEFAULT_ROOT, kernel, today = vietnamToday() } = {}) {
  const findings = [];
  const warnings = [];
  const add = (code, subject, message) => findings.push({ code, subject, message });
  let rules;
  try {
    rules = kernel ?? (await loadKernel(root));
    if (typeof rules.ruleTypeDefinitions !== 'function' || typeof rules.validateRuleParams !== 'function') throw new Error('the kernel does not export the registry');
  } catch (failure) {
    add('GOV_REGISTRY_UNREADABLE', KERNEL_RULES, `the rule registry could not be read: ${failure instanceof Error ? failure.message : String(failure)}`);
    return { findings, warnings, summary: { types: 0, defaults: 0, unverified: 0 } };
  }

  const typePattern = rules.RULE_TYPE_PATTERN instanceof RegExp ? rules.RULE_TYPE_PATTERN : /^[A-Z][A-Z0-9_]{2,63}$/;
  const summary = { types: 0, defaults: 0, unverified: 0 };
  const alertCodes = new Set();
  const alertSources = new Set();
  for (const definition of rules.ruleTypeDefinitions()) {
    summary.types += 1;
    const type = String(definition.type);
    if (!typePattern.test(type)) add('GOV_TYPE_NAME_INVALID', type, `${type} is not a well-formed rule type name`);
    if (!present(definition.ownerModule, 2)) add('GOV_TYPE_OWNER_MISSING', type, `${type} names no module that owns it`);
    const typeGaps = [
      !present(definition.formula, 8) && 'formula',
      !present(definition.source, 3) && 'source',
      !isDay(definition.asOf) && 'as-of',
      !LEGAL_STATUSES.includes(definition.legalStatus) && 'legal status',
    ].filter(Boolean);
    if (typeGaps.length > 0) add('GOV_TYPE_PROVENANCE_MISSING', type, `${type} lacks ${typeGaps.join(', ')}`);
    const codes = Object.keys(definition.defaults ?? {});
    if (codes.length === 0) add('GOV_TYPE_NO_DEFAULT', type, `${type} has no built-in default: nothing says what applies before a tenant approves a rule`);
    for (const code of codes) {
      const one = definition.defaults[code];
      const subject = `${type}/${code}`;
      summary.defaults += 1;
      if (one.legalStatus === 'UNVERIFIED') summary.unverified += 1;
      const gaps = [
        !present(one.formula, 8) && 'formula',
        !present(one.source, 3) && 'source',
        !isDay(one.asOf) && 'as-of',
        !LEGAL_STATUSES.includes(one.legalStatus) && 'legal status',
      ].filter(Boolean);
      if (gaps.length > 0) add('GOV_DEFAULT_PROVENANCE_MISSING', subject, `${subject} lacks ${gaps.join(', ')}`);
      // One day of tolerance: the clock of a machine in another time zone must not fail the check.
      if (isDay(one.asOf) && one.asOf > nextDay(today)) add('GOV_DEFAULT_AS_OF_IN_FUTURE', subject, `${subject} has an as-of (${one.asOf}) later than today (${today})`);
      if (one.unverified !== (one.legalStatus === 'UNVERIFIED')) add('GOV_DEFAULT_LEGAL_FLAG', subject, `${subject}: the unverified flag disagrees with the legal status ${String(one.legalStatus)}`);
      try {
        rules.validateRuleParams(type, one.params);
      } catch (failure) {
        add('GOV_DEFAULT_PARAMS_INVALID', subject, `${subject} does not pass the schema of ${type} (${failure?.detail ?? (failure instanceof Error ? failure.message : 'unknown')})`);
      }
      if (type === 'ALERT_TYPE') {
        alertCodes.add(code);
        if (typeof one.params?.source === 'string') alertSources.add(one.params.source);
        if (typeof one.params?.review_on === 'string' && one.params.review_on < today) warnings.push({ code: 'GOV_ALERT_REVIEW_OVERDUE', subject, message: `${subject} was due for review on ${one.params.review_on}` });
      }
    }
  }

  const stored = tablePattern(root);
  if (stored !== undefined && stored.pattern !== typePattern.source) {
    add('GOV_TABLE_PATTERN_MISMATCH', stored.file, `${stored.file} checks rule_type against ${stored.pattern} but the kernel registers names by ${typePattern.source}`);
  }

  const alerts = alertCentreNames(root);
  if (alertCodes.size > 0) {
    for (const key of alerts.consequenceKeys) if (!alertCodes.has(key)) add('GOV_ALERT_TYPE_MISSING', key, `the alert centre says what happens when ${key} is not done, but there is no ALERT_TYPE ${key}`);
    for (const source of alerts.sources) if (!alertSources.has(source)) add('GOV_ALERT_TYPE_MISSING', source, `the alert centre reads the source ${source} but no ALERT_TYPE has it as its source`);
  }
  return { findings, warnings, summary };
}

export async function main(root = DEFAULT_ROOT, write = (line) => process.stdout.write(`${line}\n`)) {
  const { findings, warnings, summary } = await checkGovernance({ root });
  for (const warning of warnings) write(`warning ${warning.code}: ${warning.message}`);
  for (const finding of findings) write(`${finding.code}: ${finding.message}`);
  if (findings.length > 0) {
    write(`${findings.length} governance finding(s); see docs/governance-roadmap-10of10.md (G0-1, G0-3)`);
    return 1;
  }
  write(`All governance rules are sound (${summary.types} types, ${summary.defaults} built-in defaults, ${summary.unverified} flagged unverified)`);
  return 0;
}

if (process.argv[1] !== undefined && relative(process.argv[1], fileURLToPath(import.meta.url)) === '') process.exit(await main());
