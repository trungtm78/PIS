import { DomainError } from './errors.ts';

/**
 * Integration connectors (ST-ADM-018, ADM 3.13, BR-ADM-10). The verdict on the adapter of a connector is a fact about the format of the agency
 * on the other side, not a setting: VERIFIED when the agency has confirmed it, PROPOSED when the format is a proposal waiting for a contract,
 * MOCK for a test adapter, MISSING when there is none. The same four words are used by the integration cursors of master data (ST-MDM-007).
 */
export const ADAPTER_STATUSES = ['VERIFIED', 'PROPOSED', 'MOCK', 'MISSING'] as const;
export type AdapterStatus = (typeof ADAPTER_STATUSES)[number];

export const CONNECTOR_MODES = ['FILE_IMPORT', 'FILE_EXPORT', 'API', 'LGSP'] as const;
export type ConnectorMode = (typeof CONNECTOR_MODES)[number];

export type ConnectorStatus = 'Draft' | 'Active' | 'Disabled';

/** The deployment environments of infra/environments in which real data lives: a test adapter never runs there. */
export const PRODUCTION_ENVIRONMENTS: readonly string[] = ['production', 'dr'];
const KNOWN_ENVIRONMENTS: readonly string[] = ['production', 'dr', 'staging', 'ci', 'test', 'local'];

/** Whether the environment holds real data. An environment that is not named is taken as production: the safe answer. */
export function isProductionEnvironment(environment: string | undefined): boolean {
  return environment === undefined || !KNOWN_ENVIRONMENTS.includes(environment) || PRODUCTION_ENVIRONMENTS.includes(environment);
}

export type ActivationBlock = 'ADAPTER_NOT_VERIFIED' | 'MOCK_IN_PRODUCTION';

/**
 * Why a connector with this adapter may not be Active, or undefined when it may: only VERIFIED and MOCK can be Active (the database CHECK says the
 * same), and MOCK only outside production. PROPOSED and MISSING are never Active: no connector claims to be live without a verified adapter.
 */
export function activationBlock(adapter: AdapterStatus, environment: string | undefined): ActivationBlock | undefined {
  if (adapter === 'VERIFIED') return undefined;
  if (adapter === 'MOCK') return isProductionEnvironment(environment) ? 'MOCK_IN_PRODUCTION' : undefined;
  return 'ADAPTER_NOT_VERIFIED';
}

/** Throws 422 CONNECTOR_NOT_ACTIVATABLE; the detail names the reason, never a value. */
export function assertActivatable(adapter: AdapterStatus, environment: string | undefined): void {
  const block = activationBlock(adapter, environment);
  if (block !== undefined) throw new DomainError('CONNECTOR_NOT_ACTIVATABLE', 422, block);
}

const SECRET_KEY = /pass(word)?|secret|token|authorization|api[_-]?key|private[_-]?key|credential/i;
const MAX_DEPTH = 8;
const MAX_CONFIG_BYTES = 16_384;
const MAX_REFERENCE = 200;
// The vault of the platform names its entries secret://<environment>/<path> (infra/environments).
const SECRET_REFERENCE = /^secret:\/\/[a-z0-9][a-z0-9._/-]*$/;

/** The paths of the members of a configuration whose name says it holds a secret; the configuration of a connector never carries one (vault reference only). */
export function secretKeysIn(config: unknown, path = ''): string[] {
  if (typeof config !== 'object' || config === null) return [];
  if (path.split('.').length > MAX_DEPTH) return [path];
  const found: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    const here = path === '' ? key : `${path}.${key}`;
    if (SECRET_KEY.test(key)) found.push(here);
    else found.push(...secretKeysIn(value, here));
  }
  return found;
}

/** Whether a string is a reference to an entry of the vault, which is all a connector may hold of a credential. */
export function isVaultReference(reference: string): boolean {
  return reference.length <= MAX_REFERENCE && SECRET_REFERENCE.test(reference);
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** The rules of the configuration of a connector that the request schema cannot state; the detail names the field. */
export function assertConnectorSettings(settings: { config?: unknown; credentialSecretRef?: string | undefined; mappingVersion?: string | undefined }): void {
  if (settings.config !== undefined) {
    if (typeof settings.config !== 'object' || settings.config === null || Array.isArray(settings.config)) throw invalid('config');
    if (Buffer.byteLength(JSON.stringify(settings.config)) > MAX_CONFIG_BYTES || secretKeysIn(settings.config).length > 0) throw invalid('config');
  }
  if (settings.credentialSecretRef !== undefined && !isVaultReference(settings.credentialSecretRef)) throw invalid('credential_secret_ref');
  if (settings.mappingVersion !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/.test(settings.mappingVersion)) throw invalid('mapping_version');
}

const TRANSITIONS: Readonly<Record<ConnectorStatus, readonly ConnectorStatus[]>> = {
  Draft: ['Active', 'Disabled'],
  Active: ['Disabled'],
  Disabled: ['Active', 'Draft'],
};

/** Whether a connector may move from one status to another; staying where it is is not a move. */
export function mayMove(from: ConnectorStatus, to: ConnectorStatus): boolean {
  return TRANSITIONS[from].includes(to);
}
