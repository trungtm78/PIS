# DGV: data contracts with the approval of the consumers (ST-DGV-005, DGV 3.1 F2, BR-DGV-07, DGV-13, DGV-19, UAT-AC50)

A data contract is an ODCS document (Open Data Contract Standard) of the version the platform pins (`docs/spikes/DGV-SPK-ODCS.md`). The working copy is a row of `dataset_contract` (a **revision**); the published form is a row of `data_contract_version`, written once.

## The commands

| Command | Who | What it does |
|---|---|---|
| `createDatasetContractRevision` `POST /dgv/dataset-contracts` | `data.contract.manage` over the whole tenant, on a dataset the person sees | Checks the document (422 `ODCS_SCHEMA_INVALID` naming the path), compares it with the published version, makes the revision `IN_REVIEW` with its `compatibility`, and for a breaking one a `PENDING` approval for each required consumer. 409 `CONTRACT_REVISION_OPEN` while another revision of the dataset is in review (also when two come together: the unique index). |
| `recordConsumerApproval` `POST /dgv/contract-consumer-approvals/{id}/decision` | the owner of the consumer (`data.contract.consume`) | `APPROVED` or `REJECTED` once, against the version read: 404, 409 `VERSION_CONFLICT`, 403 `NOT_CONSUMER_OWNER`, 409 `STAGE_TRANSITION_DENIED` (decided already, or the revision is no longer in review). |
| `publishDatasetContract` `POST /dgv/dataset-contracts/{id}/publish` | `data.contract.approve` over the whole tenant, **not the person who drafted it** | In this order: 404, 409 `VERSION_CONFLICT`, 409 `STAGE_TRANSITION_DENIED`, 403 `SELF_APPROVAL_DENIED`; for a breaking revision 409 `CONSUMER_APPROVAL_PENDING` (listing the consumers that have not approved) and 422 `MIGRATION_WINDOW_REQUIRED`. A window for a revision that is not breaking is 422. Then it writes the version (hash of the document, the document stored as a file, `supersedes_id`), makes the revision `PUBLISHED` and the one before it `SUPERSEDED`, and the dataset stands on the new version (and is `ACTIVE`). |
| `post_data_contracts_id_publish` `POST /data-contracts/{id}/publish` | `data.contract.publish`, not the person who drafted it | The baseline decision on a revision in review: `approve` publishes (a breaking revision then needs the window only the other command takes), `return` and `reject` close it (`RETURNED`, `REJECTED`) so that another can be drafted. Reason and evidence ids go on the audit trail. |

Reads: `GET /resources/dataset_contract[/{id}]` (revisions, newest first, filters `dataset_id` and `status`, cursor; the detail adds the document and the changes from the published version) and `GET /resources/data_contract_version[/{id}]` (versions with `serving` and `serving_until`). Both show only the contracts of datasets the person may see (BR-DGV-11); another's is 404.

Events `dgv.contract.drafted.v1`, `dgv.contract.consumer_decided.v1`, `dgv.contract.published.v1` (`compatibility`, `odcs_sha256`, `migration_window_until`); audit `dgv.contract_drafted`, `dgv.contract_consumer_decided`, `dgv.contract_published`, `dgv.contract_returned`, `dgv.contract_rejected`.

## Compatibility (BR-DGV-07)

`INITIAL` for the first revision. Against the published version, **breaking** is: a column removed or renamed (a name that is gone), a type that is not widened (another logical type except integer to number; a physical type that changes its scale or narrows its precision or length), a column added as required or made required, a change of the key that gives the grain (`primaryKey`), of the unit (custom property `unit`), a classification raised. **Backward compatible** is a column added as optional, relaxed to optional, a type widened, a classification lowered, and any change outside the columns. A physical type given where there was none is not a change of type; one that was given and is gone is.

## The consumers

A breaking revision is approved by the owner of each consumer: those the **published** contract declares (a custom property `consumer` of the ODCS document, `{ kind: MODULE | BI_DATASET | EXPORT | EXTERNAL, ref, owner_user_id }`) and the datasets of BI built on the dataset (`bi_dataset.dgv_dataset_id`), once each. The consumers are the published contract's, not the new revision's: leaving one out of the new document does not spare its owner. When the document and the platform name the same consumer (a dataset of BI), the platform wins: the owner is the one of the BI dataset, and a document cannot name somebody else to answer for it. A dataset of BI built on the dataset **after** the draft is asked at the publication: the owner gets an approval, it is kept, and the publication answers 409 `CONSUMER_APPROVAL_PENDING` listing it (audit `dgv.contract_consumers_added`); the publication is made again once the owner has answered. A consumer that was asked of somebody else (the document named an owner before the platform knew the consumer) is answered for by nobody: an approval is never reassigned, so the publication answers 409 `CONSUMER_APPROVAL_PENDING` for it and the revision is closed for another to be drafted. Each person sees the approvals that wait for them in `GET /dgv/contract-consumer-approvals` (`listConsumerApprovals`, filter `decision`, cursor; each approval carries what the revision changes, so the owner decides knowing it), whether or not they may read the contracts. A consumer that rejects blocks the publication; the revision is closed (`reject`) and another is drafted.

## The window and what serves

A breaking revision is published with `migration_window_until`, at least thirty days after its `effective_from` (an assumption of BR-DGV-07) and not before the day of the publication (a window that ended while the revision was in review is 422 `MIGRATION_WINDOW_REQUIRED`). The version before it serves until that day (`serving`, `serving_until`); a backward compatible revision replaces the one before it at once. Published versions are immutable, so what serves is worked out when they are read.

## The database (V1027)

A revision with a document never changes what it says, is never deleted and moves forward only (`IN_REVIEW` → `PUBLISHED` | `REJECTED` | `RETURNED`; `PUBLISHED` → `SUPERSEDED`); one revision is open per dataset (unique index); a published version is written once (no update, delete or truncate for the application role) with its hash, who published it and, for a breaking one, its window; a consumer decision is written once, by the owner of the consumer, and approvals are never deleted. The working copies the quality rules lean on (no document) are left alone by the guards.

## The screens

DGV-13 (`ContractScreen`): the dataset, the versions published (hash, compatibility, whether they serve), the revision in review with its changes, columns and consumer approvals, the form to publish (window) or return/reject (reason), and the form to draft the next revision from an ODCS document. DGV-19 (`ConsumerInboxScreen`): the approvals that wait for the person as the owner of a consumer, to approve or reject with a comment.
