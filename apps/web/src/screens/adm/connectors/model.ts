import { ApiError } from '@machvon/api-client';
import type { AdapterStatus } from '../../mdm/model';

/** Permission of both commands of ADM-09 (x-permission in openapi.json). */
export const MANAGE_CONNECTOR_PERMISSION = 'adm.integration.manage';
export const REASON_MIN_LENGTH = 10;
export const REASON_MAX_LENGTH = 2000;
const MAX_CONFIG_BYTES = 16_384;

/** The words for the verdict on an adapter are those of the integration cursors of master data: one vocabulary, one table of truth. */
export const ADAPTER_STATUSES: readonly AdapterStatus[] = ['VERIFIED', 'PROPOSED', 'MOCK', 'MISSING'];
export type ConnectorMode = 'FILE_IMPORT' | 'FILE_EXPORT' | 'API' | 'LGSP';
export const CONNECTOR_MODES: readonly ConnectorMode[] = ['FILE_IMPORT', 'FILE_EXPORT', 'API', 'LGSP'];
export type ConnectorStatus = 'Draft' | 'Active' | 'Disabled';
const CONNECTOR_STATUSES: readonly string[] = ['Draft', 'Active', 'Disabled'];

const CODE = /^[a-z0-9_.-]{3,60}$/;
const SECRET_REFERENCE = /^secret:\/\/[a-z0-9][a-z0-9._/-]*$/;
const MAPPING_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;
const SECRET_KEY = /pass(word)?|secret|token|authorization|api[_-]?key|private[_-]?key|credential/i;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** Whether the adapter can ever be Active: only a VERIFIED one, or a MOCK one outside production; the others are kept but never run. */
export function mayBeActive(adapter: AdapterStatus): boolean {
  return adapter === 'VERIFIED' || adapter === 'MOCK';
}

export interface ConnectorView {
  id: string;
  connectorCode: string;
  adapterStatus: AdapterStatus;
  mode: ConnectorMode;
  /** The names of the members of the configuration; the values are the business of the connector, not of the list. */
  configKeys: string[];
  credentialSecretRef: string | null;
  mappingVersion: string | null;
  status: ConnectorStatus;
  lastTestAt: string | null;
  lastTestResult: string | null;
  version: number;
}

/** One connector as the read of the register returns it; a row that lacks what the table shows is dropped, never shown half. */
export function toConnector(raw: unknown): ConnectorView | undefined {
  if (!isRecord(raw)) return undefined;
  const id = text(raw.id);
  const connectorCode = text(raw.connector_code);
  const adapter = text(raw.adapter_status);
  const mode = text(raw.mode);
  const status = text(raw.status);
  if (id === undefined || connectorCode === undefined || adapter === undefined || mode === undefined || status === undefined || typeof raw.version !== 'number') return undefined;
  if (!(ADAPTER_STATUSES as readonly string[]).includes(adapter) || !(CONNECTOR_MODES as readonly string[]).includes(mode) || !CONNECTOR_STATUSES.includes(status)) return undefined;
  return {
    id,
    connectorCode,
    adapterStatus: adapter as AdapterStatus,
    mode: mode as ConnectorMode,
    configKeys: isRecord(raw.config) ? Object.keys(raw.config).sort() : [],
    credentialSecretRef: nullableText(raw.credential_secret_ref),
    mappingVersion: nullableText(raw.mapping_version),
    status: status as ConnectorStatus,
    lastTestAt: nullableText(raw.last_test_at),
    lastTestResult: nullableText(raw.last_test_result),
    version: raw.version,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// The form of a connector.

export interface ConnectorValues {
  connectorCode: string;
  mode: ConnectorMode;
  adapterStatus: AdapterStatus;
  /** JSON text of the configuration (an object). */
  config: string;
  credentialSecretRef: string;
  mappingVersion: string;
}

export const EMPTY_CONNECTOR: ConnectorValues = { connectorCode: '', mode: 'FILE_IMPORT', adapterStatus: 'PROPOSED', config: '{}', credentialSecretRef: '', mappingVersion: '' };

export type ConnectorField = keyof ConnectorValues;
export type ConnectorProblem = 'required' | 'code' | 'configJson' | 'configSecret' | 'configSize' | 'credential' | 'mapping';
export type ConnectorErrors = Partial<Record<ConnectorField, ConnectorProblem>>;

function secretKeysIn(value: unknown, depth = 0): boolean {
  if (typeof value !== 'object' || value === null || depth > 8) return false;
  return Object.entries(value).some(([key, member]) => SECRET_KEY.test(key) || secretKeysIn(member, depth + 1));
}

/** The configuration typed in the box, or the reason it cannot be sent. */
export function parseConfig(source: string): { config: Record<string, unknown> } | { problem: 'configJson' | 'configSecret' | 'configSize' } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { problem: 'configJson' };
  }
  if (!isRecord(parsed)) return { problem: 'configJson' };
  if (secretKeysIn(parsed)) return { problem: 'configSecret' };
  if (new TextEncoder().encode(JSON.stringify(parsed)).length > MAX_CONFIG_BYTES) return { problem: 'configSize' };
  return { config: parsed };
}

