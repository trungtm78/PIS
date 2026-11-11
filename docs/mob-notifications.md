# MOB: notifications, push with opaque links and preferences (ST-MOB-015)

The inbox (MOB-32), the detail (MOB-33) and the settings (MOB-34), the opaque deep link of a push, and the registration of the device for push. The code is in `apps/mobile/lib/features/notification_inbox`. A push reveals nothing: the server sends a neutral sentence and `/r/<notification id>`, and everything else is read from the server after the sign-in, under the permission of the moment.

## Read is not acknowledged (BR-MOB-04, UAT-AC181, NOT02)

- A push that is delivered, accepted or tapped marks nothing acknowledged, and a delivery marks nothing read. Opening the notification (MOB-33) sends `markNotificationRead` once per notification, with `opened_via` `IN_APP`, or `PUSH` when the screen was opened from a push link.
- Acknowledging is a separate button (`acknowledgeNotification`, with an optional note) that only a notification with `ack_required` offers, and only once it is read; on one that asks for none the server refuses with `422 ACK_NOT_REQUIRED` and the screen says so. A lost answer is retried under the same idempotency key.
- A copy of the inbox kept on the device marks nothing: the state of a notification is the server's.
- A notification whose record the member lost shows the server's "unavailable" title, no content, no link and no acknowledgement; an id that is not the member's (another tenant, another member, a revoked membership) is "not found" and reveals nothing.

## The deep link (BR-MOB-05, TK-MOB-015-4)

A push carries `/r/<id>` (`OPAQUE_LINK`: 16 to 64 characters of `A-Za-z0-9_-`). The core router now lets a feature add a `LocationRule` to the deep-link guard (`MobileFeature.locationRules`, `RuleDeepLinkGuard`). The rules run **after** the session guard has let the location through, so:

1. signed out: sign-in first, with the wanted location kept in `return`; nothing is requested before;
2. a link that names another tenant (`?tenant=`): the access-denied screen;
3. only then `opaqueLinkRule` sends `/r/<id>` to `MOB-33/<id>?via=push`; whatever else the link carries is dropped; a link of the opaque path that is not of the shape goes to the access-denied screen and says nothing about what exists.

MOB-33 then reads the member's notifications and shows the notification only if it is among them. The record opens from "Open the record" through `recordLocationOf`: the reference of the server is a path of the web application, and only the ones the phone has a screen for open (`/prj/prj-03?id=` to MOB-10, `/adm/adm-06?id=` to MOB-24), with a plain id; an external address, a script or an unknown path never opens, and the screen it opens checks the access again.

## Registration of the device (TK-MOB-015-1, UAT-AC192)

`PushRegistration` sends `registerDevice` with the identity of the installation (`device_public_id`), the platform, the token, the permission state, the application version and the language. The server keeps one live registration per installation, so a token refresh sends the same identity with the new token; the same token sent again after a lost answer reuses the idempotency key. A device without a token (no provider on the build, a refused permission) **is registered without one** (FIXAE-1): no `push_token` is sent, `permission_state` says why (`unavailable`, `denied`, `unknown`), it keeps its inbox and it is never a push target; the registration is what gives its offline command queue the device id of the sync batches (`docs/mobile-foundation.md`). A token that comes later is the same registration (same id). `revoke()` revokes the registration (by the id the server gave, or found among `listMyDevices` by the installation) and must be called by the sign-out of ST-MOB-008 **before** the session ends. The operating-system side is a port (`PushPlatform`: token, refreshes, permission, installation id); a build without the push configuration uses `NoPushPlatform`: no token, `permission_state` `unavailable`, an installation id of its own kept in the secure store.

## Preferences (MOB-34, UAT-AC186)

