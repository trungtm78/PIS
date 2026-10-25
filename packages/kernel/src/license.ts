import { createPublicKey, verify } from 'node:crypto';
import { canonicalJson } from './canonical-json.ts';
import type { LicenseMode } from './entitlement.ts';

/** The state of a license that follows from the clock alone (SAS 3.8): the window is `[valid_from, valid_until)`, then the grace period. */
export type LicenseTimeStatus = 'Scheduled' | 'Active' | 'Grace' | 'Expired' | 'Revoked';

/** What the state of a license depends on: its window and the status the database stores. */
export interface LicenseRevisionState {
  validFrom: Date;
  validUntil: Date;
  graceUntil: Date;
  /** The stored status: only `Revoked` and `Suspended` are decisions of a person, every other value follows the clock. */
  status?: string;
}

/**
 * The state of a license at `now`, by the clock of the server: `Scheduled` before `valid_from`, `Active` from
 * `valid_from` up to but not including `valid_until`, `Grace` from `valid_until` up to `grace_until` (when there is any
 * grace), `Expired` from then on. A revoked license is `Revoked` whatever the clock says, and stays so (BR-SAS-12).
 */
export function licenseStatusAt(revision: LicenseRevisionState, now: Date): LicenseTimeStatus {
  if (revision.status === 'Revoked') return 'Revoked';
  const at = now.getTime();
  if (at < revision.validFrom.getTime()) return 'Scheduled';
  if (at < revision.validUntil.getTime()) return 'Active';
  return at < revision.graceUntil.getTime() ? 'Grace' : 'Expired';
}

/**
 * The mode `allowedFeature` judges (BR-SAS-10). A license that has not started is no license in force yet, so it is
 * judged like an expired one; a suspended license denies whatever its window says, a revoked one denies for good.
 */
export function licenseModeAt(revision: LicenseRevisionState, now: Date): LicenseMode {
  const status = licenseStatusAt(revision, now);
  if (status === 'Revoked') return 'REVOKED';
  if (revision.status === 'Suspended') return 'SUSPENDED';
  switch (status) {
    case 'Active':
      return 'FULL';
    case 'Grace':
      return 'GRACE';
    case 'Scheduled':
    case 'Expired':
      return 'EXPIRED';
  }
}

/** The claims a license signs (SAS 3.8). Dates are ISO 8601 strings in UTC; the private key is never part of them. */
export interface LicenseClaims {
  iss: string;
  tenant_id: string;
  license_id: string;
  serial: string;
  revision: number;
  edition: string;
  valid_from: string;
  valid_until: string;
  grace_until: string;
  entitlements_hash: string;
  seats: number | null;
  quota: Record<string, unknown>;
  deployment_binding?: string;
  offline_lease_until?: string;
  kid: string;
}

/** A signing key that can only be asked to sign: the private key stays in its KMS, an HSM or the environment (never exported). */
export interface LicenseSigner {
  keyId: string;
  sign(payload: Uint8Array): Promise<Uint8Array>;
}

const ALGORITHM = 'EdDSA';
const encode = (value: string | Uint8Array): string => Buffer.from(value).toString('base64url');

/** `base64url(header).base64url(canonical claims).base64url(signature)`: a compact JWS with `alg` EdDSA and the key id in `kid`. */
export async function signLicenseClaims(claims: LicenseClaims, signer: LicenseSigner): Promise<string> {
  const header = encode(JSON.stringify({ alg: ALGORITHM, kid: signer.keyId, typ: 'JWT' }));
  const signingInput = `${header}.${encode(canonicalJson({ ...claims, kid: signer.keyId }))}`;
  return `${signingInput}.${encode(await signer.sign(Buffer.from(signingInput, 'ascii')))}`;
}

export type LicenseVerification =
  | { valid: true; claims: LicenseClaims }
  | { valid: false; reason: LicenseRejection };

export type LicenseRejection = 'MALFORMED' | 'UNKNOWN_KEY' | 'BAD_SIGNATURE' | 'TENANT_MISMATCH';

const fail = (reason: LicenseRejection): LicenseVerification => ({ valid: false, reason });

function parseJson(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Checks a signed license against the public keys it may have been signed with (`kid` to SPKI DER bytes; a retiring key
 * stays in the map until its `not_after`). Only EdDSA is accepted, so a header that asks for `none` or another algorithm is
 * malformed, and the `kid` of the claims must be the one of the header: a token signed by one key cannot pass as another's.
 * With `tenantId`, a license that was signed for another tenant is refused (`TENANT_MISMATCH`, 422 LICENSE_TENANT_MISMATCH): the
 * license of tenant A is no license of tenant B.
 */
export function verifyLicenseToken(token: string, publicKeys: ReadonlyMap<string, Uint8Array>, tenantId?: string): LicenseVerification {
  const parts = token.split('.');
  const [headerPart, claimsPart, signaturePart] = parts;
  if (parts.length !== 3 || headerPart === undefined || claimsPart === undefined || signaturePart === undefined) return fail('MALFORMED');
  const header = parseJson(headerPart) as { alg?: unknown; kid?: unknown } | undefined;
  const claims = parseJson(claimsPart) as LicenseClaims | undefined;
  if (typeof header !== 'object' || header === null || header.alg !== ALGORITHM || typeof header.kid !== 'string') return fail('MALFORMED');
  if (typeof claims !== 'object' || claims === null || claims.kid !== header.kid) return fail('MALFORMED');
  const keyBytes = publicKeys.get(header.kid);
  if (keyBytes === undefined) return fail('UNKNOWN_KEY');
  try {
    const key = createPublicKey({ key: Buffer.from(keyBytes), format: 'der', type: 'spki' });
    const signed = verify(null, Buffer.from(`${headerPart}.${claimsPart}`, 'ascii'), key, Buffer.from(signaturePart, 'base64url'));
    if (!signed) return fail('BAD_SIGNATURE');
    return tenantId !== undefined && claims.tenant_id !== tenantId ? fail('TENANT_MISMATCH') : { valid: true, claims };
  } catch {
    // A key that is not an Ed25519 public key can verify nothing.
    return fail('BAD_SIGNATURE');
  }
}

export interface RenewalWindow {
  validFrom: Date;
  validUntil: Date;
  graceUntil: Date;
}

export type RenewalVerdict = { ok: true; window: RenewalWindow } | { ok: false; field: 'valid_until' | 'grace_until' };

/**
 * The window of the revision that renews a license (ST-SAS-014, SAS 3.4): the renewed revision starts at the earlier of the moment of the renewal and the end of the revision it
 * replaces, so the term is seamless whether the renewal comes before the end (the new revision takes over at once) or after it, in the grace period (it covers the days since the
 * end). It must end later than the revision it replaces and than now, and its grace period cannot end before it does.
 */
export function renewalWindow(current: { validUntil: Date }, request: { validUntil: Date; graceUntil: Date }, now: Date): RenewalVerdict {
  const currentEnd = current.validUntil.getTime();
  if (request.validUntil.getTime() <= currentEnd || request.validUntil.getTime() <= now.getTime()) return { ok: false, field: 'valid_until' };
  if (request.graceUntil.getTime() < request.validUntil.getTime()) return { ok: false, field: 'grace_until' };
  return { ok: true, window: { validFrom: new Date(Math.min(now.getTime(), currentEnd)), validUntil: request.validUntil, graceUntil: request.graceUntil } };
}
