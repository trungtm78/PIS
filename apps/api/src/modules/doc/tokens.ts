/** Injection token of the fonts and fixed texts that the renderer draws with. */
export const DOC_RESOURCES = Symbol('DOC_RESOURCES');
/** Injection token of the `PdfRenderer` port (the `pdf-lib` adapter in production). */
export const PDF_RENDERER = Symbol('PDF_RENDERER');
/** Injection token of the fixed words of a state document (`state-text.json`). */
export const DOC_STATE_TEXT = Symbol('DOC_STATE_TEXT');
/** Injection token of the metrics sink of the document module; the no-op sink is used when none is bound. */
export const DOC_METRICS = Symbol('DOC_METRICS');
/** Injection token of the clock of the document module; the system clock is used when none is bound. */
export const DOC_CLOCK = Symbol('DOC_CLOCK');

/** How long a download URL lives (BR-DOC-19: at most 300 seconds). */
export const DOWNLOAD_URL_TTL_SECONDS = 300;

/** Injection token of the `TrustStoreProvider`: the trust anchors a tenant verifies signatures against. */
export const DOC_TRUST_STORE = Symbol('DOC_TRUST_STORE');
/** Injection token of the `RevocationPort` (OCSP and CRL adapters); the "cannot tell" port is bound until one exists. */
export const DOC_REVOCATION = Symbol('DOC_REVOCATION');

/** Injection token of the `SigningPort`: the certification authority adapter, or the MOCK adapter until one exists. */
export const DOC_SIGNING_PORT = Symbol('DOC_SIGNING_PORT');

/** Injection token of the `EmailChannelPort` of the distribution; the adapter that says "no provider" is bound until a mail transport exists. */
export const DOC_EMAIL_CHANNEL = Symbol('DOC_EMAIL_CHANNEL');

/** Injection token of the `InteropTransportPort`: the gateway of the LGSP, or the adapter that says "no provider" until the specification of the pilot tenant exists [CXN-06]. */
export const DOC_INTEROP_TRANSPORT = Symbol('DOC_INTEROP_TRANSPORT');
/** Injection token of the `InteropCodec`: the format of the envelope of the LGSP. */
export const DOC_INTEROP_CODEC = Symbol('DOC_INTEROP_CODEC');