For each kind of event the six channels (the inbox of a kind that holds an urgent event is locked and says why), how normal messages are sent (at once, hourly or daily digest; the server keeps the digest per kind and channel, so a kind whose channels were saved in different digests keeps each channel as it is until the person chooses a digest for the kind, which then applies to all its channels), the quiet hours and the time zone; the whole set is saved with `If-Match` under the version seen. The screen says what the policy is: in quiet hours normal messages are deferred, high-priority ones are sent at once (the decision itself is the server's, `UAT-AC186` is a server test). Saving is online only; the push state of the device (granted, blocked, not registered) is shown and says that the inbox still works.

## Several devices: one push, one owner (ST-MOB-031, CR-SMP-06)

A person with a phone, a tablet and a browser is pushed on **one** of them, not on all. The server decides it and the phone shows the decision (`docs/not-push.md`):

- **Dedupe.** An event is one notification for a recipient and a purpose whatever the number of devices (`n1:` + sha256 of tenant, source event, recipient and purpose, UNIQUE per tenant): a replay of the event finds the notification and starts nothing (`AC-ST-MOB-031-1`, `UAT-AC176`). The inbox (MOB-32) has it on every device; only the push is single.
- **The owner** is the live device the member used last that can be pushed to (registered, a token in the vault, the operating system's permission `granted` or `provisional`); a tie goes to the lower id. Every registration moves `last_seen_at`, and the application registers whenever it opens the inbox or the settings and when the token rotates, so the choice follows the member's use and a permission they just changed. The owner is chosen across the platforms: when the owner is an iPhone, the FCM channel finds no device for the person and the APNs channel serves them. When the provider no longer knows the owner's token, that device is revoked and the next one in line is served in the same send (at most three devices).
- **MOB-34 shows it** (`PushDevicesCard`): the live devices, the owner first ("Receives push"), this device marked, the others as "Standby" (allows notifications, used less recently) or "Does not receive push" (the operating system does not allow it). Opening the card registers this device again with what the system allows now and then reads `listMyDevices` (`push_owner`, `permission_state`). The list is read-only: the member cannot pin or remove a device from it (removing is MOB-48/49).
- **Duplicate provider callbacks** (`AC-ST-MOB-031-2`, `UAT-AC182`): a status the provider repeats, at the same moment or later, adds no history row, and an older status never moves a send back (the reducer of ST-NOT-002; `packages/db/test/delivery-engine.test.ts`).

## External channels start only when contracted (TK-MOB-031-2, CR-SMP-06, CXN-ZNS-01, CXN-SPAM-01)

Conversations with people outside through Zalo, WhatsApp and SMS are not offered until the channel contracts are in force (D06, not before R2). The switch is the release flag `omni.external_channels` that SAS-20 operates per tenant (`getMyFeatureFlags`): `externalChannelsEnabledProvider` is true only when the flag is present and enabled, and a flag that is absent or cannot be read is off. MOB-34 says which it is. The flag only switches the offer off: consent, the reply window, the account and the template are judged by the server whatever it says. The conversation screens (MOB-35/36) read the same provider; their `externalReplyEnabledProvider` is to be derived from it instead of the build define `MACHVON_EXTERNAL_REPLY`.

## Payload and transfer assessment (TK-MOB-015-5)

Only the neutral sentence and the opaque id travel through the foreign gateways (FCM and APNs): no record, amount, name, tender file or long-lived download URL. The application never builds a link from content, never puts content in a link, and treats the link as nothing more than a notification id. The server side of the test is `assertLockScreenSafe` and the push adapter of NOT; the transfer assessment of NFR-PRIVACY-04 records that the gateways are foreign and that the data they carry is a sentence and an id.

## What only a device can prove

With several real devices: that one event rings on one of them and moves to the other when the member opens the application there, and that a device which denied notifications in the system settings stops being the owner at its next registration. Receiving a push on iOS and Android with the real FCM and APNs configuration; the notification permission prompt and a refused permission; a token rotation by the provider; a tap on a push from the lock screen with the app killed, with the app on another tenant, and after the membership was revoked; the platform link filters (Android intent filter, iOS associated domains or URL scheme) that hand `/r/<id>` to the router, which are not added in this slice because the host and the scheme are a release decision (ST-MOB-016); sign-out calling `revoke()`.
