# The consent of the contacts outside the tenant (ST-OMNI-003, OMNI.md 3.6, BR-NOT-07, OMNI-04)

The consent of a contact is a row of `contact_consent` (the table of the notification module, ST-NOT-003) with `contact_id` and no `membership_id`. The rules of that table hold for it: the history is append-only, a consent has a live row per subject, channel and purpose (409 `CONSENT_ALREADY_GRANTED`, also when two are taken at once), and it ends once, by a withdrawal, with a reason and its moment; the latest consent decides.

## The operations

| Operation | Permission | Rule |
|---|---|---|
| `recordContactConsent` (`POST /contacts/{id}/consents`) | `omni.consent.manage` on the whole tenant | a channel `EMAIL`, `SMS`, `ZALO` or `WHATSAPP` (a push needs a device of the tenant's app, which a contact outside the tenant has not: 422), a purpose, the version of the terms (1 to 50), the way of capture and the reference of the proof (**required** for `CHANNEL_OPT_IN` and `PAPER_SCANNED`, which leave one). It rests on an identity of the contact that is **Verified** on the channel (a phone for `SMS`, an address for `EMAIL`, a Zalo or a WhatsApp id): else 422 `IDENTITY_UNVERIFIED`. The contact must be alive; a merged or blocked one is 409 `CONTACT_STATE_INVALID` |
| `withdrawContactConsent` (`POST /contact-consents/{id}/withdraw`, If-Match, a reason of 10 to 2000) | `omni.consent.manage` on the whole tenant | `Withdrawn` with `revoked_at` at once; an ended consent is 409 `CONSENT_STATE_INVALID`, a stale version 409 `VERSION_CONFLICT`; the consent of a member of the tenant is not found here (that person withdraws their own, ST-NOT-003) |
| `get_resources_contact_consent` (`?contact_id=`) | `contact_consent.read` on the whole tenant | the consents of one contact: its own and those of the contacts merged into it; never the proof or the reason |

Each grant and each withdrawal writes one audit row (`consent.granted`, `consent.withdrawn`: the subject, the channel, the purpose, the version of the terms and the way of capture; the reference of the proof is not on the trail) and one `not.consent.changed.v1` (`subject_kind: CONTACT`).

## The consent and the merge

A consent keeps the contact that gave it, also when that contact is merged afterwards (BR-OMNI-05). `ContactConsentStore.latestForContact(contact, channel, purpose)` is what a message to a contact asks before it is taken up (ST-OMNI-005): the latest consent given by the contact **or by a contact merged into it**, whatever became of it; the consents are not added up, and no consent at all is no consent. A contact that was merged takes no consent of its own; the contact that is alive does, on the identities it shows.

## The screen OMNI-04

`ContactConsentScreen`: the contact chosen, its consents (channel, purpose, state, version of the terms, way of capture, since when, and when it was withdrawn), the withdraw action with a reason, and the form that records a new one: the channels offered are those of its verified identities, the proof is asked for when the way of capture leaves one, and what the server would refuse is told before sending. The reading is cached per membership. Nothing is offered to a person who only reads, or for a contact that was merged away.

## Roles

V1286 gives `OMNI_AGENT` `omni.consent.manage` and `contact_consent.read`, and `OMNI_SUPERVISOR` `contact_consent.read` (it holds `omni.consent.manage` through `omni.*`), for the tenants seeded before. V1285 indexes the consents by contact.
