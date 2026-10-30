# Push channels FCM and APNs (ST-NOT-007, NOT 9, NOT-14)

The notification engine reaches the registered devices of a person through two channels, `PUSH_FCM` (Android and web) and `PUSH_APNS` (iOS). Both are adapters over a provider port; until a sandbox spike has verified them against the real providers they are **MOCK** (`MockPushProvider`, registered outside production only, none in production).

## What a push carries

- **A neutral sentence and an opaque link.** The text is the literal text of the template, **no variable of the event is filled in**, and the link is `/r/{notification_id}`: opening it asks for the permission of the moment. Nothing about the record the notification is about (a name, a figure, a code) reaches a lock screen (BR-NOT-13, UAT-AC28, AC-NOT-08).
- **A push template uses no variable at all.** The kernel refuses it when it is written (`TEMPLATE_INVALID`, `content_ast.{name}`, or `content_ast.body` over 120 characters, the length the adapter accepts; a money or confidential variable is still told as `TEMPLATE_VARIABLE_CLASSIFIED`), the form of NOT-08 says so before it is sent, and a test send renders it the same way.
- **The adapter looks once more** (`assertLockScreenSafe`): a placeholder left, an empty text, one over 120 characters or a link that names a record is refused as `LOCKSCREEN_UNSAFE` before the provider, whatever stored it.

## Sending (`DeliveryDispatcher.callPush`)

The dispatcher reads the devices of the recipient that can be pushed to (`DeviceRegistrationStore.pushTargets`: live, with a token in the vault, permission `granted` or `provisional`, a platform the channel reaches), reads each token from the vault for this call, and gives the adapter the list. At most ten devices are written to in one send.

- Some device accepted: the send is **accepted** (the message id is the first one). The devices the provider refused for good are revoked all the same.
- None accepted and a failure can be tried again (`UNAVAILABLE`, `QUOTA_EXCEEDED`, `ServiceUnavailable`, `TooManyRequests`...): **RETRYABLE** with the pause the provider asked for, nothing revoked.
- None accepted and every failure is for good: **PERMANENT** with the code of the provider in the form the engine keeps (`BadDeviceToken` becomes `BAD_DEVICE_TOKEN`).
- No device to write to: **PERMANENT `NO_DEVICE`**.
- A token the provider no longer knows (FCM `UNREGISTERED`, `INVALID_ARGUMENT_TOKEN`, `SENDER_ID_MISMATCH`; APNs `BadDeviceToken`, `Unregistered`, `DeviceTokenNotForTopic`, `ExpiredToken`) revokes the device (`revoke_reason` `PROVIDER_UNREGISTERED`, the reference leaves the row) and the token leaves the vault; the counter `push_devices_revoked_total` is incremented (UAT-AC179). The sessions opened on the device are not touched: the app registers again at its next start.

The link is `/r/{notification_id}`; the web app resolves it (`OpaqueLink`) to the details of the notification (NOT-02), which the server answers only to its recipient. A call to one device that throws does not take the others with it; with none accepted the send is UNKNOWN (never retried on its own).

The provider says "accepted" and nothing more: no delivery receipt comes back, so the status stays `ProviderAccepted` and a push never marks a notification read.

## The silent push (`SilentPushConsumer`, UAT-NOT02)

- `sas.entitlement.changed.v1` wakes **every** push-registered device of the tenant; `iam.access.changed.v1` wakes the devices of the members in `membership_ids` only (an event that names nobody wakes nobody).
- The message is a data message with no text (`{ kind: "refresh", what: "entitlements" }`): the app reads `/me/entitlements` again. It is best effort: an app that misses it reads again when it is opened, and the server never trusts what an app holds.
- The consumer runs once for each delivery (`consumeOnce`, inbox row `not.silent-push`); the devices and tokens are collected in the inbox transaction and the sends are made after the commit, ten devices at a time. A failure of one provider does not stop the other; a dead token is revoked as above. The counter `push_silent_total{channel, outcome}` is incremented.
- An event whose payload names another tenant than its signed one is ignored (the access events of the org-unit commands carry no tenant in the payload and use the signed one).

## Not here

The real providers (credentials, HTTP/2 to APNs, the FCM v1 API), delivery receipts, and the Flutter handlers of the silent message are not built; see TODOS.
