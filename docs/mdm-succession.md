# Administrative succession (MDM, ST-MDM-009)

Succession records which master data entry took over from which: provinces merged, a district level abolished, communes merged or moved under a province, agencies merged. It is the data behind the screens MDM-02 (areas and their history of mergers), MDM-03 (agencies and investors) and MDM-37 (the inheritance tree), and behind the reads `getMasterRecordAsOf` and `getMasterRecordSuccessors` that reports use to reconcile a date before the reform with a date after it (MDM 3.1 F3, BR-MDM-07, AC-ST-MDM-009-1 to 3).

## Model

One row of `master_succession` is one edge: predecessor entry, successor entry, kind, effective date, share, legal basis and the change request that put it in force. Edges are written only by the publication of a SUCCESSION change request and are never changed or deleted by the runtime role (`V1087`): a succession is a fact about the law that reports of earlier years are read against for good.

| Kind | Meaning | Share |
|---|---|---|
| `MERGE` | several entries become one (each predecessor has its own edge to the same successor) | none |
| `SPLIT` | one entry parts into several | each successor's share of the predecessor, strictly between 0 and 100, two decimals; the shares of one predecessor on one date add up to exactly 100 |
| `RENAME` | the entry continues under a new code (a rename that keeps the code is an ordinary UPDATE) | none |
| `RELEVEL` | the entry moves to another level, for example a commune directly under a province | none |
| `ABOLISH_LEVEL` | the entry ends with its level (a district); the successor is the entry that absorbs its functions | none |

The effective date is the first day of the new structure. Publication closes the predecessor's version in force on that date (`valid_until = effective_date`, the end being exclusive) and retires the entry once the date has come; no new version is written, so a project that points at revision 1 of a commune keeps pointing at it.

## Flow (four eyes)

1. `recordMasterSuccession` (permission `master.propose`) opens a SUCCESSION change request in DRAFT, anchored on the predecessor, with the edge in its proposal and the impact of the predecessor stored (what refers to it). A split is recorded edge by edge: a further edge of the same predecessor, date and legal basis is added to the open draft.
2. `submitMasterChangeRequest` sends it to review. A split goes only when its shares add up to 100 (422 `VALIDATION_FAILED`, detail `share_pct`).
3. `decideMasterChangeRequest` by someone who is not the proposer; `post_master_records_id_publish` (on the predecessor) by someone who is not the proposer. MDM-32 lists these requests and shows the kind, date, legal basis and receiving entries.
4. At publication the proposal is judged again against the graph as it stands, then the edges are written and the version is closed.

Rules judged at record, at submit and at publication:

- the predecessor is the tenant's own entry (a PLATFORM entry is 403 `POLICY_LOCKED`) and is in force or already retired; the successor is of the same type and in force on the effective date;
- the date is after the predecessor began, not after it ended by itself, and not before the predecessor itself arrived by an earlier succession;
- no cycle, through edges in force and through requests that wait (422 `SUCCESSION_CYCLE`); an entry cannot succeed itself;
- one open change request per entry (the existing rule of the change requests); one kind of succession per predecessor and date, and only a split has several successors (also enforced by the database).

## Reads

- `getMasterRecordAsOf(id, date)`: the version in force on the date (or none), the state (`IN_FORCE`, `SUCCEEDED`, `NOT_STARTED`, `ENDED`), the structure date (the latest date among the version's start and the successions the entry took part in), the edges into and out of the entry up to the date, and `targets`: the entries of that day's structure the entry converts to, each with its share.
- `getMasterRecordSuccessors(id, date)`: the edges up to the date followed transitively, and the same `targets`. With the date of today it is the conversion to the current structure; shares of chains of splits are multiplied and paths that meet are added.
- A report that wants "the structure at the cut-off date" reads each entry as of that date; one that wants "converted to the current structure" reads the successors and labels the figures as converted.
- The date defaults to today in Asia/Ho_Chi_Minh.

## The 2025 baseline

No province, commune or agency list of the 2025 reform is seeded. The official lists and the legal basis are awaiting the legal register entry CXN-34, and this story does not state legal facts it cannot verify. The screens start from 01/07/2025 (two-level local government) as a **working assumption** and say so; every date and legal basis is typed by the steward. The platform baseline for AREA, ADMIN_UNIT and AGENCY, with its succession edges, is released by the platform after CXN-34 is confirmed (MDM 3.1 F3); until then the mechanism works for the entries a tenant holds (fixture FX-MDM-001 in the tests).
