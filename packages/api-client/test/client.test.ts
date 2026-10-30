import { ApiError, createApiClient, newCommandAttempt } from '../src/index';
import type { ApiClientOptions } from '../src/index';
import { COMMAND_RESULT, json, problem, scriptedFetch } from './support';
import type { Scripted } from './support';

const UNIT = '00000000-0000-4000-8000-0000000000b1';
const MOVE_BODY = { new_parent_id: '00000000-0000-4000-8000-0000000000b2', effective_from: '2026-10-23', reason: 'reorganisation of the board' };
const CREATE_BODY = { code: 'A-NEW', name: 'New unit', parent_id: UNIT, unit_type: 'DEPARTMENT', valid_from: '2026-10-23' } as const;

function setup(script: Scripted[], overrides: Partial<ApiClientOptions> = {}) {
  const { fetch, calls } = scriptedFetch(script);
  const waits: number[] = [];
  let counter = 0;
  const client = createApiClient({
    baseUrl: 'https://api.example.test/',
    session: () => Promise.resolve({ token: 'token-1' }),
    fetch,
    locale: () => 'vi',
    newKey: () => `key-${(counter += 1)}-0123456789`,
    newCorrelationId: () => '00000000-0000-4000-8000-0000000000d0',
    delay: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    ...overrides,
  });
  return { client, calls, waits };
}

