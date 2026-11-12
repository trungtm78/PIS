import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MACROS, firstCell, guardSql, main, resolveCases, substitute } from './uat-db-cases.mjs';

/** A read of the database that answers by the text of the statement. */
const database = (answers) => async (sql) => {
  for (const [needle, rows] of answers) if (sql.includes(needle)) return rows;
  return [];
};

test('the guard lets a read through and refuses everything that writes or chains statements', () => {
  assert.equal(guardSql('SELECT id FROM machvon.project LIMIT 1'), null);
  assert.equal(guardSql('  with x as (select 1) select * from x;'), null);
  assert.match(guardSql('DELETE FROM machvon.project'), /SELECT or WITH/u);
  assert.match(guardSql('SELECT 1; SELECT 2'), /second statement/u);
  assert.match(guardSql('SELECT 1 WHERE (UPDATE x SET y = 1) IS NULL'), /writes/u);
  assert.match(guardSql(undefined), /SELECT or WITH/u);
});

test('substitute fills ${name} and $[macro] in every string of an object, an array and a url, and nothing else', () => {
  const filled = substitute({ url: '/x/${id}/y', body: { title: 'Giao ban ${stamp}', ids: ['${id}', 3], flag: true, none: null }, q: 'SELECT count(*) WHERE t >= $[since_key]' }, { id: 'A', stamp: '42' });
  assert.equal(filled.url, '/x/A/y');
  assert.deepEqual(filled.body, { title: 'Giao ban 42', ids: ['A', 3], flag: true, none: null });
  assert.ok(filled.q.endsWith(MACROS.since_key));
  assert.equal(filled.q.split('%s').length - 1, 1, 'the key parameter appears once, as the tool passes one');
});

test('${name|int} gives the whole number to a field of type integer, and a text that is not one is an error', () => {
  assert.deepEqual(substitute({ revision: '${rev|int}', label: 'r${rev}' }, { rev: '12' }), { revision: 12, label: 'r12' });
  assert.throws(() => substitute('${rev|int}', { rev: 'x' }), /not a whole number/u);
  assert.throws(() => substitute('${gone|int}', {}), /not a variable/u);
});

test('a name that is not a variable, or a macro that does not exist, is an error: a body is never sent with a hole in it', () => {
  assert.throws(() => substitute('${missing}', {}), /not a variable/u);
  assert.throws(() => substitute('$[nothing]', {}), /not a macro/u);
});

test('firstCell reads the first cell of a row given as an array or as an object, and nothing from no row or a null', () => {
  assert.equal(firstCell([['a', 'b']]), 'a');
  assert.equal(firstCell([{ id: 7 }]), '7');
  assert.equal(firstCell([]), undefined);
  assert.equal(firstCell([[null]]), undefined);
});

const meeting = {
  tc_id: 'TC-UAT-DIR-IDM-01',
  idempotency: {
    url: '/steering-meetings',
    method: 'POST',
    resolve: { day: 'SELECT (current_date - 1)::text', unit: "SELECT id::text FROM machvon.organization_unit WHERE tenant_id = '${tenant_id}' AND parent_id IS NULL LIMIT 1" },
    body: { meeting_date: '${day}', meeting_type: 'MONTHLY', title: 'Giao ban tháng ${stamp}', unit_id: '${unit}' },
    count_query: "SELECT count(*) FROM machvon.steering_meeting WHERE tenant_id = '${tenant_id}' AND title = 'Giao ban tháng ${stamp}'",
    expect_rows: 1,
  },
};

test('a block with resolve is filled with what the environment answers, in order, with the tenant and the stamp of the run, and loses its resolve', async () => {
  const asked = [];
  const run = async (sql) => {
    asked.push(sql);
    return sql.includes('current_date') ? [['2026-11-11']] : [['unit-1']];
  };
  const { cases, unresolved } = await resolveCases([meeting], run, { tenantId: 'tenant-A', stamp: '1700' });
  assert.deepEqual(unresolved, []);
  const block = cases[0].idempotency;
  assert.equal(block.resolve, undefined);
  assert.deepEqual(block.body, { meeting_date: '2026-11-11', meeting_type: 'MONTHLY', title: 'Giao ban tháng 1700', unit_id: 'unit-1' });
  assert.ok(block.count_query.includes("tenant_id = 'tenant-A'") && block.count_query.includes('Giao ban tháng 1700'));
  assert.ok(asked[1].includes("tenant_id = 'tenant-A'"), 'the second read sees the tenant');
  assert.notEqual(meeting.idempotency.body.meeting_date, '2026-11-11', 'the input is not changed');
});

test('a later variable may use an earlier one', async () => {
  const withChain = { tc_id: 'C', db_assert: { resolve: { period: 'SELECT id FROM p', project: "SELECT id FROM q WHERE period = '${period}'" }, query: "SELECT 1 WHERE '${project}' = '${period}'", expect: { rows: 1 } } };
  const run = database([
    ["period = 'P1'", [['PR1']]],
    ['FROM p', [['P1']]],
  ]);
  const { cases } = await resolveCases([withChain], run);
  assert.equal(cases[0].db_assert.query, "SELECT 1 WHERE 'PR1' = 'P1'");
});

test('a variable the environment has no row for removes the block and is reported, so the tier says NOT RUN with the reason', async () => {
  const { cases, unresolved } = await resolveCases([meeting], async () => [], { tenantId: 'T' });
  assert.equal(cases[0].idempotency, undefined);
  assert.deepEqual(unresolved, [{ tc_id: 'TC-UAT-DIR-IDM-01', block: 'idempotency', reason: 'day: the environment holds no row for it' }]);
});

