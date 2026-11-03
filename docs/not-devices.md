# Push devices (ST-NOT-006, NOT 3.7, NOT-14)

A member allows push notifications on a device once; the device is registered, the push token is kept in a vault, and the registration is removed when the member removes the device or signs out of it. The server never exposes the token.

## Registering (`registerDevice`, `POST /devices`, 201, `notification.self`)

The body names the device (`device_public_id`, 16 to 128 characters of letters, digits and `._:-`), the `platform` (`ios`, `android`, `web`), the `push_token` the provider gave the app, the `permission_state` the operating system gave (`granted`, `denied`, `provisional`, `unknown`), the `app_version` and the `locale`. It is the caller's own device: the registration belongs to the membership of the session.

- **One live registration for each (membership, device).** Registering again is the same registration with what changed: the token (its fingerprint), the permission, the app version, the locale, `last_seen_at`. The answer is `REGISTERED` the first time and `UPDATED` after, with the same `resource_id`. Two requests at the same moment find the same registration (the unique index of V002 and a retry). Two members who share a device have a registration each. A device registered again after it was removed is a new registration.
- **The token is in the vault.** `push_secret_ref` (`secret://push/{tenant}/{device}`) points to it and the database keeps the SHA-256 fingerprint only, to tell that the token changed. The token is in no answer, audit row (`device.registered|updated` carry the platform, the permission state, the app version and whether the token changed), event, stored answer of the command or table. The token is written at every registration, so a vault that lost it is repaired by the next one. Every new token has a reference of its own (a rotation points the row to a new one): a command that does not commit removes the token it wrote and leaves the old one untouched, whatever else runs at the same time, and one that commits removes the token it replaced. A token that the vault cannot take fails the command whole. The session of the request is tied to the device in the same transaction; a session that has already ended registers nothing (401). The vault is a stand-in in memory until the one of the platform is deployed (`InMemoryPushTokenVault`, MOCK).
- **Token rotation** is allowed while the device is live (migration **V1445** lets the fingerprint change); what a device is (member, public id, platform) never changes, and a revoked device stays revoked.

## Removing and revoking

`revokeMyDevice` and `revokeMySession` (ST-IAM-006) revoke the registration, take the reference out of the row (`revoke_reason` `USER_REVOKED`) and, **after the commit, remove the token from the vault**: a device that signed out is never written to again. A vault that cannot be reached at that moment leaves a token that no row refers to (TODOS). A change of tenant is the client's to say: it removes the device of the tenant it leaves (`revokeMyDevice`) before it registers in the next. A permanent failure of the provider (`UNREGISTERED`, `BadDeviceToken`) revokes the device through the push adapters of ST-NOT-007.

## Reading (NOT-14, `get_resources_device_registration` and `_id`, `device_registration.read` on the whole tenant)

The operator sees, for each device: the id, the membership, the platform, `device_hint` (the first four and the last four characters of the public id), the permission state, the app version, the locale, when it was last seen, `Active` or `Revoked`, and when and why it was revoked. **Never the token, the reference, the fingerprint or the whole public id.** Filters: `status`, `platform`, `membership_id`; the most recently seen first, a page at a time.

## The member's own list (`listMyDevices`, `session.self`)

Besides the device, its platform, its public id (the member's own), when it was last seen and `ACTIVE` or `REVOKED`, the list carries `permission_state` and `push_owner`: the one device (at most) the member's push goes to, see `docs/not-push.md` (ST-MOB-031). A revoked device and a device that denied notifications are never the owner.

## Screen NOT-14

`DeviceListScreen`: the table of the devices with the two filters, a note that nothing secret is shown, the removed devices with their time and reason, "load more", and the seven states from `StateBoundary`. The mobile side (the permission prompt MOB-05, the refresh of the token and the local cleanup on a change of tenant) belongs to the Flutter app, which is not in this repository yet.
