import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { bookPath } from './clips/production.mjs';
import { run } from './clip-scripts-check.mjs';

const capture = (overrides = {}) => {
  const lines = [];
  const writes = new Map();
  const io = { log: (line) => lines.push(line), write: (file, text) => writes.set(file, text), read: (file) => readFileSync(file, 'utf8'), ...overrides };
  return { lines, writes, io };
};

test('check passes on the repository and prints one line per clip', () => {
  const { lines, io } = capture();
  assert.equal(run(['check'], io), 0);
  assert.ok(lines.some((line) => /^public-investment: ok/u.test(line)));
  assert.ok(lines.some((line) => /^enterprise-phu-my: ok/u.test(line)));
});

test('check fails when a committed shooting script is out of date or missing', () => {
  const { lines, io } = capture({ read: () => 'stale' });
  assert.equal(run(['check', 'public-investment'], io), 1);
  assert.ok(lines.some((line) => /out of date/u.test(line)));
  const missing = capture({ read: () => { throw new Error('ENOENT'); } });
  assert.equal(run(['check', 'public-investment'], missing.io), 1);
});

test('strict passes when every screen has a module (the HPM and EBS screens of the enterprise edition count), and strict-data fails a chapter with data not yet proven', () => {
  const strict = capture();
  assert.equal(run(['check', '--strict'], strict.io), 0);
  assert.ok(!strict.lines.some((line) => /no module in this build yet/u.test(line)));
  const strictData = capture();
  assert.equal(run(['check', 'public-investment', '--strict-data'], strictData.io), 1);
  assert.ok(strictData.lines.some((line) => /groups not run and verified/u.test(line)));
});

test('book prints the script, and with --write writes it where the check looks for it', () => {
  const printed = capture();
  assert.equal(run(['book', 'public-investment'], printed.io), 0);
  assert.ok(printed.lines[0].startsWith('# '));
  const written = capture();
  assert.equal(run(['book', 'public-investment', '--write'], written.io), 0);
  assert.ok(written.writes.has(bookPath('public-investment')));
});

test('report lists the warnings, an unknown clip or command is a usage error', () => {
  const { lines, io } = capture();
  assert.equal(run(['report'], io), 0);
  assert.ok(lines.some((line) => /warning: .*chapter alerts/u.test(line)));
  assert.equal(run(['check', 'no-such-clip'], capture().io), 2);
  assert.equal(run(['frobnicate'], capture().io), 2);
});
