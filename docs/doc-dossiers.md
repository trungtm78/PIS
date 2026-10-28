# DOC: dossiers with provisional retention (ST-DOC-013, slice DOC-1)

Documents that are issued or resolved are kept in a **dossier** of a unit (DOC.md F11). Closing the dossier looks for the retention rule of its category and writes down how long it is kept and by when it is to be handed to the
archive (BR-DOC-22). Retention is data: a rule counts only when its legal basis is confirmed. Until one is, the dossier is kept for ever, provisionally, and cannot be disposed of (BR-DOC-23). This story has no screen; the
handing over, the proposal and decision of a disposal and the management of the rules are ST-DOC-017.

## Commands

| command | permission | what it does |
|---|---|---|
| `createDossier` | `doc.dossier.manage` over the unit | opens a dossier: code (unique in its year, 409 `DOSSIER_CODE_DUPLICATE`), year, title, unit, category (`UPPER_SNAKE`), and optionally the module and id it is about (both or neither) |
| `addDocumentToDossier` | `doc.dossier.manage` | puts a document into an OPEN dossier (409 `DOSSIER_NOT_OPEN`) at the next place of the contents or the place asked for (422 `ordinal` when taken); the dossier goes to its next version |
| `fileIncomingDocument` | `doc.dossier.manage` | files a RESOLVED letter (the path) into the OPEN dossier named in the body: the letter goes to FILED and emits `doc.incoming_filed.v1` |
| `closeDossier` | `doc.dossier.manage` | OPEN to CLOSED, once; an empty dossier is 422 `DOSSIER_EMPTY` |

A document is in **one dossier only** (422 `DOCUMENT_ALREADY_IN_DOSSIER`, also when two dossiers are asked at once: the document is locked by an advisory lock). What can be filed: an outgoing document ISSUED, DELIVERED or
ACKNOWLEDGED (it goes to FILED) and an incoming letter RESOLVED (it goes to FILED); anything else is 422 `DOCUMENT_NOT_FILEABLE`. A document the caller does not see, or whose issuing unit is out of reach, is as good as none
(422 `document_id`). Every command is sent under the version read (`If-Match`). `fileIncomingDocument` takes `{dossier_id, ordinal?}` (the contract names the dossier; the letter is the one in the path).

## The retention rule at closing (BR-DOC-22)

The rule is chosen among the rules that are PUBLISHED, of the category of the dossier and in force on the day of closing in Vietnam (`effective_from <= day < effective_until`): a CONFIRMED rule first, then the lowest
`precedence`, then the rule set in the order TT 74/2025/TT-BTC, TT 10/2022/TT-BNV, tenant custom. Then:

* **No confirmed rule**: `provisional_retention = true`, class PERMANENT, no rule, no end, no handover day.
* **A confirmed rule**: its class; the retention ends the rule's years after its start (`FROM_CLOSED`: the day of closing; `FROM_SETTLEMENT`: `settlement_closed_on` of the body, 422 when missing, not a day or later than
  today; `FROM_ISSUED`: the day the latest document of the dossier was issued); the handover is due `handover_months` after the day of closing (the end of a short month is kept).

What closing writes (`retention_rule_id`, `retention_class_code`, `provisional_retention`, `retention_ends_on`, `handover_due_on`, `closed_at`, `closed_by`, `settlement_closed_on`) is **not rewritten** (trigger
`dossier_guard`): publishing a later rule does not change the dossiers closed before it. The one exception is a provisional dossier, which a later command (ST-DOC-017) may settle once. The database also refuses a status that
does not follow the chain of F11, a change of the code, year, unit or category, a document added to a dossier that is not open, and any erasing of a dossier or of its documents by the runtime role. Published rules of one rule set
and category cannot overlap in time (exclusion constraint `doc_retention_rule_overlap_ex`; the later story maps it to 409 `RETENTION_RANGE_OVERLAP`); note that `ON CONFLICT DO NOTHING` on that table needs its target.

## Disposal (BR-DOC-23)

The kernel says why a dossier cannot be disposed of (`disposalBlocker`): not closed (409 `DOSSIER_NOT_CLOSED`), provisional (422 `RETENTION_PROVISIONAL`), a legal hold Active (409 `LEGAL_HOLD_ACTIVE`, also when the
retention is over) or the retention not ended (422 `RETENTION_NOT_EXPIRED`), in that order. `getDossier` shows it as `disposal_blocker` (the proposal itself is ST-DOC-017). A hold covers a dossier by the platform's own
answer (`machvon.legal_hold_blocks('dossier', id)`): the whole tenant, a unit above its own, the project or contract it is about, or the dossier named as a resource.

## Reads

`listDossiers` (keyset by creation; filters `status`, `subject_module`, `subject_id`, `year`) and `getDossier` (with the contents, `legal_hold_active` and `disposal_blocker`) answer in the scope of `doc.dossier.read`: the
unit of the dossier; one outside the scope is 404. Each dossier carries `retention`, `item_count` and `actions` (`addDocument`, `close`). `listDocumentRetentionRules` (`doc.retention.read`; filters `rule_set`,
`category_code`) lists the rules with their confirmation, so that the archivists see what is provisional.

Events: `doc.dossier_created.v1`, `doc.dossier_item_added.v1`, `doc.dossier_closed.v1`, `doc.incoming_filed.v1` (ids and facts, never a title).
