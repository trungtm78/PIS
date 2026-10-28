# QMS: site photo register (ST-QMS-003, slice QMS-1)

The phone takes the photo, uploads the file to the storage and registers it (QMS 3.4, BR-QMS-06). The register keeps when the photo was taken and received, where (only with consent) and four **review flags**. A flag is for a
person to look at: it never rejects a photo and never says that a photo is genuine or not. Registered photos are evidence: nothing edits them and the runtime role cannot erase them.

## Registering (`registerSitePhoto`, `photo.upload`)

The body is the allowlist of the contract: `client_operation_id`, `project_id`, `object_key`, `file_sha256` and, optionally, the contract and the objects the photo is evidence for (`site_diary_id`, `inspection_id`,
`nonconformance_id`, `issue_id`), the device, the place the device took it at (`device_gps_lat`, `device_gps_lng`, `device_gps_accuracy_m`), `geo_consent` and a caption. The file is read from the storage; the server computes the
hash of the bytes and reads the EXIF itself.

| rule | refusal |
|---|---|
| the shape (ids, a 64-digit hash, text of 1 to 2000 characters, a latitude and a longitude together, an accuracy only with a place) | 422 `VALIDATION_FAILED` |
| a place from the device without `geo_consent` | 422 `GEO_CONSENT_REQUIRED` |
| the project is in the scope of the caller (a guest contractor reaches it through its contract) | 404 outside the scope, 403 where it may be read and not written |
| the same `client_operation_id` again answers the photo it made (`site_photo.replayed`), whatever the key of the request | 422 for another project's operation |
| the contract is of the project; the diary, inspection and non-conformance are of the project (and of the contract when one is named); the issue is of the project | 422 `VALIDATION_FAILED` (the field) |
| `object_key` is a key of this tenant for the purpose `site_photo` (images: JPEG, PNG, WebP, up to 15 MiB, judged by their bytes) | 422 `VALIDATION_FAILED` (`object_key`) |
| the file is in the storage (a key of another tenant is as good as none) and clean | 404, 422 `FILE_NOT_CLEAN`, 409 `SCAN_PENDING` |
| the hash the client says is the hash of the bytes | 422 `HASH_MISMATCH` |
| one stored file is registered once (`site_photo_object_uq`) | 422 `VALIDATION_FAILED` (`object_key`) |

## The place

A place is kept **only with the consent to it, without exception** (`site_photo_place_chk`): with no consent there is no latitude, no longitude, no accuracy and no source, and the place that sits inside the EXIF of the file is
not kept either (the flag for the place says `MISSING`). With the consent the place is the device's, or the EXIF's when the device sent none (`gps_source`). The audit row and the event carry whether the person consented and where
the place came from, never the place. The file in the storage still holds its own EXIF (the storage does not re-encode a photo): stripping it is TODO.

## The four checks (BR-QMS-06; thresholds are assumptions to be measured on the photos of the pilot, R-QMS-03)

| check | values | rule |
|---|---|---|
| `check_time` | OK, SKEW, MISSING | MISSING without a capture time in the EXIF; SKEW when the capture is later than the moment the server received the photo or more than a day from the day of the linked diary (the day being its span in Vietnam; without a diary, from the moment of reception); OK otherwise. The camera clock is read as the clock of Vietnam unless the EXIF names a zone |
| `check_geofence` | INSIDE, OUTSIDE, LOW_ACCURACY, MISSING | MISSING without a kept place or without a zone for the project (`project_site_zone`: a centre and a radius, 500 m by default; PRJ owns the shape of a site, R-QMS-04); LOW_ACCURACY when the accuracy is over 50 m; INSIDE within the radius of the nearest zone; OUTSIDE beyond it |
| `check_duplicate` | UNIQUE, DUPLICATE_SAME_SITE, DUPLICATE_OTHER_SITE | the SHA-256 of the file is in this project, in another project of the tenant, or nowhere |
| `check_exif` | CONSISTENT, STRIPPED, INCONSISTENT | STRIPPED without any EXIF (and for PNG and WebP); INCONSISTENT when the EXIF cannot be read, holds a date or a place that is not one, or the GPS time and the capture time are more than an hour apart |
| `check_summary` | PASS, WARN, FAIL | PASS when all four are good, WARN when any is a flag. FAIL is never produced: an infected file or a wrong hash is refused, not registered |

`packages/kernel/src/qms-photo.ts` holds the EXIF reader (JPEG, bounds-checked at every read, no dependency) and the checks as pure functions; `qms-photo-fixture.ts` writes the JPEGs of the tests.

## Reads (`photo.read`)

`GET /resources/site_photo` (newest first; filters `project_id`, `contract_id`, `site_diary_id`, `summary`; keyset pagination on the moment of reception and the id), `GET /resources/site_photo/{id}` and
`GET /site-photos/{id}/checks` (the four flags, the list of flags, and a reminder that they are for review). The view is an allowlist: the key of the object in the storage is not shown, and a place only when it was kept. A
photo outside the scope of the caller is 404. The two generic reads are new in the contract (the register of QMS-08 needs a list).

## Screens

QMS-08 (`PhotoGalleryScreen`): the list with the filters (contract, result of the checks), when each photo was taken and received, the place (or why there is none), the four flags and their summary, and a panel with what each
flag asks a reviewer to look at. It never calls a photo true or false. QMS-10 (the phone) is the capture screen.

## Not in this story

- The Flutter app (QMS-10: camera, consent prompt, checksum, resumable upload, no coordinates in the app storage without consent), the presigned upload to the object storage and its antivirus (S3-compatible storage and ClamAV in Vietnam): DONE_PENDING_ENV.
- The perceptual hash (pHash) of the document for near-duplicates: only the SHA-256 is compared, since an image library is a dependency to be approved.
- The map of QMS-08 (tiles): the screen lists places as coordinates.
- A command of PRJ to draw the zones of a site; until then the rows of `project_site_zone` are written by the owner of the data and a project with none has `MISSING` for the place.
- Stripping the GPS out of the stored file when there is no consent.
