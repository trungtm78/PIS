# Row and column access policies (ST-BI-003)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/BI.md` (BR-BI-05, F3, F5). Table `bi_access_policy` (baseline, V002, with the checks `approved_by <> created_by` and "ACTIVE needs an approver"). Operations: `createBiAccessPolicy` (`bi.policy.manage`, whole tenant) and a read added to the contract for the screen, `listBiAccessPolicies` (same permission). Screen BI-08. Pure rules: `packages/kernel/src/bi-policy.ts`; store: `packages/db/src/bi-policy-store.ts`.

## Closed by default

A person reaches the data of a dataset only through a policy that is **ACTIVE** for them: a policy for their **role**, for a **unit tree** they are in (or under), or for them as a **membership**. `BiPolicyStore.applicable` returns those policies, or throws **403 `ACCESS_POLICY_MISSING`**: never an empty list, because an empty list reads as "no data". A draft allows nothing. The policy only **narrows**: its predicate is ANDed with the scope the person holds by their grants when a query is compiled (ST-BI-004), so it can never show what the grants do not.

## The policy

- **Row predicate**: a small tree (`unit_in_scope`; `eq`, `ne`, `in` over a field with scalar values; `and`, `or`, `not`), depth at most 5, 30 nodes, 100 values. A field must be a **dimension of the dataset** (`DIMENSION_NOT_IN_DATASET`, naming it); anything else, a literal "true" and any text of SQL, is `PREDICATE_NOT_ALLOWED`. The dataset says what can be cut (`bi_dataset.join_paths.dimensions`, ST-BI-002).
- **Column masks**: a record of column to `HIDE` (not in the answer at all, nor in an export) or `MASK`. Several applicable policies hide the union of what any of them hides.
- **Revisions**: a draft is the next revision of the dataset and grantee. The grantee must exist in the tenant (`VALIDATION_FAILED` on `grantee_ref_id`); the dataset must be `ACTIVE`.
- **Activation** (`BiPolicyStore.activate`): by someone other than the author (**`SELF_APPROVAL_DENIED`**), and the policy that was active for the same dataset and grantee is retired in the same moment, so a grantee has one. The path to it is the decision on a publication request (**ST-BI-006**, R2); the store method and its rules are done and tested here.

## The screen

**BI-08**: the dataset chosen, a line saying whether it is **open** (an ACTIVE policy exists) or **closed** (every query is refused), and the table of policies: who each is for, the scope (within the reader's), the columns hidden, the condition, the status. Whoever may draft sees a form built from choices (the rows in scope, one extra condition on a dimension, the columns hidden and masked), so a condition outside the grammar cannot be typed. Seven states.

## Assumptions and limits

- **Permissions**: the screen lists the datasets with `listBiDatasets` (`bi.query`), so whoever administers policies holds `bi.query` as well as `bi.policy.manage`. Both the draft and the list of policies are refused to a right held over a subtree only. Activations for one dataset and grantee are taken one at a time (an advisory lock shared with drafting), so a grantee never has two ACTIVE policies.

- `createBiAccessPolicy` is a right over the whole tenant (`tenant` scope in the contract), so "no widening beyond the creator's grants" is by construction: a policy is not a grant and is ANDed with the reader's scope.
- **Not done here, by dependency**: the answer to a query (rows in scope only, `account_no` absent from results and exports) and the 403 on a query come with the query compiler (ST-BI-004); the "preview as a user" of BI-08 needs it too. The decision on the request that activates a policy comes with ST-BI-006. Sample policies by role are not seeded: with none, the datasets are closed, which is the safe state.
