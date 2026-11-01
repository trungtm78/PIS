import type { SessionAssurance } from '../SessionContext';

const MFA_ACR: ReadonlySet<string> = new Set(['aal2', '2']);
// RFC 8176 authentication method references grouped by the kind of factor they prove.
const FACTOR_KIND: Readonly<Record<string, 'knowledge' | 'possession' | 'inherence'>> = {
  pwd: 'knowledge',
  pin: 'knowledge',
  kba: 'knowledge',
  otp: 'possession',
  hwk: 'possession',
  swk: 'possession',
  sms: 'possession',
  tel: 'possession',
  fido: 'possession',
  webauthn: 'possession',
  bio: 'inherence',
  fpt: 'inherence',
  face: 'inherence',
  iris: 'inherence',
  retina: 'inherence',
  vbm: 'inherence',
};

/** An explicit `mfa` reference, or at least two different kinds of factor (never two factors of one kind). */
function usedSecondFactor(amr: unknown): boolean {
  if (!Array.isArray(amr)) return false;
  const methods = amr.filter((method): method is string => typeof method === 'string');
  if (methods.includes('mfa')) return true;
  return new Set(methods.map((method) => FACTOR_KIND[method]).filter((kind) => kind !== undefined)).size >= 2;
}

/**
 * How strongly the identity provider says the person authenticated, from the claims of the ID token it issued (`acr`, `amr` and `auth_time` of OpenID Connect Core): `aal2` when `acr` says so or `amr` proves two
 * independent kinds of factor, and only when the time of authentication is known (the step-up window runs from it); otherwise `aal1`. It is the rule the API applies to the same claims (auth/jwt.ts, `assuranceOf`),
 * which is what decides a command that asks for the second factor; this only tells the person whether to be asked.
 */
export function assuranceOfClaims(claims: Record<string, unknown> | undefined): SessionAssurance {
  const authTime = claims?.auth_time;
  const second = (typeof claims?.acr === 'string' && MFA_ACR.has(claims.acr)) || usedSecondFactor(claims?.amr);
  return second && typeof authTime === 'number' && Number.isFinite(authTime) && authTime > 0 ? { level: 'aal2', aal2At: new Date(authTime * 1000) } : { level: 'aal1' };
}
