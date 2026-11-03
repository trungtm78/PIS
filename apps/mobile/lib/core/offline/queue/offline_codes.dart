/// The codes of the platform that the queue gives a meaning to (`error_codes.json`, MOB.md 7). Every other code is kept
/// as the server sent it and shown by its code and reference.
const String kPeriodLocked = 'PERIOD_LOCKED';
const String kLicenseExpired = 'LICENSE_EXPIRED';
const String kScopeDenied = 'SCOPE_DENIED';
const String kVersionConflict = 'VERSION_CONFLICT';
const String kDraftVersionConflict = 'DRAFT_VERSION_CONFLICT';
const String kIdempotencyConflict = 'IDEMPOTENCY_CONFLICT';
const String kFileTypeNotAllowed = 'FILE_TYPE_NOT_ALLOWED';
const String kChecksumMismatch = 'CHECKSUM_MISMATCH';
const String kFileInfected = 'FILE_INFECTED';

/// Codes made on the device, never sent by the server.
const String kInterrupted = 'INTERRUPTED';
const String kResultUnverifiable = 'RESULT_UNVERIFIABLE';
const String kFileTooLarge = 'FILE_TOO_LARGE';

/// What `POST /sync/batches` says of a command it did not settle and kept no receipt for ("what may go away is not
/// remembered", docs/mob-sync.md): the command is sent again under the same key, which the operation carries out once.
const Set<String> kTransientItemCodes = <String>{'INTERNAL_ERROR', 'RATE_LIMITED', 'SESSION_EXPIRED', 'UNAVAILABLE', 'IDEMPOTENCY_IN_PROGRESS'};

/// The batch itself failed, but the server says nothing was carried out and a later send is safe.
const Set<String> kBatchNotCarriedOut = <String>{'PROVIDER_UNAVAILABLE', 'RATE_LIMITED'};
