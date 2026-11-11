import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

// The grants of the personas of the stack (apps/api/test/e2e-stack/serve.stack.ts) against the persona table of docs/demo/demo-enterprise.md. Read as text: the stack file starts a database when it is imported.
const STACK = readFileSync(resolve(import.meta.dirname, '..', '..', '..', 'api', 'test', 'e2e-stack', 'serve.stack.ts'), 'utf8');
const roleLine = (name: string): string => STACK.split('\n').find((line) => line.startsWith(`const ${name} = `)) ?? '';

test('the reader role of the auditor holds the units, the grants and the members and no contract right', () => {
  const line = roleLine('READER_ROLE');
  assert.match(line, /'organization_unit\.read', 'role_grant\.read', 'membership\.read'/);
  assert.doesNotMatch(line, /contract/);
  assert.match(STACK, /user: 'unitAdmin', role: UNIT_CONTRACT_READER_ROLE\.code/);
  assert.doesNotMatch(STACK, /user: 'auditor', role: UNIT_CONTRACT_READER_ROLE/);
});

test('the security administrator holds the delegation and acting grants on the plain stack as on the docs stack', () => {
  const line = roleLine('SECURITY_ADMIN_ROLE');
  for (const permission of ['iam.delegation.read', 'iam.acting.read', 'adm.security.read']) assert.ok(line.includes(`'${permission}'`), permission);
  assert.match(STACK, /user: 'securityAdmin', role: SECURITY_ADMIN_ROLE\.code/);
});

test('the audit reader of the docs stack reads the audit log (ADM-11) and no contract', () => {
  const line = STACK.split('\n').find((entry) => entry.includes("code: 'THANH_TRA_KIEM_TOAN'")) ?? '';
  assert.ok(line.includes("'audit_event.read'"));
  assert.doesNotMatch(line, /contract/);
});
