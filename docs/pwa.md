# The installed manager application (PWA, YCK.01, eng review R7)

The web application (`apps/web`) is also an installed application for the leaders: a start page, three screens built for a phone of 360 px, notifications that open the right screen, and a service worker that keeps **the shell and the static files and nothing else**. The Flutter application stays; this is the second door, for people who will not install a phone application.

## The screens

They sit under `/m` in the same application, behind the same sign-in and tenant gate as every other screen (`src/pwa/SessionGate.tsx`), and are not in the route table of the design package (they are not screens of the mockup).

| Id | Path | What it is | Where the data comes from |
|---|---|---|---|
| PWA-01 | `/m` | The start page the installed application opens (`start_url` of the manifest): three entries, how to install, how to turn on notifications | the count of the approval queue; nothing else |
| PWA-02 | `/m/approvals` | The approval queue of the period data: approve (the comment is optional) or return for correction (the comment is required) | `get_resources_approval_task` (`mine`, `Pending`) and `decideApprovalTask` (`If-Match` the version of the task, `aal2`), the same operations as the approval inbox of the phone application and the monitor ADM-18 |
| PWA-03 | `/m/dashboard` | The leader dashboard: the context of every figure, the amount disbursed with its ring, the two rates side by side, the plan, what waits, "Cần xử lý ngay" | `getCommandCenter` and the alert source of the bell, through the model, hooks and kit of HOME-09, so the figures cannot differ from the full screen |
| PWA-04 | `/m/directives` | The directive tracking: who issued it, the unit, the deadline, the progress | `useDirectives` (below); no data until the directive entity exists |

States (design.md): loading is a skeleton and never a 0; empty has its kinds (nothing waits / the filter found nothing / the module is not built); an error names itself and retries in place; stale says when the list was read ("Số liệu cũ ... lúc HH:mm") and keeps the list; denied says the scope is hidden and names nothing; offline is the standard offline card; submitting locks the sheet (one request however often it is tapped); success is a receipt (record, step, time, next step); version conflict and "already decided" offer to reload the list and decide again; period locked, licence expired, self-approval and "second factor needed" are said in words, with the second factor asked for in place. A read-only session shows no decision control.

A decision is one request, sent while the page is online, under the version of the task on the screen. It is never queued, never retried by the page on its own, and never sent from a notification. A repeat of the same intention after a lost answer reuses the idempotency key, so the server records it once.

### Directives contract (TODO for the lane that builds the directive entity, DIR-1)

The screen is written against `src/pwa/screens/directives-source.ts`: a typed hook `useDirectives({ status })` that returns `loading`, `notBuilt`, `error`, or `ready` with the items, the time they were read, whether they are stale and the sources that could not be read. The default source says `notBuilt`, which the screen shows as its own empty state ("Chưa có dữ liệu chỉ đạo"), never as "no directive" and never with invented items. To plug the entity in, provide a source through `DirectivesSourceContext` (or make it the default of the context). The shape the screen needs:

```
GET /directives?status={OPEN|IN_PROGRESS|DONE|OVERDUE|CANCELLED}&unit_id={uuid}      read permission of the directive module, scope: the units of the reader
200 { items: Directive[], next_cursor, as_of, unavailable_sources: string[] }
Directive { id, title, issued_by: {id, name}, issued_on: 'YYYY-MM-DD', due_on: 'YYYY-MM-DD' | null, status,
            assignee_unit: {id, name} | null, progress_percent: 0..100 | null, last_update_at | null, overdue_days }
```

`progress_percent` is null when nothing was reported: the screen says "Chưa báo cáo", never 0%. Directive text is shown in the application only, never in a notification.

## The cache policy (R7)

The service worker (`src/pwa/sw-core.ts`, policy in `src/pwa/cache-policy.ts`, entry `src/pwa/sw.ts`, built to `/sw.js` by `vite.pwa.ts`) keeps two caches, both named with the build id: **shell** (`mv-shell-<id>`: `index.html`, the entry script and style with what they import statically, the Latin and Vietnamese fonts, the icon of a notification, fetched at install) and **static** (`mv-static-<id>`: the files of the build met while using it, at most 300, the oldest first).

