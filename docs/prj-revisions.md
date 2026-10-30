# The revisions of a project (ST-PRJ-008)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/PRJ.md` (3.1 F6, PRJ-04, PRJ-06, UAT-AC214, UAT-PLAN-57). Migration `V1209__prj1_project_revision_workflow.sql`. Operations: `proposeProjectRevision` (`project.revision.propose`, under the version of the project), `decideProjectRevision` (`project.revision.approve`, under the version of the revision) and, for the screens, one read added to the contract: `listProjectRevisions` (`GET /projects/{id}/revisions`, `project.read`).

## The life of a revision

`IN_REVIEW` -> `APPROVED` or `REJECTED`; an approved revision becomes `SUPERSEDED` when the next one is approved. Nothing is deleted. The first revision of a project (`INITIAL`, written with it, revision 1) is not decided here, so the first adjustment is revision 2. The database keeps the order: a rejected or superseded revision never changes, an approved one changes only to be superseded, what a revision proposed never changes, a revision that was decided names who decided it, when and why, and one revision at most waits per project (a unique index on `IN_REVIEW`).

- **Propose** (`POST /projects/{id}/revisions`): the project must be in the scope of the caller (404 when it is not visible, 403 `SCOPE_DENIED` when it is readable but not theirs to revise), under the version of the project (409 `VERSION_CONFLICT`), in a stage that takes revisions: `PIPELINE`, `BUDGETED`, `IMPLEMENTATION`, `SUSPENDED` or `COMPLETED` (409 `STAGE_TRANSITION_DENIED` otherwise: before the project bank the dossier is edited directly, and once it is settled, closed, rejected or cancelled it no longer changes). While another revision waits it is 409 `REVISION_PENDING_EXISTS`. The kind names what changes, and each must really change something (422 `VALIDATION_FAILED` on the field otherwise):

| `change_kind` | `after` | Applied to the project |
|---|---|---|
| `ADJUST_INVESTMENT` | empty (or repeating the total); the new total is `total_investment_vnd` at the top of the request, an integer number of dong different from the one in force | `total_investment_vnd` |
| `ADJUST_SCHEDULE` | `start_year`, `end_year` or both, 1990 to 2100, the end not before the start | `start_year`, `end_year` |
| `ADJUST_SCOPE` | `scope_summary`, 10 to 4000 characters | recorded on the revision only (the project has no scope column) |
| `ADJUST_INVESTOR` | `investor_unit_id`, a unit of the tenant that is not the one in force | `investor_unit_id` |

The revision keeps `before_json` (what the project held in those fields) and `after_json` (what it would hold), and the total in force once it is approved.

- **Decide** (`POST /project-revisions/{id}/decision`): the one who proposed it cannot decide it (403 `SELF_APPROVAL_DENIED`, checked before the version), and a project with a deciding authority is decided on by whoever holds `project.revision.approve` over that unit (403 `SCOPE_DENIED` otherwise). **Approve** needs a decision document that still stands (422 `DECISION_REQUIRED` otherwise, the same answer for a document that does not exist, is of another tenant, was recalled or has expired) and `effective_from`, a real day that is not after today. It applies the revision to the project (the total, the years or the investor unit), raises the version of the project, supersedes the revision approved before (`supersedes_id` points at it) and leaves the event `project.revised.v1` (the project, its new version, the revision, the kind, the total in force, the day, the document and the revision it supersedes). **Reject** needs a reason and may carry a document, never a day, and leaves the project as it is.

Both commands leave the audit row (`project.revision_proposed`, `project.revision_decided`; the diff holds the kind, the old and the new content, the document and the day; the decision's reason is the `reason` of the row).

## The read and the screens

`listProjectRevisions` lists the revisions of the project in the scope of `project.read`, the latest first: the old and the new content, the total, the reason, the decision reason, the decision document (id, title, number, year, symbol, day issued, effect), the day it takes effect, who proposed and who decided, and `current_total_investment_vnd`. **PRJ-06** (`RevisionScreen`) puts the old content next to the new with the basis and the day, proposes a revision (the form follows the kind) and decides one in a dialog (approve with the document and the day, or reject). **PRJ-04** (`LegalDossierScreen`) lists the decision documents of the approved revisions: the decision number, the day it takes effect and the version. Both keep the project in the address (`?id=`) and start over when it changes.

## What is not done

- The first revision (`INITIAL`) stays a draft after the project is admitted to the project bank, so the first adjustment supersedes nothing.
- The day a decision takes effect cannot be in the future: an approval is applied at once. A decision that takes effect later is not supported.
- The group of the project (`QTQG`/`A`/`B`/`C`) is not worked out again when the total changes.
- Nothing consumes `project.revised.v1` yet (the obligations of MNE); PRJ-04 lists only documents tied to a revision, not the ones of the stage changes.
