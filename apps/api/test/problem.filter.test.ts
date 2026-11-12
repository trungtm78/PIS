import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ArgumentsHost } from '@nestjs/common';
import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { DomainError, loadErrorRegistry } from '@machvon/kernel';
import { ProblemFilter } from '../src/problem.filter';

const REGISTRY = loadErrorRegistry(resolve(__dirname, '../../../Design/MACHVON_Design/03_Engineering/error_codes.json'));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Captured {
  status: number | undefined;
  headers: Record<string, string>;
  raw: string;
  body: Record<string, unknown>;
}

function run(filter: ProblemFilter, exception: unknown, headers: Record<string, string | string[] | undefined> = {}): Captured {
  const captured: Captured = { status: undefined, headers: {}, raw: '', body: {} };
  const response = {
    status(code: number) {
      captured.status = code;
      return response;
    },
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
      return response;
    },
    send(payload: string) {
      captured.raw = payload;
      captured.body = JSON.parse(payload) as Record<string, unknown>;
      return response;
    },
  };
  const host = { switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({ headers }) }) } as unknown as ArgumentsHost;
  filter.catch(exception, host);
  return captured;
}

function newFilter(registry = REGISTRY) {
  const logged: unknown[][] = [];
  const filter = new ProblemFilter(registry, { error: (...args: unknown[]) => void logged.push(args) });
  return { filter, logged };
}

