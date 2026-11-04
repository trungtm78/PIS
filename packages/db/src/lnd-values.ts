import { DomainError, hasControlChar } from '@machvon/kernel';

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** The integer digits of the columns: numeric(14,2) areas hold 12, numeric(8,2) kilometres hold 6. */
export const AREA_INTEGER_DIGITS = 12;
export const KILOMETRE_INTEGER_DIGITS = 6;
export const MAX_CODE = 50;
export const MAX_NAME = 300;
export const MAX_ADDRESS = 500;
/** The most a boundary may weigh: an outline of a parcel is a few hundred points, not a map. */
const MAX_BOUNDARY_BYTES = 200_000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A text as it is stored: trimmed, within its length, without control characters. */
export function textOf(value: string, field: string, min: number, max: number): string {
  const text = value.trim();
  if (text.length < min || text.length > max || hasControlChar(text)) throw invalid(field);
  return text;
}

/**
 * An exact decimal with at most two fraction digits and `integerDigits` integer digits, returned with exactly two fraction digits
 * (`30000` and `30000.5` are `30000.00` and `30000.50`). A figure wider than its column is a 422, never a database overflow.
 */
export function fixedTwo(value: string, integerDigits: number, field: string): string {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value.trim());
  const whole = match?.[1];
  if (match === null || whole === undefined || whole.length > integerDigits) throw invalid(field);
  return `${whole}.${(match[2] ?? '').padEnd(2, '0')}`;
}

/** A calendar date as `YYYY-MM-DD`; a day that does not exist is refused. */
export function dateOf(value: string, field: string): string {
  if (!ISO_DATE.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw invalid(field);
  return value;
}

/** The lower-case text of an identifier: the database writes uuids so, and an audit row or an event is matched against it as a string. */
export const lowerId = (value: string): string => value.toLowerCase();

/**
 * The outline of a parcel as GeoJSON geometry and nothing else (LND section 1: a parcel carries no information about who uses it). Only a Polygon or
 * a MultiPolygon with its coordinates is taken; a member such as `properties`, `name` or `owner` is where a person would be written, so any
 * other member makes the outline unreadable.
 */
export function boundaryOf(value: unknown, field: string): { type: string; coordinates: unknown } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid(field);
  const keys = Object.keys(value);
  const geometry = value as { type?: unknown; coordinates?: unknown };
  const typed = geometry.type === 'Polygon' || geometry.type === 'MultiPolygon';
  if (!typed || !Array.isArray(geometry.coordinates) || keys.length !== 2 || !keys.includes('type') || !keys.includes('coordinates')) throw invalid(field);
  if (JSON.stringify(geometry.coordinates).length > MAX_BOUNDARY_BYTES) throw invalid(field);
  return { type: geometry.type as string, coordinates: geometry.coordinates };
}
