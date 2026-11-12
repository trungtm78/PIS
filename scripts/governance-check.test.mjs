import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FINDING_CODES, checkGovernance, loadKernel, main } from './governance-check.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = [];
const TODAY = '2026-11-08';

const alert = (overrides = {}) => ({
  params: { source: 'APPROVAL', owner: 'APPROVER', expected_action: 'Làm', consequence: 'Dừng', response_hours: 24, default_severity: 'ACTION', reason_to_exist: 'Có lý do', review_on: '2027-05-08', enabled: true },
  formula: 'Một loại cảnh báo nói ai làm gì',
  source: 'Sổ loại cảnh báo',
  asOf: '2026-11-08',
  legalStatus: 'VERIFIED',
  unverified: false,
  ...overrides,
});

/** A kernel with one well-formed type; `patch` changes it. */
function kernelWith(patch = {}) {
  const definition = {
    type: 'ALERT_TYPE',
    ownerModule: 'ADM',
    formula: 'Một loại cảnh báo nói ai làm gì',
    source: 'Sổ loại cảnh báo',
    asOf: '2026-11-08',
    legalStatus: 'VERIFIED',
    defaults: { APPROVAL: alert() },
    ...patch,
  };
  return { RULE_TYPE_PATTERN: /^[A-Z][A-Z0-9_]{2,63}$/, ruleTypeDefinitions: () => [definition], validateRuleParams: () => ({}) };
}

function tree(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'governance-check-'));
  scratch.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const codes = async (options) => (await checkGovernance({ today: TODAY, ...options })).findings.map((finding) => finding.code);

