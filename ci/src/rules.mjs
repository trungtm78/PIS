// Rule tables for AUTONOMOUS_EXECUTION_PROTOCOL.md section 4 (code standard), section 5 (banned
// shortcuts) and section 8c (secrets). This file defines the patterns as text, so it is excluded
// from scanning itself (see IGNORED_PATHS in scan.mjs).

export const COVERAGE_FLOOR = 90;

const CODE_FILE = /\.(mjs|cjs|js|jsx|ts|tsx|dart|py|java|kt|cs|go|rs|sql|json|ya?ml|toml)$/;
const SOURCE_FILE = /\.(mjs|cjs|js|jsx|ts|tsx|dart|py|java|kt|cs|go|rs)$/;
// Resources and tests: the message files, the string tables of the apps (`*_strings.dart`, `l10n/`), the files that a tool writes (`*.generated.*`),
// the tests and the helpers that only the tests use (`test-support.*`).
const RESOURCE_OR_TEST = /(^|\/)(messages|locales|i18n|l10n|test|tests|__tests__|fixtures?)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py|dart)$|_strings\.dart$|\.generated\.[a-z]+$|(^|\/)test-support\.[a-z]+$/;
const VIETNAMESE_LETTER = /[À-ỹ]/;
// The interactive mockup is a design artifact whose on-screen copy is Vietnamese by design; the
// English-code rule protects product code and is not applied to it. Every other rule still is.
const DESIGN_MOCKUP = /(^|\/)02_Prototype\//;

function numberBelowFloor(line, pattern) {
  const match = line.match(pattern);
  return match !== null && Number(match[1]) < COVERAGE_FLOOR;
}

export const CODE_RULES = [
  {
    code: 'TYPE_SUPPRESSION',
    appliesTo: (file) => CODE_FILE.test(file),
    test: (line) => /@ts-(ignore|nocheck|expect-error)|eslint-disable|#\s*type:\s*ignore|#\s*noqa|\/\/\s*nolint/.test(line),
  },
  {
    code: 'EMPTY_CATCH',
    appliesTo: (file) => SOURCE_FILE.test(file),
    test: (line) => /catch\s*(\([^)]*\))?\s*\{\s*\}/.test(line) || /except[^:]*:\s*pass\b/.test(line),
  },
  {
    code: 'SKIPPED_TEST',
    appliesTo: (file) => SOURCE_FILE.test(file),
    test: (line) =>
      /\b(it|test|describe|t)\.(skip|only)\s*\(/.test(line) ||
      /\b(xit|xdescribe|xtest)\s*\(/.test(line) ||
      /\bskip\s*:\s*true\b/.test(line) ||
      /@(Disabled|Ignore)\b/.test(line),
  },
  {
    code: 'DEBT_MARKER',
    appliesTo: (file) => SOURCE_FILE.test(file),
    test: (line) => /\b(TODO|FIXME|HACK|XXX)\b/.test(line),
  },
  {
    code: 'FIXED_SLEEP',
    severity: 'warning',
    appliesTo: (file) => SOURCE_FILE.test(file) && !RESOURCE_OR_TEST.test(file),
    test: (line) => /\b(sleep|Thread\.sleep|time\.sleep)\s*\(/.test(line) || /new Promise\([^)]*setTimeout/.test(line),
  },
  {
    code: 'LOWERED_COVERAGE',
    appliesTo: (file) => CODE_FILE.test(file) || /\.(cfg|ini)$/.test(file),
    test: (line) =>
      numberBelowFloor(line, /--test-coverage-(?:lines|functions|branches)=(\d+)/) ||
      numberBelowFloor(line, /fail_under\s*=\s*(\d+)/) ||
      numberBelowFloor(line, /--cov-fail-under=(\d+)/) ||
      numberBelowFloor(line, /"lines"\s*:\s*(\d+)/),
  },
  {
    code: 'NON_ENGLISH_CODE',
    appliesTo: (file) => SOURCE_FILE.test(file) && !RESOURCE_OR_TEST.test(file) && !DESIGN_MOCKUP.test(file),
    test: (line) => VIETNAMESE_LETTER.test(line),
  },
];

export const SECRET_RULES = [
  {
    code: 'SECRET_FOUND',
    appliesTo: () => true,
    test: (line) =>
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line) ||
      /\bAKIA[0-9A-Z]{16}\b/.test(line) ||
      /\bgh[pousr]_[A-Za-z0-9]{36,}\b/.test(line) ||
      /\bsk_(live|test)_[A-Za-z0-9]{10,}\b/.test(line) ||
      /\b(password|passwd|secret|api[_-]?key|access[_-]?token)\b\s*[:=]\s*["'][^"'\s]{8,}["']/i.test(line),
  },
];
