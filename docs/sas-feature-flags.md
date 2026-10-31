# Release flags and cohort rollout (ST-SAS-020)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/SAS.md` (3.11, SAS-20, UAT-AC170). Migration `V1493__sas1_feature_flag_rollout.sql`. Operations: `updateFeatureFlag` (`PUT /system/feature-flags/{flagKey}`, control plane, `system.release.manage`, under the version of the flag), and two reads added to the contract: `listFeatureFlags` (`GET /system/feature-flags`, control plane) and `getMyFeatureFlags` (`GET /me/feature-flags`, tenant plane, `session.self`).

## What a flag is

A flag decides which code path a tenant runs while a release is staged. It **never grants a commercial entitlement** (BR-R07: a flag can only switch more off): the client reads `getMyFeatureFlags` next to `getMyEntitlements` and uses a flag only to hold a feature back. The flags are **declared in the code** (`DECLARED_FLAGS` of the kernel: today `sas.silo_promotion` and `sas.tenant_restore_in_place`, the two R2 features that are staged); the migration writes them as `Off`, revision 1, and the control role may change a flag but not add or delete one (a unit test and the migration keep the two lists the same).

## The states and the rollout

`Off` (on for no tenant), `Rollout`, `On` (on for every tenant) and `Retired`. **Retired is final**: the code path it decided is no longer in the code, so a retired flag is on for no tenant and is changed no more (422 `FLAG_RULE_INVALID` on `status`; the database refuses it too).

`Rollout` names whom the flag is on for, and must name someone (422 `FLAG_RULE_INVALID` on `rollout` otherwise); `Off`, `On` and `Retired` carry no rollout. A rollout has:

- `tenant_cohorts`: names of 2 to 31 lower-case letters, digits and hyphens (up to 20). **A tenant is in the cohort named like its region** (the region of its placement) until the tenant has an attribute of its own for it.
- `tenant_ids`: tenants named one by one (up to 500).
- `percentage`: a whole number from 0 to 100. A tenant falls in a bucket 0 to 99 by a stable hash of the flag and the tenant, and is in the share when its bucket is below the percentage, so **a tenant that is in stays in as the share grows**, and a different flag draws different tenants.

A tenant is on when it is named, in a cohort named, or in the share. The reason of every change is 10 to 2000 characters.

## The command

`updateFeatureFlag` locks the flag, checks the version (409 `VERSION_CONFLICT`, 428 without `If-Match`), refuses a retired flag, and writes the status and the rollout; the **revision** (how many times the rollout was set) and the version (the `If-Match` counter) both rise by one. A key the code does not declare is 404. It leaves the audit row `feature_flag.updated` on the platform tenant (the reason is the reason of the row; the diff holds the key, the status before and after, the revision, the cohorts, how many tenants and the share) and the event `sas.feature_flag.changed.v1` with the same figures. Only the System Admin holds `system.release.manage`.

## The screen (SAS-20)

`FlagsScreen` lists each flag with its status in words, whom it is on for (the cohorts, how many tenants and the share), the revision and when it was set, and an action that opens the editor: the status, the cohorts, the tenants and the share (only for `Rollout`) and the reason, checked before they are sent. A retired flag has no action. A caller without the right is told so and nothing is asked of the server.

## What is not done

- A flag is not added from the screen; a new flag is a change of the code and of the migration that declares it.
- The cohort is the region of the tenant; a cohort attribute of its own, and an operation to assign tenants to cohorts, do not exist.
- Nothing in the product reads a flag yet: the two declared flags gate features that are not built (SAS-21, SAS-23).