| Request | What the worker does |
|---|---|
| Not a `GET` | nothing (the browser does what it would have done) |
| To another origin, with an `Authorization` header, or to the API, the sign-in or the worker itself (`/api/`, `/v1/`, `/resources/`, `/me/`, `/auth`, `/oidc`, `/.well-known/`, `/sw.js`) | nothing: **never stored, never answered from a cache** |
| A page load (`navigate`) | the network; with no network the stored `/index.html` (the shell, the same for every path), never a stored page of data. The screens say they are offline themselves |
| A file under `/assets/`, `/fonts/`, `/icons/` (or the manifest, the favicon) | the cache first, then the network, stored only if the answer is a complete `200` of the same origin, of a static content type (script, style, font, image), without `no-store`, `private` or a cookie. A page of HTML (the shell answered for a missing file) and JSON are never stored |

Every path of the contract (`OPERATIONS` of `@machvon/contracts`), bare and under `/v1`, is tested to be `network-only`. Nothing the API answers is in a cache, so there is nothing of a person's data to leave on a shared phone.

**Registered in a production build only** (`import.meta.env.PROD`, a secure context, a browser with workers): a development server would otherwise serve stale modules and hide every change.

**Updates are safe and never forced.** A new build changes the id (a hash of the shell files and of the page), so the bytes of the worker change and the browser installs it in the background (`updateViaCache: 'none'`, a check every hour and when the page comes back to the front). One shell file that cannot be fetched fails the install and the running worker stays. The new worker waits: the banner "Đã có phiên bản mới" (on every screen) offers the update, and only a tap sends it `mv:skip-waiting`; the page reloads once when it has taken over. Nothing reloads by itself, because the reload loses what is typed. The caches of earlier builds are deleted at activation.

**Purge at logout and when the session expires** (`src/pwa/PwaSessionGuard.tsx`, `src/pwa/purge.ts`). When the session ends, whoever ended it, the page: deletes every cache of the origin, tells the worker to do the same (`mv:purge`), ends the push subscription at the push service, forgets the device record, and clears the query cache in memory. Each step runs on its own, so one failure never stops the others. A sign-out through the session first asks the server to remove the device record and its subscription (`revokeMyDevice`, which also revokes the sessions bound to that device), while the session can still ask, waiting at most 3 seconds; the server revokes the device with the session in any case. Tested: `purge.test.ts`, `PwaSessionGuard.test.tsx`, and the browser spec `e2e/pwa-flows.spec.ts` (sign-out leaves no cache and no device record).

## Installing

Installability needs three things: **HTTPS** (or `localhost`), a **manifest** with a name, a start URL inside the scope, `display: standalone` and icons of 192 and 512 px, and a **service worker** (a production build). The manifest is generated at build time (`vite.pwa.ts`, `src/pwa/manifest.ts`), served at `/manifest.webmanifest` (also by the development server), and checked by `src/pwa/manifest.test.ts`.