after(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

describe('governance:check on the repository', () => {
  it('finds every built-in default with its formula, source, as-of and legal status, and every default passing its schema', async () => {
    const lines = [];
    const status = await main(REPO, (line) => lines.push(line));
    assert.equal(status, 0, lines.join('\n'));
    assert.match(lines.at(-1), /All governance rules are sound \(\d+ types, \d+ built-in defaults, \d+ flagged unverified\)/);
    const kernel = await loadKernel(REPO);
    assert.ok(kernel.registeredRuleTypes().includes('CONTRACT_HEALTH_RAG'));
  });
});

describe('governance:check findings', () => {
  it('passes a well-formed registry', async () => {
    const result = await checkGovernance({ kernel: kernelWith(), today: TODAY, root: tree() });
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.summary, { types: 1, defaults: 1, unverified: 0 });
  });

  it('refuses a type without an owner, a formula, a source, an as-of or a legal status', async () => {
    assert.deepEqual(await codes({ kernel: kernelWith({ ownerModule: '' }), root: tree() }), ['GOV_TYPE_OWNER_MISSING']);
    for (const patch of [{ formula: '' }, { source: ' ' }, { asOf: '2026-02-30' }, { legalStatus: 'MAYBE' }]) {
      assert.deepEqual(await codes({ kernel: kernelWith(patch), root: tree() }), ['GOV_TYPE_PROVENANCE_MISSING']);
    }
  });

  it('refuses a type name that does not match the pattern and a type with no default', async () => {
    assert.deepEqual(await codes({ kernel: kernelWith({ type: 'ab' }), root: tree() }), ['GOV_TYPE_NAME_INVALID']);
    assert.deepEqual(await codes({ kernel: kernelWith({ defaults: {} }), root: tree() }), ['GOV_TYPE_NO_DEFAULT']);
  });

  it('refuses a default that lacks formula, source, as-of or legal status, or whose as-of is in the future', async () => {
    for (const patch of [{ formula: 'ngắn' }, { source: '' }, { asOf: undefined }, { legalStatus: undefined, unverified: undefined }]) {
      const found = await codes({ kernel: kernelWith({ defaults: { APPROVAL: alert(patch) } }), root: tree() });
      assert.ok(found.includes('GOV_DEFAULT_PROVENANCE_MISSING'), JSON.stringify(patch));
    }
    assert.deepEqual(await codes({ kernel: kernelWith({ defaults: { APPROVAL: alert({ asOf: '2026-11-10' }) } }), root: tree() }), ['GOV_DEFAULT_AS_OF_IN_FUTURE']);
  });

  it('refuses a default whose unverified flag disagrees with its legal status, and counts the unverified ones', async () => {
    assert.deepEqual(await codes({ kernel: kernelWith({ defaults: { APPROVAL: alert({ legalStatus: 'UNVERIFIED', unverified: false }) } }), root: tree() }), ['GOV_DEFAULT_LEGAL_FLAG']);
    const result = await checkGovernance({ kernel: kernelWith({ defaults: { APPROVAL: alert({ legalStatus: 'UNVERIFIED', unverified: true }) } }), today: TODAY, root: tree() });
    assert.equal(result.summary.unverified, 1);
  });

  it('refuses a default that does not pass the schema of its type, naming the field', async () => {
    const kernel = {
      ...kernelWith(),
      validateRuleParams: () => {
        throw Object.assign(new Error('GOVERNANCE_RULE_PARAMS_INVALID'), { detail: 'response_hours' });
      },
    };
    const result = await checkGovernance({ kernel, today: TODAY, root: tree() });
    assert.deepEqual(result.findings.map((finding) => finding.code), ['GOV_DEFAULT_PARAMS_INVALID']);
    assert.match(result.findings[0].message, /response_hours/);
  });

  it('warns, without failing, about an alert type whose review day has passed', async () => {
    const stale = alert();
    stale.params.review_on = '2026-01-01';
    const result = await checkGovernance({ kernel: kernelWith({ defaults: { APPROVAL: stale } }), today: TODAY, root: tree() });
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.warnings.map((warning) => warning.code), ['GOV_ALERT_REVIEW_OVERDUE']);
  });

  it('compares the pattern in the migrations with the pattern of the kernel', async () => {
    const ok = tree({ 'db/migrations/V1850__x.sql': "CREATE TABLE t (rule_type text CHECK (rule_type ~ '^[A-Z][A-Z0-9_]{2,63}$'));" });
    assert.deepEqual(await codes({ kernel: kernelWith(), root: ok }), []);
    const closed = tree({ 'db/migrations/V1850__x.sql': "CREATE TABLE t (rule_type text CHECK (rule_type ~ '^[A-Z]+$'));" });
    assert.deepEqual(await codes({ kernel: kernelWith(), root: closed }), ['GOV_TABLE_PATTERN_MISMATCH']);
  });

  it('wants an ALERT_TYPE for every consequence and every source of the alert centre', async () => {
    const rules = [
      "export const WORK_SOURCES = ['APPROVAL', 'PERMIT'] as const;",
      'export const CONSEQUENCES: Readonly<Record<string, string>> = {',
      "  APPROVAL: 'a',",
      "  PERMIT_EXPIRED: 'b',",
      '};',
    ].join('\n');
    const found = await checkGovernance({ kernel: kernelWith(), today: TODAY, root: tree({ 'packages/db/src/home-work-rules.ts': rules }) });
    assert.deepEqual(
      found.findings.map((finding) => finding.subject),
      ['PERMIT_EXPIRED', 'PERMIT'],
    );
    assert.deepEqual(found.findings.map((finding) => finding.code), ['GOV_ALERT_TYPE_MISSING', 'GOV_ALERT_TYPE_MISSING']);
  });

  it('finds a KPI set or a workflow template that refers to a code the other type does not have (R37)', async () => {
    const kpiSet = (kpiCode, ragCode = 'PWF_SCORE', templateCode = 'PUBLIC_INVESTMENT') => alert({ params: { template_code: templateCode, items: [{ kpi_code: kpiCode, rag_code: ragCode }] } });
    const kernel = (setDefaults, templateDefaults) => ({
      RULE_TYPE_PATTERN: /^[A-Z][A-Z0-9_]{2,63}$/,
      validateRuleParams: () => ({}),
      ruleTypeDefinitions: () => [
        { ...kernelWith().ruleTypeDefinitions()[0], type: 'KPI_DEFINITION', defaults: { PWF_ON_TIME_RATE: alert() } },
        { ...kernelWith().ruleTypeDefinitions()[0], type: 'RAG_THRESHOLDS', defaults: { PWF_SCORE: alert() } },
        { ...kernelWith().ruleTypeDefinitions()[0], type: 'PROJECT_WORKFLOW_TEMPLATE', defaults: templateDefaults },
        { ...kernelWith().ruleTypeDefinitions()[0], type: 'WORKFLOW_KPI_SET', defaults: setDefaults },
      ],
    });
    const template = { PUBLIC_INVESTMENT: alert({ params: { tasks: [{ kpi_codes: ['PWF_ON_TIME_RATE'] }, { kpi_codes: [] }, {}] } }) };
    assert.deepEqual(await codes({ kernel: kernel({ DEFAULT: kpiSet('PWF_ON_TIME_RATE') }, template), root: tree() }), []);
    const missing = await checkGovernance({ kernel: kernel({ DEFAULT: kpiSet('PWF_NO_SUCH', 'NO_RAG', 'NO_TEMPLATE') }, { PUBLIC_INVESTMENT: alert({ params: { tasks: [{ kpi_codes: ['NOPE'] }] } }) }), today: TODAY, root: tree() });
    assert.deepEqual(
      missing.findings.map((finding) => finding.code),
      ['GOV_REFERENCE_MISSING', 'GOV_REFERENCE_MISSING', 'GOV_REFERENCE_MISSING', 'GOV_REFERENCE_MISSING'],
    );
    assert.ok(missing.findings.some((finding) => finding.message.includes('refers to NOPE at tasks[].kpi_codes[]')));
  });

  it('holds the built-in project workflow data of the repository to its references', async () => {
    const found = await checkGovernance({ today: '2026-11-12', root: REPO });
    assert.deepEqual(found.findings.filter((finding) => finding.code === 'GOV_REFERENCE_MISSING'), []);
  });

  it('says so when the registry cannot be read', async () => {
    assert.deepEqual(await codes({ kernel: {}, root: tree() }), ['GOV_REGISTRY_UNREADABLE']);
    assert.deepEqual(await codes({ root: tree() }), ['GOV_REGISTRY_UNREADABLE']);
  });

  it('prints each finding and a count, and returns 1', async () => {
    const lines = [];
    const root = tree({ 'packages/kernel/src/governance-rules.ts': 'export const nothing = 1;\n' });
    assert.equal(await main(root, (line) => lines.push(line)), 1);
    assert.match(lines[0], /^GOV_REGISTRY_UNREADABLE:/);
    assert.match(lines.at(-1), /1 governance finding\(s\)/);
  });

  it('lists its finding codes', () => {
    assert.ok(FINDING_CODES.includes('GOV_DEFAULT_PROVENANCE_MISSING'));
    assert.equal(new Set(FINDING_CODES).size, FINDING_CODES.length);
  });
});
