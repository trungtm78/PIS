import { Controller, Get, Post, HttpCode } from '@nestjs/common';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { loadErrorRegistry } from '@machvon/kernel';
import { AUTH_TOKEN_REQUEST_KEY } from '../../src/auth/auth.guard';
import type { AuthenticatedToken } from '../../src/auth/auth.guard';
import { OperationId } from '../../src/operation-id.decorator';
import { ProblemFilter } from '../../src/problem.filter';
import { Public } from '../../src/public.decorator';
import { ReadOnlyModeGuard } from '../../src/session/read-only-mode.guard';
import { ERROR_CODES_PATH } from '../isolation/test-app';

const TOKENS: Record<string, AuthenticatedToken> = {
  full: { audience: 'tenant', roles: [], mode: 'FULL' },
  readonly: { audience: 'tenant', roles: [], mode: 'READ_ONLY' },
};

/** Stands in for the authentication guard: it puts the facts of the token named in a header on the request. */
class FakeAuthentication {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string>; [AUTH_TOKEN_REQUEST_KEY]?: AuthenticatedToken }>();
    const token = TOKENS[request.headers['x-mode'] ?? ''];
    if (token !== undefined) request[AUTH_TOKEN_REQUEST_KEY] = token;
    return true;
  }
}

@Controller('mode')
class ModeController {
  @Get('read')
  @OperationId('probe_read')
  read(): { ok: true } {
    return { ok: true };
  }

  @Post('write')
  @HttpCode(200)
  @OperationId('probe_write')
  write(): { ok: true } {
    return { ok: true };
  }

  // report.export belongs to the `export` feature: an export stays allowed while the tenant is read-only.
  @Post('export')
  @HttpCode(200)
  @OperationId('createReportExport')
  exportReport(): { ok: true } {
    return { ok: true };
  }

  // The export of all the data of the tenant is the tenant's own right while it is read-only, though no plan feature gates it (ST-SAS-016).
  @Post('tenant-export')
  @HttpCode(200)
  @OperationId('post_tenants_id_export')
  exportTenant(): { ok: true } {
    return { ok: true };
  }

  @Post('open')
  @HttpCode(200)
  @Public()
  open(): { ok: true } {
    return { ok: true };
  }
}

describe('ReadOnlyModeGuard', () => {
  let app: INestApplication;
  let baseUrl: string;

  async function call(method: string, path: string, mode?: string): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await fetch(`${baseUrl}${path}`, { method, headers: mode === undefined ? {} : { 'x-mode': mode } });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ModeController],
      providers: [
        { provide: APP_GUARD, useClass: FakeAuthentication },
        { provide: APP_GUARD, useClass: ReadOnlyModeGuard },
        { provide: Reflector, useValue: new Reflector() },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('lets a read through while the tenant is read-only', async () => {
    expect((await call('GET', '/mode/read', 'readonly')).status).toBe(200);
  });

  it('refuses a command with 403 TENANT_SUSPENDED while the tenant is read-only', async () => {
    const reply = await call('POST', '/mode/write', 'readonly');
    expect(reply.status).toBe(403);
    expect(reply.json.code).toBe('TENANT_SUSPENDED');
  });

  it('lets an export through while the tenant is read-only', async () => {
    expect((await call('POST', '/mode/export', 'readonly')).status).toBe(200);
  });

  it('lets the export of the data of the tenant through while it is read-only, as it does for a feature export', async () => {
    expect((await call('POST', '/mode/tenant-export', 'readonly')).status).toBe(200);
  });

  it('changes nothing for a full session', async () => {
    expect((await call('POST', '/mode/write', 'full')).status).toBe(200);
    expect((await call('GET', '/mode/read', 'full')).status).toBe(200);
  });

  it('does not judge a request that carries no authenticated token, and public routes', async () => {
    expect((await call('POST', '/mode/write')).status).toBe(200);
    expect((await call('POST', '/mode/open', 'readonly')).status).toBe(200);
  });
});
