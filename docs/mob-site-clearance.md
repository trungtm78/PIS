# MOB: land-clearance field tasks on the phone (ST-MOB-024)

MOB-68 is the screen of the land-clearance (GPMB) officer in the field: the affected households of a project, the inventory counted at a household, the answer of the household, and the photos of the site. The code is in `apps/mobile/lib/features/site_clearance`. The server half is `docs/lnd-households.md` and `docs/lnd-inventory.md`; the web screens are LND-03 and LND-04, whose rules and sentences the screen reuses so that the two agree.

## The screen (`/projects/mob-68`)

One screen, three views, by what the location names (a screen opens from its location alone):

| location | shows | reads |
|---|---|---|
| `/projects/mob-68` | the projects, to choose one | `get_resources_project` |
| `?project=<id>` | the households of the project in the scope of the officer, by code, with their parcels | `listAffectedHouseholds` |
| `?project=<id>&household=<id>` | the task of one household: its parcels, the inventory counted, the answer of the household, a new count, the kept counts, the photos | `listInventoryRecords`, `listAffectedHouseholds` |

## The data the phone keeps (AC-ST-MOB-024-2, UAT-AC379, NFR-PRIVACY-01/02)

A household is personal data (BR-LND-07; the LND note for mobile: households, inventories, payments and complaints are not synced to the phone). The server already masks the name, the identity number, the telephone and the address in a list, but even a masked name does not belong on a phone. The phone works with the **code** of the household, the **parcels** it holds a right on, how many people it counts, its status and **whether a consent is on record**:

- `minimiseHousehold`, `minimiseRegister` and `minimiseRecord` cut every answer down to those members **before** it is returned to the reading layer (`DataView`), so what is copied for the offline view, and what is shown, never held a name, an identity number, a telephone, an address, the reference of the consent or the legal reference. A test reads everything written to the read cache and everything in the encrypted store of the device (the drafts) and fails on any of those values or keys, and on any request to `revealHouseholdIdentity` (the phone never asks for it; whoever holds `lnd.pii.read` opens it on the web).
- A household that asked for restricted processing, or whose data was erased, is shown and not worked on.
- What is kept in the store of the device is the draft of an inventory record: the household by id and code, the parcel by id and code, and what was counted (kind, a description of the asset, quantity, unit, price, the price decision, the day). The store is the encrypted database of ST-MOB-005 and is purged with the session.

## The inventory (TK-MOB-024-1, TK-MOB-024-4)

**Counting** is the form of LND-04: parcel (of the household), kind of asset, description, quantity (at most six decimals, a comma is taken as a point), unit, unit price in whole dong, the price decision applied and the day of the survey; the amount is previewed on whole numbers (`quantity × price`, half up, `BigInt`) and the server's amount is what the record shows afterwards. The form stops what the server would refuse for its shape; the server alone judges the price decision of the day of the survey, the household's right on the parcel and whether the survey is in the future.

**Offline.** *Keep on this phone* writes the record to the encrypted store and sends nothing; it works with no network, and the record survives a restart. *Keep and send*, or *Send* on a kept record, makes `recordInventory` under the idempotency key **made with the draft and stored in it** (`attempt_key`), so a lost answer, a killed application and a second tap are one command: the screen says "result not known" and sending again reuses the key. A final refusal (a 4xx other than a time-out) keeps the draft with its code and gives it a new key, because the person corrects it and sends another command. The draft is deleted only when the server has recorded the record. Nothing is put in the command queue: `land.inventory.record` is not a command type of `POST /sync/batches` yet (see Gaps), and sending from a draft is the person's act.

**The answer of the household** (`confirmInventory`, `If-Match`) is made on the server, so it is online only, never from a copy kept on the device and never queued; it is offered for a record that waits for the household and that someone else counted (the server judges: `SELF_APPROVAL_DENIED`). Confirming without the consent of the household is refused: **422 `CONSENT_REQUIRED`** is shown in words with its code and the form stays (AC-ST-MOB-024-1, UAT-AC380). `PRICE_DECISION_NOT_EFFECTIVE`, `HOUSEHOLD_PARCEL_NOT_LINKED`, `INVENTORY_STATE_INVALID`, `VERSION_CONFLICT`, `DOCUMENT_NOT_CLEAN`, a second factor, a licence, validation and the ended session each have their sentence. The outcome of a command is pinned above the list so it is seen wherever the page is scrolled.

## A task that is not the officer's (AC-ST-MOB-024-3, UAT-PLAN-39)

There is no task table on the server: the unit of the field work is the household in the scope of the officer's unit (the scope of `land.household.read` and `land.process`). The inventory of the household is read **first**, and for a household outside the scope the server answers **404 `RESOURCE_NOT_FOUND`**, which the screen shows as the not-found state with its code and nothing of the household (the register is not even read afterwards). A household missing from the register while its inventory could be read is a contract mismatch, never a half page.

## Photos

*Add a photo of the site* appears only when the application has a picker (`attachmentPickerProvider`, still null: the camera/gallery story provides it); until then the screen says so. A photo is added to the upload list of the household (`ownerKind` `land_inventory`, `ownerRef` the household id), uploaded in chunks, resumed, scanned and shown in MOB-19, which the screen links to. The screen asks for photographs of the parcel and the assets, not people.

## What only a device can prove

Offline capture on a phone with no signal and the draft surviving a kill and a restart; the encrypted store on Keychain/Keystore and a file restored from a backup not opening; the camera and gallery pickers and their permission screens; the photos' EXIF (position and time are kept only with consent, BR-MOB-06); TalkBack/VoiceOver on the forms; the inventory of a real household against the real scope. `UAT-AC380`, `UAT-AC379`, `UAT-PLAN-39` on a device against the API (the screen tests show the refusals the server gives; the server's own tests prove the server).

## Gaps

- **Appointments** (the "Lịch hẹn" field of the design): there is no operation to book an appointment with a household. The screen says so; nothing local pretends to book one.
- **An officer's task assignment** does not exist as data. The scope of the unit stands for it (above). A task read model (`task`, `assignee`) is a contract change for LND.
- **Offline commands**: `packages/kernel/src/sync-command.ts` (`SYNC_COMMAND_TYPES`, `planOf`) has no `land.inventory.record`. With it, a kept record could be sent by the background queue (the same key, `POST /land-inventory-records`) instead of by the person. The mapping is three lines and a test on the server; it is not done here because it changes server code outside this story's acceptance criteria.
- **Photos are not linked to the record.** `recordInventory` takes `evidence_photo_id` (a registered site photo of QMS, from `registerSitePhoto`, whose storage key has the purpose `site_photo`), and a chunked upload is a different object; no operation takes a clean attachment for a land record. The photo-capture story of MOB (field evidence) owns the registration; the link from MOB-68 follows it.
- **`confirmInventory` and consent.** In the server code, `CONSENT_REQUIRED` is raised when a household is registered on the basis `CONSENT` without a consent record (`registerAffectedHousehold`); `confirmInventory` does not raise it today. The screen maps the code wherever it comes from, and shows the consent state of the household (`has_consent_record`) beside the record, so that the refusal the story asks for (a confirmation without consent) can be given by the server without a change on the phone.
- **A 404 does not clear the copy.** `DataView` forgets a copy on 401/403/licence but not on 404; a household that leaves the scope of the officer stays in the in-memory copy until sign-out, and is shown only when the server cannot be reached.
