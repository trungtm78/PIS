// The journal lines of a Flutter test run (scripts/uat-run.mjs): reads the output of `flutter test --reporter json` (one JSON event per line) and writes one `result` line for each test case that ended,
// in the file of the journal, with the suite `dart`.
//   flutter test --reporter json test/features/account > dart.json && node scripts/uat-dart-journal.mjs dart.json <journal>
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** The journal lines of the events of a Flutter run: a test that has a name, the file of its suite and an end (hidden loading steps are left out). */
export function dartJournal(events, startedAt = Date.now()) {
  const suites = new Map();
  const started = new Map();
  const lines = [];
  for (const event of events) {
    if (event.suite !== undefined) suites.set(event.suite.id, event.suite.path);
    if (event.type === 'testStart') started.set(event.test.id, { name: event.test.name, file: suites.get(event.test.suiteID), time: event.time });
    if (event.type !== 'testDone' || event.hidden === true) continue;
    const test = started.get(event.testID);
    if (test?.file === undefined) continue;
    const durationMs = Math.max(0, (event.time ?? 0) - (test.time ?? 0));
    const status = event.skipped === true ? 'skipped' : event.result === 'success' ? 'passed' : 'failed';
    lines.push({
      kind: 'result',
      suite: 'dart',
      file: resolve(test.file),
      name: test.name,
      status,
      durationMs,
      at: new Date(startedAt + (test.time ?? 0)).toISOString(),
    });
  }
  return lines;
}

export function parseEvents(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [input, journal] = process.argv.slice(2);
  if (input === undefined || journal === undefined) {
    console.error('usage: node scripts/uat-dart-journal.mjs <flutter-json-output> <journal>');
    process.exit(2);
  }
  const lines = dartJournal(parseEvents(readFileSync(input, 'utf8')));
  appendFileSync(journal, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
  console.log(`${lines.length} test cases written to ${journal}`);
}