test('a read that writes is never run, and a hole in the block is reported instead of sent', async () => {
  let ran = 0;
  const run = async () => {
    ran += 1;
    return [['x']];
  };
  const writes = { tc_id: 'W', db_assert: { resolve: { v: 'DELETE FROM machvon.project' }, query: 'SELECT 1', expect: { rows: 1 } } };
  const hole = { tc_id: 'H', db_assert: { resolve: { v: 'SELECT 1' }, query: "SELECT '${nope}'", expect: { rows: 1 } } };
  const hole2 = { tc_id: 'H2', db_assert: { resolve: { v: "SELECT '${nope}'" }, query: 'SELECT 1', expect: { rows: 1 } } };
  const { cases, unresolved } = await resolveCases([writes, hole, hole2], run);
  assert.equal(ran, 1, 'only the one statement that is a read and has no hole ran: the write is refused and the hole is found before it is run');
  assert.deepEqual(cases.map((one) => one.db_assert), [undefined, undefined, undefined]);
  assert.deepEqual(unresolved.map((item) => item.tc_id), ['W', 'H', 'H2']);
  assert.match(unresolved[0].reason, /SELECT or WITH/u);
  assert.match(unresolved[1].reason, /not a variable/u);
});

test('a block that only uses the stamp needs no resolve, and one that uses an unknown name is reported', async () => {
  const stamped = { tc_id: 'S', idempotency: { body: { name: 'Lakehouse ${stamp}' }, count_query: "SELECT count(*) WHERE name = 'Lakehouse ${stamp}'" } };
  const broken = { tc_id: 'B', db_assert: { query: "SELECT '${nobody}'", expect: { rows: 1 } } };
  const { cases, unresolved } = await resolveCases([stamped, broken], async () => [['1']], { stamp: '77' });
  assert.deepEqual(cases[0].idempotency.body, { name: 'Lakehouse 77' });
  assert.equal(cases[1].db_assert, undefined);
  assert.deepEqual(unresolved, [{ tc_id: 'B', block: 'db_assert', reason: '${nobody} is not a variable of the block' }]);
});

test('cases and blocks without resolve are returned unchanged, and a block can be a non-object without breaking the walk', async () => {
  const plain = { tc_id: 'P', db_assert: { query: 'SELECT 1', expect: { rows: 1 } }, audit_assert: null, idempotency: 'x' };
  const { cases, unresolved } = await resolveCases([plain, { tc_id: 'Q' }], async () => [['1']]);
  assert.deepEqual(cases, [plain, { tc_id: 'Q' }]);
  assert.deepEqual(unresolved, []);
});

async function withFiles(run) {
  const folder = mkdtempSync(join(tmpdir(), 'uat-db-cases-'));
  try {
    return await run(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

test('main reads the cases, resolves them through the connection, writes the cases and the list of what was not resolved, and ends the connection', async () => {
  await withFiles(async (folder) => {
    const input = join(folder, 'cases.json');
    const output = join(folder, 'resolved.json');
    writeFileSync(input, `${String.fromCharCode(0xfeff)}${JSON.stringify({ feature: 'f', cases: [meeting, { tc_id: 'Z', db_assert: { resolve: { v: 'SELECT 1 WHERE false' }, query: 'SELECT 1', expect: { rows: 1 } } }] })}`);
    const lines = [];
    let ended = 0;
    const connect = async (dsn) => {
      assert.equal(dsn, 'postgres://ro@host/db');
      return { query: async (sql) => (sql.includes('false') ? [] : sql.includes('current_date') ? [['2026-11-11']] : [['unit-1']]), end: async () => (ended += 1) };
    };
    const code = await main(['--cases', input, '--out', output, '--tenant', 'tenant-A'], { env: { UAT_DB_DSN: 'postgres://ro@host/db' }, log: (line) => lines.push(line), connect });
    assert.equal(code, 0);
    assert.equal(ended, 1);
    const written = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(written.feature, 'f');
    assert.equal(written.cases[0].idempotency.body.unit_id, 'unit-1');
    assert.equal(written.cases[1].db_assert, undefined);
    const listed = JSON.parse(readFileSync(join(folder, 'resolved.unresolved.json'), 'utf8'));
    assert.deepEqual(listed.unresolved.map((item) => item.tc_id), ['Z']);
    assert.ok(lines.some((line) => line.includes('1 block(s) not resolved')));
    assert.ok(lines.some((line) => line.includes('Z db_assert')));
  });
});

test('main takes the DSN and the tenant from the environment, and ends the connection even when a read fails', async () => {
  await withFiles(async (folder) => {
    const input = join(folder, 'cases.json');
    writeFileSync(input, JSON.stringify({ cases: [{ tc_id: 'X', db_assert: { resolve: { v: 'SELECT 1' }, query: 'SELECT 1', expect: { rows: 1 } } }] }));
    let ended = 0;
    const connect = async () => ({
      query: async () => {
        throw new Error('connection lost');
      },
      end: async () => (ended += 1),
    });
    await assert.rejects(() => main(['--cases', input, '--out', join(folder, 'o.json')], { env: { UAT_DB_DSN: 'postgres://x', UAT_TENANT_ID: 't' }, log: () => {}, connect }), /connection lost/u);
    assert.equal(ended, 1);
  });
});

test('main without the files or the DSN, or with an unknown option, says how it is used and does nothing', async () => {
  const lines = [];
  const log = (line) => lines.push(line);
  assert.equal(await main([], { env: {}, log }), 2);
  assert.equal(await main(['--cases', 'a.json', '--out', 'b.json'], { env: {}, log }), 2);
  assert.equal(await main(['--bogus'], { env: {}, log }), 2);
  assert.equal(lines.length, 3);
  assert.ok(lines.every((line) => line.startsWith('usage:')));
});
