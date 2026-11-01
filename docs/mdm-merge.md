# Merging master records and the rules of survivorship (ST-MDM-010)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/MDM.md` (3.1 F5, BR-MDM-05, MDM-30, MDM-35, MDM-36, UAT-AC274, UAT-AC275). Migration `V1090__mdm1_merge_survivorship.sql`. Pure rules in `packages/kernel/src/master-merge.ts`, storage in `packages/db/src/master-merge-store.ts`, the API in `apps/api/src/modules/mdm/master-merge.controller.ts`, the screens in `apps/web/src/screens/mdm/merge/`.

## The operations

| Operation | Who | What it does |
| --- | --- | --- |
| `createSurvivorshipRuleVersion` `POST /survivorship-rules` | `master.survivorship.manage` | Drafts the next revision of the rule of one attribute of a type (strategy `SOURCE_PRIORITY`, `MOST_RECENT`, `MOST_COMPLETE` or `STEWARD_DECISION`, the order of sources where the strategy uses one). |
| `publishSurvivorshipRule` `POST /survivorship-rules/{id}/publish` | `master.survivorship.approve`, **not the drafter** | 403 `SELF_APPROVAL_DENIED`, 409 `VERSION_CONFLICT`, 409 `STAGE_TRANSITION_DENIED` (not a draft, or a later revision already overrides it from its own day); the revisions it replaces become RETIRED, but a revision published for a later day leaves the one in force deciding until that day. |
| `post_master_records_id_merge` `POST /master-records/{id}/merge` | `master.merge`, **not the maker of either record** | `{id}` is the survivor, `If-Match` its version. Settles each attribute, moves the references, ends the survivor's version and starts the next, and marks the other record MERGED. |
| `unmergeMasterRecords` `POST /master-merges/{id}/unmerge` | `master.merge` | Gives back what was taken from the merged record and restores that record. |
| `listSurvivorshipRules`, `listMasterMerges` | `master.read` | The rules and the merges, newest first, with the filters of the contract and a cursor. |

## How an attribute is settled

For each attribute (the `label` of the entry counts as one, keyed `label`; an attribute of the entry that is itself called `label`, or starts with `~`, is keyed with one more `~`, e.g. `~label`, so the two never share a key) the decision is, in this order: only one entry has a value → that one (`ONLY_ONE`); both have the same value → the survivor's (`EQUAL`); otherwise the published rule of the attribute decides (`RULE`: the source with the higher place in the order, the later entry, or the more complete one: the one with fewer empty attributes among those either entry has); otherwise the steward must choose in `survivorship_overrides` (`OVERRIDE`). When some attributes are still unsettled the merge is refused with 409 `MERGE_CONFLICT` and `extensions.attributes` names them; nothing is written. An override on an attribute that was not in conflict is 422. The decisions are kept in `master_merge.survivorship_json`.

## What a merge does

Both records are locked in the order of their ids. The merge is refused when the version is stale (409 `VERSION_CONFLICT`), the types differ (422), either record is not in force, or has a change that is open or a published one that waits for its day (409 `STAGE_TRANSITION_DENIED`), either belongs to the platform namespace or the type is platform-only (403 `POLICY_LOCKED`), or the person merging made either record (403 `SELF_APPROVAL_DENIED`).

It then points again the references that name the merged record: its ACTIVE crosswalks and the `master_record_id` of a contractor (UAT-AC274); the references are kept in `repointed_refs_json`. A version cannot end the day it starts, so an entry whose version began today is merged from tomorrow on: the merge is refused today (409 `STAGE_TRANSITION_DENIED`) and nothing is written. Otherwise the survivor gets a new version from today, and the merged record becomes `MERGED` with `merged_into_id`, and its old business key stays readable as an alias (`alias_json`). A change request of kind MERGE is written as APPLIED by the person who merged.

The version the survivor gets keeps the end date the survivor was approved for, and must meet the rules of its type like any version (422 naming the field when the attributes that were chosen break them, e.g. a programme that would end before it starts; nothing is written). A survivor whose version ends on or before the merge day has run out (409 `STAGE_TRANSITION_DENIED`). A reference to the key of the merged entry from another catalogue entry stays valid: the lookup of the rules of a type follows the key to the entry it was merged into. The key of the merged entry is found through the survivor: `searchMasterRecords` with that `business_key` returns the survivor (following the merges that stood on the day asked, one hop at a time, to the last survivor; a merge counts from its day until the day it was undone), and still returns the entry itself for an `as_of` day when its own version was in force.

## Undoing a merge

`unmergeMasterRecords` is refused with 409 `MERGE_ALREADY_REVERTED` for a merge that was undone, and while the survivor is not in force or was itself merged away. The attributes that were taken from the merged record are given back. When the survivor edited one of them after the merge, the undo is refused with 409 `UNMERGE_CONFLICT` naming the attributes (UAT-AC275), unless `steward_decisions` answers `KEEP` (keep the edit) or `REVERT` (give the old value back) for each; any other answer is 422. A survivor whose version began today cannot take its attributes back before tomorrow, so the undo is refused until then (409 `STAGE_TRANSITION_DENIED`): the two entries come back together or not at all. The merged record comes back as a new version copying the version it had before the merge; a reference that is still valid is restored, one that is not is reported in `not_restored`. The merge row is then REVERTED and never changes again.

## Guards in the database

`survivorship_rule`: the content of a revision never changes; DRAFT → PUBLISHED → RETIRED only; a published rule needs `approved_by`, different from `created_by`; one published rule for a type and attribute. `master_merge`: the recorded fields never change; REVERTED is final. Neither table allows DELETE or TRUNCATE to the application role (the owner role bypasses, as elsewhere).
