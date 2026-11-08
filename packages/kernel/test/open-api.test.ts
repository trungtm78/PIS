import { DomainError } from '../src/errors';
import {
  MACHINE_RATE_DEFAULT,
  MachineRateLimiter,
  OPEN_API_SCOPES,
  OPEN_DATASET_DEFINITIONS,
  assertDatasetOpen,
  assertExternalCodeFits,
  assertOpenScope,
  biLoginName,
  biReaderMove,
  biReaderRequestOf,
  datasetGate,
  datasetOfScope,
  expiryOf,
  graceEndsAt,
  graceHoursOf,
  isBiLoginName,
  machineAccountLive,
  machineAccountMove,
  machineAccountRequestOf,
  machineCredentialState,
  projectCodeRequestOf,
  queryKeysOf,
  rateLimitError,
  sourceSystemRequestOf,
} from '../src/open-api';
import { openApiSubsetOf } from '../src/open-api-document';
import { generateBiPassword, generateClientCredentials, hashClientSecret, isClientId, isScramVerifier, scramVerifierOf, verifyClientSecret } from '../src/open-api-secret';

const TODAY = '2026-11-08';

function refusal(run: () => unknown): DomainError {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('open API scopes and the certification gate (INT-1)', () => {
  it('knows four scopes and the dataset behind each of the two that need a certification', () => {
    expect(OPEN_API_SCOPES.map((scope) => scope.code)).toEqual(['open.projects.read', 'open.project-codes.read', 'open.disbursement.read', 'open.contracts.read']);
    expect(datasetOfScope('open.disbursement.read')).toBe('DS-DISB');
    expect(datasetOfScope('open.contracts.read')).toBe('DS-CTR');
    expect(datasetOfScope('open.projects.read')).toBeNull();
    for (const definition of Object.values(OPEN_DATASET_DEFINITIONS)) expect(datasetOfScope(definition.scope)).toBe(definition.code);
  });

  it('refuses a token that lacks the scope an operation needs', () => {
    expect(() => assertOpenScope(['open.projects.read'], 'open.projects.read')).not.toThrow();
    const error = refusal(() => assertOpenScope(['open.projects.read'], 'open.contracts.read'));
    expect([error.code, error.status, error.extensions]).toEqual(['OPEN_SCOPE_DENIED', 403, { required_scope: 'open.contracts.read' }]);
  });

  it('opens a dataset only when it is on, CERTIFIED and not past its day', () => {
    const base = { enabled: true, certification: 'CERTIFIED' as const, expiresOn: '2026-12-31', today: TODAY };
    expect(datasetGate(base)).toEqual({ open: true });
    expect(datasetGate({ ...base, expiresOn: null })).toEqual({ open: true });
    expect(datasetGate({ ...base, enabled: false })).toEqual({ open: false, reason: 'DISABLED' });
    for (const certification of ['NOT_ASSESSED', 'PROVISIONAL', 'REVOKED', null] as const) expect(datasetGate({ ...base, certification })).toEqual({ open: false, reason: 'NOT_CERTIFIED' });
    // The day it runs out is the first day it no longer holds.
    expect(datasetGate({ ...base, expiresOn: TODAY })).toEqual({ open: false, reason: 'EXPIRED' });
    expect(datasetGate({ ...base, expiresOn: '2026-11-09' })).toEqual({ open: true });
    const error = refusal(() => assertDatasetOpen({ ...base, certification: 'REVOKED' }));
    expect([error.code, error.status, error.extensions]).toEqual(['OPEN_DATASET_NOT_CERTIFIED', 403, { reason: 'NOT_CERTIFIED' }]);
  });
});

describe('machine accounts (INT-1)', () => {
  const body = { name: ' Power BI of the ministry ', scopes: ['open.contracts.read', 'open.projects.read', 'open.projects.read'], rate_limit_per_minute: 120, expires_on: '2027-01-31' };

  it('reads a request: trimmed name, sorted and de-duplicated scopes, the default rate', () => {
    expect(machineAccountRequestOf(body, TODAY)).toEqual({ name: 'Power BI of the ministry', description: null, scopes: ['open.contracts.read', 'open.projects.read'], ratePerMinute: 120, expiresOn: '2027-01-31' });
    expect(machineAccountRequestOf({ name: 'x', scopes: ['open.projects.read'] }, TODAY)).toMatchObject({ ratePerMinute: MACHINE_RATE_DEFAULT, expiresOn: null });
  });

  it.each([
    [{ ...body, name: '   ' }, 'name'],
    [{ ...body, name: 'a'.repeat(121) }, 'name'],
    [{ ...body, name: 'bad\u0007name' }, 'name'],
    [{ ...body, scopes: [] }, 'scopes'],
    [{ ...body, scopes: ['open.everything'] }, 'scopes'],
    [{ ...body, scopes: 'open.projects.read' }, 'scopes'],
    [{ ...body, rate_limit_per_minute: 0 }, 'rate_limit_per_minute'],
    [{ ...body, rate_limit_per_minute: 6001 }, 'rate_limit_per_minute'],
    [{ ...body, rate_limit_per_minute: 1.5 }, 'rate_limit_per_minute'],
    [{ ...body, expires_on: TODAY }, 'expires_on'],
    [{ ...body, expires_on: '2026-02-30' }, 'expires_on'],
    [{ ...body, expires_on: '2031-01-01' }, 'expires_on'],
    [{ ...body, description: 'x'.repeat(1001) }, 'description'],
  ])('refuses a request that breaks %#', (request, field) => {
    const error = refusal(() => machineAccountRequestOf(request, TODAY));
    expect([error.code, error.status, error.detail]).toEqual(['VALIDATION_FAILED', 422, field]);
  });

  it('keeps the day an account runs out within two years', () => {
    expect(expiryOf(undefined, TODAY)).toBeNull();
    expect(expiryOf('2028-11-07', TODAY)).toBe('2028-11-07');
    expect(refusal(() => expiryOf('2028-11-09', TODAY)).detail).toBe('expires_on');
  });

  it('suspends, reactivates and revokes along the lines of the life, with a reason', () => {
    const reason = 'Key found in a public repository';
    expect(machineAccountMove({ status: 'ACTIVE', expiresOn: null }, { move: 'SUSPEND', reason, today: TODAY })).toEqual({ to: 'SUSPENDED', reason });
    expect(machineAccountMove({ status: 'SUSPENDED', expiresOn: null }, { move: 'REACTIVATE', reason, today: TODAY })).toEqual({ to: 'ACTIVE', reason });
    expect(machineAccountMove({ status: 'SUSPENDED', expiresOn: null }, { move: 'REVOKE', reason, today: TODAY }).to).toBe('REVOKED');
    for (const [status, move] of [['ACTIVE', 'REACTIVATE'], ['SUSPENDED', 'SUSPEND'], ['REVOKED', 'SUSPEND'], ['REVOKED', 'REACTIVATE'], ['REVOKED', 'REVOKE']] as const) {
      expect(refusal(() => machineAccountMove({ status, expiresOn: null }, { move, reason, today: TODAY })).code).toBe('OPEN_ACCOUNT_STATE_INVALID');
    }
    // A stale screen sees the conflict before the missing reason.
    expect(refusal(() => machineAccountMove({ status: 'REVOKED', expiresOn: null }, { move: 'SUSPEND', reason: '', today: TODAY })).code).toBe('OPEN_ACCOUNT_STATE_INVALID');
    expect(refusal(() => machineAccountMove({ status: 'ACTIVE', expiresOn: null }, { move: 'SUSPEND', reason: 'short', today: TODAY })).detail).toBe('reason');
    // An account past its own day cannot be reactivated.
    expect(refusal(() => machineAccountMove({ status: 'SUSPENDED', expiresOn: TODAY }, { move: 'REACTIVATE', reason, today: TODAY })).code).toBe('OPEN_ACCOUNT_STATE_INVALID');
  });

  it('lets only an ACTIVE account that is not past its day authenticate', () => {
    expect(machineAccountLive({ status: 'ACTIVE', expiresOn: null }, TODAY)).toBe(true);
    expect(machineAccountLive({ status: 'ACTIVE', expiresOn: '2026-11-09' }, TODAY)).toBe(true);
    expect(machineAccountLive({ status: 'ACTIVE', expiresOn: TODAY }, TODAY)).toBe(false);
    expect(machineAccountLive({ status: 'SUSPENDED', expiresOn: null }, TODAY)).toBe(false);
    expect(machineAccountLive({ status: 'REVOKED', expiresOn: null }, TODAY)).toBe(false);
  });

  it('keeps an old secret alive for a bounded overlap after a rotation', () => {
    const now = new Date('2026-11-08T03:00:00Z');
    expect(graceHoursOf(undefined)).toBe(24);
    expect(graceHoursOf(0)).toBe(0);
    expect(refusal(() => graceHoursOf(73)).detail).toBe('grace_hours');
    expect(refusal(() => graceHoursOf(-1)).detail).toBe('grace_hours');
    const end = graceEndsAt(now, 24);
    expect(end.toISOString()).toBe('2026-11-09T03:00:00.000Z');
    expect(machineCredentialState({ expiresAt: null, revokedAt: null, supersededAt: null }, now)).toBe('ACTIVE');
    expect(machineCredentialState({ expiresAt: end, revokedAt: null, supersededAt: now }, now)).toBe('RETIRING');
    expect(machineCredentialState({ expiresAt: end, revokedAt: null, supersededAt: now }, end)).toBe('EXPIRED');
    expect(machineCredentialState({ expiresAt: end, revokedAt: now, supersededAt: now }, now)).toBe('REVOKED');
  });
});

describe('the rate limit of a machine account (INT-1)', () => {
  it('counts per account with the limit of that account and tells when to come back', () => {
    let now = 1_000_000;
    const limiter = new MachineRateLimiter({ now: () => now });
    expect(limiter.consume('a', 2)).toEqual({ allowed: true, limit: 2, remaining: 1, retryAfterSeconds: 0 });
    expect(limiter.consume('a', 2).remaining).toBe(0);
    const refused = limiter.consume('a', 2);
    expect(refused).toMatchObject({ allowed: false, remaining: 0, retryAfterSeconds: 60 });
    // Another account is not touched, and has its own limit.
    expect(limiter.consume('b', 5)).toMatchObject({ allowed: true, remaining: 4 });
    now += 30_000;
    expect(limiter.consume('a', 2)).toMatchObject({ allowed: false, retryAfterSeconds: 30 });
    now += 30_000;
    expect(limiter.consume('a', 2)).toMatchObject({ allowed: true, remaining: 1 });
    const error = rateLimitError(refused);
    expect([error.code, error.status, error.headers]).toEqual(['RATE_LIMIT', 429, { 'Retry-After': '60', 'X-RateLimit-Limit': '2', 'X-RateLimit-Remaining': '0' }]);
  });

  it('drops idle windows and refuses a limit that is not a positive integer', () => {
    let now = 0;
    const limiter = new MachineRateLimiter({ now: () => now, windowSeconds: 10 });
    limiter.consume('a', 1);
    limiter.consume('b', 1);
    expect(limiter.size()).toBe(2);
    now += 10_000;
    limiter.consume('c', 1);
    expect(limiter.size()).toBe(1);
    expect(() => limiter.consume('a', 0)).toThrow(RangeError);
    expect(() => new MachineRateLimiter({ windowSeconds: 0 })).toThrow(RangeError);
  });
});

describe('the access log keeps names, never values (INT-1)', () => {
  it('lists the names of the query parameters, sorted, and drops what is not a name', () => {
    expect(queryKeysOf({ period: '2026-10', limit: '5', 'bad key': 'x', cursor: 'abc' })).toEqual(['cursor', 'limit', 'period']);
    expect(queryKeysOf({})).toEqual([]);
  });
});

describe('source systems and the codes of projects in them (INT-1)', () => {
  it('reads a source system and refuses the names other lanes own, a bad kind and a pattern that could hang', () => {
    expect(sourceSystemRequestOf({ code: 'HPM', name: 'Hyperion', kind: 'FINANCE', code_pattern: '[A-Z]{2}-\\d{4}' })).toEqual({ code: 'HPM', name: 'Hyperion', kind: 'FINANCE', codePattern: '[A-Z]{2}-\\d{4}' });
    for (const code of ['MUASAMCONG', 'TENANT_ALIAS', 'hpm', 'H', '1ABC', 'A B']) expect(refusal(() => sourceSystemRequestOf({ code, name: 'x', kind: 'ERP' })).detail).toBe('code');
    expect(refusal(() => sourceSystemRequestOf({ code: 'EBS', name: 'x', kind: 'SPREADSHEET' })).detail).toBe('kind');
    expect(refusal(() => sourceSystemRequestOf({ code: 'EBS', name: 'x', kind: 'ERP', code_pattern: '(' })).detail).toBe('code_pattern');
    expect(refusal(() => sourceSystemRequestOf({ code: 'EBS', name: 'x', kind: 'ERP', code_pattern: '(a+)+' })).detail).toBe('code_pattern');
  });

  it('reads the request to map a project and judges the days', () => {
    expect(projectCodeRequestOf({ source_system: 'EBS', our_code: ' PRJ-001 ', external_code: 'P-100', valid_from: '2026-01-01', valid_until: '2027-01-01' })).toEqual({
      sourceSystem: 'EBS',
      ourCode: 'PRJ-001',
      externalCode: 'P-100',
      validFrom: '2026-01-01',
      validUntil: '2027-01-01',
    });
    expect(refusal(() => projectCodeRequestOf({ source_system: 'MUASAMCONG', our_code: 'a', external_code: 'b' })).detail).toBe('source_system');
    expect(refusal(() => projectCodeRequestOf({ source_system: 'EBS', our_code: 'a', external_code: 'b', valid_from: '2026-01-01', valid_until: '2026-01-01' })).detail).toBe('valid_until');
    expect(refusal(() => projectCodeRequestOf({ source_system: 'EBS', our_code: 'a', external_code: '' })).detail).toBe('external_code');
  });

  it('holds a code to the format of its system, whole (never a part of it)', () => {
    const system = { codePattern: '[A-Z]{2}-\\d{4}' };
    expect(() => assertExternalCodeFits(system, 'AB-1234')).not.toThrow();
    expect(refusal(() => assertExternalCodeFits(system, 'xAB-1234')).detail).toBe('external_code');
    expect(refusal(() => assertExternalCodeFits(system, 'AB-12345')).detail).toBe('external_code');
    expect(() => assertExternalCodeFits({ codePattern: null }, 'anything at all')).not.toThrow();
  });
});

describe('logins of BI tools (INT-1)', () => {
  it('names a login from the id of its reader and refuses what is not an id', () => {
    const name = biLoginName('0b1c0877-9aa3-4841-92e9-158bbc5f01c7');
    expect(name).toBe('machvon_bi_0b1c08779aa3');
    expect(isBiLoginName(name)).toBe(true);
    expect(isBiLoginName('machvon_bi_0b1c08779aa3; drop')).toBe(false);
    expect(isBiLoginName('postgres')).toBe(false);
    expect(refusal(() => biLoginName('not-an-id')).detail).toBe('reader');
  });

  it('reads the request for a login with a bounded number of connections', () => {
    expect(biReaderRequestOf({ name: ' Power BI ', tool: 'Power BI Desktop' })).toEqual({ name: 'Power BI', tool: 'Power BI Desktop', connectionLimit: 5 });
    expect(refusal(() => biReaderRequestOf({ name: 'x', connection_limit: 21 })).detail).toBe('connection_limit');
    expect(refusal(() => biReaderRequestOf({ name: '' })).detail).toBe('name');
  });

  it('moves a login along its life and keeps the retired one retired', () => {
    const reason = 'The workspace was handed to another team';
    expect(biReaderMove({ status: 'ACTIVE' }, { move: 'SUSPEND', reason }).to).toBe('SUSPENDED');
    expect(biReaderMove({ status: 'SUSPENDED' }, { move: 'REACTIVATE', reason }).to).toBe('ACTIVE');
    expect(biReaderMove({ status: 'SUSPENDED' }, { move: 'RETIRE', reason }).to).toBe('RETIRED');
    for (const [status, move] of [['RETIRED', 'REACTIVATE'], ['RETIRED', 'SUSPEND'], ['ACTIVE', 'REACTIVATE']] as const) {
      expect(refusal(() => biReaderMove({ status }, { move, reason })).code).toBe('BI_READER_STATE_INVALID');
    }
  });
});

describe('secrets are made once and kept only as hashes (INT-1)', () => {
  it('makes a client id and a secret of the documented shape, and keeps only the hash', () => {
    const made = generateClientCredentials();
    expect(isClientId(made.clientId)).toBe(true);
    expect(made.clientSecret).toMatch(/^mvs_[A-Za-z0-9_-]{43}$/);
    expect(made.secretHash).toBe(hashClientSecret(made.clientSecret));
    expect(made.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(made.secretHint).toHaveLength(8);
    expect(made.clientSecret.startsWith(made.secretHint)).toBe(true);
    expect(JSON.stringify({ ...made, clientSecret: undefined })).not.toContain(made.clientSecret);
    expect(generateClientCredentials().clientSecret).not.toBe(made.clientSecret);
  });

  it('verifies a presented secret in constant time and refuses anything of the wrong shape', () => {
    const made = generateClientCredentials();
    expect(verifyClientSecret(made.clientSecret, made.secretHash)).toBe(true);
    expect(verifyClientSecret(`${made.clientSecret.slice(0, -1)}A`, made.secretHash)).toBe(made.clientSecret.endsWith('A'));
    expect(verifyClientSecret('mvs_short', made.secretHash)).toBe(false);
    expect(verifyClientSecret(made.clientSecret, 'not a hash')).toBe(false);
    expect(verifyClientSecret(undefined, made.secretHash)).toBe(false);
    expect(verifyClientSecret(made.secretHash, made.secretHash)).toBe(false);
  });

  it('makes the scripted randomness reproducible, so the format is pinned', () => {
    const fixed = (size: number): Uint8Array => new Uint8Array(size).fill(7);
    const made = generateClientCredentials(fixed);
    expect(made.clientId).toBe('mvc_a4dqobyha4dqobyha4dqobyha4');
    expect(made.clientSecret).toBe(`mvs_${Buffer.alloc(32, 7).toString('base64url')}`);
  });

  it('writes the SCRAM-SHA-256 verifier PostgreSQL stores, for a fixed salt', () => {
    const salt = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
    const verifier = scramVerifierOf('pencil', salt, 4096);
    expect(verifier).toMatch(/^SCRAM-SHA-256\$4096:W22ZaJ0SNY7soEsUEjb6gQ==\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$/);
    expect(isScramVerifier(verifier)).toBe(true);
    expect(scramVerifierOf('pencil', salt, 4096)).toBe(verifier);
    expect(scramVerifierOf('pencil2', salt, 4096)).not.toBe(verifier);
    expect(isScramVerifier("x'; drop role y; --")).toBe(false);
    expect(generateBiPassword()).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });
});

describe('the OpenAPI subset for external readers (INT-1)', () => {
  const full = {
    openapi: '3.0.3',
    paths: {
      '/open/v1/projects': {
        get: { operationId: 'listOpenProjects', 'x-open-api': true, 'x-open-scope': 'open.projects.read', 'x-permission': 'int.secret', 'x-plane': 'tenant', responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/OpenProjectPage' } } } } } },
      },
      '/open/v1/token': { post: { operationId: 'issueOpenApiToken', 'x-open-api': true, requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/OpenTokenRequest' } } } }, responses: { '200': { description: 'ok' } } } },
      '/projects': { get: { operationId: 'listProjects', 'x-permission': 'project.read', responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/InternalOnly' } } } } } } },
    },
    components: {
      schemas: {
        OpenProjectPage: { type: 'object', properties: { items: { type: 'array', items: { $ref: '#/components/schemas/OpenProject' } } } },
        OpenProject: { type: 'object', properties: { code: { type: 'string' } } },
        OpenTokenRequest: { type: 'object' },
        InternalOnly: { type: 'object', properties: { secret: { type: 'string' } } },
      },
    },
  };

  it('lists the marked operations only, with their schemas and without the internal markers', () => {
    const subset = openApiSubsetOf(full, { title: 'Open API', version: '1.0.0', description: 'for readers' });
    expect(Object.keys(subset.document.paths as object)).toEqual(['/open/v1/projects', '/open/v1/token']);
    expect(Object.keys((subset.document.components as { schemas: object }).schemas)).toEqual(['OpenProject', 'OpenProjectPage', 'OpenTokenRequest']);
    expect(JSON.stringify(subset.document)).not.toMatch(/int\.secret|x-permission|x-plane|InternalOnly|x-open-api/);
    expect(subset.operations).toEqual([
      { id: 'listOpenProjects', method: 'get', path: '/open/v1/projects', scope: 'open.projects.read' },
      { id: 'issueOpenApiToken', method: 'post', path: '/open/v1/token', scope: null },
    ]);
    const security = (subset.document.components as { securitySchemes: { clientCredentials: { flows: { clientCredentials: { scopes: object } } } } }).securitySchemes;
    expect(Object.keys(security.clientCredentials.flows.clientCredentials.scopes)).toEqual(['open.projects.read']);
    const token = (subset.document.paths as Record<string, { post?: { security: unknown } }>)['/open/v1/token']?.post;
    expect(token?.security).toEqual([]);
  });
});