describe('ProblemFilter', () => {
  it('answers with every member the Problem schema of the contract requires, the correlation id as correlation_id', () => {
    const contract = JSON.parse(readFileSync(resolve(__dirname, '../../../Design/MACHVON_Design/03_Engineering/openapi.json'), 'utf8')) as { components: { schemas: { Problem: { required: string[] } } } };
    const { filter } = newFilter();
    const body = run(filter, new DomainError('FIELD_NOT_ALLOWED', 400, 'status')).body;
    for (const member of contract.components.schemas.Problem.required) expect(body).toHaveProperty(member);
    expect(body).not.toHaveProperty('correlationId');
  });

  it('renders a DomainError as application/problem+json with the standard members', () => {
    const { filter } = newFilter();
    const result = run(filter, new DomainError('FIELD_NOT_ALLOWED', 400, 'status, tenant_id, role'));
    expect(result.status).toBe(400);
    expect(result.headers['content-type']).toBe('application/problem+json; charset=utf-8');
    expect(result.body).toEqual({
      type: 'urn:machvon:error:FIELD_NOT_ALLOWED',
      title: 'error.FIELD_NOT_ALLOWED.title',
      status: 400,
      code: 'FIELD_NOT_ALLOWED',
      detail: 'status, tenant_id, role',
      correlation_id: expect.stringMatching(UUID),
    });
    expect(result.headers['x-correlation-id']).toBe(result.body.correlation_id);
  });

  it('renders DomainError extensions as top-level members that cannot overwrite the standard ones', () => {
    const { filter } = newFilter();
    const result = run(filter, new DomainError('VERSION_CONFLICT', 409, undefined, { extensions: { current_version: 8, code: 'FORGED', status: 200 } }));
    expect(result.body.current_version).toBe(8);
    expect(result.body.code).toBe('VERSION_CONFLICT');
    expect(result.body.status).toBe(409);
  });

  it('sends DomainError headers but never from other exceptions', () => {
    const { filter } = newFilter();
    const conflict = run(filter, new DomainError('IDEMPOTENCY_IN_PROGRESS', 409, undefined, { headers: { 'Retry-After': '2' } }));
    expect(conflict.headers['retry-after']).toBe('2');
    const other = run(filter, Object.assign(new Error('boom'), { headers: { 'Retry-After': '2' } }));
    expect(other.headers['retry-after']).toBeUndefined();
  });

  it('omits detail when the DomainError has none', () => {
    const result = run(newFilter().filter, new DomainError('SCOPE_DENIED', 403));
    expect(result.status).toBe(403);
    expect(result.body).not.toHaveProperty('detail');
  });

  it('turns an unknown error into 500 INTERNAL_ERROR without message, stack, SQL text or constraint names', () => {
    const { filter, logged } = newFilter();
    const failure = Object.assign(new Error('select * from secret where email = $1'), {
      constraint: 'users_email_key',
      detail: 'Key (email)=(a@b.c) already exists.',
      table: 'users',
    });
    const result = run(filter, failure);
    expect(result.status).toBe(500);
    expect(result.body).toEqual({
      type: 'urn:machvon:error:INTERNAL_ERROR',
      title: 'error.INTERNAL_ERROR.title',
      status: 500,
      code: 'INTERNAL_ERROR',
      detail: 'error.INTERNAL_ERROR.detail',
      correlation_id: expect.stringMatching(UUID),
    });
    for (const leaked of ['select', 'secret', 'users_email_key', 'a@b.c', 'users', 'problem.filter', 'at ', 'stack']) {
      expect(result.raw).not.toContain(leaked);
    }
    expect(logged).toHaveLength(1);
    expect(logged[0]?.[0]).toBe(failure);
    expect(logged[0]?.[1]).toBe(result.body.correlation_id);
  });

  it.each([
    ['a string', 'boom select 1'],
    ['null', null],
    ['undefined', undefined],
    ['an object', { message: 'secret' }],
  ])('turns %s thrown as an exception into 500 INTERNAL_ERROR', (_label, thrown) => {
    const result = run(newFilter().filter, thrown);
    expect(result.status).toBe(500);
    expect(result.body.code).toBe('INTERNAL_ERROR');
    expect(result.raw).not.toContain('secret');
    expect(result.raw).not.toContain('select');
  });

  it('maps Nest HttpException statuses to the nearest registered code and drops the message', () => {
    const { filter } = newFilter();
    const notFound = run(filter, new NotFoundException('Cannot GET /internal/path'));
    expect(notFound.status).toBe(404);
    expect(notFound.body.code).toBe('RESOURCE_NOT_FOUND');
    expect(notFound.raw).not.toContain('internal');
    expect(notFound.body.detail).toBe('error.RESOURCE_NOT_FOUND.detail');

    const bad = run(filter, new BadRequestException('Unexpected token } in JSON at position 4'));
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
    expect(bad.raw).not.toContain('token');

    expect(run(filter, new HttpException('x', 403)).body.code).toBe('SCOPE_DENIED');
    expect(run(filter, new HttpException('x', 401)).body.code).toBe('SESSION_EXPIRED');
    expect(run(filter, new HttpException('x', 429)).body.code).toBe('RATE_LIMIT');
    expect(run(filter, new HttpException('x', 413)).body.code).toBe('PAYLOAD_TOO_LARGE');
    expect(run(filter, new HttpException('x', 415)).body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(run(filter, new HttpException('x', 418)).body.code).toBe('VALIDATION_FAILED');
  });

  it('maps a 5xx HttpException to 500 INTERNAL_ERROR', () => {
    const result = run(newFilter().filter, new HttpException('upstream said select 1', 503));
    expect(result.status).toBe(500);
    expect(result.body.code).toBe('INTERNAL_ERROR');
    expect(result.raw).not.toContain('select');
  });

  it('falls back to 500 INTERNAL_ERROR when the nearest code is not registered', () => {
    const empty = new Map<string, { status: number; title: string }>();
    const result = run(newFilter(empty).filter, new NotFoundException());
    expect(result.status).toBe(500);
    expect(result.body.code).toBe('INTERNAL_ERROR');
  });

  it('takes the correlation id from a UUID x-correlation-id header', () => {
    const id = '0b7f6c0e-2d52-4c41-9a7e-5d4c3b2a1f00';
    expect(run(newFilter().filter, new Error('x'), { 'x-correlation-id': id }).body.correlation_id).toBe(id);
  });

  it.each([
    ['not a UUID', 'abc'],
    ['an injection attempt', 'x\r\nSet-Cookie: a=b'],
    ['a repeated header', ['0b7f6c0e-2d52-4c41-9a7e-5d4c3b2a1f00', '0b7f6c0e-2d52-4c41-9a7e-5d4c3b2a1f01']],
    ['missing', undefined],
  ])('generates a correlation id when the header is %s', (_label, header) => {
    const result = run(newFilter().filter, new Error('x'), { 'x-correlation-id': header });
    expect(result.body.correlation_id).toMatch(UUID);
    expect(result.body.correlation_id).not.toBe(header);
  });

  describe('errors raised by Express body parsing (not Nest HttpExceptions)', () => {
    function middlewareError(message: string, status: number, type: string, key: 'status' | 'statusCode' = 'status'): Error {
      return Object.assign(new Error(message), { [key]: status, type, expose: true });
    }

    it('maps an oversize body (413 entity.too.large) to 413 PAYLOAD_TOO_LARGE without the message', () => {
      const { filter, logged } = newFilter();
      const result = run(filter, middlewareError('request entity too large: limit 102400 bytes', 413, 'entity.too.large'));
      expect(result.status).toBe(413);
      expect(result.body.code).toBe('PAYLOAD_TOO_LARGE');
      expect(result.body.title).toBe('error.PAYLOAD_TOO_LARGE.title');
      expect(result.body.detail).toBe('error.PAYLOAD_TOO_LARGE.detail');
      expect(result.raw).not.toContain('102400');
      expect(result.raw).not.toContain('limit');
      expect(logged).toHaveLength(0);
    });

    it('maps malformed JSON (SyntaxError, 400 entity.parse.failed) to 400 MALFORMED_JSON without the message', () => {
      const failure = Object.assign(new SyntaxError('Unexpected token } in JSON at position 17'), {
        status: 400,
        statusCode: 400,
        type: 'entity.parse.failed',
        body: '{"name": }',
      });
      const result = run(newFilter().filter, failure);
      expect(result.status).toBe(400);
      expect(result.body.code).toBe('MALFORMED_JSON');
      expect(result.raw).not.toContain('token');
      expect(result.raw).not.toContain('name');
    });

    it.each([
      ['unsupported content type', 'charset.unsupported', 415],
      ['unsupported encoding', 'encoding.unsupported', 415],
    ])('maps %s to 415 UNSUPPORTED_MEDIA_TYPE', (_label, type, status) => {
      const result = run(newFilter().filter, middlewareError('unsupported charset "UTF-7"', status, type, 'statusCode'));
      expect(result.status).toBe(415);
      expect(result.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
      expect(result.raw).not.toContain('UTF-7');
    });

    it('maps any other 4xx error object to 422 VALIDATION_FAILED', () => {
      const result = run(newFilter().filter, middlewareError('request aborted', 400, 'request.aborted'));
      expect(result.status).toBe(422);
      expect(result.body.code).toBe('VALIDATION_FAILED');
      expect(result.raw).not.toContain('aborted');
    });

    it('keeps a 400 whose type is not a parse failure on VALIDATION_FAILED, not MALFORMED_JSON', () => {
      expect(run(newFilter().filter, middlewareError('x', 400, 'entity.verify.failed')).body.code).toBe('VALIDATION_FAILED');
    });

    it.each([
      ['a 5xx status', { status: 500 }],
      ['a 503 statusCode', { statusCode: 503 }],
      ['a status below 400', { status: 302 }],
      ['a non-integer status', { status: 404.5 }],
      ['a string status', { status: '404' }],
      ['an out-of-range status', { statusCode: 600 }],
    ])('still treats an error object with %s as 500 INTERNAL_ERROR and logs it', (_label, fields) => {
      const { filter, logged } = newFilter();
      const result = run(filter, Object.assign(new Error('select * from secret'), fields));
      expect(result.status).toBe(500);
      expect(result.body.code).toBe('INTERNAL_ERROR');
      expect(result.raw).not.toContain('secret');
      expect(logged).toHaveLength(1);
    });

    it('falls back to 500 INTERNAL_ERROR when the mapped code is not registered', () => {
      const empty = new Map<string, { status: number; title: string }>();
      const result = run(newFilter(empty).filter, middlewareError('x', 413, 'entity.too.large'));
      expect(result.status).toBe(500);
      expect(result.body.code).toBe('INTERNAL_ERROR');
    });
  });
});
