# Runbook: the live check (spike) of the web-push channel

Why: the web-push sender is written from RFC 8030, 8291 and 8292 and is tested against a fake push service, but no browser vendor has been asked to accept a message from our key yet. Until this runbook has been done and its result recorded, the channel is `PENDING_SPIKE`: it can run outside production (to do this check) and it is **not registered in production**. The check turns it `VERIFIED`.

States (`apps/api/src/notifications/push/web-push-config.ts`): `MOCK` (no VAPID key, the stand-in), `PENDING_SPIKE` (keys set, real sender, not proven), `VERIFIED` (the operator sets `MACHVON_WEBPUSH_SPIKE_VERIFIED=true` after this runbook passes).

## 0. What you need

- A staging deployment over HTTPS (a service worker and push need a secure context) built with `VITE_WEBPUSH_VAPID_PUBLIC_KEY` and `VITE_API_BASE_URL` set; `sw.js` and `index.html` served with `Cache-Control: no-cache`.
- The devices: a Windows or macOS PC with **Chrome** and **Edge**, **Firefox** (desktop), an Android phone with Chrome, and an **iPhone or iPad with iOS/iPadOS 16.4 or later** (Safari, the site installed to the Home Screen). Web push on iOS works only from the installed application.
- A test account of the staging tenant, in each browser.
- A shell on a trusted machine with Node 24 and this repository (the probe has no dependency).

## 1. Make the keys (once per environment)

```
node scripts/web-push-probe.mjs keygen --out-private /secure/webpush/vapid-private.key
```

The public key is printed; the private key is written to the file (mode 600; refuses to overwrite) and never printed. Set, on the API: `MACHVON_WEBPUSH_VAPID_PUBLIC_KEY=<public>`, `MACHVON_WEBPUSH_VAPID_PRIVATE_KEY_FILE=/secure/webpush/vapid-private.key`, `MACHVON_WEBPUSH_SUBJECT=mailto:<operations mailbox>`; and `MACHVON_WEBPUSH_RECEIPT_KEY_FILE` to a file holding at least 32 random characters (the key of the receipt token; several separated by commas while it is rotated). Build the web with the same public key. The files are never in git (the repository ignores them and the gate scans for keys).

## 2. For each browser: get a subscription

1. Open the staging site, sign in, open `/m/notifications`, press "Turn on push notifications" and allow. (iPhone: first Share > Add to Home Screen, open the installed application, then press the button.)
2. Save the subscription: in the browser console of the page run `copy(JSON.stringify((await (await navigator.serviceWorker.ready).pushManager.getSubscription()).toJSON()))` and paste it into a file `sub-<browser>.json` **on the trusted machine only**. It is a secret of that person's device: do not commit or send it.

## 3. Send one push with the probe

```
node scripts/web-push-probe.mjs send --subscription sub-chrome.json --public-key <public> \
  --private-key-file /secure/webpush/vapid-private.key --subject mailto:<mailbox> --urgency high --ttl 120
```

Expected: `status: 201`, a `location`, verdict `ACCEPTED`, and within a minute the notification on the device with the **fixed sentence of the application and the product name** (the message has no title and no text of its own), and a tap opens `/m`. Record, for each browser: the host of the push service (printed), the status, the time to arrive, whether the tap opened the page.

Negative checks (once, any browser): remove the permission in the browser settings, send again, expect `ACCEPTED` or `GONE`; in the browser press "Turn off" on `/m/notifications`, send again, expect `GONE` (404 or 410); send with a different `--public-key` than the subscription was made with, expect `AUTH` (401 or 403).

| Browser | Push service host | Special points |
|---|---|---|
| Chrome (desktop, Android) | `fcm.googleapis.com` | the key must be the one the subscription was made with |
| Edge | `*.notify.windows.com` | Windows notification settings (Focus assist) can hold the notification |
| Firefox | `*.push.services.mozilla.com` | the browser must be running |
| Safari on iOS/iPadOS 16.4+ | `*.push.apple.com` | installed to the Home Screen only; the permission is asked after a tap; `Urgency` and `TTL` are honoured |

## 4. Through the application (not only the probe)

On `/m/notifications` press "Send a test notification to me": the server sends through the delivery engine to the registered device. Expect the same notification and, in the delivery overview (NOT-11), the send as `ProviderAccepted`, then `Delivered` when the device shows it (the service worker posts the receipt, `acknowledgePush`) and `Read` when it is tapped. A `Delivered` that never appears means the receipt key is not set, the worker could not reach the API, or the token is older than 48 hours.

## 5. Record and promote

1. Write the result in `docs/evidence/` (browser, version, OS, push service host, status, delay, tap result, date, who) without any subscription, endpoint path or key.
2. When Chrome, Edge, Firefox and Safari on iOS have all passed, set `MACHVON_WEBPUSH_SPIKE_VERIFIED=true` on the production API. The channel is then registered in production as `VERIFIED` (provider `web-push`, `PUSH_FCM`). A browser that failed is written down as unsupported on the page of the notification settings and in the user guide, and the channel can still be promoted if the product accepts that browser as unsupported (a decision of the owner).
3. Delete the subscription files.

## 6. If something fails

| Symptom | Likely cause |
|---|---|
| `AUTH` (401/403) | the key pair differs from the one the subscription was made with (the page was built with another public key); make the subscription again |
| `GONE` right after subscribing | the subscription belongs to another key, or the browser profile was cleared |
| `ACCEPTED` and nothing on the device | the browser is closed (Firefox), the OS is holding notifications, the permission was removed, or (iOS) the site is not installed to the Home Screen |
| `QUOTA` | wait for `Retry-After`; the server obeys the same value |
| nothing posted to `/push/receipts` | `VITE_API_BASE_URL` of the build, CORS or the receipt key; see the network panel of the service worker |
