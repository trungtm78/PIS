import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';

/**
 * The journal of a UAT run (scripts/uat-run.mjs): one JSON line for each request the tests make to the API, with the id the request
 * carries, so that a result of the run can name the requests that were made for it. It is off unless `UAT_JOURNAL` names a file.
 * The lines hold the method, the path (never the query, a header or a body), the status and the times; never a secret.
 */
export interface JournalLine {
  kind: 'request';
  id: string;
  pid: number;
  /** The test that made the request, as Jest names it (`describe test`), and its file; empty when the request is not made by a test. */
  test: string;
  file: string;
  method: string;
  path: string;
  status: number;
  at: string;
  durationMs: number;
}

const append = (file: string, line: JournalLine): void => appendFileSync(file, `${JSON.stringify(line)}\n`);

interface JestState {
  currentTestName?: string;
  testPath?: string;
}

const stateOfJest = (): JestState => (globalThis as { expect?: { getState?: () => JestState } }).expect?.getState?.() ?? {};

const isLocal = (url: URL): boolean => url.hostname === '127.0.0.1' || url.hostname === 'localhost';

/**
 * Wraps the global `fetch` of a Jest test file: a request to the local API gets an `x-correlation-id` (the id by which the audit trail and the
 * outbox of the API record the request) when it carries neither that header nor a `traceparent` (the correlation id outranks the trace of the caller,
 * so a request that names its trace is left as it is and is known by the id of that trace), and a line is written when the answer comes.
 */
export function journalFetch(file: string | undefined = process.env.UAT_JOURNAL): void {
  if (file === undefined || file === '') return;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    if (typeof input !== 'string' && !(input instanceof URL)) return original(input, init);
    const url = new URL(input);
    if (!isLocal(url)) return original(input, init);
    const headers = new Headers(init?.headers);
    const trace = /^[0-9a-f]{2}-([0-9a-f]{32})-/.exec(headers.get('traceparent') ?? '')?.[1];
    const id = headers.get('x-correlation-id') ?? trace ?? randomUUID();
    if (trace === undefined) headers.set('x-correlation-id', id);
    const started = Date.now();
    const response = await original(input, { ...init, headers });
    const state = stateOfJest();
    append(file, {
      kind: 'request',
      id: response.headers.get('x-request-id') ?? id,
      pid: process.pid,
      test: state.currentTestName ?? '',
      file: state.testPath ?? '',
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      status: response.status,
      at: new Date(started).toISOString(),
      durationMs: Date.now() - started,
    });
    return response;
  }) as typeof fetch;
}

interface HttpRequest {
  method?: string;
  path?: string;
}

interface HttpResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  on(event: 'finish', listener: () => void): unknown;
}

/**
 * Express middleware for the API stack the browser tests run against: gives each request an `x-request-id` and writes its line when the answer
 * is done. The browser tests are matched to the lines by the time of the test (scripts/uat-run.mjs).
 */
export function requestJournal(file: string) {
  return (request: HttpRequest, response: HttpResponse, next: () => void): void => {
    const id = randomUUID();
    const started = Date.now();
    response.setHeader('x-request-id', id);
    response.on('finish', () => {
      append(file, {
        kind: 'request',
        id,
        pid: process.pid,
        test: '',
        file: '',
        method: request.method ?? 'GET',
        path: request.path ?? '',
        status: response.statusCode,
        at: new Date(started).toISOString(),
        durationMs: Date.now() - started,
      });
    });
    next();
  };
}
