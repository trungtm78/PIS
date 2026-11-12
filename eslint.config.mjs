import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const KEY_VALUE_RECEIVERS = 'store|redis|kv';
const KEY_VALUE_STORE_MESSAGE =
  'KeyValueStore may only be used in packages/kernel/src/tenant-keys.ts, packages/kernel/src/index.ts and packages/kernel/src/adapters/**; other code receives a TenantCache so keys carry the t:{tenantId}: prefix.';
const RAW_STORE_MESSAGE =
  'Direct .get/.set on a key-value store is forbidden outside packages/kernel/src/tenant-keys.ts; use TenantCache so keys carry the t:{tenantId}: prefix.';

// Second layer: calls on receivers that are named like a store.
const RAW_ACCESS_SELECTORS = [
  {
    selector: `CallExpression[callee.property.name=/^(get|set)$/][callee.object.name=/^(${KEY_VALUE_RECEIVERS})$/]`,
    message: RAW_STORE_MESSAGE,
  },
  {
    selector: `CallExpression[callee.property.name=/^(get|set)$/][callee.object.property.name=/^(${KEY_VALUE_RECEIVERS})$/]`,
    message: RAW_STORE_MESSAGE,
  },
];

// Primary layer: the KeyValueStore type cannot be named outside its allowed homes, whatever the module
// it is imported from (barrel, package or relative path) and whatever local name it is given.
const STORE_TYPE_SELECTORS = [
  "ImportSpecifier[imported.name='KeyValueStore']",
  "ImportSpecifier[imported.value='KeyValueStore']",
  "ExportSpecifier[local.name='KeyValueStore']",
  "ExportSpecifier[local.value='KeyValueStore']",
  "TSImportType[qualifier.name='KeyValueStore']",
  "TSQualifiedName[right.name='KeyValueStore']",
  String.raw`ExportAllDeclaration[source.value=/(^|\/)(tenant-keys|index)(\.[cm]?[jt]s)?$|^@machvon\/kernel$/]`,
].map((selector) => ({ selector, message: KEY_VALUE_STORE_MESSAGE }));

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/lint-fixtures/**', '**/*.generated.ts', 'Design/**', 'ci/**', 'docs/**', 'backend/**', '.tools/**', '.superpowers/**', '.claude/**', '.gstack/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-console': 'error',
    },
  },
  {
    // Plain scripts served as-is from apps/web/public run in the browser, not in Node.
    files: ['apps/web/public/**/*.js'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // Raw key-value access must go through TenantCache so every key carries the tenant prefix.
    files: ['**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', ...RAW_ACCESS_SELECTORS, ...STORE_TYPE_SELECTORS] },
  },
  {
    // The workspace packages are loaded by Node through type stripping, which cannot run TypeScript-only syntax
    // that emits code: a parameter property (`constructor(private x: T)`) fails at load time, so declare the field.
    files: ['packages/*/src/**/*.ts'],
    rules: { '@typescript-eslint/parameter-properties': 'error' },
  },
  {
    // Allowed homes of the store abstraction: its definition, the public re-export and store adapters.
    files: ['packages/kernel/src/tenant-keys.ts', 'packages/kernel/src/index.ts', 'packages/kernel/src/adapters/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // Tests implement in-memory stores to exercise TenantCache, so only the type ban is lifted for them.
    files: ['**/*.test.ts'],
    rules: { 'no-restricted-syntax': ['error', ...RAW_ACCESS_SELECTORS] },
  },
  {
    files: ['scripts/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.test.ts'],
    languageOptions: { globals: { ...globals.jest } },
  },
  {
    // The k6 scripts run in k6, not in Node: its globals.
    files: ['tests/k6/**/*.js'],
    languageOptions: { globals: { __ENV: 'readonly', open: 'readonly' } },
  },
  {
    // The web app runs in the browser; hooks rules apply, and warnings and errors may be logged.
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs['recommended-latest'].rules, 'no-console': ['error', { allow: ['warn', 'error'] }] },
  },
  {
    // The scripts the web app serves as they are (apps/web/public) run in the browser, before and outside the bundle.
    files: ['apps/web/public/**/*.js'],
    languageOptions: { globals: { ...globals.browser } },
  },
);
