import { DomainError } from '@machvon/kernel';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT = 100;

/** A calendar date as the contract writes it; anything else, or a date that does not exist, is 422 naming the parameter. */
export function dateOf(value: unknown, name: string): string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new DomainError('VALIDATION_FAILED', 422, name);
  }
  return value;
}

/** A short text of a query parameter: absent stays absent, empty or long or holding a NUL is 422 naming the parameter. */
export function textOf(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '' || value.length > MAX_TEXT || value.includes('\0')) throw new DomainError('VALIDATION_FAILED', 422, name);
  return value;
}
