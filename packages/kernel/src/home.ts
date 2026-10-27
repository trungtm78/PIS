import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { DomainError } from './errors.ts';
import type { RateFigures } from './dis-rates.ts';
import { activeGrants } from './effective-access.ts';
import type { EffectiveAccess } from './effective-access.ts';
import { permissionMatches } from './permission.ts';

/**
 * The command center of the leader (ST-HOME-001, HOME 3 F1, BR-HOME-01): every figure is given with the scope it was counted for, the day it is as of, the snapshot it comes from, its unit and its formula, or it is
 * not given. HOME owns no figure of its own: the tiles are made of the sums of a frozen DIS snapshot, with the same code as DIS-19, so that the two screens cannot disagree.
 */
export const HOME_CONTEXT_TTL_SECONDS = 1800;
/** A snapshot older than this many days is stale: the screen says so and does not hide the figures. */
export const HOME_STALE_DAYS = 8;
const MIN_KEY_BYTES = 32;
/** What a token of this kind is for; the key that signs it also signs the contexts of background work, and the two never pass for each other. */
const PURPOSE = 'home-context:';

export type HomeTileUnit = 'PERCENT' | 'VND';

export interface HomeTile {
  metricCode: string;
  /** The figure as a decimal text (a percent with four decimals, whole dong), null when it cannot be given. */
  value: string | null;
  numerator: string | null;
  denominator: string | null;
  /** Why there is no figure; null when there is one. */
  nullReason: string | null;
  unit: HomeTileUnit;
  formula: string;
  definitionStatus: string;
}

const RATE_PM_FORMULA = 'disbursed_treasury_vnd / plan_pm_assigned_vnd * 100';
const RATE_TOTAL_FORMULA = 'disbursed_treasury_vnd / (plan_pm_assigned_vnd + plan_local_added_vnd) * 100';

/**
 * The tiles of a scope over a snapshot, from the figures of `rateOfSums`: the two rates side by side over the same numerator, the amount the Treasury paid, and the two plans. A figure that cannot be given is null with
 * its reason and is never shown as 0: the Treasury that booked nothing gives no disbursed amount (NO_DATA) and no rate.
 */
export function homeTiles(figures: RateFigures, definitionStatus: string): HomeTile[] {
  const noData = figures.numeratorVnd === null;
  const rate = (metricCode: string, value: string | null, denominator: string, formula: string): HomeTile => ({
    metricCode,
    value,
    numerator: figures.numeratorVnd,
    denominator,
    nullReason: value === null ? (figures.rateNullReason ?? 'NO_DATA') : null,
    unit: 'PERCENT',
    formula,
    definitionStatus,
  });
  const amount = (metricCode: string, value: string | null, formula: string): HomeTile => ({ metricCode, value, numerator: null, denominator: null, nullReason: value === null ? 'NO_DATA' : null, unit: 'VND', formula, definitionStatus });
  return [
    rate('DISBURSEMENT_RATE_PM', figures.ratePmPct, figures.planPmVnd, RATE_PM_FORMULA),
    rate('DISBURSEMENT_RATE_TOTAL', figures.rateTotalPct, figures.planTotalVnd, RATE_TOTAL_FORMULA),
    amount('DISBURSED_TREASURY', noData ? null : figures.numeratorVnd, 'sum(disbursed_treasury_vnd) up to the Treasury cutoff'),
    amount('PLAN_PM_ASSIGNED', figures.planPmVnd, 'sum(plan_pm_assigned_vnd)'),
    amount('PLAN_TOTAL', figures.planTotalVnd, 'sum(plan_pm_assigned_vnd + plan_local_added_vnd)'),
  ];
}

export type HomeSnapshotState = 'EMPTY' | 'FRESH' | 'STALE';

