import { DomainError } from '@machvon/kernel';

const MAX_TEXT = 200;

/** A short text of a query parameter: absent stays absent, empty or long or holding a NUL is 422 naming the parameter. */
export function textOf(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '' || value.length > MAX_TEXT || value.includes('\0')) throw new DomainError('VALIDATION_FAILED', 422, name);
  return value;
}
