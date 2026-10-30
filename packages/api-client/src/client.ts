import { OPERATIONS } from '@machvon/contracts';
import { defaultKeyGenerator, newCommandAttempt } from './idempotency.ts';
import { errorFromResponse, networkError, unusableAnswer } from './problem.ts';
import type { ApiError } from './problem.ts';
import type { CommandInput, CommandOperation, ItemsOf, ReadArguments, ReadOperation, SuccessBody, UploadInput, UploadOperation } from './operations.ts';
import { fillPath, queryString } from './operations.ts';

const IN_PROGRESS_CODE = 'IDEMPOTENCY_IN_PROGRESS';
const DEFAULT_RETRY_AFTER_SECONDS = 2;
const MAX_RETRY_AFTER_SECONDS = 10;
const MAX_IN_PROGRESS_RETRIES = 5;
const MAX_PAGES = 1000;

export interface ApiClientOptions {
  baseUrl: string;
  /** Called for every request, so an expired or refreshed token is never reused. */
  session: () => Promise<{ token: string } | undefined>;
  fetch?: typeof fetch;
  locale?: () => string;
  /** Headers every request carries besides its own (read again for each request); they never replace the ones the client sets itself. */
  headers?: () => Record<string, string>;
  /** Source of idempotency keys; defaults to random UUIDs. */
  newKey?: () => string;
  /** Source of correlation ids, which the server only accepts as UUIDs; defaults to random UUIDs. */
  newCorrelationId?: () => string;
  /** Waits the given milliseconds; injectable so tests do not wait. */
  delay?: (milliseconds: number) => Promise<void>;
}

export interface ApiClient {
  read<K extends ReadOperation>(operation: K, ...input: ReadArguments<K>): Promise<SuccessBody<K>>;
  /** Reads every page of a list operation, following `next_cursor`, and returns the items in order. */
  readAll<K extends ReadOperation>(operation: K, ...input: ReadArguments<K>): Promise<ItemsOf<SuccessBody<K>>>;
  command<K extends CommandOperation>(operation: K, input: CommandInput<K>): Promise<SuccessBody<K>>;
  /** Sends a prepared `multipart/form-data` form (see `uploadFile`) with the same headers, retries and errors as a command. */
  upload<K extends UploadOperation>(operation: K, input: UploadInput<K>): Promise<SuccessBody<K>>;
}

interface RequestParts {
  path?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  form?: FormData;
  ifMatchVersion?: number;
  idempotencyKey?: string;
}

// A wait that the server asked for (Retry-After); the caller can replace it, so it is not a sleep that hides a race.
function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function retryDelaySeconds(error: ApiError): number {
  return Math.min(error.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS, MAX_RETRY_AFTER_SECONDS);
}

/**
 * Creates the typed client over the generated operation table. Reads are plain GETs. Commands always send an
 * Idempotency-Key (one per attempt) and, for versioned operations, If-Match with the version the caller saw; an
 * answer of IDEMPOTENCY_IN_PROGRESS is retried with the same key, every other failure is reported as an ApiError.
 */
export function createApiClient(options: ApiClientOptions): ApiClient {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const newKey = options.newKey ?? defaultKeyGenerator;
  const newCorrelationId = options.newCorrelationId ?? defaultKeyGenerator;
  const delay = options.delay ?? defaultDelay;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  async function headersFor(parts: RequestParts, correlationId: string): Promise<Headers> {
    const headers = new Headers(options.headers?.());
    headers.set('accept', 'application/json, application/problem+json');
    headers.set('x-correlation-id', correlationId);
    const session = await options.session();
    if (session !== undefined) headers.set('authorization', `Bearer ${session.token}`);
    const locale = options.locale?.();
    if (locale !== undefined) headers.set('accept-language', locale);
    if (parts.idempotencyKey !== undefined) headers.set('idempotency-key', parts.idempotencyKey);
    if (parts.ifMatchVersion !== undefined) headers.set('if-match', `"${parts.ifMatchVersion}"`);
    // A form carries no content type of its own here: the runtime adds the multipart one with its boundary.
    if (parts.body !== undefined) headers.set('content-type', 'application/json');
    return headers;
  }

  async function execute(operation: string, parts: RequestParts): Promise<unknown> {
    const descriptor = OPERATIONS[operation as keyof typeof OPERATIONS];
    const url = `${baseUrl}${fillPath(descriptor.path, parts.path)}${queryString(parts.query)}`;
    const correlationId = newCorrelationId();
    const retriable = parts.idempotencyKey !== undefined;
    for (let retries = 0; ; retries += 1) {
      // A failing session is not a network failure: its error reaches the caller untouched.
      const headers = await headersFor(parts, correlationId);
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: descriptor.method.toUpperCase(),
          headers,
          body: parts.form ?? (parts.body === undefined ? undefined : JSON.stringify(parts.body)),
        });
      } catch {
        throw networkError(correlationId);
      }
      if (response.ok) {
        if (response.status === 204) return undefined;
        try {
          return (await response.json()) as unknown;
        } catch {
          throw unusableAnswer(response.status, correlationId);
        }
      }
      const error = await errorFromResponse(response, correlationId);
      if (retriable && error.code === IN_PROGRESS_CODE && retries < MAX_IN_PROGRESS_RETRIES) {
        await delay(retryDelaySeconds(error) * 1000);
        continue;
      }
      throw error;
    }
  }

  async function read(operation: string, input: RequestParts = {}): Promise<unknown> {
    return execute(operation, { path: input.path, query: input.query });
  }

  return {
    read: ((operation: ReadOperation, input?: RequestParts) => read(operation, input)) as ApiClient['read'],

    readAll: (async (operation: ReadOperation, input: RequestParts = {}) => {
      const items: unknown[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const query = cursor === undefined ? input.query : { ...input.query, cursor };
        const answer = (await read(operation, { path: input.path, query })) as { items?: unknown[]; next_cursor?: string | null };
        items.push(...(answer.items ?? []));
        const next = answer.next_cursor;
        if (next === undefined || next === null) return items;
        if (seen.has(next)) throw unusableAnswer(200, 'pagination-cursor-repeated');
        seen.add(next);
        cursor = next;
      }
      throw unusableAnswer(200, 'pagination-limit');
    }) as ApiClient['readAll'],

    command: ((operation: CommandOperation, input: RequestParts & { attempt?: { key: string } }) =>
      execute(operation, {
        path: input.path,
        body: input.body,
        ifMatchVersion: input.ifMatchVersion,
        idempotencyKey: (input.attempt ?? newCommandAttempt(newKey)).key,
      })) as ApiClient['command'],

    upload: ((operation: UploadOperation, input: RequestParts & { attempt?: { key: string } }) =>
      execute(operation, { path: input.path, form: input.form, idempotencyKey: (input.attempt ?? newCommandAttempt(newKey)).key })) as ApiClient['upload'],
  };
}
