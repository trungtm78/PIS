/** Helpers to read what the API replies with and what the tables hold as the JSON it is, without `any`. */

/** A JSON object whose members are checked by what a test expects of them. */
export type JsonObject = Record<string, unknown>;

/** The value as a JSON object; anything else (an array, a scalar, null) is a failure of the test. */
export function asObject(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`expected a JSON object, got ${JSON.stringify(value)}`);
  return value as JsonObject;
}

/** The value as a list of anything; anything else is a failure of the test. */
export function asList(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error(`expected a JSON array, got ${JSON.stringify(value)}`);
  return value;
}

/** The value as a list of JSON objects; anything else is a failure of the test. */
export function asObjects(value: unknown): JsonObject[] {
  return asList(value).map(asObject);
}

/** The value as a string; anything else is a failure of the test. */
export function asString(value: unknown): string {
  if (typeof value !== 'string') throw new Error(`expected a string, got ${JSON.stringify(value)}`);
  return value;
}

/** The value as a number; anything else is a failure of the test. */
export function asNumber(value: unknown): number {
  if (typeof value !== 'number') throw new Error(`expected a number, got ${JSON.stringify(value)}`);
  return value;
}
