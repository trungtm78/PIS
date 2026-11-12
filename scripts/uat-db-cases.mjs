// Resolves the variables of the DB-tier cases (`db_assert`, `audit_assert`, `idempotency`) of docs/uat/*/uat.json against the environment that is measured.
//
// Why it exists (UAT run r6, R6-ENT-07): the cases of the data tier were written with placeholders (`<hôm qua>`, `<id kỳ>`, `{appropriation_id}`) and counted rows by a content that an earlier run of the
// same case had left, so against a shared demo database 13 idempotency cases sent bodies the API refuses (400) and 15 audit/db cases named a table the product does not have. A case now carries, next to
// its block, `resolve`: an ordered map of name -> read-only SQL (SELECT or WITH). Each SQL runs once against the measured database, in order (a later one may use `${name}` of an earlier one), and the first
// cell of its first row becomes the value of `${name}` everywhere in the block (url, body, query, count_query). Built-in values: `${tenant_id}` (`--tenant` or UAT_TENANT_ID) and `${stamp}` (a number
// that is new at every run, so a body made with it is a body no earlier run wrote and a count of what it made is exact).
//
// `$[since_key]` expands to the instant the first request of the run under the Idempotency-Key was recorded (minus ten seconds), for a count of "what this run made" where a stamp cannot be used.
//
// A variable that finds no row means the environment lacks what the case needs (no unused period, no scenario data): the block is removed and the case is reported in `unresolved`, so the tier says
// NOT RUN for it with the reason; it is never given an invented value and never turned into a pass. The SQL is held to the same read-only guard as the tool that runs the blocks.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const BLOCKS = ['db_assert', 'audit_assert', 'idempotency'];

/** Text a case may use in any of its strings as `$[name]`. The query parameter `%s` is the Idempotency-Key the tool sends. */
export const MACROS = {
  since_key: "(SELECT min(created_at) FROM machvon.idempotency_record WHERE key_hash = encode(sha256(convert_to(%s, 'UTF8')), 'hex')) - interval '10 seconds'",
};

const WRITE_WORDS = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|COPY|CALL|DO)\b/i;

/** Null when the statement may run; otherwise why not (the guard of the tool that runs the blocks: reads only, one statement). */
export function guardSql(sql) {
  const text = String(sql ?? '').trim().replace(/;+\s*$/u, '');
  if (!/^(SELECT|WITH)\b/iu.test(text)) return 'a variable is read with SELECT or WITH only';
  if (text.includes(';')) return 'a second statement is a way round the read-only rule';
  if (WRITE_WORDS.test(text)) return 'the statement holds a word that writes';
  return null;
}

/**
 * `${name}` of the variables, then `$[macro]`, in every string of a value (arrays and objects are walked). A string that is only `${name|int}` becomes the whole number (a body field of type integer);
 * a text that is not a whole number is an error. An unknown name is an error: a body must never be sent with a hole in it.
 */
export function substitute(value, variables) {
  if (typeof value === 'string') {
    const whole = /^\$\{(\w+)\|int\}$/u.exec(value);
    if (whole !== null) {
      const text = Object.hasOwn(variables, whole[1]) ? variables[whole[1]] : undefined;
      if (text === undefined) throw new Error(`\${${whole[1]}} is not a variable of the block`);
      if (!/^-?\d+$/u.test(text)) throw new Error(`\${${whole[1]}} is not a whole number`);
      return Number(text);
    }
    const filled = value.replace(/\$\{(\w+)\}/gu, (_whole, name) => {
      if (!Object.hasOwn(variables, name)) throw new Error(`\${${name}} is not a variable of the block`);
      return variables[name];
    });
    return filled.replace(/\$\[(\w+)\]/gu, (_whole, name) => {
      if (!Object.hasOwn(MACROS, name)) throw new Error(`$[${name}] is not a macro`);
      return MACROS[name];
    });
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, variables));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, substitute(item, variables)]));
  return value;
}

