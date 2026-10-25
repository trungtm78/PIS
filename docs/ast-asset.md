# Asset dossier (ST-AST-002)

AST 3.2, BR-AST-02, UAT-AC389. Screen AST-03 (the asset dossier). The migration is `V1521__ast1_asset_register.sql`; the module is `apps/api/src/modules/ast`; the rules of the statuses and of the value are in `packages/kernel/src/ast-asset.ts`.

| Operation | Route | Permission | Moves |
|---|---|---|---|
| `registerAsset` | `POST /asset-records` | `asset.manage` | ∅ → `REGISTERED` |
| `transferAsset` | `POST /asset-records/{id}/transfer` (If-Match) | `asset.transfer` | `REGISTERED` → `TRANSFERRED` |
| `get_resources_asset_record` (+ `_id`) | `GET /resources/asset_record` | `asset_record.read` | none |

Events: `ast.asset.registered.v1`, `ast.asset.transferred.v1` (ids, the code of the asset, the handover, the contract, the value and its basis, the contract value, the total registered under the contract, the day of the transfer and the code in the other system). Both commands write an audit row with the same facts.

## Rules

- **Registering.** The handover is `ACCEPTED` (409 `HANDOVER_STATE_INVALID`); the project is the handover's (422 `VALIDATION_FAILED`, `project_id`); an optional source contract is the contract of the handover; the receiving unit and the asset class (a master record version) exist; the code is unique in the tenant (409 `ASSET_CODE_DUPLICATE`, from the unique index, not from a read). The contract row is locked first, so two registrations cannot both pass the check of the value.
- **The value (BR-AST-02).** The assets of a contract (those not disposed) never come to more than the contract is worth (422 `VALUE_EXCEEDS_CONTRACT`, with `total_vnd` and `contract_value_vnd` so that the screen can say by how much). The value is whole VND with a basis: the contract value, the settled value or the appraised value.
- **Transferring.** The asset is `REGISTERED` (409 `ASSET_STATE_INVALID`) and its handover is still accepted (422 `HANDOVER_NOT_ACCEPTED`); the day is neither before the asset was registered nor in the future (Vietnam date); the dossier of the commissioning is a clean document version (422 `DOCUMENT_NOT_CLEAN`). The code the asset has in the national system of public assets is **typed by hand** (`external_asset_id`); nothing in the system generates or looks it up, and the screen says so while it is empty.
- **The database.** `asset_record_guard` allows only `REGISTERED → TRANSFERRED | DISPOSED`, `TRANSFERRED → IN_OPERATION | DISPOSED`, `IN_OPERATION → DISPOSED`, an insert only as `REGISTERED`, the identity of the asset never changes, and a transfer, once written, is not rewritten. Checks on the texts, the dates and the transfer fields; `DELETE` is revoked.
- **Scope.** The same as the handover: by the contract (the owner and investor unit of the project, the contract for a guest contractor) **or** by the unit that receives the asset. The read answers 403 or 404 according to whether the caller holds the permission anywhere.
- **What is shown.** The value, its basis and the total registered under the contract are shown only to whoever holds `asset.manage` or `asset.transfer`; the code in the other system only after the transfer; the answer says whether the caller may transfer (`allowed.transfer`).

## Screen

AST-03 lists the assets (filtered by handover, from the address or from the choice) with the handover, the unit, the value and what is left of the contract, the code in the other system or the note that it is typed by hand, and the status. The button to register is offered to whoever may and the dialog offers the accepted handovers and the units of the tenant; a refusal is worded, with the amounts when the value is too high. The button to transfer is offered only for an asset the server says the caller may transfer.
