# Runbook: TLS and HTTP security headers

Standard for every installation. Configuration: `infra/onprem/nginx/` (edge: TLS, headers, proxy), `apps/api/src/security/security-headers.ts` (headers the API sends itself). Checked by `npm run infra:check` and tested where the headers are actually produced.

## TLS standard (the edge)

| Setting | Value | Why |
|---|---|---|
| Protocols | TLS 1.2 and TLS 1.3 only | SSLv3, TLS 1.0 and 1.1 are broken or retired |
| Cipher suites (1.2) | ECDHE with AES-GCM or ChaCha20-Poly1305 only (ECDSA and RSA certificates) | forward secrecy and AEAD only; no CBC, no static RSA key exchange, no RC4 or 3DES |
| Server preference | off (clients choose among the safe suites) | modern clients pick better than a fixed order |
| Curves | X25519, prime256v1, secp384r1 | |
| Session tickets | off; session cache 10 MB, one day | ticket keys would outlive the process |
| Certificates | from the customer's authority, mounted as secret files `tls_cert` and `tls_key`; chain included; renewed before expiry (alert in the monitoring of the customer) | |
| HTTP | port 80 only redirects (301) to HTTPS and answers `/healthz` | |
| HSTS | `max-age=63072000; includeSubDomains` on every edge response | two years, as in the Mozilla guidance |
| Inside the host | the data and app networks are internal (no route out); only the database, the backup runs and Keycloak join the `egress` network, which the host firewall limits to the object store and the directory (`infra/onprem/config/egress-firewall.sh`); the edge talks to the API and Keycloak over the app network in clear text because nothing else can see that network; move them to TLS if the database host is separate | |

## Header standard

Web application (every response of the edge for the SPA, `snippets/security-headers.conf`):

| Header | Value |
|---|---|
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` |
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` (the legacy twin of `frame-ancestors 'none'`) |
| `Referrer-Policy` | `no-referrer` |
| `Permissions-Policy` | camera, microphone, geolocation, payment and usb disabled |
| `Cross-Origin-Opener-Policy` / `Cross-Origin-Resource-Policy` | `same-origin` |
| `Cache-Control` | `no-cache` for the shell and the service worker, `public, max-age=31536000, immutable` for hashed assets |

API (every response, `apps/api/src/security/security-headers.ts`): `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` (a route that needs another value sets it later and wins), `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Cross-Origin-Resource-Policy: same-site`, `Permissions-Policy`, and `Strict-Transport-Security` when the request came over TLS (the socket, or `X-Forwarded-Proto: https` from the edge). `X-Powered-By` is switched off. The edge adds HSTS and the transport headers on `/api/` responses and passes the rest through.

Keycloak (`/idp/`): its own content policy and framing rules govern its login pages; the edge adds HSTS, `nosniff` and the referrer policy only. The admin console, metrics and health paths are answered 404 at the edge.

## Tests

| What | Where |
|---|---|
| The API sends the headers on a real HTTP response, HSTS only behind TLS, a route can override `Cache-Control` | `apps/api/src/security/security-headers.test.ts` |
| The API sends them on a success, a refusal and a health answer of the whole application | `apps/api/test/bootstrap.test.ts` (section "security headers") |
| The nginx configuration states the TLS standard and the headers, every location includes the header snippet, the headers in the snippet equal the standard here | `scripts/infra-check.test.mjs` and the rules of `npm run infra:check` |
| The running installation (not run in CI) | the checks below, and the ZAP scans of `dast.yml` (rules in `.zap/rules.tsv`: a missing header fails the scan) |

Check an installed edge by hand:

```
curl -sI https://<PUBLIC_HOST>/ | grep -i -E "strict-transport|content-security|x-frame|x-content-type|referrer|permissions|cross-origin"
curl -sI https://<PUBLIC_HOST>/api/health/live
curl -sI http://<PUBLIC_HOST>/ | head -n 3                      # 301 to https
openssl s_client -connect <PUBLIC_HOST>:443 -tls1_1 </dev/null   # must fail to handshake
openssl s_client -connect <PUBLIC_HOST>:443 -tls1_2 </dev/null | grep -E "Protocol|Cipher"
```

(`testssl.sh` and the SSL Labs equivalent for an internal host give the full report; attach it to the installation evidence.)

## Known exceptions

- `style-src 'unsafe-inline'`: the interface library writes inline `style` attributes. Scripts are not affected (`script-src 'self'`). The ZAP rule 10055 is a recorded WARN in `.zap/rules.tsv`. Removing it needs a style nonce pipeline; tracked in `docs/security/pentest-readiness.md`, section 6.
- OCSP stapling is not configured: the certificates come from a private authority without a public OCSP responder.

## Changing the standard

A change to a header or a TLS setting is a change of `infra/onprem/nginx/snippets/` or `security-headers.ts`, of the table above and of the tests in one commit. Do not weaken a header to fix a screen: fix the screen.