/** A block is resolved when it declares variables or uses one (`${...}`, `$[...]`), so that a body made with the stamp alone needs no `resolve`. */
export const needsResolving = (spec) => spec.resolve !== undefined || /\$[{[]/u.test(JSON.stringify(spec));

/** The first cell of the first row as text; undefined when the query gave no row or a null. */
export const firstCell = (rows) => {
  const row = rows[0];
  if (row === undefined) return undefined;
  const cell = Array.isArray(row) ? row[0] : Object.values(row)[0];
  return cell === null || cell === undefined ? undefined : String(cell);
};

/**
 * Resolves the blocks of the cases. `runQuery(sql)` answers the rows of a read. Returns the cases with their blocks filled (a block that cannot be resolved is removed) and the list of what could not be.
 * Cases whose blocks declare and use no variable are returned as they are.
 */
export async function resolveCases(cases, runQuery, { tenantId, stamp = String(Date.now()) } = {}) {
  const unresolved = [];
  const resolved = [];
  for (const original of cases) {
    const copy = structuredClone(original);
    for (const block of BLOCKS) {
      const spec = copy[block];
      if (spec === undefined || spec === null || typeof spec !== 'object' || !needsResolving(spec)) continue;
      const { resolve = {}, ...rest } = spec;
      const variables = { stamp, ...(tenantId === undefined ? {} : { tenant_id: tenantId }) };
      let reason;
      for (const [name, sql] of Object.entries(resolve)) {
        let text;
        try {
          text = substitute(sql, variables);
        } catch (error) {
          reason = `${name}: ${error.message}`;
          break;
        }
        const refused = guardSql(text);
        if (refused !== null) {
          reason = `${name}: ${refused}`;
          break;
        }
        const value = firstCell(await runQuery(text));
        if (value === undefined) {
          reason = `${name}: the environment holds no row for it`;
          break;
        }
        variables[name] = value;
      }
      if (reason === undefined) {
        try {
          copy[block] = substitute(rest, variables);
        } catch (error) {
          reason = error.message;
        }
      }
      if (reason !== undefined) {
        delete copy[block];
        unresolved.push({ tc_id: original.tc_id, block, reason });
      }
    }
    resolved.push(copy);
  }
  return { cases: resolved, unresolved };
}

const USAGE = 'usage: node scripts/uat-db-cases.mjs --cases <cases.json> --out <resolved.json> [--dsn <postgres url> | UAT_DB_DSN] [--tenant <uuid> | UAT_TENANT_ID]';

export async function main(argv, { env = process.env, log = console.log, connect } = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { cases: { type: 'string' }, out: { type: 'string' }, dsn: { type: 'string' }, tenant: { type: 'string' } } }));
  } catch {
    log(USAGE);
    return 2;
  }
  const dsn = values.dsn ?? env.UAT_DB_DSN;
  if (values.cases === undefined || values.out === undefined || dsn === undefined || dsn === '') {
    log(USAGE);
    return 2;
  }
  const text = readFileSync(values.cases, 'utf8');
  const document = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  const open = connect ?? (async (url) => {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    // The tier reads only; the session is held to it as well.
    await client.query('SET default_transaction_read_only = on');
    return { query: async (sql) => (await client.query({ text: sql, rowMode: 'array' })).rows, end: () => client.end() };
  });
  const database = await open(dsn);
  try {
    const { cases, unresolved } = await resolveCases(document.cases ?? [], (sql) => database.query(sql), { tenantId: values.tenant ?? env.UAT_TENANT_ID });
    writeFileSync(values.out, `${JSON.stringify({ ...document, cases }, null, 2)}\n`);
    writeFileSync(values.out.replace(/\.json$/u, '.unresolved.json'), `${JSON.stringify({ unresolved }, null, 2)}\n`);
    log(`uat-db-cases: ${cases.length} cases, ${unresolved.length} block(s) not resolved (the environment lacks what they need; they are NOT RUN, not passed)`);
    for (const item of unresolved) log(`  - ${item.tc_id} ${item.block}: ${item.reason}`);
  } finally {
    await database.end();
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
