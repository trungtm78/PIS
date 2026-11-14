// node:test reporter of a UAT run (scripts/uat-run.mjs): one JSON line for each test case that ended, in the journal named by UAT_JOURNAL (the same lines as
// scripts/uat-jest-reporter.mjs, suite `jest`: uat-run.mjs reads a node:test case the way it reads a Jest one). Used as
//   UAT_JOURNAL=<file> node --test --test-reporter=./scripts/uat-node-reporter.mjs --test-reporter-destination=stdout scripts/*.test.mjs
// The name of a case is the names of the suites around it and its own, as Jest builds a full name.
import { appendFileSync } from 'node:fs';

/** The journal line of one `test:pass` or `test:fail` event, or undefined for a suite; `stack` holds the names of the open suites and tests of the file by nesting. */
export function journalLine(event, stack, now = Date.now()) {
  const { data, type } = event;
  if (data.details?.type === 'suite') return undefined;
  const duration = data.details?.duration_ms ?? 0;
  const name = [...stack.slice(0, data.nesting), data.name].join(' ');
  const status = data.skip !== undefined ? 'skipped' : data.todo !== undefined ? 'todo' : type === 'test:pass' ? 'passed' : 'failed';
  return { kind: 'result', suite: 'jest', file: data.file ?? '', name, status, durationMs: Math.round(duration), at: new Date(now - duration).toISOString() };
}

export default async function* uatNodeReporter(source) {
  const stacks = new Map();
  for await (const event of source) {
    const file = event.data?.file ?? '';
    if (event.type === 'test:start') {
      const stack = stacks.get(file) ?? [];
      stack.length = event.data.nesting;
      stack[event.data.nesting] = event.data.name;
      stacks.set(file, stack);
    } else if (event.type === 'test:pass' || event.type === 'test:fail') {
      const line = journalLine(event, stacks.get(file) ?? []);
      const journal = process.env.UAT_JOURNAL;
      if (line !== undefined) {
        if (journal !== undefined && journal !== '') appendFileSync(journal, `${JSON.stringify(line)}\n`);
        yield `${line.status === 'passed' ? 'ok' : line.status === 'failed' ? 'not ok' : line.status} ${line.name}\n`;
      }
    }
  }
}