async function failureOf(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

describe('command', () => {
  it('sends an unversioned command with the idempotency, auth, language and correlation headers', async () => {
    const { client, calls } = setup([json(201, COMMAND_RESULT)]);
    const result = await client.command('createOrganizationUnit', { body: CREATE_BODY });
    expect(result).toEqual(COMMAND_RESULT);
    const call = calls[0];
    expect(call?.url).toBe('https://api.example.test/org-units');
    expect(call?.method).toBe('POST');
    expect(call?.headers.get('idempotency-key')).toBe('key-1-0123456789');
    expect(call?.headers.get('authorization')).toBe('Bearer token-1');
    expect(call?.headers.get('content-type')).toBe('application/json');
    expect(call?.headers.get('accept-language')).toBe('vi');
    expect(call?.headers.get('x-correlation-id')).toBe('00000000-0000-4000-8000-0000000000d0');
    expect(call?.headers.get('if-match')).toBeNull();
    expect(JSON.parse(call?.body ?? '')).toEqual(CREATE_BODY);
  });

  it('sends If-Match with the version of a versioned command and fills the path parameters', async () => {
    const { client, calls } = setup([json(200, COMMAND_RESULT)]);
    await client.command('moveOrganizationUnit', { path: { unitId: UNIT }, body: MOVE_BODY, ifMatchVersion: 7 });
    expect(calls[0]?.url).toBe(`https://api.example.test/org-units/${UNIT}/move`);
    expect(calls[0]?.headers.get('if-match')).toBe('"7"');
  });

  it('encodes path parameters so they cannot change the route', async () => {
    const { client, calls } = setup([json(200, COMMAND_RESULT)]);
    await client.command('moveOrganizationUnit', { path: { unitId: '../x?y=1/#' }, body: MOVE_BODY, ifMatchVersion: 1 });
    expect(calls[0]?.url).toBe('https://api.example.test/org-units/..%2Fx%3Fy%3D1%2F%23/move');
  });

  it('uses one key for every call of an attempt and a fresh key for a new attempt', async () => {
    const { client, calls } = setup([json(201, COMMAND_RESULT), json(201, COMMAND_RESULT), json(201, COMMAND_RESULT), json(201, COMMAND_RESULT)]);
    const attempt = newCommandAttempt();
    await client.command('createOrganizationUnit', { body: CREATE_BODY, attempt });
    await client.command('createOrganizationUnit', { body: CREATE_BODY, attempt });
    await client.command('createOrganizationUnit', { body: CREATE_BODY, attempt: newCommandAttempt() });
    await client.command('createOrganizationUnit', { body: CREATE_BODY });
    const keys = calls.map((call) => call.headers.get('idempotency-key'));
    expect(keys[0]).toBe(attempt.key);
    expect(keys[1]).toBe(attempt.key);
    expect(new Set(keys).size).toBe(3);
    expect(keys[3]).toBe('key-1-0123456789');
  });

  it('parses a Problem+JSON answer into an ApiError with code, status, detail, correlation id and extensions', async () => {
    const { client } = setup([problem(409, 'VERSION_CONFLICT', { detail: 'error.VERSION_CONFLICT.detail', current_version: 8, safe_diff: { name: 'x' } })]);
    const error = await failureOf(client.command('moveOrganizationUnit', { path: { unitId: UNIT }, body: MOVE_BODY, ifMatchVersion: 7 }));
    expect(error.status).toBe(409);
    expect(error.code).toBe('VERSION_CONFLICT');
    expect(error.detail).toBe('error.VERSION_CONFLICT.detail');
    expect(error.correlationId).toBe('00000000-0000-4000-8000-0000000000c0');
    expect(error.extensions).toEqual({ current_version: 8, safe_diff: { name: 'x' } });
    expect(error.retryAfterSeconds).toBeUndefined();
    expect(error.message).toBe('VERSION_CONFLICT');
  });

  it('retries IDEMPOTENCY_IN_PROGRESS with the same key and correlation id, waiting Retry-After capped at 10 seconds', async () => {
    const { client, calls, waits } = setup([
      problem(409, 'IDEMPOTENCY_IN_PROGRESS', {}, { 'retry-after': '2' }),
      problem(409, 'IDEMPOTENCY_IN_PROGRESS', {}, { 'retry-after': '30' }),
      problem(409, 'IDEMPOTENCY_IN_PROGRESS'),
      json(201, COMMAND_RESULT),
    ]);
    expect(await client.command('createOrganizationUnit', { body: CREATE_BODY })).toEqual(COMMAND_RESULT);
    expect(waits).toEqual([2000, 10_000, 2000]);
    expect(new Set(calls.map((call) => call.headers.get('idempotency-key'))).size).toBe(1);
    expect(new Set(calls.map((call) => call.headers.get('x-correlation-id'))).size).toBe(1);
  });

  it('gives up after five retries and reports the in-progress error with its Retry-After', async () => {
    const script = Array.from({ length: 6 }, () => problem(409, 'IDEMPOTENCY_IN_PROGRESS', {}, { 'retry-after': '2' }));
    const { client, calls, waits } = setup(script);
    const error = await failureOf(client.command('createOrganizationUnit', { body: CREATE_BODY }));
    expect(error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect(error.retryAfterSeconds).toBe(2);
    expect(calls).toHaveLength(6);
    expect(waits).toHaveLength(5);
  });

  it.each([
    [403, 'MFA_REQUIRED'],
    [428, 'PRECONDITION_REQUIRED'],
    [409, 'IDEMPOTENCY_CONFLICT'],
    [500, 'INTERNAL_ERROR'],
  ])('does not retry %s %s', async (status, code) => {
    const { client, calls, waits } = setup([problem(status, code), json(201, COMMAND_RESULT)]);
    const error = await failureOf(client.command('createOrganizationUnit', { body: CREATE_BODY }));
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('turns a non-JSON gateway answer into INTERNAL_ERROR without exposing its body', async () => {
    const html = new Response('<html><body>upstream secret_table exploded</body></html>', { status: 502, headers: { 'content-type': 'text/html' } });
    const { client } = setup([html]);
    const error = await failureOf(client.command('createOrganizationUnit', { body: CREATE_BODY }));
    expect(error.status).toBe(502);
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify([error.message, error.detail, error.extensions])).not.toContain('secret_table');
    expect(error.correlationId).toBe('00000000-0000-4000-8000-0000000000d0');
  });

  it.each([
    [401, 'SESSION_EXPIRED'],
    [403, 'SCOPE_DENIED'],
    [404, 'RESOURCE_NOT_FOUND'],
    [429, 'RATE_LIMIT'],
    [422, 'VALIDATION_FAILED'],
  ])('maps a body-less %s to %s', async (status, code) => {
    const { client } = setup([new Response('', { status })]);
    expect((await failureOf(client.command('createOrganizationUnit', { body: CREATE_BODY }))).code).toBe(code);
  });

  it('ignores a JSON error body that is not a problem and keeps the status mapping', async () => {
    const { client } = setup([json(500, { message: 'database exploded', stack: 'at x' })]);
    const error = await failureOf(client.command('createOrganizationUnit', { body: CREATE_BODY }));
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(error.extensions)).not.toContain('exploded');
  });

  it('reports a network failure as status 0 NETWORK_ERROR without retrying or echoing the cause', async () => {
    const { client, calls } = setup([new TypeError('connect ECONNREFUSED 10.0.0.1:443'), json(201, COMMAND_RESULT)]);
    const error = await failureOf(client.command('createOrganizationUnit', { body: CREATE_BODY }));
    expect(error.status).toBe(0);
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.message).not.toContain('10.0.0.1');
    expect(calls).toHaveLength(1);
  });

  it('asks for the session on every request and sends no Authorization header without one', async () => {
    const tokens: Array<{ token: string } | undefined> = [{ token: 'first' }, undefined, { token: 'third' }];
    const { client, calls } = setup([json(201, COMMAND_RESULT), json(201, COMMAND_RESULT), json(201, COMMAND_RESULT)], {
      session: () => Promise.resolve(tokens.shift()),
    });
    for (let n = 0; n < 3; n += 1) await client.command('createOrganizationUnit', { body: CREATE_BODY });
    expect(calls.map((call) => call.headers.get('authorization'))).toEqual(['Bearer first', null, 'Bearer third']);
  });

  it('lets an error of the session reach the caller instead of reporting a network failure', async () => {
    const { client, calls } = setup([json(201, COMMAND_RESULT)], { session: () => Promise.reject(new RangeError('no session')) });
    await expect(client.command('createOrganizationUnit', { body: CREATE_BODY })).rejects.toBeInstanceOf(RangeError);
    expect(calls).toHaveLength(0);
  });

  it('reads a fresh token for each retry of an in-progress command', async () => {
    let n = 0;
    const { client, calls } = setup([problem(409, 'IDEMPOTENCY_IN_PROGRESS'), json(201, COMMAND_RESULT)], {
      session: () => Promise.resolve({ token: `token-${(n += 1)}` }),
    });
    await client.command('createOrganizationUnit', { body: CREATE_BODY });
    expect(calls.map((call) => call.headers.get('authorization'))).toEqual(['Bearer token-1', 'Bearer token-2']);
  });

  it('answers undefined for 204 and fails on a success body that is not JSON', async () => {
    const empty = setup([new Response(null, { status: 204 })]);
    expect(await empty.client.command('createOrganizationUnit', { body: CREATE_BODY })).toBeUndefined();
    const broken = setup([new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } })]);
    expect((await failureOf(broken.client.command('createOrganizationUnit', { body: CREATE_BODY }))).code).toBe('INTERNAL_ERROR');
  });

  it('sends the headers the caller asks for on every request, and never lets them replace the ones the client sets', async () => {
    const { client, calls } = setup([json(201, COMMAND_RESULT)], { headers: () => ({ 'x-tenant-host': 'b.machvon.vn', accept: 'text/plain', 'x-correlation-id': 'mine' }) });
    await client.command('createOrganizationUnit', { body: CREATE_BODY });
    expect(calls[0]?.headers.get('x-tenant-host')).toBe('b.machvon.vn');
    expect(calls[0]?.headers.get('accept')).toBe('application/json, application/problem+json');
    expect(calls[0]?.headers.get('x-correlation-id')).not.toBe('mine');
  });

  it('sends a command without a language header when no locale is configured', async () => {
    const { client, calls } = setup([json(201, COMMAND_RESULT)], { locale: undefined });
    await client.command('createOrganizationUnit', { body: CREATE_BODY });
    expect(calls[0]?.headers.get('accept-language')).toBeNull();
  });
});

