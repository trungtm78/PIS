/**
 * The Vietnamese words of the enterprise edition manifest. They live here, in a `messages` folder, so that `manifest.ts` stays in English. This module is plain TypeScript with no file access, because the
 * manifest is also bundled into the web app, where a file read is not possible, and it is loaded by Node itself (`scripts/edition-check.mjs`) and by the test runner.
 */
export const PRODUCT_NAME_VI = 'Phần mềm quản lý đầu tư xây dựng';
