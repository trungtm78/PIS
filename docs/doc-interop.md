# DOC: interoperability of documents through the LGSP (ST-DOC-021, slice DOC-1)

An agency sends its issued documents to other agencies and receives theirs through the national document interoperability backbone (QD 28/2018/QD-TTg, QCVN 102:2016/BTTTT), reached through the LGSP of the agency (DOC 3 F13, FT-DOC-08).
This story builds the receiving side, the sending queue with its progressive retries and its end as DEAD, the monitor (DOC-20) and the alert. **It is not connected to a real LGSP**: the specification of the pilot tenant is open
([CXN-06], D05), so the gateway adapter is a port with a MOCK implementation, the envelope is a JSON stand-in and the connector of a tenant can only be `Active` with a MOCK adapter outside production (see "What is not here").

## The message and its states

Table `doc_interop_message` (V002, made a record by V1230): one row for each message that leaves (`OUTBOUND`, one for each distribution on the LGSP channel) or arrives (`INBOUND`, one for each envelope).

| direction | states and edges (kernel `doc-interop.ts`, the same in the guard trigger) |
|---|---|
| OUTBOUND | `QUEUED` -> `SENT` -> `ACKED` or `REJECTED`; `QUEUED` -> `FAILED` -> `QUEUED` (the wait is over); `QUEUED` -> `DEAD` (the twentieth failure); `FAILED` or `DEAD` -> `QUEUED` (a person sends it again); `QUEUED` or `FAILED` -> `REJECTED` with `DISTRIBUTION_CANCELLED` (the document was recalled) |
| INBOUND | `RECEIVED` -> `PROCESSED` (in one transaction, so a received message that is not processed is not left behind) |

`attempts` counts the attempts to hand the message to the gateway (0 to 20). The waits between attempts are progressive (kernel `interopBackoffSeconds`): 1, 2, 4, 8 ... minutes after the first, second, third, fourth ... failure, up to 6 hours
(`planFailure`). The twentieth failure ends the message as DEAD (about three days after the first attempt) and sets no next attempt. A message that goes `QUEUED`, fails four times and is handed over on the fifth attempt is `SENT` with
`attempts = 5`, and `ACKED` when the receiving agency confirms (AC-ST-DOC-021-1, UAT-AC425).

## Distributing on the LGSP (`dispatchOutgoingDocument`, channel `LGSP`)

The channel was refused by name before this story. It is now taken for a recipient the document names that is an `EXTERNAL_AGENCY` with a code (the gateway addresses a message by the code of the receiving agency): another kind is 422
`RECIPIENT_INVALID` with reason `LGSP_NEEDS_AGENCY`, no code is `CODE_REQUIRED_FOR_LGSP`. The call only queues: the adapter (`InteropCodec`, JSON stand-in `JsonInteropCodec`) builds the envelope around the sealed PDF, it is kept in the object
store under its SHA-256 (`interop-envelope`), the row of `document_distribution` stays `PENDING` and a `QUEUED` message is written for it, one for each distribution (V1230 `doc_interop_message_distribution_uq`; asking again is the same message).
The document is not reported as delivered. `retryDocumentDistribution` on an LGSP row is 409 `DISTRIBUTION_STATE_INVALID` (reason `USE_INTEROP_RETRY`): the message carries it, and DOC-20 sends it again. The recall of the document (ST-DOC-012)
calls off the messages that did not leave together with their rows.

## The job `doc-interop-send` (every minute)

`DocInteropSender.runPass` for each tenant (a stand-in for `DocInteropSendWorkflow`; there is no workflow engine in this repository, the job runner holds one owner at a time and every message is locked `FOR UPDATE SKIP LOCKED`):

1. messages `SENT` in an earlier pass are asked what the receiving agency did (`receipt`): `ACKED` or `REJECTED` (with the code of the reason), or still pending, or the gateway cannot say (the message stays `SENT`, counted as `receipt_unavailable`);
   A pass asks at most 50 messages, in the order of the last poll: the messages never asked first (the longest sent first), then the one asked the longest ago. Every message that is asked gets the moment of the poll in
   `doc_interop_message.last_polled_at`, whatever the answer (pending, the gateway cannot say, acknowledged, refused), so a batch of messages whose receipts stay pending moves behind the others and the later messages are
   asked in the next pass. The moment is bookkeeping: the version and `updated_at` of the message do not change, and the guard trigger lets it be written only while the message is `SENT`. The column belongs to the
   migration `V1230__doc1_interop_message.sql` itself (not released anywhere, so it was extended in place, with a partial index `doc_interop_message_poll_idx` for the order);
2. messages that are due (`QUEUED`, or `FAILED` with the wait over) are handed to the gateway, one transaction for each message, so that one that fails does not hold the others. A failed attempt keeps its code in `error_code`:
   `INTEROP_ADAPTER_NOT_ACTIVE` (the tenant has no LGSP connector in `Active`), `EGRESS_NOT_ALLOWED` (see below), `ENVELOPE_INVALID` (the stored envelope no longer matches its digest), the code the gateway named, or `CHANNEL_ERROR`;