describe('defaults', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('waits the Retry-After the server asked for with the real timer, and uses random UUIDs for keys and correlation ids', async () => {
    jest.useFakeTimers();
    const { fetch, calls } = scriptedFetch([problem(409, 'IDEMPOTENCY_IN_PROGRESS', {}, { 'retry-after': '1' }), json(201, COMMAND_RESULT)]);
    const client = createApiClient({ baseUrl: 'https://api.example.test', session: () => Promise.resolve(undefined), fetch });
    const pending = client.command('createOrganizationUnit', { body: CREATE_BODY });
    await jest.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual(COMMAND_RESULT);
    expect(calls).toHaveLength(2);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(calls[0]?.headers.get('idempotency-key')).toMatch(uuid);
    expect(calls[0]?.headers.get('x-correlation-id')).toMatch(uuid);
    expect(calls[0]?.headers.get('idempotency-key')).not.toBe(calls[0]?.headers.get('x-correlation-id'));
  });

  it('uses the global fetch when none is given', async () => {
    const original = globalThis.fetch;
    const { fetch, calls } = scriptedFetch([json(200, { items: [] })]);
    globalThis.fetch = fetch;
    try {
      await createApiClient({ baseUrl: 'https://api.example.test', session: () => Promise.resolve(undefined) }).read('get_resources_organization_unit');
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toHaveLength(1);
  });
});

