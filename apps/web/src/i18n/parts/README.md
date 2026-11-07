Strings of work in progress (see `index.ts`). One pair of files per piece of work: `<name>.vi.json` and `<name>.en.json`, flat `{ "key": "text" }`.
`node scripts/fold-i18n-parts.mjs` folds them into `vi.json` and `en.json` and removes them.
