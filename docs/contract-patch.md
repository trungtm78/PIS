# contract-patch: one tool for the shared contract files

Several lanes add operations, schemas, error codes, screens and migration blocks at the same time. Hand edits of the big shared JSON files collide and reformat each other, so they go through `scripts/contract-patch.mjs` instead.

| File | Commands |
|---|---|
| `Design/MACHVON_Design/03_Engineering/openapi.json` | `add-operation`, `add-schema` |
| `Design/MACHVON_Design/03_Engineering/error_codes.json` | `add-error-code` |
| `Design/MACHVON_Design/03_Engineering/screen_catalog.json` | `add-screen` |
| `db/migrations/blocks.json` | `register-block` |

## What it guarantees

- **Exact formatting.** The four files are two-space `JSON.stringify` output (blocks.json with CRLF). The tool refuses a file that does not render back to exactly its own text (`check` tells you), patches the parsed data and writes it back, so only the added lines differ. Key order and line endings are kept. A new entry goes at the end of its container (new path at the end of `paths`, new schema at the end of `components.schemas`, new code at the end of `registry`).
- **Idempotent.** Running the same command again changes nothing and writes nothing (`Unchanged`). The same name with different content is an error until you pass `--replace`.
- **Safe to run in parallel.** Each run takes `<file>.lock`, re-reads the file inside it, patches, re-parses what it wrote and renames it over the file. A lock of a dead process or older than 30 seconds is reclaimed.
- **All or nothing.** In a batch every file is read, patched and checked before the first write; a failing step writes nothing.
- **Checks.** operationId unique across the document; every `$ref` of an added operation or schema resolves to `components.schemas` (schemas of the same batch count); every `x-error-codes` entry is registered (codes of the same batch count); an error code is absent and not a canonical, alias or excluded name; a screen takes the next free `<MODULE>-NN`; a block is 20 numbers, overlaps nothing, and does not move once registered.

The tool does not regenerate anything. After a contract change run `npm run contracts:generate`, then `npm run contracts:check`, `node scripts/lint-error-codes.mjs`, `npm run migrations:check`.

## Commands

Add `--dry-run` to any command to print a unified diff and write nothing. `--root <dir>` points at another repository layout (tests use it). `--locale en` switches messages from Vietnamese.

```bash
# error code: --en is the title, --vi is the meaning; --module is required (or --source spec:<MODULE>)
node scripts/contract-patch.mjs add-error-code --code PAY_X_DENIED --status 422 \
  --vi 'Đề nghị bị từ chối vì ...' --en 'X denied' --module PAY [--other-statuses 409] [--status-basis spec] [--source spec:PAY]

# schema (inline JSON or a file)
node scripts/contract-patch.mjs add-schema --name PayFoo --schema-file foo.schema.json

# operation built like its neighbours (path params from {id}, Idempotency-Key for commands, standard 4xx/5xx responses)
node scripts/contract-patch.mjs add-operation --path '/things/{id}/clear' --method post \
  --operation-id clearThing --summary '...' --tags PAY --permission thing.clear \
  --request-ref ClearThing --error-codes VALIDATION_FAILED,VERSION_CONFLICT \
  --domain-events pay.thing.cleared.v1 --if-match --extra '{"x-plane":"tenant"}'
node scripts/contract-patch.mjs add-operation --path '/things/{id}' --method get \
  --operation-id getThing --summary '...' --tags PAY --permission thing.read \
  --response-ref Thing --query as_of:string:date

# operation written out in full (any shape: x-state-guard, x-audit-action, x-step-up ...)
node scripts/contract-patch.mjs add-operation --path /things --method post --operation-file op.json

# screen: next free id of the module; a new module also needs --module-name; --fields separated by ';'
node scripts/contract-patch.mjs add-screen --module PAY --title '...' --kind table \
  --fields 'A;B;C' --role '...' --rule '...' --phase P1 --source '...' [--platform web] [--req FR-PAY-19]

# migration block of 20 numbers (the slice owns from..from+19)
node scripts/contract-patch.mjs register-block --slice GOV-3 --from 1790

# is every shared file patchable?
node scripts/contract-patch.mjs check
```

In Git Bash a `--path` that starts with `/` is rewritten to a Windows path: run the command with `MSYS_NO_PATHCONV=1` in front, or use `--spec`.

`add-operation` flags: `--tags a,b`; `--success-status 201`; `--path-param id:uuid` (default for every `{name}`); `--query name[:type[:format]][:required]` (repeatable); `--if-match`. A command (any method but get) gets the `CommandResult` 200 unless `--response-ref` is given; a get is a DTO read model (`x-read-model`, `x-exposure: dto`) and needs `--response-ref`. `x-command` is not a field of openapi.json; commands are registered in the API (`npm run commands:check`).

## Batch: `--spec`

One file, applied under one lock round, one write per file. Steps use the same names as the flags, in camelCase.

```json
{
  "steps": [
    { "command": "add-error-code", "code": "PAY_X_DENIED", "status": 422, "en": "X denied", "vi": "...", "module": "PAY" },
    { "command": "add-schema", "name": "ClearThing", "schema": { "type": "object", "required": ["reason"], "properties": { "reason": { "type": "string" } } } },
    { "command": "add-operation", "path": "/things/{id}/clear", "method": "post",
      "build": { "operationId": "clearThing", "summary": "...", "tags": ["PAY"], "permission": "thing.clear",
                 "requestRef": "ClearThing", "errorCodes": ["VALIDATION_FAILED", "PAY_X_DENIED"], "ifMatch": true } },
    { "command": "add-operation", "path": "/things", "method": "get", "operation": { "operationId": "listThings", "x-permission": "thing.read", "responses": { "200": { "description": "ok" } } } },
    { "command": "add-screen", "module": "PAY", "title": "...", "kind": "table", "fields": ["A"], "role": "...", "rule": "...", "phase": "P1", "source": "..." },
    { "command": "register-block", "slice": "GOV-3", "from": 1790 }
  ]
}
```

```bash
node scripts/contract-patch.mjs apply --spec lane-b2.contract.json --dry-run
node scripts/contract-patch.mjs apply --spec lane-b2.contract.json          # re-run any time: unchanged
```

A step may carry `"replace": true`; `--replace` on the command line sets it for the steps that do not say otherwise. Exit code 0 on success (also when nothing changed), 1 for a refused step (message on stderr), 2 for a bad invocation.

## Tests

`node --test scripts/contract-patch.test.mjs` works on temp copies only (fixtures and copies of the real files); a test asserts that the real files keep their hash.
