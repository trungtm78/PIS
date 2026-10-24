import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FINDING_CODES, checkAlerts, main, mandatoryRules } from './alerts-check.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = [];

/** A small tree: one rule whose runbook and emitted metric exist, plus the kernel list of mandatory rules. */
function tree(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'alerts-check-'));
  scratch.push(root);
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write('packages/kernel/src/alerts.ts', "export const MANDATORY_ALERT_RULES: readonly string[] = [\n  'A_RULE',\n];\n");
  write('packages/db/src/emits.ts', "metrics.gauge('a_metric', 1); alerts.raise('AN_EVENT', {});\n");
  write('docs/runbooks/alerts/A_RULE.md', '# A_RULE\n');
  const rule = { id: 'A_RULE', severity: 'critical', channel: 'operations', owner: 'platform-oncall', runbook: 'docs/runbooks/alerts/A_RULE.md', adapter: 'log', summary: 's', source: { type: 'gauge', metric: 'a_metric', above: 1 } };
  write('alerts/rules/A_RULE.json', JSON.stringify(rule));
  for (const [path, text] of Object.entries(files)) {
    if (text === null) rmSync(join(root, path), { force: true });
    else write(path, typeof text === 'string' ? text : JSON.stringify(text));
  }
  return { root, rule };
}

const codes = (root) => checkAlerts({ root }).map((finding) => finding.code);
const withRule = (rule, extra = {}) => ({ 'alerts/rules/A_RULE.json': rule, ...extra });

