import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChecks } from '../src/checks/index.mjs';
import { checkUniqueIds } from '../src/checks/unique-ids.mjs';
import { checkScreenLinks } from '../src/checks/screen-links.mjs';
import { checkTestReferences } from '../src/checks/test-references.mjs';
import { checkTestQuality } from '../src/checks/test-quality.mjs';
import { checkRequirementCoverage } from '../src/checks/requirement-coverage.mjs';
import { checkOpenApi } from '../src/checks/openapi.mjs';
import { checkDataModel } from '../src/checks/data-model.mjs';
import { validModel, codes } from './fixtures.mjs';

test('a consistent model produces no findings', () => {
  assert.deepEqual(runChecks(validModel()), []);
});

test('duplicate ids are reported per collection', () => {
  const model = validModel();
  model.screens.push({ ...model.screens[0] });
  model.tests.push({ ...model.tests[0] });
  assert.deepEqual(codes(checkUniqueIds(model)), ['DUPLICATE_ID', 'DUPLICATE_ID']);
});

test('screen links must resolve in both directions', () => {
  const model = validModel();
  model.backlog = model.backlog.filter((b) => b.screen !== 'DIS-01');
  model.trace.push({ requirement: 'FR-X-01', screen: 'X-01', backlog_id: 'BL-X-01', test_ids: [] });
  // Removing BL-DIS-01 also leaves the FR-DIS-01 trace row dangling, hence two unknown-backlog findings.
  assert.deepEqual(codes(checkScreenLinks(model)), [
    'SCREEN_WITHOUT_BACKLOG',
    'TRACE_UNKNOWN_BACKLOG',
    'TRACE_UNKNOWN_BACKLOG',
    'TRACE_UNKNOWN_SCREEN',
  ]);
});

test('backlog rows must point at catalogued screens and screens need trace rows', () => {
  const model = validModel();
  model.backlog.push({ id: 'BL-Y-01', screen: 'Y-01', requirement: 'FR-Y-01', test_ids: [] });
  model.trace = model.trace.filter((t) => t.screen !== 'IAM-01');
  assert.deepEqual(codes(checkScreenLinks(model)), ['BACKLOG_UNKNOWN_SCREEN', 'SCREEN_WITHOUT_TRACE']);
});

test('test references must exist and every test must be referenced', () => {
  const model = validModel();
  model.backlog[0].test_ids.push('UI-MISSING');
  model.tests.push({ id: 'UAT-AC99', priority: 'P1', steps: ['x'], expected: 'y' });
  assert.deepEqual(codes(checkTestReferences(model)), ['ORPHAN_TEST', 'UNKNOWN_TEST_REF']);
});

test('a test may declare the requirements it covers instead of being referenced', () => {
  const model = validModel();
  model.tests.push({ id: 'UAT-AC98', priority: 'P1', steps: ['x'], expected: 'y', covers: ['FR-DIS-01'] });
  assert.deepEqual(checkTestReferences(model), []);
  model.tests.at(-1).covers = ['FR-NOPE-01'];
  assert.deepEqual(codes(checkTestReferences(model)), ['UNKNOWN_COVERED_REQUIREMENT']);
});

test('P0 tests sharing template steps and tests without expected results are reported', () => {
  const model = validModel();
  const template = ['Prepare preconditions', 'Do the action', 'Read back'];
  for (const id of ['UAT-AC01', 'UI-IAM-01', 'UI-DIS-01']) {
    model.tests.find((t) => t.id === id).steps = [...template];
  }
  model.tests[0].expected = '  ';
  const findings = checkTestQuality(model, { templateThreshold: 3 });
  assert.deepEqual(codes(findings), ['TEST_EXPECTED_MISSING', 'TEST_TEMPLATE_STEPS', 'TEST_TEMPLATE_STEPS', 'TEST_TEMPLATE_STEPS']);
});

test('shared steps below the threshold or on P1 tests are allowed', () => {
  const model = validModel();
  model.tests.push({ id: 'UAT-AC02', priority: 'P1', steps: ['a'], expected: 'b' });
  model.tests.push({ id: 'UAT-AC03', priority: 'P1', steps: ['a'], expected: 'b' });
  model.tests.push({ id: 'UAT-AC04', priority: 'P1', steps: ['a'], expected: 'b' });
  assert.deepEqual(checkTestQuality(model, { templateThreshold: 3 }), []);
});

