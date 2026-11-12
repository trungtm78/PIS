import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { NEEDS_A_RECORD, REGISTRY, SUITE, main, manualReason, planOf, withAutomation } from './uat-screen-contract.mjs';

const CASE = (id, extra = '') => `    {\n      "tc_id": "${id}",\n      "platform": "web",\n      "screen_id": "${id.replace('TC-UI-', '')}",\n      "expected": "x"${extra},\n      "module": "ADM"\n    }`;
const FILE = (...cases) => `{\n  "feature": "adm",\n  "coverage_pct": 100.0,\n  "test_cases": [\n${cases.join(',\n')}\n  ]\n}\n`;

test('an automation block is appended to a case that has none, with the comma and nothing else touched', () => {
  const text = FILE(CASE('TC-UI-ADM-01'), CASE('TC-UI-ADM-02'));
  const out = withAutomation(text, 'TC-UI-ADM-02', { state: 'AUTOMATED', suite: 'a.ts' });
  assert.match(out, /"module": "ADM",\n {6}"automation": \{\n {8}"state": "AUTOMATED",\n {8}"suite": "a\.ts"\n {6}\}\n {4}\}\n {2}\]/);
  const parsed = JSON.parse(out);
  assert.equal(parsed.test_cases[1].automation.suite, 'a.ts');
  assert.equal(parsed.test_cases[0].automation, undefined);
  assert.ok(out.includes('"coverage_pct": 100.0'), 'a number the writer wrote with a trailing .0 stays');
});

test('an existing automation block is replaced, in the middle of a case and at its end', () => {
  const middle = CASE('TC-UI-ADM-01', ',\n      "automation": {\n        "state": "MANUAL",\n        "reason": "old"\n      }');
  const out = withAutomation(FILE(middle), 'TC-UI-ADM-01', { state: 'AUTOMATED', suite: 'a.ts', registry: 'r.json' });
  assert.equal(JSON.parse(out).test_cases[0].automation.registry, 'r.json');
  assert.equal(JSON.parse(out).test_cases[0].module, 'ADM');
  const again = withAutomation(out, 'TC-UI-ADM-01', { state: 'AUTOMATED', suite: 'a.ts', registry: 'r.json' });
  assert.equal(again, out, 'the same automation changes nothing');
  const last = `    {\n      "tc_id": "TC-UI-ADM-03",\n      "platform": "web",\n      "automation": {\n        "state": "MANUAL",\n        "reason": "old"\n      }\n    }`;
  const lastOut = withAutomation(FILE(last), 'TC-UI-ADM-03', { state: 'MANUAL', reason: 'new' });
  assert.equal(JSON.parse(lastOut).test_cases[0].automation.reason, 'new');
});

test('the line ends of the file are kept', () => {
  const text = FILE(CASE('TC-UI-ADM-01')).replace(/\n/g, '\r\n');
  const out = withAutomation(text, 'TC-UI-ADM-01', { state: 'MANUAL', reason: 'r' });
  assert.ok(out.includes('\r\n') && !/[^\r]\n/.test(out));
  assert.equal(JSON.parse(out).test_cases[0].automation.state, 'MANUAL');
});

test('a case that is not in the file is an error, not a silent skip', () => {
  assert.throws(() => withAutomation(FILE(CASE('TC-UI-ADM-01')), 'TC-UI-ADM-09', { state: 'MANUAL', reason: 'r' }), /not in the handoff file/);
});

