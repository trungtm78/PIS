# ADM delegation-of-authority matrix: the contract of the resolver (ST-ADM-011)

The approval engine (ST-ADM-012) and every module that starts an approval ask one question: "who approves this document?".
The answer comes from the matrix of the tenant, which is data (CXN-DOA-01), never code.

## The question

```ts
new DoaMatrixStore().resolve(tx, { documentType, amountVnd, unitId, businessDate }): Promise<DoaResolution>
```

Inside the tenant transaction that starts the approval. `amountVnd` is whole VND as a decimal string (`null` for a document that
has no amount: the band that holds 0 applies). `businessDate` is the Vietnam date (`YYYY-MM-DD`) on which the document is
submitted. The pure rule is `resolveDoa` in `packages/kernel/src/doa.ts` (BR-ADM-03); the screen of ADM-15 holds a copy of it for
the "who approves" preview, and both are held to the same answers by `packages/contracts/test-vectors/doa-matrix.json`.

## The answer

`DoaResolution { matrixVersionId, ruleId, ruleUnitId, approverRoleId, approvalLevels, requiresDistinctApprovers }`.

- `matrixVersionId` is the version that decided. A running instance pins it (`workflow_instance.doa_matrix_version_id`): a
  matrix approved later never changes an approval that has started; only the ones that start afterwards read the new version.
- The matrix used is the one in force on `businessDate`: a published version, or one that was superseded but covered the day
  (a superseded version ends on the first day of its successor, so the days are covered once).
- Among the rules for the document type whose unit is the unit asked about, or above it with `include_subtree`, the rule of the
  **nearest** unit (the longest `organization_unit.path`) applies; in that unit the band with `min <= amount < max` (no max: no
  end). A band includes its lower end and excludes its upper end.
- No matrix, no rule or no band: 422 `DOA_RULE_NOT_FOUND` (the submission transaction rolls back and the document stays a draft;
  HOME shows the warning). An amount that is not whole VND, or a unit that is not in the tenant: 422 `VALIDATION_FAILED`.

## What the maker-checker rule asks of the caller

`approvalLevels` and `requiresDistinctApprovers` are the instruction to the engine: with `requiresDistinctApprovers` each level is
decided by a different person (BR-ADM-02, compared by `user_account.id`). The resolver does not pick people; it names the role
and the number of levels.

## How a version comes to be in force

`createDoaMatrixDraft` and `updateDoaMatrixDraft` store a draft: whole-VND amounts, proper bands, no overlap of the bands of one
document type and unit (the database also refuses an overlap), and every unit and role must exist in the tenant. A gap is allowed
in a draft; the screen draws it. `submitDoaMatrix` (BR-ADM-04) needs, for each document type and unit, bands that run from 0 to no
end without a gap or an overlap: the findings are `GAP`, `OVERLAP`, `NOT_FROM_ZERO`, `NOT_TO_INFINITY`, with `NO_RULES` for a
matrix without a rule, listed in `errors` of the 422 `DOA_MATRIX_INVALID`. `decideDoaMatrix` approve needs a person who is neither
the author nor the last person who wrote the draft (403 `SELF_APPROVAL_DENIED`); it checks the units and roles again, requires a
start date after that of the matrix in force, publishes the version and ends the one it replaces on its first day. Return sends
it back to Draft, reject ends it. A version that left the draft state is never edited.

Events: `adm.doa_matrix.published.v1 { matrix_id, revision, effective_from }` after an approval.