/** The rules of the server that the form can state, so the mistakes a person can see never leave the screen. */
export function validateConnector(values: ConnectorValues): ConnectorErrors {
  const errors: ConnectorErrors = {};
  const code = values.connectorCode.trim();
  if (code === '') errors.connectorCode = 'required';
  else if (!CODE.test(code)) errors.connectorCode = 'code';
  const parsed = parseConfig(values.config);
  if ('problem' in parsed) errors.config = parsed.problem;
  const credential = values.credentialSecretRef.trim();
  if (credential !== '' && !SECRET_REFERENCE.test(credential)) errors.credentialSecretRef = 'credential';
  const mapping = values.mappingVersion.trim();
  if (mapping !== '' && !MAPPING_VERSION.test(mapping)) errors.mappingVersion = 'mapping';
  return errors;
}

export interface ConnectorBody {
  connector_code: string;
  mode: ConnectorMode;
  adapter_status: AdapterStatus;
  /** The contract types the configuration as an object with no named member, which is how it is written here. */
  config: Record<string, never>;
  credential_secret_ref?: string;
  mapping_version?: string;
}

/** The body of createIntegrationConnector for values that passed `validateConnector`. */
export function connectorBody(values: ConnectorValues): ConnectorBody {
  const parsed = parseConfig(values.config);
  return {
    connector_code: values.connectorCode.trim(),
    mode: values.mode,
    adapter_status: values.adapterStatus,
    config: ('config' in parsed ? parsed.config : {}) as Record<string, never>,
    ...(values.credentialSecretRef.trim() === '' ? {} : { credential_secret_ref: values.credentialSecretRef.trim() }),
    ...(values.mappingVersion.trim() === '' ? {} : { mapping_version: values.mappingVersion.trim() }),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Failures of the commands.

export type ProblemReason = 'adapterNotVerified' | 'mockInProduction' | 'codeTaken' | 'invalid' | 'conflict' | 'notFound' | 'denied' | 'session' | 'general';

export interface ProblemView {
  reason: ProblemReason;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  CONNECTOR_CODE_TAKEN: 'codeTaken',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  VERSION_CONFLICT: 'conflict',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  SESSION_EXPIRED: 'session',
};

/** Maps the error of a command of ADM-09 to what the screen shows; a refused activation says which rule refused it. */
export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general' };
  if (error.code === 'CONNECTOR_NOT_ACTIVATABLE') return { reason: error.detail === 'MOCK_IN_PRODUCTION' ? 'mockInProduction' : 'adapterNotVerified' };
  return { reason: REASON_BY_CODE[error.code] ?? 'general' };
}

/** The order of the register: by code. */
export function inRegisterOrder(connectors: readonly ConnectorView[]): ConnectorView[] {
  return [...connectors].sort((a, b) => a.connectorCode.localeCompare(b.connectorCode));
}