3. the number of dead messages of the tenant is set in the gauge `doc_interop_dead_gauge{tenant_id}`.

The distribution follows the message: `SENT` when the gateway took it, `ACKNOWLEDGED` when the receiving agency confirmed (and the outgoing document is settled as in ST-DOC-010: `DELIVERED`, then `ACKNOWLEDGED` when every
recipient that had to acknowledge has, one event each), `FAILED` with the reason when the message is `DEAD` or `REJECTED`. A row that ended its own way (a receipt a clerk recorded by hand, a recall) is left as it is.
Audit rows `doc_interop_message.<status>` carry ids, codes and counts, never the words of the letter; events `doc.interop_acked.v1`, `doc.interop_rejected.v1` and `doc.interop_dead.v1` go to the outbox once for each message.

The call to the gateway runs inside the transaction that records its outcome. If that transaction fails after the call the next pass sends the same message again; the port requires a gateway to drop a message id it has seen
(`messageId` is the id of the message in this system).

### Egress

The connector of the tenant (ADM-09, `mode` `LGSP`, status `Active`) carries `config.endpoint` (https), `config.egress_allowlist` (host names, or `*.domain` for the hosts below a domain) and `config.agency_code` (the sender code of the agency).
Before every call `assertEgressAllowed` checks the address: not https, a host that is not listed (a look-alike such as `lgsp.example.gov.vn.attacker.net` included), an empty or missing allowlist, or no address is the failure
`EGRESS_NOT_ALLOWED` and **no call is made**. Nothing but an address on the allowlist is ever passed to the gateway; the tests assert the addresses a MOCK gateway was called with.

### The alert

Rule `alerts/rules/DOC_INTEROP_DEAD.json` (critical, owner `integration-admin`, the integration administrators of the agency, runbook `docs/runbooks/alerts/DOC_INTEROP_DEAD.md`) fires while any tenant's `doc_interop_dead_gauge` is above zero and resolves when the gauge is back to zero.

## Receiving (`receiveInteropMessage`, `doc.interop.ingest` over the whole tenant, Idempotency-Key)

`POST /integrations/lgsp/inbound-messages` with `{ envelope_object_key, envelope_sha256, external_message_id, sender_code, signature_key_id, signature }`. The LGSP acts for the whole tenant through a service principal (a grant on a subtree
is 403 `SCOPE_DENIED`). Steps, in order, nothing is written for a refusal:

| step | refusal |
|---|---|
| the tenant has no LGSP connector in `Active` status | 503 `PROVIDER_UNAVAILABLE` |
| the key `signature_key_id` is not one of the keys the connector holds in the vault (`credential_secret_ref`, `keyId:secret`, two while a key rotates) | 422 `SIGNATURE_KEY_UNKNOWN` |
| the signature is not `hex(HMAC-SHA256(secret, ["external_message_id","sender_code","envelope_sha256","envelope_object_key","signature_key_id"] as JSON))` | 401 `SIGNATURE_INVALID` |
| the envelope is not a clean upload of this tenant (the shared pipeline: 404, 409 `SCAN_PENDING`, 422 `FILE_NOT_CLEAN`) | as the pipeline answers |
| the SHA-256 of the stored bytes is not `envelope_sha256` (which the signature covers) | 422 `VALIDATION_FAILED` (`envelope_sha256`) |
| the adapter cannot read the envelope (`InteropCodec.decode`: not an envelope of the format, an attachment that does not match its own digest, facts that do not fit) | 422 `ENVELOPE_INVALID` |
| the title, symbol or sender is marked as a level of state secret (BR-DOC-20); audited as DENIED | 422 `STATE_SECRET_NOT_SUPPORTED` |
| the attachment is not a PDF | 422 `UPLOAD_NOT_PDF` |
| **the digest of the envelope, or the id the sender gave the message, was received before** | **409 `ENVELOPE_DUPLICATE`** with `interop_message_id` and `incoming_document_id` of the first; nothing is written |
| the document type of the envelope is not one of the tenant | 422 `VALIDATION_FAILED` (`doc_type_code`) |

Then, in the same transaction as the message: the letter is made exactly as a clerk's `receiveIncomingDocument` makes it (`takeInLetter`: document, file, version, incoming letter `RECEIVED`, channel `LGSP`,
`interop_message_id`), the event `doc.incoming_received.v1` and the audit row `incoming_document.received` go out as for any letter, and the message is `PROCESSED`. A letter that looks like one already in the register (same sender, symbol and
day, BR-DOC-18) under another envelope is taken in with `duplicate_of_id` and the fixed reason "Received again through the LGSP under another envelope", for the clerk to reject or keep. Audit row `doc_interop_message.receive`
(sender code, key id, digest, ids).

