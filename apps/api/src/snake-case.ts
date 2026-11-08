const SNAKE = /[A-Z]/g;
const KEY_WORD = /^[a-z][A-Za-z0-9]*$/;

/**
 * The keys of a read model of the kernel (camelCase) as the contract writes them (snake_case), deeply. Keys that are not words (a project id, a unit id used as a key) are kept as they are, so a map keyed by ids
 * survives; values are never touched.
 */
export function snakeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeKeys);
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[KEY_WORD.test(key) ? key.replace(SNAKE, (letter) => `_${letter.toLowerCase()}`) : key] = snakeKeys(inner);
  }
  return out;
}
