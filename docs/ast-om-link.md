# The link of a transferred asset to the unit that operates it (ST-AST-005, AST 3.2, AST-06, UAT-AC393)

An operator links an asset that was handed to the unit that operates it to a plan of operation and maintenance, an O&M contract, a cycle of maintenance and the day of the next one. There is no integration with a system of assets: the code the asset has in another system is typed by hand, and the screen says it is not synchronised.

## The command

`linkOmPlan` `POST /asset-records/{id}/om-link` (`asset.manage`, over the contract or the receiving unit of the asset; no If-Match, the link is new):

| Rule | Answer |
|---|---|
| the asset is in the scope of the permission (404 if it cannot be read, 403 `SCOPE_DENIED` if read but not linkable) | |
| the asset is `TRANSFERRED` or `IN_OPERATION` | else 422 `ASSET_NOT_TRANSFERRED` |
| `operator_unit_id` is a unit of the tenant | 422 `VALIDATION_FAILED` on it |
| `om_plan_document_version_id`, if given, is a version of a file of the tenant that passed the scan | 422 `VALIDATION_FAILED` if there is none, `DOCUMENT_NOT_CLEAN` if it is not clean |
| `om_contract_id`, if given, is a contract of the project of the asset | 422 `VALIDATION_FAILED` on it |
| `maintenance_cycle_months` is a whole number from 1 to 120; `next_maintenance_due` a real day; `external_system_ref` words up to 2000 | 422 on the field (a cycle that is not an integer is 400, by the shape of the request) |
| the asset has no link that is not suspended (`om_link_asset_uq`) | else 409 `OM_LINK_EXISTS`, and the first link is left as it was |

The link is made `LINKED`. The trail (`asset.om_linked`) and the event (`ast.om_link.linked.v1`) carry ids, the unit, the cycle and the day of the next maintenance; the reference to the other system stays in the table.

## The table (V1523)

`om_link` (V002) gains the bounds of the cycle and the words of the reference, a guard that a link says what it said (it moves only from `LINKED` to `SUSPENDED`, which frees the asset for another link), and no delete.

## The read and the screen

`get_resources_asset_record` and `get_resources_asset_record_id` carry `om_link` (the link in force or null) and `allowed.link_om` (the asset is operated, has no link, and the caller holds the right). **AST-06** `OmLinkScreen` (`/ast/ast-06?id=<asset>`, reached from AST-03 for a transferred asset): the asset, its code in the outside system marked "typed by hand, not synchronised", the link it has, or the form to make one (the operating unit from the units the caller reads, the plan, the contract, the cycle, the next maintenance, the reference), or the reason there is none: not transferred, or no right. No form while the tenant is read-only.
