import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Body, Controller, Get, Patch } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadErrorRegistry } from '@machvon/kernel';
import { AllowlistPipe } from '../src/allowlist.pipe';
import { ProblemFilter } from '../src/problem.filter';

interface PatchBody {
  name: string;
}

@Controller('things')
class ThingsController {
  @Patch()
  update(@Body(new AllowlistPipe<PatchBody>(['name'])) body: PatchBody): PatchBody {
    return body;
  }

  @Get('boom')
  boom(): never {
    throw new Error('select * from secret');
  }
}

const REGISTRY = loadErrorRegistry(resolve(__dirname, '../../../Design/MACHVON_Design/03_Engineering/error_codes.json'));

describe('AllowlistPipe and ProblemFilter in a Nest application', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [ThingsController] }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalFilters(new ProblemFilter(REGISTRY, { error: () => undefined }));
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  function patch(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${base}/things`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  it('passes a body that only has allowed fields through unchanged', async () => {
    const response = await patch({ name: 'Đà Nẵng' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: 'Đà Nẵng' });
  });

  it('rejects mass-assignment fields with 400 FIELD_NOT_ALLOWED naming them (AC-ST-KERNEL-021-1)', async () => {
    const response = await patch(
      { name: 'x', status: 'ACTIVE', tenant_id: 't', role: 'admin' },
      { 'x-correlation-id': '0b7f6c0e-2d52-4c41-9a7e-5d4c3b2a1f00' },
    );
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(await response.json()).toMatchObject({
      type: 'urn:machvon:error:FIELD_NOT_ALLOWED',
      code: 'FIELD_NOT_ALLOWED',
      detail: 'status, tenant_id, role',
      correlation_id: '0b7f6c0e-2d52-4c41-9a7e-5d4c3b2a1f00',
    });
  });

  it('rejects a body that is not an object with 422 VALIDATION_FAILED', async () => {
    const response = await patch([1, 2]);
    expect(response.status).toBe(422);
    expect(((await response.json()) as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('renders body-parser failures as registered problems without echoing their messages', async () => {
    const send = (body: string, headers: Record<string, string> = {}) =>
      fetch(`${base}/things`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...headers }, body });

    const oversize = await send(JSON.stringify({ name: 'x'.repeat(200_000) }));
    expect(oversize.status).toBe(413);
    expect(await oversize.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', status: 413 });

    // Nest rewraps body-parser's SyntaxError as BadRequestException(message), losing its parse type,
    // so a running app answers 422 VALIDATION_FAILED; the raw-error MALFORMED_JSON path is unit tested.
    const malformed = await send('{"name": }');
    const malformedText = await malformed.text();
    expect(malformed.status).toBe(422);
    expect(JSON.parse(malformedText)).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(malformedText).not.toContain('token');

    const encoded = await send('{}', { 'content-encoding': 'unknown-encoding' });
    expect(encoded.status).toBe(415);
    expect(((await encoded.json()) as { code: string }).code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('renders an unknown route as 404 RESOURCE_NOT_FOUND and an unknown failure as a bare 500', async () => {
    const missing = await fetch(`${base}/nope`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { code: string }).code).toBe('RESOURCE_NOT_FOUND');

    const boom = await fetch(`${base}/things/boom`);
    const text = await boom.text();
    expect(boom.status).toBe(500);
    expect(JSON.parse(text)).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(text).not.toContain('secret');
  });
});

describe('AllowlistPipe', () => {
  it('leaves non-body arguments untouched', () => {
    const pipe = new AllowlistPipe<PatchBody>(['name']);
    expect(pipe.transform({ other: 1 }, { type: 'query' })).toEqual({ other: 1 });
  });
});