/** Where the snapshot stands against today (both days of the Vietnam calendar): none, within eight days, or older. */
export function homeSnapshotState(asOfDate: string | null, today: string): HomeSnapshotState {
  if (asOfDate === null) return 'EMPTY';
  const days = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${asOfDate}T00:00:00Z`)) / 86_400_000);
  return days > HOME_STALE_DAYS ? 'STALE' : 'FRESH';
}

/**
 * What the grants that carry a permission let a person read right now: the kind and the places of each grant that counts at this moment, sorted. A grant that expires or begins to count changes the reading of the
 * database without changing the version of the grants, so the fingerprint is of what is effective, not of a version.
 */
export function homeScopeFingerprint(access: EffectiveAccess, permission: string, now: Date): string {
  const parts = activeGrants(access, now)
    .filter((grant) => grant.permissions.some((held) => permissionMatches(held, permission)))
    .map((grant) => (grant.scope.kind === 'TENANT' ? 'TENANT::' : `${grant.scope.kind}:${[...grant.scope.refIds].sort().join(',')}:${[...(grant.scope.paths ?? [])].sort().join(',')}`));
  return [...new Set(parts)].sort().join(';');
}

/** The scope a person reads in, as a hash: the member, the version of their grants, what those grants let them read now, and the unit they narrowed to. A token carries it, so that another scope cannot use it. */
export function homeScopeHash(input: { membershipId: string; scopeVersion: number; unitId: string | null; grants: string }): string {
  return createHash('sha256').update(`${input.membershipId}|${input.scopeVersion}|${input.grants}|${input.unitId ?? ''}`).digest('hex');
}

export interface HomeContext {
  tenantId: string;
  snapshotId: string;
  scopeHash: string;
  metricCode: string;
  unitId: string | null;
}

export interface SignedHomeContext extends HomeContext {
  exp: number;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const invalid = (): DomainError => new DomainError('INVALID_REQUEST', 400);

function assertKey(key: Buffer): void {
  if (key.length < MIN_KEY_BYTES) throw new Error('key too short');
}

const mac = (payloadPart: string, key: Buffer): Buffer => createHmac('sha256', key).update(PURPOSE).update(payloadPart).digest();

/** The token of a tile: `base64url(payload).base64url(hmac)`, good for 30 minutes. The drill (HOME-10) takes it back and judges the scope again. */
export function signHomeContext(context: HomeContext, key: Buffer, now: () => number = nowSeconds): string {
  assertKey(key);
  const payload: SignedHomeContext = { tenantId: context.tenantId, snapshotId: context.snapshotId, scopeHash: context.scopeHash, metricCode: context.metricCode, unitId: context.unitId, exp: now() + HOME_CONTEXT_TTL_SECONDS };
  const payloadPart = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${payloadPart}.${mac(payloadPart, key).toString('base64url')}`;
}

const text = (value: unknown): value is string => typeof value === 'string' && value !== '';

/**
 * Reads a token back. A token that was altered, signed with another key, made for another purpose or is not one is a 400 INVALID_REQUEST that says nothing of why; one that is good but old is a 409
 * SNAPSHOT_EXPIRED, which the screen answers by asking for a new token of the same snapshot (AC-ST-HOME-002-4).
 */
export function verifyHomeContext(token: string, key: Buffer, now: () => number = nowSeconds): SignedHomeContext {
  assertKey(key);
  const parts = token.split('.');
  const payloadPart = parts[0];
  const signaturePart = parts[1];
  if (parts.length !== 2 || !payloadPart || !signaturePart) throw invalid();
  const expected = mac(payloadPart, key);
  const actual = Buffer.from(signaturePart, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalid();
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  const record = payload as Record<string, unknown> | null;
  if (typeof record !== 'object' || record === null || !text(record.tenantId) || !text(record.snapshotId) || !text(record.scopeHash) || !text(record.metricCode) || typeof record.exp !== 'number') throw invalid();
  if (record.unitId !== null && !text(record.unitId)) throw invalid();
  if (record.exp <= now()) throw new DomainError('SNAPSHOT_EXPIRED', 409);
  return { tenantId: record.tenantId, snapshotId: record.snapshotId, scopeHash: record.scopeHash, metricCode: record.metricCode, unitId: (record.unitId as string | null) ?? null, exp: record.exp };
}