Dedupe is held by the database: `doc_interop_message_hash_uq` (tenant, direction, envelope digest, INBOUND) and `doc_interop_message_ext_uq` (tenant, direction, external id), and one incoming letter for one message
(`incoming_document_interop_message_uq`). Two deliveries that race give one letter (the second waits on the unique index, finds the first and answers 409). The answer to a duplicate is 409, not 200, on the reading of the design list of error
codes (`ENVELOPE_DUPLICATE` is the error of this operation); a gateway that retries on a non-2xx answer must treat this code as "already received". The same request again (same Idempotency-Key) is answered with the first answer.

## The monitor and the retry

`GET /doc-interop-messages` (`doc.interop.read`, over the whole tenant; `status`, `direction`, `cursor`, `limit`): the latest first, an allowlist of fields (never the envelope or its key), `actions.retry` true for a failed or dead
message. `POST /doc-interop-messages/{id}/retry` (`doc.interop.manage` over the whole tenant, If-Match, Idempotency-Key): a failed or dead message goes back to `QUEUED`; a **dead** one starts over with `attempts = 0` (the history is in the
audit row `doc_interop_message.retry`: status, attempts and code before), a failed one keeps its count so that twenty attempts remain the bound. Any other state is 409 `INTEROP_STATE_INVALID`, a stale version 409 `VERSION_CONFLICT`, another
tenant's message 404. The overview of the documents (DOC-01) counts `FAILED` and `DEAD` messages in the tile `interop_errors` for a reader over the whole tenant and gives a reader of a unit no figure (it was a constant 0 before).

## What the database holds (V1230)

`doc_interop_message.distribution_id` (foreign key to `document_distribution`, unique when set); checks for the shape of each direction (what leaves has a document, a distribution and a receiver; what arrives has a sender, an id, no distribution, no
attempts and no wait), the envelope digest as 64 lower-case hex digits, a failed message with its wait and its reason, a dead one with twenty attempts, a message that was handed over with its id, one that ended with the time it ended; the guard
`guard_doc_interop_message`: written as `QUEUED` or `RECEIVED`, never deleted or truncated (`machvon_app` also loses DELETE and TRUNCATE), direction, parties and envelope never change, the id of the gateway and the document are written once, only the
edges above, attempts are never counted back except for a dead message sent again, a message that ended is kept as it is. `incoming_document.interop_message_id` is written once.

## Screen

DOC-20 `/doc/doc-20`: the messages in a table (direction, external id with the way to the distribution or to the letter, parties by their codes, status, when the next attempt is, attempts out of 20, error code, adapter status and code,
updated), a filter by direction and status that stays in view when nothing matches, "load more" by cursor, a note while no listed adapter is verified, a note of how many messages are dead, and "Send again" for a message the server
says may be sent again to a holder of `doc.interop.manage` in a session that is not read-only (one at a time, an idempotency attempt for each intention, the version the person saw). A refusal is shown outside the rows.

## What is not here

- **No real LGSP.** `DOC_INTEROP_TRANSPORT` is bound to `UnconfiguredInteropTransport` (every call is 503 `PROVIDER_UNAVAILABLE`), so on a real tenant a message waits, fails with that reason and ends DEAD with its alert; it never claims to be sent. The
  HTTP client for the gateway (authentication, the call that hands a message over, the call that asks for the receipt, the timeout the port requires) is written when the specification exists. Whether a receipt is polled (as here) or pushed by the
  LGSP is open: a push needs a second operation that the design does not list.
- **No edXML.** The envelope of QCVN 102:2016 is XML with its own header and attachments; `JsonInteropCodec` (`machvon.lgsp.json/1`) is a stand-in so the whole path can be exercised. The upload pipeline refuses markup (`text/plain` that starts with `<`),
  so the real envelope will need its own intake or a purpose for it before `receiveInteropMessage` can take a real file.
- **No digital signature check of the received PDF.** The message is authenticated by the HMAC of the agency; the PDF inside is stored as received, as for a letter taken in by a clerk. Verifying its PAdES signatures (DOC-07) is not part of reception.
- **The signature scheme is ours.** The design says "xác thực chữ ký thông điệp" and names a key id; the message has no signature field in the list of the design, so `signature` (HMAC-SHA256 over the fields) is added to the request. A real LGSP signs
  with its own scheme (certificates), which replaces `verifyProviderCallback` here. Contract change recorded in `compat-allow.json` (REQUIRED_FIELD_ADDED).
- **The connector keys.** The keys are read from the vault reference of the connector through the environment-backed resolver of the platform (`MACHVON_SECRET_...`) until the vault exists.
- **A refused document has no resend.** A message the receiving agency refused is `REJECTED` and is not sent again; its distribution is `FAILED`. The clerk sends the document on another channel (a new distribution).
- **No workflow engine.** The retry state machine is a job, not Temporal; no activity is a separate step.
