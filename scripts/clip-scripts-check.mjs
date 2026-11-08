import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBook, bookPath, checkClip, checkFiles, loadAll } from './clips/production.mjs';
import { flag, positionals } from './clips/common.mjs';
import { loadScenario } from './clips/scenario.mjs';

/**
 * The check of the production scripts of the two intro clips:
 *   node scripts/clip-scripts-check.mjs check [clip ...] [--strict] [--strict-data]
 *   node scripts/clip-scripts-check.mjs book [clip ...] [--write]     prints (or writes to docs/clips) the shooting script
 *   node scripts/clip-scripts-check.mjs report [clip ...]            the warnings only (screens without a module, chapters with data not yet proven)
 * `check` fails when a screen id or route is unknown, durations do not add up, a sentence is English only or too long for the voice, a term is missing in the
 * phonetic table, a secret shows up, a subtitle line is too long, the music cue sheet has a gap, or a committed shooting script is out of date.
 * `--strict` also fails on a screen that has a route but no module in this build; `--strict-data` on a chapter whose data groups are not all run and verified.
 */
export function run(argv, io = { log: (line) => console.log(line), write: (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); }, read: (file) => readFileSync(file, 'utf8') }) {
  const [command = 'check', ...rest] = argv;
  const strict = flag(argv, 'strict');
  const strictData = flag(argv, 'strict-data');
  const all = loadAll({ strict });
  const wanted = positionals(rest);
  const clips = wanted.length > 0 ? wanted : all.clips;
  for (const clip of clips) if (!all.clips.includes(clip)) {
    io.log(`unknown clip ${clip}`);
    return 2;
  }
  const shared = { context: all.context, facts: all.facts, production: all.production };
  if (command === 'book') {
    for (const clip of clips) {
      const text = buildBook(clip, shared);
      if (flag(argv, 'write')) {
        io.write(bookPath(clip), text);
        io.log(`wrote ${bookPath(clip)}`);
      } else io.log(text);
    }
    return 0;
  }
  if (command !== 'check' && command !== 'report') {
    io.log('usage: node scripts/clip-scripts-check.mjs <check|book|report> [clip ...] [--strict] [--strict-data] [--write]');
    return 2;
  }
  let failures = 0;
  const scenarios = [];
  for (const clip of clips) {
    const { problems, warnings } = checkClip(clip, { ...shared, strict, strictData });
    scenarios.push(loadScenario(clip));
    if (command === 'check') {
      const stale = (() => {
        try {
          return io.read(bookPath(clip)).replace(/\r\n/gu, '\n') !== buildBook(clip, shared);
        } catch {
          return true;
        }
      })();
      if (stale) problems.push(`${clip}: the shooting script ${bookPath(clip)} is missing or out of date (run: node scripts/clip-scripts-check.mjs book --write)`);
      io.log(`${clip}: ${problems.length === 0 ? 'ok' : `${problems.length} problem(s)`}${warnings.length > 0 ? `, ${warnings.length} warning(s)` : ''}`);
      for (const problem of problems) io.log(`  ${problem}`);
      failures += problems.length;
    }
    if (command === 'report' || flag(argv, 'warnings')) for (const warning of warnings) io.log(`  warning: ${warning}`);
  }
  if (command === 'check' && wanted.length === 0) {
    const fileProblems = checkFiles({ production: all.production, scenarios });
    for (const problem of fileProblems) io.log(`  ${problem}`);
    failures += fileProblems.length;
  }
  return failures === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = run(process.argv.slice(2));
}
