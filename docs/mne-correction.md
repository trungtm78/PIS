# The correction of an issued or filed report (ST-MNE-007)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/MNE.md` (F3, section 4). Migration `V1705__mne1_report_correction.sql`. Operation: `correctMneReport` (`mne.report.prepare`, versioned on the report, in the units of the grant). Event: `mne.report.correction_started.v1`, and from the consumer `mne.report.superseded.v1`.

## The road

A report that DOC issued (`ISSUED`, `EXPORTED`, `SUBMITTED_EXTERNAL` or `RETURNED`) is corrected by **a new revision**, never by a change of the issued one (the table keeps the cells and the hash of an issued report for good):

- `correctMneReport` makes **revision n+1 as a `DRAFT`** on the same form revision, unit, project and period, with the cells of the revision it corrects, `supersedes_id` and the **reason** (`correction_reason`, ten characters at least once trimmed: **422 `CORRECTION_REASON_REQUIRED`**). A `snapshot_id` in the request fills the locked cells again from another frozen snapshot (as in ST-MNE-002); the reason is kept in the audit row `mne.report.correction_started`.
- A report that is not issued is 409 `REPORT_NOT_ISSUED` naming the state (a draft is edited, not corrected). A report is corrected by **one** revision at a time: a second request is **409 `CORRECTION_ALREADY_OPEN`** naming the first, and the table says the same (a unique index on `supersedes_id`).
- Revision n+1 is written, handed in, approved and issued like any report (MNE-03, MNE-05). **Only DOC's answer supersedes**: when `doc.issued.v1` names it, the consumer makes the revision it corrects `SUPERSEDED`, with the audit row `mne.report_superseded` and the event `mne.report.superseded.v1`. Until then the old revision stays what it was (filed, if it was filed).
- What was issued **stays downloadable** after it was superseded (its packages keep their links unless DOC recalled it), and it is not exported again (409 `REPORT_NOT_ISSUED`). The job that expires the files nobody filed leaves the files of a superseded report alone: they are what was offered when it was issued, and cannot be made again. The new revision makes packages of its own content, so with another hash.
- `getMneReport` carries `revision`, `supersedes_id`, `correction_reason` and **`history`**: every revision of the report with its status, the day it was issued and the reason of the correction (what MNE-10 lists).

## Assumptions and limits

- The reason is not checked against the figures: the text says why, and the audit trail keeps it.
- A revision made by a correction keeps the `obligation_rule_id` and the due date of the first one; the calendar of obligations lists the first revision of each obligation (the filing is judged on it); MNE-10 (history) is the place to see the chain.
- No screen is in this story: MNE-03 edits revision n+1 and MNE-05 and MNE-06 treat it like any report; the list of the revisions and the button that starts a correction belong to MNE-10.
