import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { EMPTY_CONNECTOR, connectorBody, describeProblem, inRegisterOrder, mayBeActive, parseConfig, toConnector, validateConnector } from './model';
import type { ConnectorValues } from './model';

const ROW = {
  id: 'c1',
  connector_code: 'treasury-file',
  adapter_status: 'PROPOSED',
  mode: 'FILE_IMPORT',
  config: { directory: '/inbox', encoding: 'UTF-8' },
  credential_secret_ref: 'secret://production/connectors/treasury',
  mapping_version: 'v1',
  status: 'Draft',
  last_test_at: null,
  last_test_result: null,
  version: 1,
};

const valid = (overrides: Partial<ConnectorValues> = {}): ConnectorValues => ({ ...EMPTY_CONNECTOR, connectorCode: 'treasury-file', ...overrides });

describe('toConnector', () => {
  it('reads a connector of the register and shows the names of its configuration, never the values', () => {
    expect(toConnector(ROW)).toEqual({
      id: 'c1',
      connectorCode: 'treasury-file',
      adapterStatus: 'PROPOSED',
      mode: 'FILE_IMPORT',
      configKeys: ['directory', 'encoding'],
      credentialSecretRef: 'secret://production/connectors/treasury',
      mappingVersion: 'v1',
      status: 'Draft',
      lastTestAt: null,
      lastTestResult: null,
      version: 1,
    });
    expect(toConnector({ ...ROW, config: undefined, credential_secret_ref: null, mapping_version: undefined })).toMatchObject({ configKeys: [], credentialSecretRef: null, mappingVersion: null });
    expect(JSON.stringify(toConnector(ROW))).not.toContain('/inbox');
  });

  it.each([
    ['not an object', 'x'],
    ['an array', []],
    ['no id', { ...ROW, id: undefined }],
    ['no code', { ...ROW, connector_code: '' }],
    ['an unknown adapter status', { ...ROW, adapter_status: 'LIVE' }],
    ['no adapter status', { ...ROW, adapter_status: undefined }],
    ['an unknown mode', { ...ROW, mode: 'CARRIER_PIGEON' }],
    ['an unknown status', { ...ROW, status: 'Retired' }],
    ['a version that is not a number', { ...ROW, version: '1' }],
  ])('drops a connector with %s: a row is never shown half', (_name, raw) => {
    expect(toConnector(raw)).toBeUndefined();
  });
});

describe('what a connector may be made Active with (BR-ADM-10)', () => {
  it('lets only a VERIFIED or a MOCK adapter be offered for activation', () => {
    expect(mayBeActive('VERIFIED')).toBe(true);
    expect(mayBeActive('MOCK')).toBe(true);
    expect(mayBeActive('PROPOSED')).toBe(false);
    expect(mayBeActive('MISSING')).toBe(false);
  });
});

describe('parseConfig', () => {
  it('reads one JSON object', () => {
    expect(parseConfig('{}')).toEqual({ config: {} });
    expect(parseConfig('{"directory": "/inbox", "retries": 3}')).toEqual({ config: { directory: '/inbox', retries: 3 } });
  });

  it('refuses text that is not JSON, JSON that is not an object, a secret at any depth and a configuration that is too large', () => {
    for (const source of ['', '{', 'directory=/inbox', '[]', '"text"', 'null', '7']) expect(parseConfig(source)).toEqual({ problem: 'configJson' });
    for (const source of ['{"password":"x"}', '{"auth":{"apiKey":"x"}}', '{"list":[{"token":"x"}]}', '{"client_secret":"x"}', '{"Authorization":"x"}', '{"credentials":{}}']) {
      expect(parseConfig(source)).toEqual({ problem: 'configSecret' });
    }
    expect(parseConfig(JSON.stringify({ note: 'x'.repeat(20_000) }))).toEqual({ problem: 'configSize' });
    let deep = '{"leaf": true}';
    for (let level = 0; level < 12; level += 1) deep = `{"next": ${deep}}`;
    expect(parseConfig(deep)).toEqual({ config: JSON.parse(deep) });
  });
});

