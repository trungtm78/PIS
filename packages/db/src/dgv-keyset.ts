import { DomainError } from '@machvon/kernel';

/** A page of a keyset: the time as the database wrote it (microseconds, never through a date of the language that keeps milliseconds) and the id. */
export function cursorOf(raw: string | undefined): { at: string; id: string } | undefined {
  if (raw === undefined) return undefined;
  const [at, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  if (at === undefined || id === undefined || Number.isNaN(Date.parse(at)) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
  return { at, id };
}

export const cursorFor = (at: string, id: string): string => Buffer.from(`${at}|${id}`, 'utf8').toString('base64url');
