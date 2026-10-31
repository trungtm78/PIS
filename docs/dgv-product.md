# The certification of data products (ST-DGV-009)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/DGV.md` (3.1 F9, DGV-18, UAT-AC495). Migration `V1025__dgv1_data_product_certification.sql`. Operations: `certifyDataProduct` (`POST /dgv/data-products/{id}/certification`, `data.product.certify`, `If-Match`) and one read added to the contract, `listDataProducts` (`GET /dgv/data-products`, `data.catalog.read`). Job: `dgv-product-cert-expiry`.

## The rule

A **data product** (`data_product`) is a set of 1 to 50 datasets with an owner. Its status is `NOT_ASSESSED`, `PROVISIONAL`, `CERTIFIED` or `REVOKED`, and moves only along these lines (the table keeps them with a trigger, whatever the application does):

| From | Decision | To |
| --- | --- | --- |
| NOT_ASSESSED | PROVISIONAL, CERTIFIED | the same |
| PROVISIONAL | CERTIFIED | CERTIFIED |
| CERTIFIED | CERTIFIED (renewal), REVOKED | the same |
| CERTIFIED | (its last day has gone) | PROVISIONAL, by the job |
| REVOKED | — | final (409 `PRODUCT_STATE_INVALID`) |

The order of the refusals of a decision: 404 (no such product), 409 `VERSION_CONFLICT` (the `If-Match` is not the version read), 409 `PRODUCT_STATE_INVALID`, 403 `SELF_APPROVAL_DENIED`, 422 on the fields, then for a certification 422 `CONTRACT_NOT_PUBLISHED` and 422 `QUALITY_NOT_PASSED`.

- **Who.** Somebody who holds `data.product.certify` on the whole tenant (403 `SCOPE_DENIED` for a grant on a unit). The owner of the product may not certify it or lift it to provisional (403 `SELF_APPROVAL_DENIED`); an owner may revoke their own product.
- **What a decision names.** A reason of 10 to 2000 characters. A certification also names its evidence (at least one record, at most 500, each a small object) and the last day it stands, after today in Vietnamese time (`certification_expires_on`); the other decisions name no day.
- **What a certification needs of the datasets.** Every dataset of the product has a contract with status `PUBLISHED` (`CONTRACT_NOT_PUBLISHED`, checked first) and its latest finished run gives the badge `PASSED` (`QUALITY_NOT_PASSED`): no run, a run that failed or warned, and a run older than the freshness the dataset promises (`STALE`) all refuse. The answer counts the datasets that stand in the way (`datasets`) and names none: the person who certifies may not see them all.
- **What is written.** The new status; for a certification the certifier, the time, the last day and the evidence; for a revocation the reason; the audit row `dgv.product_certification_decided` (with the reason) and the event `dgv.product.certified.v1` (carrying the status it led to and the one before it).

## The expiry

The job `dgv-product-cert-expiry` (hourly, every tenant) turns a `CERTIFIED` product whose last day is before today in Vietnamese time back into `PROVISIONAL` (the certifier, the day and the evidence stay on the row), writes the audit row `dgv.product_certification_expired`, announces `dgv.product.expired.v1` and tells the owner. The event type is registered with the migration, and the owner is told only when allowed to read the product: the notification service reads a `data_product` with the right `data.catalog.read` (a tenant sets a notification workflow for the type, as for any other). A product already turned is not announced twice. Until the job runs the screen shows the certification as run out.

## The read

`listDataProducts` lists the products by code with the status, the owner, the certifier, the last day, the number of pieces of evidence, the reason of a revocation and the version to send as `If-Match`; for each dataset of a product the caller may see: its code, whether it has a published contract and its quality badge. Datasets the caller may not see (their classification, owner and allowed roles decide, as in the catalogue) are counted in `datasets_hidden` and never named.

## The screen (DGV-18)

`ProductsScreen`: one card per product with the status in words (never by colour alone), the owner, who certified it and until when, the datasets with the contract and the badge, and a line that says whether the conditions of a certification are met, not met or not known (a hidden dataset leaves it unknown unless a dataset seen already blocks it). Somebody who may certify sees, by status, the decisions that may follow and a form for each: the reason, the evidence a line and, for a certification, the last day. The server's refusals are told in words and the form stays open. A reader sees the cards and no button.

## What is not done

- No command creates or edits a data product (its code, title and datasets): the contract has none, so the products are put in the table by a migration or by the platform. This story certifies them.
- No consumer reads `dgv.product.certified.v1` or `dgv.product.expired.v1` yet: BI shows the badge from the read.
- The conditions look at the contract status and the runs as they stand; the data contract itself (ST-DGV-005) is not built, so a contract is published only by whoever writes the row.
