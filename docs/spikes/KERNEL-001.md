# KERNEL-001: Flutter OIDC with PKCE, offline command queue, resumable upload, tokens-driven theme

Status: **DONE_PENDING_ENV** (the Dart logic and the server contract run here; the device and identity-provider parts need an environment).
Story: ST-KERNEL-001 (SPIKE-FLUTTER). Decision under test: D-B12, Flutter for the mobile app.

## Question

Can Flutter do OIDC Authorization Code with PKCE through the system browser, queue commands offline with the `UNKNOWN`
state, resume a SHA-256 checked photo upload after the network is lost, and render a theme generated from
`design_tokens.json`, so that D-B12 rests on measurements and the review-hour estimate of MOB can be measured?

## Method

Three small Dart modules next to the generated API client, each with tests that run with `flutter test`
(`packages/mobile-api-client/spike/`, tests in `packages/mobile-api-client/test/spike/`):

- `pkce.dart`: verifier, S256 challenge, authorization URL, state check, token request, restorable session. Moved to `apps/mobile/lib/features/session/auth/pkce.dart` by ST-MOB-002 (see `docs/mob-session.md`); the spike keeps `sha256.dart` for the upload spike.
- `offline_command_queue.dart`: an ordered queue over the generated `MachvonApiClient`; a command keeps one
  `CommandAttempt` key for its whole life, so a replay is the same intention.
- `resumable_upload.dart`: a chunked uploader over a `ChunkUploadServer` port; after a failure it asks the server which
  chunks it holds and sends only the others. `sha256.dart` is a dependency-free SHA-256 used for the whole-file digest.

The plan said to put the spike in `packages/mobile-tokens/spike/`; it lives in `mobile-api-client` because the queue and
the upload build on the client's `CommandAttempt` and transport, and `mobile-tokens` has no dependency on it.

## What ran here

- AC-1 (PKCE logic): the S256 challenge equals the RFC 7636 appendix B vector; verifiers have 43 to 128 unreserved
  characters; the authorization URL carries the challenge and never the verifier; a stored session
  (`toJson`/`fromJson`) completes the login after a simulated kill mid-redirect; a redirect with another state, an error
  or no code is ignored.
- AC-2 (offline queue): with an answer lost after the server executed the command, the command goes `QUEUED`, `UNKNOWN`,
  `ACCEPTED`; the server holds exactly one record; every request carries the same idempotency key (no new command is
  created); the same holds when the queue is stored and restored between the two flushes (process kill); order is kept; a
  4xx is final (`REJECTED`) and a 5xx stays `UNKNOWN`.
- AC-3 (upload): a 12 MiB source in 1 MiB chunks, the network cut when chunk 7 is first sent, a resume that sends chunks
  7 to 12 only; chunks 1 to 6 are sent exactly once; the digest the server computes over the joined chunks equals the
  source digest (`e3b046bf...521f`, computed independently with Node); a corrupted stored chunk makes `complete` fail.
- AC-3 (theme): `packages/mobile-tokens/test/theme_test.dart` already asserts the button minimum size of the theme built
  from the generated tokens: 48 dp on Android and the other platforms, 44 pt on Apple platforms.

## Evidence

`flutter test` in `packages/mobile-api-client`: 37 tests pass, 15 of them are the spike tests
(1 SHA-256, 5 PKCE, 6 queue, 3 upload). `flutter test` in `packages/mobile-tokens`: 16 pass. `flutter analyze spike
test/spike`: no issues. The SHA-256 implementation is checked against four published vectors (empty, "abc", the 56-byte
boundary string, 1000 times "a").

## What did not run and why

- Login against a real Keycloak realm with a public PKCE client, through the system browser of a device: there is no
  Keycloak here (external blocker) and no device. Not measured: whether the redirect scheme survives a kill on Android
  and iOS.
- Refresh-token storage in Keychain and Keystore, and "0 tokens in the app log": needs a device.
- The photo upload against a real endpoint: no upload endpoint was added to the API e2e stack (it is not in the files of
  this task); the server in the tests is a test double that implements the port. A real endpoint must expose the same
  three operations: begin, which chunks are held, put chunk, complete with a digest.
- Review-hour estimate for MOB: nothing to replace it with until the device run exists.
- iOS touch targets: the theme asks 44 pt on Apple platforms (the platform guideline), the acceptance criterion says
  "below 48 dp". Android meets 48 dp. Either the criterion names Android only or the iOS value changes; that is a design
  decision (recorded in TODOS.md).

## Decision

Keep Flutter (D-B12): nothing run here argues against it, and the three pieces of logic that carry the risk (PKCE
session restore, exactly-once replay by key, resumable upload) work on the Dart VM with plain ports. The decision is
**not confirmed on devices**. To close the spike, run on one physical Android and one iOS device:
`flutter test integration_test` of an app that wires `PkceSession` to `flutter_appauth` or `app_links` and a Keycloak
test realm, plus the upload against the real endpoint; record the results in the evidence section above.
