# LND-1: sections, parcels and recovery notice timers (ST-LND-001)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/LND.md` (sections 3.1, 3.4, 5, 6, 7). Migration: `V1680__lnd1_section_parcel_deadline.sql`.

## What the story does

| Command | Permission | What it does |
|---|---|---|
| `createLandSection` | `land.manage` over the project | A handover section of a project, by kilometre or by area, `NOT_READY`, optionally for a contract of the same project. |
| `createLandParcel` | `land.manage` over the parcel | A parcel in `SURVEYED`: code, address, areas, land use, outline, the unit that answers for it. |
| `importLandParcels` | `land.manage` over the whole project or tenant | A parcel list from a stored CSV/XLSX file, through the idempotent file import (kit K6). |
| `recordRecoveryNotice` | `land.process` over the parcel (`land.read` to see it) | The notice of recovery: starts the 90 or 180 day timer. |

## A parcel carries no owner (AC-ST-LND-001-2)

Personal data minimisation is the point of the story. A parcel is land and nothing more; the people (households, CCCD, phone) are other records under other rules (`affected_household`, `scope_units_guard`, a later story).

- **Table.** `land_parcel` has no column that could hold a person. `owner_unit_id` is the unit of the organisation that answers for the parcel. A test lists the columns and fails when one that looks like a person appears.
- **Body.** The request is an allowlist (`additionalProperties: false`): `owner_name`, `household_id`, `national_id`, `phone` and every other field are `400 FIELD_NOT_ALLOWED`.
- **Outline.** `boundary_geojson` is a `Polygon` or `MultiPolygon` with `type` and `coordinates` and nothing else. `properties`, `name`, `owner` (where a name would hide) are refused by the store (422) and by the check `land_parcel_boundary_geometry_chk`, so no statement can store them.
- **Import.** The layout of the file is closed: the headers are `parcel_code`, `owner_unit_code`, `land_use_group`, `area_total_m2`, `area_affected_m2` and optionally `address_text`, `section_code` (Vietnamese aliases exist). A header that is not one of them (a name, an identity number, a phone, an owner, whatever it is called) makes the whole file unreadable (`IMPORT_SCHEMA_INVALID`); an empty column with no header is ignored, one with content is refused.
- **Trail and event.** The audit diff and the outbox payload carry the code, the ids, the land use and the areas; never the address and never the outline. A refused import row shows only the parcel, unit, land use and areas in the quarantine.
- **What is not detected.** `address_text` is free text. The form says not to write the user of the land in it; nothing can tell a name from a place.

## The timers (BR-LND-01, AC-ST-LND-001-1)

- The days are rule data: master type `LND_TIMER` (MDM rule, `PLATFORM_ONLY`), one record per timer (`NOTICE_AGRICULTURAL_90`, `NOTICE_NON_AGRICULTURAL_180`, `PLAN_POSTING_30`, `PAYMENT_30`, `COMPLAINT_RESOLUTION`), with legal basis, validity and the confirmation it waits for (CXN-12). The baseline pack carries 90, 180, 30, 30, 30 calendar days flagged `awaiting_confirmation`. See `docs/mdm-catalogue-dictionary.md`.
- The rule in force on the **notice date** decides (not today's rule). None in force is `422 TIMER_RULE_UNCONFIRMED` and nothing is started.
- Agricultural land takes 90 days; every other land use takes 180, public land included (the assumption of BR-LND-01 for a mixed parcel is the larger number).
- `due_on = notice_on + days`. The statute counts calendar days (`day_count: CALENDAR`, BR-LND-01 and UAT-AC376: 2026-07-01 gives 2026-09-29 and 2026-12-28). A rule may instead say `day_count: WORKING` with a `calendar_code`: the days are then counted on the published working calendar of ADM (`WorkCalendarStore.source`, `addWorkingDays` of `packages/kernel/src/land-timers.ts`, holidays skipped, compensated days counted); a year without a published calendar is `422 CALENDAR_NOT_EFFECTIVE`, never a guess. A working-day deadline is never earlier than the calendar one, so `land_parcel_notice_chk` still holds.
- The deadline (`land_deadline`) keeps the days, the dates and the rule version it was counted by; a trigger refuses to rewrite them (no retroactive change: a new rule governs the timers that start after it) and refuses to reopen an ended timer. The notice itself (date, days, document) cannot be rewritten once recorded.
- A decision to recover cannot come before `due_on`: `land_parcel_notice_chk` refuses it in the database whoever writes it, and `LndParcelStore.recordRecoveryDecision` answers `422 NOTICE_PERIOD_NOT_ELAPSED` first and satisfies the timer on the day of the decision. No operation of the contract records the decision yet (see TODOS.md).

## Decisions

| Point | Decision |
|---|---|
| Who may import | `land.manage` over the whole project (a `PROJECT` grant) or the whole tenant. A file covers every unit of the project and uses its identity up once, so a narrower grant could shadow it for a wider one. |
| Identity of a file | Its SHA-256 **within the project**: the connector of the file import is `LAND_PARCEL_FILE_<project id>`, so the same bytes are new to another project. A parcel is identified by its code within the project: another file with the same code leaves the first parcel as it is (same content: a repeat; other content: a `DUPLICATE_CONFLICT` item). |
| Parcel scope | The unit tree of the unit that answers for the parcel, or a grant on its project. A caller who cannot see a parcel (`land.read`) gets 404, one who sees it but may not process it gets 403. |
| Section scope | The project: the unit trees of its owner and investor units, a grant on it, or the tenant (as contracts). |
| Notice | Once per parcel, before payment, handover or enforcement; the date may not be in the future; the document must be a clean version of the tenant. The document is kept on the parcel (`notice_document_version_id`, added by the migration). |
| Retention | Sections, parcels and timers are part of the project dossier: the runtime role cannot delete or truncate them. |
| Layout of the file | A working assumption (`ASSUMED-2026.1`): the land registry gives no API and no sample (LND 7, adapter PROPOSED). |

## Pieces

| Piece | File |
|---|---|
| Timers and calendar-day / working-day counting | `packages/kernel/src/land-timers.ts` |
| Rule type and baseline | `packages/db/src/master-types.ts`, `master-baseline.ts`, `master-store.ts` |
| Rules reader | `packages/db/src/lnd-timer-rules.ts` |
| Stores | `packages/db/src/lnd-section-store.ts`, `lnd-parcel-store.ts`, `lnd-parcel-import.ts`, `lnd-land-source.ts`, `lnd-values.ts` |
| API | `apps/api/src/modules/lnd/` |
| Screen pieces | `apps/web/src/screens/lnd/` (LND-02) |