describe('validateConnector', () => {
  it('accepts the declaration of a draft with the defaults', () => {
    expect(validateConnector(valid())).toEqual({});
    expect(validateConnector(valid({ credentialSecretRef: 'secret://production/x', mappingVersion: 'v1.2', config: '{"directory":"/in"}' }))).toEqual({});
  });

  it('wants a code of the shape of the contract, a configuration that holds no secret, a credential that is a reference and a clean mapping version', () => {
    expect(validateConnector(EMPTY_CONNECTOR)).toEqual({ connectorCode: 'required' });
    for (const code of ['AB', 'ab', 'Has Capital', 'x'.repeat(61), 'with space']) expect(validateConnector(valid({ connectorCode: code }))).toEqual({ connectorCode: 'code' });
    expect(validateConnector(valid({ config: '{"password":"x"}' }))).toEqual({ config: 'configSecret' });
    expect(validateConnector(valid({ config: 'not json' }))).toEqual({ config: 'configJson' });
    expect(validateConnector(valid({ credentialSecretRef: 'hunter2' }))).toEqual({ credentialSecretRef: 'credential' });
    expect(validateConnector(valid({ mappingVersion: 'no spaces' }))).toEqual({ mappingVersion: 'mapping' });
  });

  it('builds the body of createIntegrationConnector, trimmed, without the optional members that were left empty', () => {
    expect(connectorBody(valid({ connectorCode: ' treasury-file ' }))).toEqual({ connector_code: 'treasury-file', mode: 'FILE_IMPORT', adapter_status: 'PROPOSED', config: {} });
    expect(connectorBody(valid({ mode: 'LGSP', adapterStatus: 'MOCK', config: '{"a":1}', credentialSecretRef: ' secret://x/y ', mappingVersion: ' v2 ' }))).toEqual({
      connector_code: 'treasury-file',
      mode: 'LGSP',
      adapter_status: 'MOCK',
      config: { a: 1 },
      credential_secret_ref: 'secret://x/y',
      mapping_version: 'v2',
    });
    expect(connectorBody(valid({ config: 'broken' })).config).toEqual({});
  });
});

describe('describeProblem and inRegisterOrder', () => {
  const failure = (code: string, status = 422, detail?: string) => new ApiError({ status, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }) });

  it('says which rule refused an activation, and maps the other codes', () => {
    expect(describeProblem(failure('CONNECTOR_NOT_ACTIVATABLE', 422, 'MOCK_IN_PRODUCTION')).reason).toBe('mockInProduction');
    expect(describeProblem(failure('CONNECTOR_NOT_ACTIVATABLE', 422, 'ADAPTER_NOT_VERIFIED')).reason).toBe('adapterNotVerified');
    expect(describeProblem(failure('CONNECTOR_NOT_ACTIVATABLE')).reason).toBe('adapterNotVerified');
    expect(describeProblem(failure('CONNECTOR_CODE_TAKEN', 409)).reason).toBe('codeTaken');
    expect(describeProblem(failure('VALIDATION_FAILED')).reason).toBe('invalid');
    expect(describeProblem(failure('INVALID_REQUEST', 400)).reason).toBe('invalid');
    expect(describeProblem(failure('VERSION_CONFLICT', 409)).reason).toBe('conflict');
    expect(describeProblem(failure('RESOURCE_NOT_FOUND', 404)).reason).toBe('notFound');
    expect(describeProblem(failure('SCOPE_DENIED', 403)).reason).toBe('denied');
    expect(describeProblem(failure('ENTITLEMENT_DENIED', 403)).reason).toBe('denied');
    expect(describeProblem(failure('SESSION_EXPIRED', 401)).reason).toBe('session');
    expect(describeProblem(failure('OTHER', 500)).reason).toBe('general');
    expect(describeProblem(new Error('x')).reason).toBe('general');
  });

  it('orders the register by code', () => {
    const make = (code: string) => toConnector({ ...ROW, id: code, connector_code: code }) as NonNullable<ReturnType<typeof toConnector>>;
    expect(inRegisterOrder([make('b-code'), make('a-code'), make('c-code')]).map((connector) => connector.connectorCode)).toEqual(['a-code', 'b-code', 'c-code']);
  });
});
