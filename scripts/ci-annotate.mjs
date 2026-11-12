#!/usr/bin/env node
// Turns the log of a failed CI step into public check-run annotations that name the failing tests.
//
// Why: the job log of a GitHub Actions run needs repository admin rights to download, but the annotations of a check run are public. A step that
// ends with "Process completed with exit code 1" tells nobody which test failed. Running the test command through `tee` and then this script (in a
// step with `if: failure()`) puts the failing test names and their first error lines into annotations, where the API and the run page show them.
//
//   node scripts/ci-annotate.mjs <logfile> <kind> [--title "text"]    kind: jest | dart | playwright | gates
//
// A workflow-command annotation shows only about 4 KB of its message, so the text is cut into chunks (one annotation each, at most 8), lines of passing
// tests are left out, and the script itself always exits 0: it must never turn a green step red or hide the exit status of the step it reports on.
import { readFileSync, existsSync } from 'node:fs';

const CHUNK = 3600;
const MAX_CHUNKS = 8;
const MAX_BLOCKS = 80;
/** A line of a passing test: it is context of a failure, never worth the 4 KB. */
const PASSING = /^\s*(✓|✅|ok \d+|PASS\b)/;

/** Line patterns that start a block worth reporting, and how many lines after it belong to the block. */
export const KINDS = {
  jest: { start: /^\s*(FAIL |● .+ › |● .+$)|^\s*[✕×]\s|Tests:\s+\d+ failed|Test Suites:\s+\d+ failed|^\s*(ERR!|npm error)\s|error TS\d+|^\s*not ok \d+|^\s*✖ |coverage threshold|does not meet threshold/, after: 6 },
  dart: { start: /\[E\]|❌|\d+ failed|Some tests failed|^\s*Failed to load|^\s*Error: |FAILED:/, after: 6 },
  playwright: { start: /^\s*(\d+\)\s|[✘x]\s)|\d+ failed|\d+ flaky|Error: |Timeout of \d+ms exceeded/, after: 8 },
  gates: { start: /\bFAIL(ED)?\b|✗|✘|\bERROR\b|exit code [1-9]|not ok /, after: 4 },
};

/** The escaping the runner applies to the message of a workflow command. */
export function escapeMessage(text) {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Escaping of a property (the title): also the separators of properties. */
export function escapeProperty(text) {
  return escapeMessage(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/** The blocks of a log: every start line with the lines after it (passing-test lines dropped), consecutive blocks merged, ANSI colours removed. */
export function failureBlocks(log, kind) {
  const rule = KINDS[kind];
  if (!rule) throw new Error(`unknown kind ${kind}`);
  // eslint-disable-next-line no-control-regex
  const lines = log.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/);
  const blocks = [];
  let until = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (!rule.start.test(lines[index])) continue;
    const end = Math.min(lines.length - 1, index + rule.after);
    if (index <= until && blocks.length > 0) {
      blocks[blocks.length - 1].end = end;
    } else {
      blocks.push({ start: index, end });
    }
    until = end;
  }
  return blocks
    .map((block) => lines.slice(block.start, block.end + 1).filter((line) => !PASSING.test(line)).map((line) => line.slice(0, 240)).join('\n'))
    .filter((block) => block.trim() !== '');
}

/** The last non-empty lines of a log, cut to a readable width. */
function tailOf(log, count) {
  return log.split(/\r?\n/).filter((line) => line.trim() !== '').slice(-count).map((line) => line.slice(0, 240)).join('\n');
}

/** The annotation text for a log: the failure blocks, the first ones kept when there are many, and a tail of the log when nothing matched. */
export function annotationText(log, kind) {
  const blocks = failureBlocks(log, kind);
  if (blocks.length === 0) {
    return `no failure line matched the ${kind} patterns; last lines of the log:\n${tailOf(log, 25)}`;
  }
  const shown = blocks.slice(0, MAX_BLOCKS);
  // The end of the log is always added: a step that was killed (memory, a dead server) leaves no failure line, only a log that stops.
  return `${blocks.length} failure block(s)${blocks.length > shown.length ? `, first ${shown.length} shown` : ''}:\n${shown.join('\n---\n')}\n--- end of the log:\n${tailOf(log, 12)}`;
}

/** The text cut into the chunks of one annotation each, at line ends; what does not fit in MAX_CHUNKS is dropped with a marker. */
export function chunksOf(text) {
  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current !== '' && current.length + line.length + 1 > CHUNK) {
      chunks.push(current);
      current = '';
    }
    current = current === '' ? line.slice(0, CHUNK) : `${current}\n${line}`;
  }
  if (current !== '') chunks.push(current);
  if (chunks.length <= MAX_CHUNKS) return chunks;
  return [...chunks.slice(0, MAX_CHUNKS - 1), `${chunks[MAX_CHUNKS - 1]}\n[cut: ${chunks.length - MAX_CHUNKS} more chunk(s) dropped]`];
}

/** The workflow command lines to print: one annotation per chunk, numbered in the title when there are several. */
export function annotationCommands(log, kind, title) {
  const chunks = chunksOf(annotationText(log, kind));
  return chunks.map((chunk, index) => `::error title=${escapeProperty(chunks.length > 1 ? `${title} (${index + 1}/${chunks.length})` : title)}::${escapeMessage(chunk)}`);
}

export function main(argv, out = (line) => console.log(line)) {
  const [file, kind, ...rest] = argv;
  const titleAt = rest.indexOf('--title');
  const title = titleAt >= 0 && rest[titleAt + 1] ? rest[titleAt + 1] : `Failures (${kind})`;
  if (!file || !KINDS[kind]) {
    out(`::warning title=ci-annotate::usage: ci-annotate.mjs <logfile> <${Object.keys(KINDS).join('|')}> [--title text]`);
    return 0;
  }
  if (!existsSync(file)) {
    out(`::warning title=${escapeProperty(title)}::the log file ${escapeMessage(file)} does not exist, nothing to report`);
    return 0;
  }
  for (const line of annotationCommands(readFileSync(file, 'utf8'), kind, title)) out(line);
  return 0;
}

if (process.argv[1]?.endsWith('ci-annotate.mjs')) {
  process.exit(main(process.argv.slice(2)));
}