- **The name** is the name of the product of the edition being built (`VITE_EDITION`, `packages/kernel/src/edition.ts`: public "Hệ thống quản lý đầu tư công", enterprise "Phần mềm quản lý đầu tư xây dựng"; the colour of the bar is the edition's `brand.themeColor`). If the edition manifest cannot be loaded the build warns and the shell brand key `shell.app.name.title` names the application. The same name is the title of a notification that has no generic title of its own.
- **The icons** (`public/icons`: `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon-180.png`, `icon.svg`, `icon-maskable.svg`) are generated from the tokens of the design by `npm run pwa:icons -w @machvon/web` (`src/pwa/icon-art.ts`: three rising bars over a baseline on the colour of the sidebar). `npm run pwa:icons:check` fails when a file differs from what the tokens give; a test runs it. The maskable icon keeps the mark inside the central 80%.
- **Shortcuts** of the installed application open the three screens.

Steps for a person:

1. Open the application over HTTPS on the phone, sign in, and open `/m`.
2. **Android / Chrome, Edge, Samsung Internet:** "Cài đặt ứng dụng" on the start page (or the browser menu: Install app).
3. **iPhone and iPad (Safari only):** Share, "Thêm vào Màn hình chính", Add. The start page says so on an iPhone.
4. **Desktop Chrome / Edge:** the install icon in the address bar, or the button on the start page.
5. Open the installed application: it starts at `/m?source=pwa`.
6. On the start page, "Bật thông báo đẩy" (a tap; the browser refuses to ask otherwise) and allow the notifications. A blocked permission is changed in the settings of the browser for the site.

For operators: serve the build over HTTPS, set `VITE_WEBPUSH_VAPID_PUBLIC_KEY` at build time to enable the button, and keep `sw.js` and `index.html` out of long-lived HTTP caches (`Cache-Control: no-cache`); the files under `/assets/` are hashed and may be cached for a year.

## Notifications (web push)

The server side follows the pattern of the push channels (docs/not-push.md): a **web device is a device registration of platform `web`** whose token is its push subscription (the JSON the browser makes: endpoint and two keys), kept in the vault of the push tokens like any other token. There is no second store: the registration (`registerDevice`), revocation (`revokeMyDevice`, the end of a session), retention and audit of devices serve it, and `PUSH_FCM` already serves "Android and web". The client (`src/pwa/push-client.ts`) asks the permission from a tap, subscribes with the VAPID key and registers the device with a random id kept in the browser.

`apps/api/src/notifications/push/web-push.ts`:

- `WebAwarePushProvider` is the provider of the `PUSH_FCM` channel: a token that is a subscription goes to `WebPushProvider`, every other token to the native provider.
- `WebPushSender` is the port to a push service. `MockWebPushSender` (the stand-in, MOCK, never in production) records what it was asked to send. `VapidWebPushSender` is the real sender, written from RFC 8030 (protocol), RFC 8291 (`aes128gcm` encryption) and RFC 8292 (VAPID, ES256) with `node:crypto`; it is used only when the keys are configured. Like FCM and APNs it is **VERIFIED only after a sandbox spike** against the real push services of the browsers, so the channel stays MOCK and is not registered in production until then.
- **Keys:** `MACHVON_WEBPUSH_VAPID_PUBLIC_KEY` (the same value as `VITE_WEBPUSH_VAPID_PUBLIC_KEY` of the web build), the private key in `MACHVON_WEBPUSH_VAPID_PRIVATE_KEY` or, better, named by a vault reference in `MACHVON_WEBPUSH_VAPID_PRIVATE_KEY_REF` (`secret://<environment>/<path>`, read as `MACHVON_SECRET_<ENVIRONMENT>_<PATH>`, the convention of the webhook secrets), and `MACHVON_WEBPUSH_SUBJECT` (`mailto:` or `https:`). Any missing or malformed value means the stand-in. Never in the database, an audit row or a log.
- **The address is guarded.** A subscription names an address the browser chose and the server POSTs to it, so only the push services of the browsers are called (`fcm.googleapis.com`, `push.services.mozilla.com`, `push.apple.com`, `notify.windows.com`, and the suffixes of `MACHVON_WEBPUSH_ALLOWED_HOSTS`); redirects are refused; anything else is answered as a token nobody knows, and the device is revoked. A request is also limited to ten seconds.
- **Answers** are in the codes of the engine: 404 and 410 are `UNREGISTERED` (the device is revoked and its token leaves the vault), 429 is `QUOTA_EXCEEDED` (retry), 5xx and no answer are `UNAVAILABLE` (retry), 401 and 403 are `THIRD_PARTY_AUTH_ERROR`, other 4xx `INVALID_ARGUMENT` (for good). The `Topic` header is a hash of the idempotency key, so a repeated send replaces the message that waits instead of ringing twice.
- **Silent pushes** (the entitlements changed) are not sent to a web device: a browser must show something for every push it receives, so a silent one would put a notice of the browser's own on the screen. The page reads the entitlements again whenever it is opened.

### What a notification carries

A generic title and a link, never an amount or a name. The data is `{"v":1,"title":"...","url":"..."}`. The title is the neutral sentence of the template (a push template has no variable at all) when it is generic (at most 60 characters, no digit, no code like `BC-2027-001`, no mail address, no word of money), else the name of the product. The sentence under the title is fixed by the worker, whatever the server sends. The link is the opaque link of a notification (`/r/{id}`, which asks for the permission of the moment) or one of the four start paths; a link that names a record is refused by the server (`webPushDataOf`) and replaced by the worker (`safeDeepLink`). The worker builds the notification with exactly three members, so even a server that put a figure in the message could not put it on a lock screen. Tested on both sides with the same adversarial inputs: `src/pwa/push-payload.test.ts`, `sw-core.test.ts`, `apps/api/test/notifications/web-push.test.ts`.

## Where things are

| | |
|---|---|
| Worker | `src/pwa/cache-policy.ts` (pure policy), `push-payload.ts` (pure payload), `sw-core.ts` (the handlers over an injected scope), `sw.ts` (entry), `sw-texts.ts` |
| Build | `vite.pwa.ts` (manifest, worker, shell list, build id), `src/pwa/manifest.ts`, `manifest-texts.ts`, `brand.ts`, `icon-art.ts`, `icons-cli.ts` |
| Page | `register.ts`, `install.ts`, `pwa-state.ts`, `push-client.ts`, `usePushControl.ts`, `purge.ts`, `PwaSessionGuard.tsx`, `UpdateBanner.tsx`, `PwaRoutes.tsx`, `SessionGate.tsx` |
| Screens | `src/pwa/screens/` (`PwaStartScreen`, `ApprovalQueueScreen`, `LeaderDashboardScreen`, `DirectivesScreen`, `DecisionSheet`, `pwa.css`) |
| Words | `src/i18n/parts/pwa.vi.json`, `pwa.en.json` (the worker's own sentence is in `sw-texts.ts`: a worker has no catalogue) |
| Server | `apps/api/src/notifications/push/web-push.ts`, wired in `notifications/delivery/wiring.ts` |
| Tests | `src/pwa/**/*.test.ts(x)`, `apps/api/test/notifications/web-push.test.ts`, `apps/web/e2e/pwa-flows.spec.ts` (written, not run in the lane; the last block needs `E2E_PWA_PREVIEW_URL`) |

## Web push in operation (lane WEBPUSH)

- **State of the channel:** `MOCK` (no VAPID key), `PENDING_SPIKE` (keys set, real sender, runs outside production only), `VERIFIED` (`MACHVON_WEBPUSH_SPIKE_VERIFIED=true` after `docs/runbooks/web-push-spike.md`; probe: `scripts/web-push-probe.mjs`). In production the web channel (provider `web-push`, `PUSH_FCM`) is registered only when `VERIFIED`.
- **Keys** come from a file (`MACHVON_WEBPUSH_VAPID_PRIVATE_KEY_FILE`, `MACHVON_WEBPUSH_RECEIPT_KEY_FILE`), else a vault reference, else the variable. A limit per tenant (`MACHVON_WEBPUSH_TENANT_PER_MINUTE`, default 600) answers QUOTA_EXCEEDED with a pause; the pause a push service asks for (`Retry-After`) reaches the delivery engine; priority CRITICAL/HIGH sends `Urgency: high` with a 4 hour TTL.
- **Receipt:** the push carries `rcpt`, an opaque HMAC token bound to tenant, notification and device (48 hours). The worker posts `{receipt, event: SHOWN|CLICKED}` to `POST /push/receipts` (`acknowledgePush`, public, no session): the send moves ProviderAccepted -> Delivered -> Read through the monotonic reducer, idempotent. The alert ladder (NOT-30) reads these statuses as rung receipts, so an unacknowledged push is waited out by the `wait_minutes` of its rung and the next rung (e-mail, Teams) is sent; `TEAMS` is now a ladder channel.
- **Page:** `/m/notifications` (PWA-05): permission, subscribe, unsubscribe, test notification to myself (`sendMyTestPush`).

## Not here (yet)

- The live check itself (needs real browser subscriptions): the channel stays `PENDING_SPIKE`.
- The directive entity (DIR-1) and its list operation: the hook is the contract.
- A shared constant for the manager start paths between the server and the worker (they are repeated, and tested against each other).
- A web push for `PUSH_FCM` in production is not registered (no MOCK adapter runs there), like FCM and APNs.
