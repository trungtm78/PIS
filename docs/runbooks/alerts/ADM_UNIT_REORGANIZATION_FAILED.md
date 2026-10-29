# ADM_UNIT_REORGANIZATION_FAILED

**Owner:** platform-oncall · **Severity:** warning · **Rule:** `alerts/rules/ADM_UNIT_REORGANIZATION_FAILED.json`

## What it means

The job `unit-reorganization` (every minute, `docs/runbooks/jobs.md`) carries out an approved reorganisation of organisation units (merge, split, dissolution, rename; ADM 3.2) one step at a time, each step in a transaction of its own. A step that cannot be done stops that reorganisation: it becomes `Failed`, and `result_summary.failed` says the step (`reorg:{id}:{step}:{item}`) and the code. The gauge `unit_reorganization_failed_total` is the number of such reorganisations over all tenants. The steps already done stay done (they have rows in `unit_reorganization_step`); nothing is rolled back.

The usual causes: the module that owns projects is not bound to the saga (`PROJECT_TRANSFER_UNAVAILABLE`, cross-module request XM-ADM-02) or refused a transfer; a member or project of the old units has no successor in the mapping (`REORG_MAPPING_INCOMPLETE`: someone joined the unit after the proposal).

## What to do

1. Open ADM-16 or `get_resources_unit_reorganization_id`: the steps done and the step that failed are shown.
2. Mend the cause: bind or repair the project transfer; for a member or project with no successor, move it by hand (`updateMembership`, the project owner command) or, if the mapping has to change, cancel this proposal and propose again.
3. A person other than the proposer decides it again (`decideUnitReorganization`, `approve`): the saga carries on from the step that failed, and the steps done are skipped.
4. Do not edit `unit_reorganization`, `unit_reorganization_step` or `organization_unit_succession` in the database: the guards refuse it, and the record of what was moved is the audit of the reorganisation.