test('a screen that is a web route is automated; one that is not has a reason', () => {
  const catalogue = new Map([['MOB-01', { id: 'MOB-01', platform: 'android' }], ['WEB-09', { id: 'WEB-09', platform: 'web' }]]);
  assert.equal(manualReason('ADM-01', new Set(['ADM-01']), catalogue), undefined);
  assert.match(manualReason('MOB-01', new Set(), catalogue), /chỉ có trên điện thoại/);
  assert.match(manualReason('WEB-09', new Set(), catalogue), /không có tuyến/);
  assert.match(manualReason('NOPE-01', new Set(), catalogue), /không có trong danh mục/);
  assert.equal(manualReason('PWA-05', new Set(['PWA-05']), catalogue), NEEDS_A_RECORD['PWA-05'], 'a screen of one record is manual even where the route table names it');
});

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'uat-screen-'));
  mkdirSync(join(root, 'apps', 'web', 'src', 'routes'), { recursive: true });
  mkdirSync(join(root, 'apps', 'web', 'e2e', 'support'), { recursive: true });
  mkdirSync(join(root, 'Design', 'MACHVON_Design', '03_Engineering'), { recursive: true });
  mkdirSync(join(root, 'docs', 'uat', 'adm'), { recursive: true });
  mkdirSync(join(root, 'docs', 'uat', 'critical'), { recursive: true });
  writeFileSync(join(root, 'apps', 'web', 'src', 'routes', 'routes.generated.json'), JSON.stringify({ routes: [{ id: 'ADM-01' }, { id: 'ADM-02' }] }));
  writeFileSync(join(root, 'Design', 'MACHVON_Design', '03_Engineering', 'screen_catalog.json'), JSON.stringify([{ id: 'ADM-01', platform: 'web' }, { id: 'ADM-02', platform: 'web' }, { id: 'ADM-03', platform: 'mobile' }]));
  const phone = CASE('TC-UI-ADM-03');
  const api = CASE('TC-UI-ADM-04').replace('"platform": "web"', '"platform": "api"');
  const other = CASE('TC-ADM-05');
  writeFileSync(join(root, 'docs', 'uat', 'adm', 'uat.json'), FILE(CASE('TC-UI-ADM-02'), CASE('TC-UI-ADM-01'), phone, api, other));
  writeFileSync(join(root, 'docs', 'uat', 'critical', 'uat.json'), FILE(CASE('TC-UI-ADM-01')));
  return root;
}

test('the plan lists the web screen-contract cases of the module folders in order, automates the routes and makes the others manual', () => {
  const root = repository();
  try {
    const plan = planOf(root);
    const rows = JSON.parse(plan.registry);
    assert.deepEqual(rows.map((row) => row.id), ['UI-ADM-01', 'UI-ADM-02']);
    assert.equal(rows[0].tc, 'TC-UI-ADM-01');
    const [[, text]] = [...plan.files];
    const cases = JSON.parse(text).test_cases;
    assert.deepEqual(cases.find((entry) => entry.tc_id === 'TC-UI-ADM-01').automation, { state: 'AUTOMATED', suite: SUITE, registry: REGISTRY });
    assert.equal(cases.find((entry) => entry.tc_id === 'TC-UI-ADM-03').automation.state, 'MANUAL');
    assert.equal(cases.find((entry) => entry.tc_id === 'TC-UI-ADM-04').automation, undefined, 'an API case is not a screen');
    assert.equal(cases.find((entry) => entry.tc_id === 'TC-ADM-05').automation, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('generate writes the registry and the handoff file; check then passes, and fails when either is changed', () => {
  const root = repository();
  const logs = [];
  const log = (line) => logs.push(line);
  try {
    assert.equal(main(['check'], { root, log }), 1);
    assert.ok(logs.some((line) => line.includes(REGISTRY)));
    assert.equal(main(['generate'], { root, log }), 0);
    assert.equal(main(['check'], { root, log }), 0);
    const handoff = join(root, 'docs', 'uat', 'adm', 'uat.json');
    writeFileSync(handoff, readFileSync(handoff, 'utf8').replace('"state": "AUTOMATED"', '"state": "MANUAL"'));
    assert.equal(main(['check'], { root, log }), 1);
    assert.equal(main(['generate'], { root, log }), 0);
    writeFileSync(join(root, REGISTRY), '[]\n');
    assert.equal(main(['check'], { root, log }), 1);
    assert.equal(main(['nonsense'], { root, log }), 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the repository is in step: the registry and the handoff files are what the generator writes', () => {
  const logs = [];
  assert.equal(main(['check'], { log: (line) => logs.push(line) }), 0, logs.join('\n'));
});
