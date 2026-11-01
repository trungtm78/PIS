# SPIKE-ODCS: the version of the Open Data Contract Standard the platform pins (ST-DGV-005, TK-DGV-005-4)

**Status: decided, to be confirmed by Data/Platform (the module text marks the pin as an assumption).**

## Decision

The platform pins the **ODCS 3.0 line**, accepting documents written for `v3.0.0`, `v3.0.1` and `v3.0.2` (the newest is the default of the screens). A document names its version twice (`apiVersion` in the document, `odcs_version` in the request) and the two must agree; any other version is `ODCS_SCHEMA_INVALID` naming `odcs_version`.

## What is checked

The platform does not carry the whole JSON Schema of the standard. It checks the fields it stands on, with the paths of the standard, and keeps the rest of the document as it came (the hash is of the whole document, keys in any order):

- `apiVersion`, `kind` (= `DataContract`), `id`, `version`, `status`: present, texts.
- `schema[]` (at least one object, each with a unique `name`) with `properties[]` (each with a unique `name` and a `logicalType` of `string | date | number | integer | object | array | boolean`; `required`, `primaryKey` booleans when given; `physicalType`, `classification` texts when given; a custom property `unit`).
- `slaProperties[]`: the property `freshness` (a positive number with the unit `s`, `m`, `h` or `d`) becomes the freshness of the contract.
- `customProperties[]` at the top: the properties `consumer` declare the consumers (kind, reference, owner).
- `quality[]`: a list, kept as it is.

## What is not done

- No validation against the published JSON Schema file of ODCS (the repository does not carry it, and no library for it is a dependency). When Data/Platform confirms the pin, the file of that version can be added and checked beside the fields above; the contract of the API does not change.
- No detection of a change of the meaning of a column (a description changed): the compatibility is worked out from the types, the requirement, the key, the unit and the classification.

## Assumptions to confirm

1. The 3.0 line is the right pin (the module text says v3.0.x).
2. The window of a breaking change is at least 30 days after the revision takes effect (BR-DGV-07).
3. Consumers are declared in `customProperties` (the standard has no field for who reads the data); the owner of a BI dataset is the owner of the dataset of BI.
