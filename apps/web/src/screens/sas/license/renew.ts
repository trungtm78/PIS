import type { CommandInput } from '@machvon/api-client';
import type { License } from './types';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** What the person types to renew a license (SAS-14): the new end and grace period, optionally other seats. The edition, the quota and the binding are those of the revision it replaces. */
export interface RenewValues {
  valid_until: string;
  grace_until: string;
  seats: string;
}

export const EMPTY_RENEW_VALUES: RenewValues = { valid_until: '', grace_until: '', seats: '' };

export type RenewField = keyof RenewValues;

/** Why a field is refused before anything is sent; the screen turns each reason into its own words. */
export type RenewProblem = 'required' | 'date' | 'notLater' | 'past' | 'grace' | 'seats';

export type RenewErrors = Partial<Record<RenewField, RenewProblem>>;

const isDate = (value: string): boolean => DATE_PATTERN.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().startsWith(value);
const instant = (value: string): number => Date.parse(`${value}T00:00:00.000Z`);

/**
 * The rules of the renewal, applied before the command is sent (the server judges them again, BR-SAS-11): the new end is a real day later than the end of the revision it replaces and
 * later than now, the grace period does not end before the term, and the seats, when given, are a whole number of at least one.
 */
export function validateRenewForm(values: RenewValues, current: License, now: Date): RenewErrors {
  const errors: RenewErrors = {};
  for (const field of ['valid_until', 'grace_until'] as const) {
    if (values[field] === '') errors[field] = 'required';
    else if (!isDate(values[field])) errors[field] = 'date';
  }
  if (errors.valid_until === undefined) {
    if (instant(values.valid_until) <= Date.parse(current.validUntil)) errors.valid_until = 'notLater';
    else if (instant(values.valid_until) <= now.getTime()) errors.valid_until = 'past';
  }
  if (errors.valid_until === undefined && errors.grace_until === undefined && instant(values.grace_until) < instant(values.valid_until)) errors.grace_until = 'grace';
  if (values.seats.trim() !== '' && !/^[1-9]\d*$/.test(values.seats.trim())) errors.seats = 'seats';
  return errors;
}

export type LicenseRenewBody = NonNullable<CommandInput<'renewLicense'>['body']>;

/** The request body: the days at the start of the day in UTC, the seats only when typed. */
export function renewBody(values: RenewValues, reason: string): LicenseRenewBody {
  const body: LicenseRenewBody = { valid_until: `${values.valid_until}T00:00:00.000Z`, grace_until: `${values.grace_until}T00:00:00.000Z`, reason: reason.trim() };
  if (values.seats.trim() !== '') body.seats = Number(values.seats.trim());
  return body;
}

/** Whether the revision can be renewed by this person: a live one (not started, active or in grace), by someone who manages licenses. */
export function licenseRenewable(status: string, canManage: boolean): boolean {
  return canManage && (status === 'Scheduled' || status === 'Active' || status === 'Grace');
}

/** When the renewed revision starts: the earlier of the moment of the renewal and the end of the revision it replaces, so the term has no gap. */
export function renewalStart(current: License, now: Date): string {
  const end = Date.parse(current.validUntil);
  return new Date(Math.min(now.getTime(), Number.isNaN(end) ? now.getTime() : end)).toISOString();
}

/** The revisions of one license in the order of the chain, the first revision first, with the one that is current marked. */
export function chainOf(licenses: readonly License[]): Array<{ license: License; current: boolean }> {
  const sorted = [...licenses].sort((a, b) => a.serial.localeCompare(b.serial) || a.revision - b.revision);
  return sorted.map((license) => ({ license, current: license.status !== 'Superseded' && license.status !== 'Revoked' && license.status !== 'Expired' && license.status !== 'Draft' }));
}
