# IAM: my profile, my sessions and my devices (ST-IAM-006, slice IAM-1)

A person edits their own profile and signs out the sessions and devices they no longer use (IAM 3.4, BR-IAM-13). Everything is of the caller's own membership: another member's session or device is not there for
them (404), and nobody can reach a profile but their own.

## The profile (`getMyProfile`, `updateMyProfile`, IAM-05)

The profile is the `user_account` of the person: a table of the control plane, which the tenant plane has no privilege on. It is read and written through two narrow functions (`my_profile`, `update_my_profile`, V1242) that
take the **membership** of the caller; the user is the one that membership belongs to in the tenant of the transaction, so no other row can be reached. The application role still has no direct access to the table.

* The update is `PUT /me/profile` with `If-Match` (permission `profile.self`): no `If-Match` is 428; a stale version is 409 `VERSION_CONFLICT` and nothing is written; the right version is 200 with the profile and its new
  version. The 409 carries what the profile says now (`display_name`, `locale`, `time_zone`, masked phone), so a screen can put it beside what the person entered.
* A field that is absent stays as it is. `display_name` is 2 to 120 characters (NFC, no control characters), `locale` is `vi-VN` or `en-US`, `time_zone` a name of the time-zone database, `phone_e164` an E.164 number; a body
  that changes nothing is 422 `body`. The phone number cannot be cleared yet (the contract has no way to say "none").
* The email is shown masked (`a***@example.vn`), the phone too (last three digits). The audit row `user.profile_updated` names the fields that changed and the new version, never their values.
* The profile belongs to the person in every tenant they are a member of: a change made in one tenant is a change in all of them.

## The sessions (`listMySessions`, `revokeMySession`, IAM-06)

`GET /me/sessions` lists the live sessions of the membership, the latest first, with `current` on the one the request is made with. The screen offers no revoke for it, and the server refuses it too (422
`SESSION_CURRENT`: the person signs out of it in the usual way). `POST /me/sessions/{id}/revoke` takes a `reason` of 10 characters or more:

* the row is revoked (`revoked_at`, `revoke_reason = USER_REVOKED`); a trigger keeps a revoked session revoked (the retention job purges old technical rows, as for every technical table);
* after the commit the deny-list the authentication guard consults refuses the session **at once in this process**; another process sees it within its negative cache (5 s, far inside the 60 s of BR-IAM-13);
* the identity provider's back-channel logout (`IdentityLogout`, Keycloak) is asked to end its own session; it is a port with no implementation yet (`NoIdentityLogout`), and a failure of it never undoes the revocation;
* asking again for a session that is revoked changes nothing: one `session.revoked` audit row, one `iam.session.revoked.v1` event, and the repeat is noted as `session.revoke_repeated`;
* if the session was opened on a device, **the device is removed with it** (a device that signed out receives no push).

## The devices (`listMyDevices`, `revokeMyDevice`)

`device_registration` is registered by the notification service (ST-NOT-006, not built yet); this story reads and revokes. Revoking a device sets `revoked_at` and `revoke_reason`, **takes the reference of the push token away**
(`push_secret_ref` is null exactly when the device is revoked, checked by the database), signs out the live sessions opened on it, and writes `device.revoked` and `iam.device.revoked.v1`. The row stays as history; at most one
live row exists for a device (an index from V002), so the device that signs in again is a new row. A revoked device stays revoked (trigger).

## Screens

* **IAM-05** (`ProfileScreen`): the form; only the fields changed are sent, under the version read. On a conflict what was entered stays in the form, the profile is read again and the two values are shown side by side;
  the person takes the current values or keeps theirs and saves at the new version.
* **IAM-06** (`SessionsScreen`): the sessions (current marked, no revoke for it) and the devices (live and removed), a dialog with a reason (a default is offered) for each revocation.