test('functional requirements need an existing test; non-functional ones need controls and tests', () => {
  const model = validModel();
  model.trace[1].test_ids = ['UI-GONE'];
  model.nonFunctional.push({ id: 'NFR-OPS-01', title: 'Restore drill', controls: [], test_ids: [] });
  assert.deepEqual(codes(checkRequirementCoverage(model)), [
    'FR_WITHOUT_TEST',
    'NFR_WITHOUT_CONTROL',
    'NFR_WITHOUT_TEST',
  ]);
});

test('a requirement covered only through a test covers list counts as tested', () => {
  const model = validModel();
  model.trace[1].test_ids = [];
  model.tests.push({ id: 'UAT-AC05', priority: 'P1', steps: ['a'], expected: 'b', covers: ['FR-DIS-01'] });
  assert.deepEqual(checkRequirementCoverage(model), []);
});

test('openapi write operations need idempotency, unique ids and a permission', () => {
  const model = validModel();
  model.openapi.paths['/projects'] = {
    post: { operationId: 'post_reports_id_submit', parameters: [] },
    delete: { operationId: 'delete_project', 'x-required-role': 'SystemAdmin', parameters: [{ name: 'Idempotency-Key', in: 'header' }] },
  };
  assert.deepEqual(codes(checkOpenApi(model)), [
    'OPERATION_DUPLICATE_ID',
    'OPERATION_WITHOUT_PERMISSION',
    'WRITE_WITHOUT_IDEMPOTENCY',
  ]);
});

test('a write that returns a secret may declare that nothing is stored, with its reason, and only then', () => {
  const model = validModel();
  const secret = { 'x-required-role': 'SupportOperator', parameters: [] };
  model.openapi.paths['/tokens'] = {
    post: { ...secret, operationId: 'issue_token', 'x-idempotency': 'not-stored', 'x-idempotency-reason': 'The answer is a secret and is never kept for a replay' },
    put: { ...secret, operationId: 'no_reason', 'x-idempotency': 'not-stored' },
    patch: { ...secret, operationId: 'blank_reason', 'x-idempotency': 'not-stored', 'x-idempotency-reason': '  ' },
    delete: { ...secret, operationId: 'other_value', 'x-idempotency': 'stored', 'x-idempotency-reason': 'x' },
  };
  assert.deepEqual(
    checkOpenApi(model).filter((item) => item.code === 'WRITE_WITHOUT_IDEMPOTENCY').map((item) => item.params.id),
    ['no_reason', 'blank_reason', 'other_value'],
  );
});

test('public operations flagged x-public do not need a permission', () => {
  const model = validModel();
  model.openapi.paths['/health'] = { get: { operationId: 'get_health', 'x-public': true } };
  assert.deepEqual(checkOpenApi(model), []);
});

test('data model entities, tables, RLS and foreign key indexes must agree', () => {
  const model = validModel();
  model.entities.contract = { tenant_id: 'uuid', id: 'uuid PK' };
  model.sql += [
    '',
    'CREATE TABLE orphan_table (',
    '  tenant_id uuid NOT NULL,',
    '  project_id uuid NOT NULL',
    ');',
  ].join('\n');
  assert.deepEqual(codes(checkDataModel(model)), [
    'ENTITY_WITHOUT_TABLE',
    'FK_COLUMN_WITHOUT_INDEX',
    'TABLE_WITHOUT_ENTITY',
    'TENANT_TABLE_WITHOUT_RLS',
  ]);
});

test('every finding carries a severity, code and message key', () => {
  const model = validModel();
  model.tests.push({ id: 'UAT-AC97', priority: 'P1', steps: ['x'], expected: 'y' });
  const [finding] = runChecks(model);
  assert.equal(finding.code, 'ORPHAN_TEST');
  assert.equal(finding.severity, 'error');
  assert.equal(finding.messageKey, 'check.finding.orphanTest');
  assert.deepEqual(finding.params, { id: 'UAT-AC97' });
});
