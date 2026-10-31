# The glossary bound to datasets (ST-DGV-007)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/DGV.md` (3.1, DGV-02, UAT-AC490). Migration `V1024__dgv1_glossary_binding.sql`. Operations: `bindGlossaryTermToDataset` (`POST /dgv/datasets/{id}/glossary-bindings`, `data.catalog.manage`) and one read added to the contract, `listDatasetGlossaryBindings` (`GET /dgv/datasets/{id}/glossary-bindings`, `data.catalog.read`).

## The rule

**DGV holds no table of terms.** The terms live in the glossary of MDM (`glossary_term`: a code and a revision, `PUBLISHED` once, the revision before it `DEPRECATED` in the same step). A binding (`dataset_glossary_binding`) only points at **one revision** of a term, for a dataset as a whole or for one of its columns.

- **Bind.** The dataset must be one the caller may see (404 otherwise: the visibility of the catalogue, by owner, steward, allowed roles and classification). The term must exist (422 `VALIDATION_FAILED` on `glossary_term_id`) and be `PUBLISHED` (422 `GLOSSARY_TERM_NOT_PUBLISHED`; the answer carries the status it has: a revision in review, a draft or a deprecated one are alike refused). The column name is 1 to 120 characters, or absent for the whole dataset. Binding what is already bound (the same revision, the same column) writes nothing, announces nothing and answers the binding that stands with `existing: true`.
- **What is written.** The binding row (append-only: the application role can neither update nor delete it), the audit row `dgv.glossary_bound` and, for a new binding, the event `dgv.glossary.bound.v1`.
- **Replacing.** Several bindings of one term on one column are history except the latest. Binding the revision in force on a column that holds an older revision makes the new binding the current one and the old one `replaced`.

## The read

`listDatasetGlossaryBindings` lists the bindings of a dataset, the latest first, with the term as it stands now (code, Vietnamese name, definition, revision, status). `deprecated` says the revision bound is no longer in force, and `successor` names the revision in force of the same term when there is one (UAT-AC490: after r2 publishes, the binding to r1 is deprecated and r2 is offered). `replaced` marks history. `coverage` counts the bindings in force (`bound`), the ones among them on a deprecated revision (`deprecated`) and the different terms (`terms`).

## The screen (DGV-02)

`GlossaryScreen`: a dataset chosen in the address (`?id=`), the coverage, and the bindings in force with the term, the column (or the whole dataset), whether the revision is in force and who bound it. A binding on a replaced revision carries a warning in words and, to a manager of the catalogue, an action that binds the revision in force to the same column in one step. A manager also binds a term chosen from the terms in force (read with `glossary.read`) or typed as an identifier when the caller may not read the glossary. A reader sees the warning and binds nothing.

## What is not done

- A binding is not removed; there is no unbind command.
- The coverage counts bindings and terms; it is not set against the columns of the dataset because the columns are described by the data contract (ST-DGV-005), which is not built.
- Nobody is notified when a bound revision is deprecated: the warning is shown when the dataset is read.
