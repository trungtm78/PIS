/** Injection token of the `ContractorIdentityPort`: the official lookup of a tax id, or the unbound adapter (MISSING) until one exists. */
export const CONTRACTOR_IDENTITY_PORT = Symbol('CONTRACTOR_IDENTITY_PORT');
/** Injection token of the metrics sink of the procurement import; the no-op sink is used when none is bound. */
export const BID_METRICS = Symbol('BID_METRICS');
/** The field cipher of the management of contractors (VND-1): seals the number of a payee account and keys the identity of an owner blind. */
export const VENDOR_CIPHER = Symbol('VENDOR_CIPHER');
/** The scan hook of the files a contractor puts on the portal (PORTAL-2). The default adapter fails closed: nothing is accepted unless a scanner says CLEAN. */
export const PORTAL_UPLOAD_SCAN = Symbol('PORTAL_UPLOAD_SCAN');