after(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

describe('alerts:check on the repository', () => {
  it('finds the nine mandatory rules sound: owners, runbooks, emitted sources, no notification route for operations', () => {
    assert.deepEqual(checkAlerts({ root: REPO }), []);
    assert.equal(mandatoryRules(REPO).length, 9);
    assert.ok(mandatoryRules(REPO).includes('OUTBOX_LAG') && mandatoryRules(REPO).includes('LICENSE_EXPIRING'));
  });

  it('prints the verdict and returns the exit status', () => {
    const lines = [];
    assert.equal(main(REPO, (line) => lines.push(line)), 0);
    assert.match(lines.at(-1), /All alert rules are sound \(\d+ rules\)/);
    const broken = tree({ 'alerts/rules/A_RULE.json': { id: 'A_RULE' } });
    const out = [];
    assert.equal(main(broken.root, (line) => out.push(line)), 1);
    assert.match(out.join('\n'), /ALERT_FILE_INVALID/);
  });
});

describe('alerts:check defects (scratch trees)', () => {
  it('accepts the sound scratch tree', () => {
    assert.deepEqual(codes(tree().root), []);
  });

  it('fails a rule without an owner (empty or absent) (AC-ST-KERNEL-051-2)', () => {
    const { root, rule } = tree();
    for (const owner of ['', '  ', undefined]) {
      writeFileSync(join(root, 'alerts/rules/A_RULE.json'), JSON.stringify({ ...rule, owner }));
      assert.deepEqual(codes(root), ['ALERT_OWNER_MISSING']);
    }
  });

  it('fails a rule whose runbook file does not exist (AC-ST-KERNEL-051-2)', () => {
    const { root, rule } = tree(withRule({}, {}));
    writeFileSync(join(root, 'alerts/rules/A_RULE.json'), JSON.stringify({ ...rule, runbook: 'docs/runbooks/alerts/NOPE.md' }));
    assert.deepEqual(codes(root), ['ALERT_RUNBOOK_MISSING']);
  });

  it('fails two files that define the same id', () => {
    const { root, rule } = tree();
    writeFileSync(join(root, 'alerts/rules/COPY.json'), JSON.stringify(rule));
    assert.deepEqual(codes(root), ['ALERT_ID_DUPLICATE']);
  });

  it('fails a rule whose metric or event code nothing in the code emits', () => {
    const { root, rule } = tree();
    writeFileSync(join(root, 'alerts/rules/A_RULE.json'), JSON.stringify({ ...rule, source: { type: 'gauge', metric: 'never_emitted', above: 1 } }));
    assert.deepEqual(codes(root), ['ALERT_SOURCE_UNKNOWN']);
    writeFileSync(join(root, 'alerts/rules/A_RULE.json'), JSON.stringify({ ...rule, source: { type: 'event', code: 'AN_EVENT' } }));
    assert.deepEqual(codes(root), []);
    writeFileSync(join(root, 'alerts/rules/A_RULE.json'), JSON.stringify({ ...rule, source: { type: 'event', code: 'NEVER_RAISED' } }));
    assert.deepEqual(codes(root), ['ALERT_SOURCE_UNKNOWN']);
  });

  it('counts a call that emits the name, directly or through a constant, and not a string that merely appears in the code', () => {
    const { root, rule } = tree();
    const eventRule = { ...rule, source: { type: 'event', code: 'AN_EVENT' } };
    const setSource = (text) => writeFileSync(join(root, 'packages/db/src/emits.ts'), text);
    writeFileSync(join(root, 'alerts/rules/A_RULE.json'), JSON.stringify(eventRule));
    // The code only lists the name (as the mandatory list of the kernel does): the producer has been deleted.
    setSource("export const KNOWN = ['AN_EVENT'];\nconst message = 'AN_EVENT is raised elsewhere';\n");
    assert.deepEqual(codes(root), ['ALERT_SOURCE_UNKNOWN']);
    // A call in a comment is not an emission either.
    setSource("// alerts.raise('AN_EVENT', {});\n/* alerts.raise('AN_EVENT', {}); */\n");
    assert.deepEqual(codes(root), ['ALERT_SOURCE_UNKNOWN']);
    setSource("const AN_EVENT_ALERT = 'AN_EVENT';\nexport function f(alerts) { alerts?.raise(AN_EVENT_ALERT, {}); }\n");
    assert.deepEqual(codes(root), []);
    setSource('export function f(alerts) {\n  alerts.raise(\n"AN_EVENT", {});\n}\n');
    assert.deepEqual(codes(root), []);
  });

  it('counts every branch of a conditional or fallback argument, and only a name the code can really emit', () => {
    const { root, rule } = tree();
    const watch = (metric) => writeFileSync(join(root, 'alerts/rules/A_RULE.json'), JSON.stringify({ ...rule, source: { type: 'counter', metric, increaseAbove: 0 } }));
    const setSource = (text) => writeFileSync(join(root, 'packages/db/src/emits.ts'), text);
    setSource("const OTHER = 'other_total';\nexport function f(result, metrics) {\n  metrics.increment(result.created ? 'created_total' : OTHER, { a: (1, 2) });\n}\n");
    watch('created_total');
    assert.deepEqual(codes(root), []);
    watch('other_total');
    assert.deepEqual(codes(root), []);
    watch('absent_total');
    assert.deepEqual(codes(root), ['ALERT_SOURCE_UNKNOWN']);
    // Nested conditionals, parentheses, a call in the condition and a fallback.
    setSource("metrics.increment(a(1, 'x') ? (b ? 'first_total' : 'second_total') : 'third_total');\nmetrics.increment(name ?? 'fallback_total');\nmetrics.increment(x ? y ? 'deep_total' : 'deeper_total' : 'last_total');\n");
    for (const metric of ['first_total', 'second_total', 'third_total', 'fallback_total', 'deep_total', 'deeper_total', 'last_total']) {
      watch(metric);
      assert.deepEqual(codes(root), [], metric);
    }
    // A name that is only in the condition, or in a gauge call, is not an increment emission.
    setSource("metrics.increment(result.kind === 'ghost_total' ? 'real_total' : 'other_total');\nmetrics.gauge(ok ? 'gauge_total' : 'g2_total', 1);\n");
    watch('ghost_total');
    assert.deepEqual(codes(root), ['ALERT_SOURCE_UNKNOWN']);
    watch('gauge_total');
    assert.deepEqual(codes(root), ['ALERT_SOURCE_UNKNOWN']);
    watch('real_total');
    assert.deepEqual(codes(root), []);
  });

  it('wants the emission to be of the kind the rule watches: a gauge rule is not satisfied by a counter of that name', () => {
    const { root, rule } = tree();
    writeFileSync(join(root, 'packages/db/src/emits.ts'), "metrics.increment('a_metric');\n");
    assert.deepEqual(codes(root), ['ALERT_SOURCE_UNKNOWN']);
    writeFileSync(join(root, 'alerts/rules/A_RULE.json'), JSON.stringify({ ...rule, source: { type: 'counter', metric: 'a_metric', increaseAbove: 0 } }));
    assert.deepEqual(codes(root), []);
  });

  it('fails a source without the threshold or the name its type needs, so a rule can not be disabled silently', () => {
    const { root, rule } = tree();
    const bad = [
      { type: 'gauge', metric: 'a_metric' },
      { type: 'gauge', metric: 'a_metric', above: '300' },
      { type: 'gauge', metric: 'a_metric', above: null },
      { type: 'counter', metric: 'a_metric' },
      { type: 'counter', metric: 'a_metric', increaseAbove: Number.POSITIVE_INFINITY },
      { type: 'gauge', above: 1 },
      { type: 'event' },
      { type: 'event', code: '  ' },
      { type: 'gauge', metric: 'a_metric', above: 1, labels: { stat: 5 } },
    ];
    for (const source of bad) {
      writeFileSync(join(root, 'alerts/rules/A_RULE.json'), JSON.stringify({ ...rule, source }));
      assert.ok(codes(root).includes('ALERT_FILE_INVALID'), JSON.stringify(source));
    }
    writeFileSync(join(root, 'alerts/rules/A_RULE.json'), JSON.stringify({ ...rule, source: { type: 'counter', metric: 'a_metric', increaseAbove: 0 } }));
    assert.ok(!codes(root).includes('ALERT_FILE_INVALID'), 'a threshold of zero is a threshold');
  });

  it('does not count an emission that exists only in a test file', () => {
    const { root, rule } = tree({ 'packages/db/src/emits.ts': 'export {};\n', 'packages/db/src/emits.test.ts': "metrics.gauge('a_metric', 1);\n" });
    assert.deepEqual(codes(root), ['ALERT_SOURCE_UNKNOWN']);
    assert.equal(rule.id, 'A_RULE');
  });

  it('fails an operations alert routed through the notification module, and allows a product alert to be', () => {
    const { root, rule } = tree();
    writeFileSync(join(root, 'alerts/rules/A_RULE.json'), JSON.stringify({ ...rule, adapter: 'notification' }));
    assert.deepEqual(codes(root), ['ALERT_VIA_NOTIFICATION']);
    writeFileSync(join(root, 'alerts/rules/A_RULE.json'), JSON.stringify({ ...rule, adapter: 'notification', channel: 'product' }));
    assert.deepEqual(codes(root), []);
  });

  it('fails a mandatory rule that has no file', () => {
    const { root } = tree({ 'packages/kernel/src/alerts.ts': "export const MANDATORY_ALERT_RULES: readonly string[] = ['A_RULE', 'ANOTHER'];\n" });
    assert.deepEqual(checkAlerts({ root }).map((finding) => [finding.code, finding.rule]), [['ALERT_RULE_MISSING', 'ANOTHER']]);
  });

  it('fails a file that is not JSON or has invalid fields, and reports a missing rules directory as missing rules', () => {
    const { root, rule } = tree({ 'alerts/rules/BAD.json': '{not json' });
    assert.deepEqual(codes(root), ['ALERT_FILE_INVALID']);
    for (const bad of [{ ...rule, id: 'lower' }, { ...rule, severity: 'fatal' }, { ...rule, channel: 'x' }, { ...rule, adapter: 'smoke' }, { ...rule, source: { type: 'magic' } }, { ...rule, summary: '' }, null]) {
      writeFileSync(join(root, 'alerts/rules/BAD.json'), JSON.stringify(bad));
      assert.ok(codes(root).includes('ALERT_FILE_INVALID'), JSON.stringify(bad));
    }
    const empty = mkdtempSync(join(tmpdir(), 'alerts-empty-'));
    scratch.push(empty);
    mkdirSync(join(empty, 'packages/kernel/src'), { recursive: true });
    writeFileSync(join(empty, 'packages/kernel/src/alerts.ts'), "export const MANDATORY_ALERT_RULES: readonly string[] = ['ONLY'];\n");
    assert.deepEqual(codes(empty), ['ALERT_RULE_MISSING']);
  });

  it('declares every finding code it can report', () => {
    assert.deepEqual([...FINDING_CODES].sort(), ['ALERT_FILE_INVALID', 'ALERT_ID_DUPLICATE', 'ALERT_OWNER_MISSING', 'ALERT_RULE_MISSING', 'ALERT_RUNBOOK_MISSING', 'ALERT_SOURCE_UNKNOWN', 'ALERT_VIA_NOTIFICATION']);
    assert.ok(existsSync(join(REPO, 'docs/runbooks/alerts/README.md')) && readFileSync(join(REPO, 'docs/runbooks/alerts/README.md'), 'utf8').includes('operations channel'));
    assert.ok(cpSync);
  });
});
