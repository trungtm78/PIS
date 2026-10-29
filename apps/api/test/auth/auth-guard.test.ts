import { Controller, Get, Inject, Req } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { PLATFORM_TENANT_ID } from '@machvon/db';
import { loadErrorRegistry } from '@machvon/kernel';
import { AUTH_OPTIONS, AUTH_TOKEN_REQUEST_KEY, AuthGuard, bearerOf } from '../../src/auth/auth.guard';
import type { AuthGuardOptions, AuthenticatedToken } from '../../src/auth/auth.guard';
import { OperationId } from '../../src/operation-id.decorator';
import { principalOf } from '../../src/principal';
import type { PRINCIPAL_REQUEST_KEY } from '../../src/principal';
import { ProblemFilter } from '../../src/problem.filter';
import { Public } from '../../src/public.decorator';
import { TENANT_REQUEST_KEY } from '../../src/tenant-context.decorator';
import { InMemorySessionDenyList } from '../../src/session-deny-list';
import { ERROR_CODES_PATH } from '../isolation/test-app';
import { FakeTokenVerifier } from './fake-token-verifier';
import { NOW, SESSION_ID, SUBJECT, TENANT, pick } from './auth-fixtures';

const TENANT_TOKEN = 'tenant-token';
const READ_ONLY_TOKEN = 'read-only-token';
const CONTROL_TOKEN = 'control-token';
const IDENTITY_TOKEN = 'identity-token';
const SUPPORT_TOKEN = 'support-token';
const GRANT = '00000000-0000-4000-8000-0000000000e1';

interface RequestView {
  [TENANT_REQUEST_KEY]?: unknown;
  [PRINCIPAL_REQUEST_KEY]?: unknown;
  [AUTH_TOKEN_REQUEST_KEY]?: AuthenticatedToken;
}

@Controller('probe')
class ProbeController {
  constructor(@Inject(FakeTokenVerifier) private readonly verifier: FakeTokenVerifier) {}

  @Get('me')
  @OperationId('probe_me')
  me(@Req() request: RequestView): { tenant: unknown; principal: unknown; authenticated: AuthenticatedToken | undefined; calls: number } {
    return {
      tenant: request[TENANT_REQUEST_KEY],
      principal: principalOf(request),
      authenticated: request[AUTH_TOKEN_REQUEST_KEY],
      calls: this.verifier.tenantCalls + this.verifier.identityCalls,
    };
  }

  @Get('open')
  @Public()
  open(): { open: true } {
    return { open: true };
  }
}

