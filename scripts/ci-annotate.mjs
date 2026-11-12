#!/usr/bin/env node
// Turns the log of a failed CI step into ONE public check-run annotation that names the failing tests.
//
// Why: the job log of a GitHub Actions run needs repository admin rights to download, but the annotations of a check run are public. A step that
// ends with "Process completed with exit code 1" tells nobody which test failed. Running the test command through `tee` and then this script (in a
// step with `if: failure()`) puts the failing test names and their first error lines into the annotation, where the API and the run page show them.
//
//   node scripts/ci-annotate.mjs <logfile> <kind> [--title "text"]    kind: jest | dart | playwright | gates
//
// The annotation is capped (the check-run API refuses messages over 64 KB), the text is escaped as the workflow-command syntax requires, and the
// script itself always exits 0: it must never turn a green step red or hide the exit status of the step it reports on.
import { readFileSync, existsSync } from 'node:fs';

const MAX_MESSAGE = 48_000;
const MAX_BLOCKS = 60;

/** Line patterns that start a block worth reporting, and how many lines after it belong to the block. */
export const KINDS = {
  jest: { start: /^\s*(FAIL |● .+ › |● .+$)|^\s*[✕×]\s|Tests:\s+\d+ failed|Test Suites:\s+\d+ failed|^\s*(ERR!|npm error)\s|error TS\d+|^\s*not ok \d+|^\s*✖ |coverage threshold|does not meet threshold/, after: 6 },
  dart: { start: /\[E\]|Some tests failed|^\s*Failed to load|^\s*Error: |FAILED:/, after: 8 },
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

/** The blocks of a log: every start line with the lines after it, consecutive blocks merged, ANSI colours removed. */
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
  return blocks.map((block) => lines.slice(block.start, block.end + 1).map((line) => line.slice(0, 400)).join('\n'));
}

/** The annotation text for a log: the failure blocks, the first ones kept when they do not fit, and a tail of the log when nothing matched. */
export function annotationText(log, kind) {
  const blocks = failureBlocks(log, kind);
  let body;
  if (blocks.length === 0) {
    const tail = log.split(/\r?\n/).filter((line) => line.trim() !== '').slice(-25).map((line) => line.slice(0, 400));
    body = `no failure line matched the ${kind} patterns; last lines of the log:\n${tail.join('\n')}`;
  } else {
    const shown = blocks.slice(0, MAX_BLOCKS);
    body = `${blocks.length} failure block(s)${blocks.length > shown.length ? `, first ${shown.length} shown` : ''}:\n${shown.join('\n---\n')}`;
  }
  return body.length > MAX_MESSAGE ? `${body.slice(0, MAX_MESSAGE)}\n[cut]` : body;
}

/** The workflow command line to print. */
export function annotationCommand(log, kind, title) {
  return `::error title=${escapeProperty(title)}::${escapeMessage(annotationText(log, kind))}`;
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
  out(annotationCommand(readFileSync(file, 'utf8'), kind, title));
  return 0;
}

if (process.argv[1]?.endsWith('ci-annotate.mjs')) {
  process.exit(main(process.argv.slice(2)));
}
