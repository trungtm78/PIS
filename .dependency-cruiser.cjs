// Module rules for the MACHVON monorepo (ST-KERNEL-010). Paths are relative to the repository root.
// A target is matched by its resolved path (workspace symlinks resolve to packages/* and apps/*)
// and by the bare specifier, so the rules also hold when dependencies are not installed.
const OTHER_PACKAGES = '^(packages/(db|contracts|api-client|design-tokens|edition-enterprise)/|@machvon/(db|contracts|api-client|design-tokens|edition-enterprise|api|web)(/|$))';
const ANY_APP = '^(apps/|@machvon/(api|web)(/|$))';
// Imports that apps/web must never have: server-side workspaces and the API app.
const WEB_FORBIDDEN = '^(packages/(kernel|db)/|apps/api/|@machvon/(kernel|db|api)(/|$))';
// The one file of the kernel the web may read: the edition mechanism is pure and imports nothing (ENT-0); the rest of the kernel stays server-side.
const WEB_ALLOWED_KERNEL_FILE = '^(packages/kernel/src/(edition|fin-defaults)\\.ts|@machvon/kernel/src/(edition|fin-defaults)\\.ts)$';
// fin-defaults.ts (FIN-1) is the same kind of file: data only, no run-time import. The formula module itself (fin-analysis.ts) is read by exactly two web files, the test fixtures that build a report the way the server does.
const WEB_KERNEL_TEST_READERS = '^apps/web/src/screens/prj/fin/(fixtures\\.ts|model\\.test\\.ts)$';
const WEB_TEST_ALLOWED_KERNEL_FILE = '^(packages/kernel/src/(edition|fin-defaults|fin-analysis)\\.ts|@machvon/kernel/src/(edition|fin-defaults|fin-analysis)\\.ts)$';
// What belongs to the enterprise edition only (ENT-0, structure B): its package and the enterprise folders of the web and the phone.
const ENTERPRISE_CODE = '^(packages/edition-enterprise/|apps/web/src/editions/enterprise/|apps/mobile/lib/editions/enterprise/|@machvon/edition-enterprise(/|$))';
// The only files that may import it: the enterprise code itself, one loader per process (the composition seams) and the tests named *.enterprise.test.
// scripts/edition-check.mjs holds the same list for the static scan; its test compares the two.
const ENTERPRISE_IMPORTERS = '^(packages/edition-enterprise/|apps/web/src/editions/(enterprise/|load\\.ts$)|apps/api/src/editions/load-enterprise\\.ts$)|\\.enterprise\\.test\\.tsx?$';
// design-tokens is framework-free and imports no workspace; api-client reaches only the contracts.
const TOKENS_FORBIDDEN = '^(packages/(kernel|db|contracts|api-client)/|@machvon/(kernel|db|contracts|api-client)(/|$))';
const CLIENT_FORBIDDEN = '^(packages/(kernel|db|design-tokens)/|@machvon/(kernel|db|design-tokens)(/|$))';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'operations-alerts-independent-of-notifications',
      comment: 'Operations alerts must reach the on-call people when notifications are what is broken: apps/api/src/alerts has no import path to the notification code.',
      severity: 'error',
      from: { path: '^apps/api/src/alerts/' },
      to: { path: '^apps/api/src/(notifications|modules/not)/|^packages/db/src/notification-store' },
    },
    {
      name: 'kernel-imports-nothing-from-other-packages',
      comment: '@machvon/kernel is the dependency-free core; it must not import other workspaces.',
      severity: 'error',
      from: { path: '^packages/kernel/' },
      to: { path: `${OTHER_PACKAGES}|${ANY_APP}` },
    },
    {
      name: 'packages-must-not-import-apps',
      comment: 'Dependencies point from apps/* to packages/*, never the other way.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: ANY_APP },
    },
    {
      name: 'design-tokens-imports-no-workspace',
      comment: '@machvon/design-tokens is framework-free and imports nothing from other workspaces.',
      severity: 'error',
      from: { path: '^packages/design-tokens/' },
      to: { path: TOKENS_FORBIDDEN },
    },
    {
      name: 'api-client-imports-contracts-only',
      comment: '@machvon/api-client may import @machvon/contracts and nothing else from the workspaces.',
      severity: 'error',
      from: { path: '^packages/api-client/' },
      to: { path: CLIENT_FORBIDDEN },
    },
    {
      name: 'web-imports-allowed-packages-only',
      comment: 'apps/web may import design-tokens, api-client and contracts (types) only, never server-side code.',
      severity: 'error',
      from: { path: '^apps/web/', pathNot: WEB_KERNEL_TEST_READERS },
      to: { path: WEB_FORBIDDEN, pathNot: WEB_ALLOWED_KERNEL_FILE },
    },
    {
      name: 'web-test-fixtures-read-the-formula-module-only',
      comment: 'The two web test files that build an appraisal report with the real formula may read that one kernel file besides the allowed ones; they import nothing else server-side.',
      severity: 'error',
      from: { path: WEB_KERNEL_TEST_READERS },
      to: { path: WEB_FORBIDDEN, pathNot: WEB_TEST_ALLOWED_KERNEL_FILE },
    },
    {
      name: 'enterprise-edition-code-only-from-its-homes',
      comment: 'The enterprise edition is a product apart: only its own folders and the loader of each process may import it, so the public edition holds none of it (npm run edition:check scans the same).',
      severity: 'error',
      from: { pathNot: ENTERPRISE_IMPORTERS },
      to: { path: ENTERPRISE_CODE },
    },
    {
      name: 'api-does-not-import-web',
      comment: 'Apps do not depend on each other.',
      severity: 'error',
      from: { path: '^apps/api/' },
      to: { path: '^(apps/web/|@machvon/web(/|$))' },
    },
  ],
  options: {
    tsPreCompilationDeps: true,
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(node_modules|dist|coverage)/' },
  },
};