describe('read', () => {
  it('sends a GET with query parameters, no idempotency key and no body', async () => {
    const { client, calls } = setup([json(200, { items: [], next_cursor: null })]);
    await client.read('get_resources_organization_unit', { query: { limit: 25, cursor: 'abc def' } });
    const call = calls[0];
    expect(call?.method).toBe('GET');
    expect(call?.url).toBe('https://api.example.test/resources/organization_unit?limit=25&cursor=abc+def');
    expect(call?.headers.get('idempotency-key')).toBeNull();
    expect(call?.headers.get('content-type')).toBeNull();
    expect(call?.body).toBeUndefined();
  });

  it('reads one resource by id and needs no input when nothing is required', async () => {
    const { client, calls } = setup([json(200, { id: UNIT }), json(200, { items: [] })]);
    await client.read('get_resources_organization_unit_id', { path: { id: UNIT } });
    await client.read('get_resources_organization_unit');
    expect(calls[0]?.url).toBe(`https://api.example.test/resources/organization_unit/${UNIT}`);
    expect(calls[1]?.url).toBe('https://api.example.test/resources/organization_unit');
  });

  it('does not retry an in-progress answer on a read', async () => {
    const { client, calls } = setup([problem(409, 'IDEMPOTENCY_IN_PROGRESS')]);
    expect((await failureOf(client.read('get_resources_organization_unit'))).code).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect(calls).toHaveLength(1);
  });
});

describe('readAll', () => {
  it('follows next_cursor until it is null and returns every item in order', async () => {
    const { client, calls } = setup([
      json(200, { items: [{ id: 'a' }, { id: 'b' }], next_cursor: 'c1' }),
      json(200, { items: [{ id: 'c' }], next_cursor: 'c2' }),
      json(200, { items: [{ id: 'd' }], next_cursor: null }),
    ]);
    const items = await client.readAll('get_resources_organization_unit', { query: { limit: 2 } });
    expect(items).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]);
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.example.test/resources/organization_unit?limit=2',
      'https://api.example.test/resources/organization_unit?limit=2&cursor=c1',
      'https://api.example.test/resources/organization_unit?limit=2&cursor=c2',
    ]);
  });

  it('stops with the error of the failing page and returns nothing partial', async () => {
    const { client } = setup([json(200, { items: [{ id: 'a' }], next_cursor: 'c1' }), problem(403, 'SCOPE_DENIED')]);
    expect((await failureOf(client.readAll('get_resources_organization_unit'))).code).toBe('SCOPE_DENIED');
  });

  it('fails instead of looping when the server repeats a cursor', async () => {
    const { client, calls } = setup([json(200, { items: [], next_cursor: 'same' }), json(200, { items: [], next_cursor: 'same' }), json(200, { items: [], next_cursor: 'same' })]);
    const error = await failureOf(client.readAll('get_resources_organization_unit'));
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(calls).toHaveLength(2);
  });

  it('stops after the page limit when the server keeps handing out new cursors', async () => {
    const script = Array.from({ length: 1001 }, (_unused, n) => json(200, { items: [], next_cursor: `cursor-${n}` }));
    const { client, calls } = setup(script);
    expect((await failureOf(client.readAll('get_resources_organization_unit'))).code).toBe('INTERNAL_ERROR');
    expect(calls).toHaveLength(1000);
  });

  it('treats a page without items as empty', async () => {
    const { client } = setup([json(200, { next_cursor: null })]);
    expect(await client.readAll('get_resources_organization_unit')).toEqual([]);
  });
});

describe('newCommandAttempt', () => {
  it('creates unique keys that satisfy the server rule of 16 to 128 characters', () => {
    const keys = Array.from({ length: 50 }, () => newCommandAttempt().key);
    expect(new Set(keys).size).toBe(50);
    for (const key of keys) {
      expect(key.length).toBeGreaterThanOrEqual(16);
      expect(key.length).toBeLessThanOrEqual(128);
      expect(key).toMatch(/^[\x21-\x7e]+$/);
    }
  });

  it('uses the injected generator', () => {
    expect(newCommandAttempt(() => 'fixed-key-0123456789').key).toBe('fixed-key-0123456789');
  });
});