describe('AuthGuard', () => {
  const verifier = new FakeTokenVerifier();
  const denyList = new InMemorySessionDenyList();
  let app: INestApplication;
  let baseUrl: string;

  async function get(path: string, authorization?: string | string[]): Promise<{ status: number; json: Record<string, unknown> }> {
    const headers: Record<string, string> = {};
    if (typeof authorization === 'string') headers.authorization = authorization;
    const response = await fetch(`${baseUrl}${path}`, { headers });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  beforeAll(async () => {
    verifier.registerTenant(TENANT_TOKEN, { tenant: TENANT, sessionId: SESSION_ID, assurance: 'aal2', aal2At: NOW, audience: 'tenant', mode: 'FULL', roles: [], expiresAt: NOW });
    verifier.registerTenant(READ_ONLY_TOKEN, { tenant: TENANT, sessionId: 'sid-read-only', assurance: 'aal1', audience: 'tenant', mode: 'READ_ONLY', roles: [], expiresAt: NOW });
    verifier.registerTenant(SUPPORT_TOKEN, { tenant: TENANT, sessionId: 'sid-support', assurance: 'aal1', audience: 'tenant', mode: 'FULL', roles: [], expiresAt: NOW, support: { grantId: GRANT, operatorId: TENANT.membershipId } });
    verifier.registerIdentity(CONTROL_TOKEN, { subject: SUBJECT, sessionId: 'sid-control', assurance: 'aal2', aal2At: NOW, audience: 'control-client', roles: ['SystemAdmin'] });
    verifier.registerIdentity(IDENTITY_TOKEN, { subject: SUBJECT, sessionId: 'sid-identity', assurance: 'aal1', audience: 'tenant-client', roles: [] });
    const options: AuthGuardOptions = { verifier, denyList, controlAudience: 'machvon-control', audienceOf: (token) => (token === CONTROL_TOKEN ? ['machvon-control'] : token === IDENTITY_TOKEN ? ['machvon-web'] : ['machvon-api']) };
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        { provide: FakeTokenVerifier, useValue: verifier },
        { provide: AUTH_OPTIONS, useValue: options },
        { provide: APP_GUARD, useClass: AuthGuard },
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

  it('sets the tenant context and the principal from a tenant token', async () => {
    const reply = await get('/probe/me', `Bearer ${TENANT_TOKEN}`);
    expect(reply.status).toBe(200);
    expect(reply.json.tenant).toEqual(TENANT);
    expect(reply.json.principal).toMatchObject({ tenant: TENANT, audience: 'tenant', assurance: 'aal2', sessionId: SESSION_ID });
    expect(reply.json.authenticated).toMatchObject({ mode: 'FULL', roles: [], audience: 'tenant' });
  });

  it('puts the grant and the operator of a support token on the principal, and asks no tenant session for it: what ends the token is its grant (ST-SAS-015)', async () => {
    const asked: Array<string | undefined> = [];
    const spy = jest.spyOn(denyList, 'isRevoked').mockImplementation((_sessionId: string, tenantId?: string) => {
      asked.push(tenantId);
      return Promise.resolve(false);
    });
    try {
      const reply = await get('/probe/me', `Bearer ${SUPPORT_TOKEN}`);
      expect(reply.status).toBe(200);
      expect(reply.json.principal).toMatchObject({ audience: 'tenant', support: { grantId: GRANT, operatorId: TENANT.membershipId } });
      expect(asked).toEqual([undefined]);
      asked.length = 0;
      // An ordinary tenant token is still asked about its session in its tenant.
      await get('/probe/me', `Bearer ${TENANT_TOKEN}`);
      expect(asked).toEqual([TENANT.tenantId]);
    } finally {
      spy.mockRestore();
    }
  });

  it('carries the READ_ONLY mode of a tenant token to the request', async () => {
    const reply = await get('/probe/me', `Bearer ${READ_ONLY_TOKEN}`);
    expect(pick(reply.json, 'authenticated', 'mode')).toBe('READ_ONLY');
    expect(pick(reply.json, 'principal', 'assurance')).toBe('aal1');
  });

  it('builds a control principal on the platform tenant from a control token and keeps its realm roles', async () => {
    const reply = await get('/probe/me', `Bearer ${CONTROL_TOKEN}`);
    expect(reply.status).toBe(200);
    expect(reply.json.principal).toMatchObject({ audience: 'control', sessionId: 'sid-control', assurance: 'aal2' });
    expect(reply.json.tenant).toMatchObject({ tenantId: PLATFORM_TENANT_ID, scopeVersion: 0 });
    expect(pick(reply.json, 'tenant', 'membershipId')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(reply.json.authenticated).toMatchObject({ roles: ['SystemAdmin'], mode: 'FULL', audience: 'control' });
  });

  it('gives the same control subject the same pseudo membership every time and different subjects different ones', async () => {
    const first = await get('/probe/me', `Bearer ${CONTROL_TOKEN}`);
    const second = await get('/probe/me', `Bearer ${CONTROL_TOKEN}`);
    expect(pick(second.json, 'tenant', 'membershipId')).toBe(pick(first.json, 'tenant', 'membershipId'));
  });

  it('does not accept an identity token for the client application on an API route', async () => {
    const reply = await get('/probe/me', `Bearer ${IDENTITY_TOKEN}`);
    expect(reply.status).toBe(401);
    expect(reply.json.code).toBe('SESSION_EXPIRED');
  });

  describe('the Authorization header', () => {
    it.each([
      ['is missing', undefined],
      ['uses another scheme', `Basic ${TENANT_TOKEN}`],
      ['has no token', 'Bearer'],
      ['has no token after the space', 'Bearer '],
      ['has two spaces', `Bearer  ${TENANT_TOKEN}`],
      ['carries a token with spaces inside', 'Bearer a b'],
      ['carries an unknown token', 'Bearer not-registered'],
    ])('is refused with 401 SESSION_EXPIRED when it %s', async (_label, header) => {
      const reply = await get('/probe/me', header);
      expect(reply.status).toBe(401);
      expect(reply.json.code).toBe('SESSION_EXPIRED');
      expect(JSON.stringify(reply.json)).not.toMatch(/signature|jwks|issuer|audience|expired at/i);
    });

    it('accepts the scheme in any letter case', async () => {
      expect((await get('/probe/me', `bearer ${TENANT_TOKEN}`)).status).toBe(200);
      expect((await get('/probe/me', `BEARER ${TENANT_TOKEN}`)).status).toBe(200);
    });

    it('is a pure function over the header value: repeated headers and non-strings give nothing', () => {
      expect(bearerOf(undefined)).toBeUndefined();
      expect(bearerOf(['Bearer a', 'Bearer b'])).toBeUndefined();
      expect(bearerOf('Bearer abc.def-ghi_jkl~+/=')).toBe('abc.def-ghi_jkl~+/=');
      expect(bearerOf(`Bearer ${'a'.repeat(9000)}`)).toBeUndefined();
    });
  });

  it('refuses a token whose session is on the deny-list, before any handler runs', async () => {
    denyList.revoke(SESSION_ID);
    const reply = await get('/probe/me', `Bearer ${TENANT_TOKEN}`);
    expect(reply.status).toBe(401);
    expect(reply.json.code).toBe('SESSION_EXPIRED');
  });

  it('lets a @Public route through without any token', async () => {
    const reply = await get('/probe/open');
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ open: true });
  });
});
