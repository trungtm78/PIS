# DGV lineage graph (ST-DGV-006)

DGV 3 F5: where a figure comes from and what is made of it, as a graph of nodes and edges that is read up or down from a node, with a check of each node for the person who reads.

## Recording

`POST /dgv/lineage-batches` (`recordLineageBatch`, `data.lineage.write`, over the whole tenant): `run_id`, `transform_version` and up to 500 `edges`, each `{ from, to, observed_at? }`. A node is named by `{ node_id }` (a node of this tenant that exists) or described by `{ node_kind, ref_module, ref_id | ref_key, display_name, classification? }` (made when it is not there yet). A node is one thing by its kind, its module and the id or the key it stands for, so describing it twice is one node (V1026 indexes the identity with the nulls turned into values, which the index of V002 did not see). An edge is one for each pair of nodes and each version of the transform: the same batch posted twice adds nothing (`edges_created: 0`). A node named by an id that is not one of the tenant (another tenant's included, which the policy of the rows hides) is 422 `LINEAGE_NODE_INVALID` naming the field, and nothing of the batch is kept; so is an edge from a node to itself, an unknown kind, a module that is not a module, a node with neither an id nor a key, a classification that does not exist. Audit `dgv.lineage_batch`.

## Reading

`GET /dgv/lineage?node_kind&ref_id&direction&depth` (`getLineageGraph`, `data.lineage.read`): the node asked for by its kind and the id of what it stands for, `direction` `upstream` (default) or `downstream`, `depth` 1 to 6 (default 3), at most 500 nodes (the answer says `truncated`). A node of another tenant, one that is not there and one the person may not see are all 404. Every node of the answer is judged for the person:

| Node | Seen by |
|---|---|
| `METRIC_VERSION` | whoever reads the catalogue of metrics |
| `DASHBOARD_VERSION` | whoever sees the dashboard (its owner, those it is shared with, the library) |
| `DATASET` of the catalogue of DGV | whoever the catalogue shows it to (its owner, its steward, the roles it names, by classification) |
| other `DATASET`, `DATASET_VERSION` (BI) | whoever an access policy opens the dataset to |
| `RECORD` | whoever reads the lineage and also reads the project of the record, as the right of the project gives it (a line of a snapshot is of its project): the lineage never tells what the source would refuse |
| `SOURCE_SYSTEM`, `IMPORT_BATCH`, `TABLE`, `EXPORT` | whoever reads the lineage, when classified public or internal |
| any node classified `PERSONAL` or `IMPORTANT_CORE` | only whoever holds the right over the whole tenant |

A node that may not be seen is `restricted`: it has a position (`restricted-1`) and a level and nothing else (no name, no id, no kind, no classification), and an edge that touches one says nothing of its run or its transform. A node is shown only when a rule shows it.

## In the database (V1026)

The graph is a record: no node and no edge is changed or deleted (`guard_lineage`; `UPDATE`, `DELETE` and `TRUNCATE` are revoked), a node names an id or a key, an edge joins two different nodes (V002) and names a transform of one to 80 characters.

## Screen

**DGV-05** `LineageScreen`: the kind and the id of a node, the direction and the depth; the nodes by level (a restricted node is "Nút bị hạn chế" and nothing else) and the edges with their run and the version of their transform.

## What is not done

- The emitters: the builder of the snapshots of BI, the imports and the exports are to post their batches (the module document calls it adoption by the other groups).
- The start of a graph that the person may not see is 404 and not a restricted node, so that the existence of a node is not told.
