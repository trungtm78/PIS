# The contact directory, verified identities and the safe merge (ST-OMNI-002, OMNI.md 3.5, BR-OMNI-05, OMNI-03)

## The model

A **contact** is a person outside the tenant that talks to it (`CITIZEN`, `CONTRACTOR_STAFF`, `AGENCY_STAFF`, `OTHER`). It is `Unverified` until one of its identities is verified, then `Verified`; `Merged` (it points to the contact it was merged into) or `Blocked` end the useful life. The name and the class are written once (V1283 refuses a change); the directory is not a place to rewrite who someone is.

An **identity** is a phone number, an e-mail address, a Zalo or a WhatsApp id. It is kept as `external_id_hash = sha256(normalised value)` and a masked copy (`+84*******01`, `n***@example.com`, `u1***89`); the value is never stored or returned, nor is the hash. The normal form of a phone number is E.164 (`0900000001`, `84900000001`, `0084900000001` and `+84 900 000 001` are one number), so the same number is the same hash on the phone and on WhatsApp: that is how one person is recognised across channels. The table is unique by `(tenant, channel, hash)`.

Reading and changing the directory takes the permission **on the whole tenant** (403 `SCOPE_DENIED` for a grant on one unit): a contact has no unit.

## The operations

| Operation | Permission | Rule |
|---|---|---|
| `createContact` (`POST /contacts`) | `omni.contact.manage` | a name (1 to 120), a class, a preferred channel if said; the audit row holds the class and the channel, not the name |
| `addContactIdentity` (`POST /contacts/{id}/identities`) | `omni.contact.manage` | the identity is Pending; one another contact holds is 409 `IDENTITY_TAKEN` (also for two agents adding it at once); one this contact holds already is returned as it is, and a Pending one is sent a new code; a contact that is Merged or Blocked takes none (409 `CONTACT_STATE_INVALID`) |
| `verifyContactIdentity` (If-Match: the version of the identity) | `omni.contact.manage` | `OTP` on a phone or an address, `PROVIDER_VERIFIED` on Zalo and WhatsApp (the channels that authenticate the sender), `ADMIN_DOCUMENT` with a reference only for whoever holds `omni.contact.merge` (a supervisor); a method that does not fit the channel is 422 |
| `mergeContacts` (`POST /contacts/merges`) | `omni.contact.merge` | see below; the event `omni.contact.merged.v1` is written |
| `get_resources_contact`, `get_resources_contact_id` | `contact.read` | the contacts newest first, a page at a time, with the identities masked, the contacts they were merged from, and `merge_candidates` |

## The code

An identity on a phone or an address that is added or added again gets a six-digit code. It is kept as `sha256(identity id : code)` with its expiry (10 minutes), sent after the transaction has committed, and spent when it is used. Five wrong codes lock the identity for 30 minutes (`OTP_INVALID` with `locked_until`); during the lock even the right code is refused and does not extend it; after it the count starts again. The failures are committed with the refusal (`refuseAfterCommit`) and are on the trail without the code. Sending is a port (`IdentityOtpSender`): MOCK outside production, **unconfigured in production** (no code is made there until the SMS and mail providers are contracted, D06; an identity is then verified by the provider or by a document).

## The merge

`mergeContacts` names the survivor, the contact merged into it, an identity and a reason (10 to 2000). The rule (`assertMergeable`, pure): both contacts are live; the identity named is one of theirs and **Verified** (else 422 `IDENTITY_UNVERIFIED`); and the other contact holds a **Verified** identity with the **same hash** (else 422 `RECIPIENT_AMBIGUOUS`). The name of a contact is never looked at. Because the table is unique by channel and hash, the shared identity is the same number on the phone of one and on the WhatsApp of the other (or on any two channels that carry the same value). The merged contact becomes `Merged`, its conversations (`contact_id` and `verified_contact_id`) go to the survivor, and **it keeps its identities and its consents**: the survivor shows them (`contact_id` of each identity says whose they were), and a lookup by identity follows `merged_into_id` to the contact that is alive; the consents do not add up (BR-OMNI-05, OMNI 3.5). The audit row holds both ids, the identity that joined them (masked), the reason and the number of conversations moved. A contact that was merged is not merged again, takes no identity and a merge into a merged contact is refused (the trigger too).

## The screen OMNI-03

`ContactDirectoryScreen`: makes a contact; lists the contacts with their identities masked, their state and how they were verified; adds an identity; verifies one (the methods offered fit the channel and the person; a lock is told with its time); and **offers the merge only for a contact that has a candidate**, that is, shares a Verified identity with a live contact (`merge_candidates`, computed by the server): otherwise the button is there, off, with the reason. Nothing is offered to a person who only reads.

## Roles

V1284 gives `OMNI_AGENT` `omni.contact.manage` and `contact.read`, and `OMNI_SUPERVISOR` `contact.read` (it holds `omni.contact.manage` and `omni.contact.merge` through `omni.*`), for the tenants seeded before.
