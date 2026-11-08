import { DomainError, asUuid } from '@machvon/kernel';

/** The cursor of a page of the assistant's lists: the time of the row to the microsecond and its id, as the stores give them. */
export const cursorOf = (key: string, id: string): string => Buffer.from(`${key}|${id}`).toString('base64url');

export function parseCursor(raw: unknown): { key: string; id: string } | undefined {
  if (raw === undefined) return undefined;
  const text = Buffer.from(String(raw), 'base64url').toString('utf8');
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6})\|([0-9a-f-]{36})$/.exec(text);
  if (match === null) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
  const key = match[1] as string;
  // The time must be a real moment and the id a real uuid: what the database would not cast is refused here, not answered with a failure of the server.
  const moment = new Date(`${key.slice(0, 23)}Z`);
  const id = asUuid(match[2] as string);
  if (Number.isNaN(moment.getTime()) || moment.toISOString().slice(0, 23) !== key.slice(0, 23) || id === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
  return { key, id };
}

export function limitOf(raw: unknown): number {
  if (raw === undefined) return 50;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 200) throw new DomainError('VALIDATION_FAILED', 422, 'limit');
  return value;
}

export function oneOf(raw: unknown, allowed: readonly string[], field: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !allowed.includes(raw)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return raw;
}

/** A uuid in a query or a body, in lower case; anything else is a 422 naming the field. */
export function idOf(raw: unknown, field: string): string {
  const id = typeof raw === 'string' ? asUuid(raw) : undefined;
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id.toLowerCase();
}
