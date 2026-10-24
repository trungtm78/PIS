import {
  ADAPTER_STATUSES,
  CONNECTOR_MODES,
  activationBlock,
  assertActivatable,
  assertConnectorSettings,
  isProductionEnvironment,
  isVaultReference,
  mayMove,
  secretKeysIn,
} from './connector.ts';
import type { ConnectorStatus } from './connector.ts';
import { inboxRetryDelaySeconds } from './inbox-policy.ts';

const refusal = (work: () => void): { code?: string; status?: number; detail?: string } => {
  try {
    work();
  } catch (error) {
    return error as { code?: string; status?: number; detail?: string };
  }
  throw new Error('expected a refusal');
};

describe('the vocabulary of connectors', () => {
  it('has the four words of honest adapter status and the four modes of the contract', () => {
    expect([...ADAPTER_STATUSES]).toEqual(['VERIFIED', 'PROPOSED', 'MOCK', 'MISSING']);
    expect([...CONNECTOR_MODES]).toEqual(['FILE_IMPORT', 'FILE_EXPORT', 'API', 'LGSP']);
  });
});

describe('environments', () => {
  it('takes production, the recovery site and any environment it does not know as production', () => {
    for (const name of ['production', 'dr', 'PRODUCTION', 'prod', '', 'unknown']) expect(isProductionEnvironment(name)).toBe(true);
    expect(isProductionEnvironment(undefined)).toBe(true);
    for (const name of ['staging', 'ci', 'test', 'local']) expect(isProductionEnvironment(name)).toBe(false);
  });
});

describe('activation (BR-ADM-10, AC-ST-ADM-018-1)', () => {
  it('lets VERIFIED be Active everywhere and MOCK outside production only', () => {
    expect(activationBlock('VERIFIED', 'production')).toBeUndefined();
    expect(activationBlock('VERIFIED', undefined)).toBeUndefined();
    expect(activationBlock('MOCK', 'staging')).toBeUndefined();
    expect(activationBlock('MOCK', 'local')).toBeUndefined();
    expect(activationBlock('MOCK', 'production')).toBe('MOCK_IN_PRODUCTION');
    expect(activationBlock('MOCK', 'dr')).toBe('MOCK_IN_PRODUCTION');
    expect(activationBlock('MOCK', undefined)).toBe('MOCK_IN_PRODUCTION');
  });

  it('never lets PROPOSED or MISSING be Active, whatever the environment', () => {
    for (const environment of ['production', 'staging', 'local', undefined]) {
      expect(activationBlock('PROPOSED', environment)).toBe('ADAPTER_NOT_VERIFIED');
      expect(activationBlock('MISSING', environment)).toBe('ADAPTER_NOT_VERIFIED');
    }
  });

  it('throws 422 CONNECTOR_NOT_ACTIVATABLE with the reason as the detail', () => {
    expect(refusal(() => assertActivatable('PROPOSED', 'staging'))).toMatchObject({ code: 'CONNECTOR_NOT_ACTIVATABLE', status: 422, detail: 'ADAPTER_NOT_VERIFIED' });
    expect(refusal(() => assertActivatable('MOCK', 'production'))).toMatchObject({ code: 'CONNECTOR_NOT_ACTIVATABLE', status: 422, detail: 'MOCK_IN_PRODUCTION' });
    expect(() => assertActivatable('VERIFIED', 'production')).not.toThrow();
  });
});

describe('what a connector may hold of a secret', () => {
  it('finds a member of the configuration whose name says it holds a secret, at any depth', () => {
    expect(secretKeysIn({ host: 'h', retries: 3 })).toEqual([]);
    expect(secretKeysIn({ password: 'x', nested: { apiKey: 'y', ok: 1, list: [{ token: 'z' }] }, Authorization: 'a' }).sort()).toEqual(['Authorization', 'nested.apiKey', 'nested.list.0.token', 'password']);
    expect(secretKeysIn({ client_secret: 'x', private_key: 'y', credentials: {} }).sort()).toEqual(['client_secret', 'credentials', 'private_key']);
    expect(secretKeysIn('text')).toEqual([]);
    expect(secretKeysIn(null)).toEqual([]);
    let deep: Record<string, unknown> = { leaf: true };
    for (let level = 0; level < 12; level += 1) deep = { next: deep };
    expect(secretKeysIn(deep).length).toBe(1);
  });

  it('accepts a reference to the vault and nothing else as a credential', () => {
    expect(isVaultReference('secret://production/connectors/treasury')).toBe(true);
    expect(isVaultReference('secret://local/platform')).toBe(true);
    for (const text of ['hunter2', 'https://vault.example/x', 'secret://', 'secret://A/B', 'secret://x y', `secret://${'a'.repeat(200)}`, '']) expect(isVaultReference(text)).toBe(false);
  });

  it('refuses a configuration that is not an object, is too large or holds a secret, a credential that is not a reference and a malformed mapping version', () => {
    expect(() => assertConnectorSettings({ config: { host: 'h' }, credentialSecretRef: 'secret://production/x', mappingVersion: 'v1.2' })).not.toThrow();
    expect(() => assertConnectorSettings({})).not.toThrow();
    for (const config of [[], 'text', null, 7]) expect(refusal(() => assertConnectorSettings({ config }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'config' });
    expect(refusal(() => assertConnectorSettings({ config: { note: 'x'.repeat(20_000) } }))).toMatchObject({ detail: 'config' });
    expect(refusal(() => assertConnectorSettings({ config: { auth: { password: 'x' } } }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'config' });
    expect(refusal(() => assertConnectorSettings({ credentialSecretRef: 'hunter2' }))).toMatchObject({ detail: 'credential_secret_ref' });
    expect(refusal(() => assertConnectorSettings({ mappingVersion: ' no spaces ' }))).toMatchObject({ detail: 'mapping_version' });
    expect(refusal(() => assertConnectorSettings({ mappingVersion: 'x'.repeat(61) }))).toMatchObject({ detail: 'mapping_version' });
  });
});

describe('moves between statuses', () => {
  it('lets a draft or a disabled connector become Active, an Active one only be disabled, and never stays where it is', () => {
    const allowed = (from: ConnectorStatus, to: ConnectorStatus): boolean => mayMove(from, to);
    expect(allowed('Draft', 'Active')).toBe(true);
    expect(allowed('Draft', 'Disabled')).toBe(true);
    expect(allowed('Active', 'Disabled')).toBe(true);
    expect(allowed('Disabled', 'Active')).toBe(true);
    expect(allowed('Disabled', 'Draft')).toBe(true);
    expect(allowed('Active', 'Draft')).toBe(false);
    for (const status of ['Draft', 'Active', 'Disabled'] as const) expect(allowed(status, status)).toBe(false);
  });
});

describe('inboxRetryDelaySeconds (ST-ADM-018)', () => {
  it('waits a minute, five minutes and then half an hour', () => {
    expect([1, 2, 3, 4, 9, 10].map(inboxRetryDelaySeconds)).toEqual([60, 300, 1800, 1800, 1800, 1800]);
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => inboxRetryDelaySeconds(bad)).toThrow(RangeError);
  });
});
