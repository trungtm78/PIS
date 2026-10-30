import { createPrivateKey } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const FIELD_KEY_BYTES = 32;

/** Whether the value is the list of master keys of the personal data: `id:base64` pairs, each key of 32 bytes, each id a whole number from 1 to 255 used once. */
function validFieldKeys(value: string): boolean {
  const ids = new Set<number>();
  return value.split(',').every((part) => {
    const [id, encoded, ...rest] = part.trim().split(':');
    const number = Number(id);
    if (rest.length > 0 || encoded === undefined || !Number.isInteger(number) || number < 1 || number > 255 || ids.has(number)) return false;
    ids.add(number);
    return /^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded) && Buffer.from(encoded, 'base64').length === FIELD_KEY_BYTES;
  });
}

export type TelemetryExporterKind = 'none' | 'console' | 'otlp';

export interface Config {
  port: number;
  /** One connection string per database role (no role may use another's). */
  databaseUrls: { app: string; control: string; outboxRelay: string };
  oidc: { issuer: string; identityAudience: string; controlAudience: string; jwksUri: string | undefined };
  tenantToken: { issuer: string; signingKeyPem: string; keyId: string; retired: { pem: string; keyId: string } | undefined };
  /** Signs the worker context of outbox deliveries; at least 32 bytes. */
  outboxSigningKey: Buffer;
  corsOrigins: readonly string[];
  /** The public origin of the web application: what the links in the messages to people are made whole with (ST-OMNI-005); none means a message that carries a link is not sent. */
  webBaseUrl: string | undefined;
  maxBodyBytes: number;
  shutdownTimeoutMs: number;
  /** Where the SQL migrations are read from to tell whether the schema is up to date. */
  migrationsDir: string;
  /** The error code registry (error_codes.json of the design pack) the problem responses are built from. */
  errorCodesPath: string;
  /** Where operations alerts are delivered besides the log (a chat or pager webhook); optional. */
  alertWebhookUrl: string | undefined;
  telemetry: { exporter: TelemetryExporterKind; otlpEndpoint: string | undefined; serviceName: string };
  /**
   * Whether this process runs the background workers (the outbox relay, the scheduled jobs). Several processes may run
   * them: each job has one owner at a time (database advisory lock). Switch it off for a process that only serves requests.
   */
  workersEnabled: boolean;
  /** Where the license signing key (the provisioning saga issues the pilot license with it) is read from; the key is read when first needed. */
  licenseKeys: { keyId: string | undefined; keyPath: string | undefined; retiredKeyId: string | undefined; retiredPublicKeyPath: string | undefined };
}

export interface ConfigProblem {
  name: string;
  /** What is wrong, never the value (a value can be a secret). */
  problem: 'missing' | 'malformed';
  expected: string;
}

/** Every missing or malformed variable at once, so an operator fixes the environment in one pass. Messages carry names only. */
export class ConfigError extends Error {
  readonly problems: readonly ConfigProblem[];

  constructor(problems: readonly ConfigProblem[]) {
    super(`invalid configuration: ${problems.map((entry) => `${entry.name} is ${entry.problem} (expected ${entry.expected})`).join('; ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

/** How the loader reads a key file; tests give their own. */
export interface ConfigIo {
  readText(path: string): string;
  /**
   * The absolute path of a repository file or folder (given relative to the repository root), or undefined when it is
   * not found. The defaults of the resource paths come from here, so they do not depend on the directory the process
   * was started in (`npm start -w @machvon/api` runs in apps/api).
   */
  locate?(relativePath: string): string | undefined;
}

/** The nearest ancestor of `start` (itself included) in which `relativePath` exists, joined with it; undefined when none has it. */
export function locateUpwards(relativePath: string, start: string, exists: (path: string) => boolean = existsSync): string | undefined {
  let directory = start;
  for (;;) {
    const candidate = join(directory, relativePath);
    if (exists(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

const fileIo: ConfigIo = {
  readText: (path) => readFileSync(path, 'utf8'),
  locate: (relativePath) => locateUpwards(relativePath, process.cwd()),
};

const DEFAULT_MIGRATIONS_DIR = 'db/migrations';
const DEFAULT_ERROR_CODES_PATH = 'Design/MACHVON_Design/03_Engineering/error_codes.json';

const MIN_OUTBOX_KEY_BYTES = 32;
const DEFAULT_PORT = 3000;
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const MAX_BODY_BYTES_LIMIT = 52_428_800;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;
const MAX_SHUTDOWN_TIMEOUT_MS = 120_000;

function urlWith(value: string, protocols: readonly string[]): boolean {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function integerIn(value: string, min: number, max: number): number | undefined {
  if (!/^[0-9]{1,9}$/.test(value)) return undefined;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : undefined;
}

function ecP256(pem: string): boolean {
  try {
    const key = createPrivateKey(pem);
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
  } catch {
    return false;
  }
}

/**
 * Validates the environment and returns the typed configuration, or throws one ConfigError that lists every problem.
 * Secrets (database URLs, the signing keys) are only checked for shape; their values never appear in a message.
 */
export function loadConfig(env: Env, io: ConfigIo = fileIo): Config {
  const problems: ConfigProblem[] = [];
  const fail = (name: string, problem: ConfigProblem['problem'], expected: string): undefined => {
    problems.push({ name, problem, expected });
    return undefined;
  };
  const read = (name: string): string | undefined => {
    const value = env[name];
    return value === undefined || value.trim() === '' ? undefined : value.trim();
  };
  const required = (name: string, expected: string, valid: (value: string) => boolean): string | undefined => {
    const value = read(name);
    if (value === undefined) return fail(name, 'missing', expected);
    return valid(value) ? value : fail(name, 'malformed', expected);
  };
  const optional = <T>(name: string, fallback: T, expected: string, parse: (value: string) => T | undefined): T => {
    const value = read(name);
    if (value === undefined) return fallback;
    return parse(value) ?? (fail(name, 'malformed', expected) as undefined) ?? fallback;
  };

  const postgres = (value: string): boolean => urlWith(value, ['postgres:', 'postgresql:']);
  const app = required('DATABASE_URL_APP', 'a postgres:// URL for the machvon_app role', postgres);
  const control = required('DATABASE_URL_CONTROL', 'a postgres:// URL for the machvon_control role', postgres);
  const outboxRelay = required('DATABASE_URL_OUTBOX_RELAY', 'a postgres:// URL for the machvon_outbox_relay role', postgres);
  const issuer = required('OIDC_ISSUER', 'an https:// URL (http:// only for localhost)', (value) => urlWith(value, ['https:']) || /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(value));
  const identityAudience = required('OIDC_IDENTITY_AUDIENCE', 'the client id of the web and mobile applications', () => true);
  const controlAudience = required('OIDC_CONTROL_AUDIENCE', 'the client id of the control plane', () => true);
  const tenantIssuer = required('TENANT_TOKEN_ISSUER', 'an https:// URL naming this API', (value) => urlWith(value, ['https:', 'http:']));
  const keyIdShape = 'a key id of 1 to 64 letters, digits, dots, dashes or underscores';
  const validKeyId = (value: string): boolean => /^[A-Za-z0-9._-]{1,64}$/.test(value);
  const keyFile = (name: string, value: string): string | undefined => {
    try {
      const pem = io.readText(value);
      return ecP256(pem) ? pem : fail(name, 'malformed', 'a path to an EC P-256 private key in PEM form');
    } catch {
      return fail(name, 'malformed', 'a path to a readable EC P-256 private key in PEM form');
    }
  };
  const signingKeyPath = required('TENANT_TOKEN_SIGNING_KEY_PEM_PATH', 'a path to an EC P-256 private key in PEM form', () => true);
  const signingKeyPem = signingKeyPath === undefined ? undefined : keyFile('TENANT_TOKEN_SIGNING_KEY_PEM_PATH', signingKeyPath);
  const keyId = required('TENANT_TOKEN_KEY_ID', keyIdShape, validKeyId);
  const retiredPath = read('TENANT_TOKEN_RETIRED_KEY_PEM_PATH');
  const retiredId = read('TENANT_TOKEN_RETIRED_KEY_ID');
  let retired: Config['tenantToken']['retired'];
  if (retiredPath !== undefined || retiredId !== undefined) {
    const pem = retiredPath === undefined ? fail('TENANT_TOKEN_RETIRED_KEY_PEM_PATH', 'missing', 'a path to the previous key when TENANT_TOKEN_RETIRED_KEY_ID is set') : keyFile('TENANT_TOKEN_RETIRED_KEY_PEM_PATH', retiredPath);
    const id = retiredId === undefined ? fail('TENANT_TOKEN_RETIRED_KEY_ID', 'missing', 'the previous key id when TENANT_TOKEN_RETIRED_KEY_PEM_PATH is set') : validKeyId(retiredId) ? retiredId : fail('TENANT_TOKEN_RETIRED_KEY_ID', 'malformed', keyIdShape);
    if (pem !== undefined && id !== undefined) retired = { pem, keyId: id };
  }
  const jwksUri = read('OIDC_JWKS_URI');
  if (jwksUri !== undefined && !urlWith(jwksUri, ['https:', 'http:'])) fail('OIDC_JWKS_URI', 'malformed', 'an http(s) URL; leave it out to discover it from the issuer');
  const outboxSigningKey = required('OUTBOX_SIGNING_KEY', `base64 of at least ${MIN_OUTBOX_KEY_BYTES} bytes`, (value) => /^[A-Za-z0-9+/_-]+={0,2}$/.test(value) && Buffer.from(value, 'base64').length >= MIN_OUTBOX_KEY_BYTES);

  // The master keys of the personal data are read by the module that seals it, straight from the environment; a value that is there is judged now, so that a mistake stops the start and not the first registration.
  const fieldKeys = read('FIELD_ENCRYPTION_KEYS');
  if (fieldKeys !== undefined && !validFieldKeys(fieldKeys)) fail('FIELD_ENCRYPTION_KEYS', 'malformed', 'pairs id:base64 of master keys of 32 bytes (id 1 to 255), separated by commas; leave it out to run without personal data');

  const port = optional('PORT', DEFAULT_PORT, 'a port from 1 to 65535', (value) => integerIn(value, 1, 65_535));
  const maxBodyBytes = optional('MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES, `a size from 1 to ${MAX_BODY_BYTES_LIMIT}`, (value) => integerIn(value, 1, MAX_BODY_BYTES_LIMIT));
  const shutdownTimeoutMs = optional('SHUTDOWN_TIMEOUT_MS', DEFAULT_SHUTDOWN_TIMEOUT_MS, `milliseconds from 100 to ${MAX_SHUTDOWN_TIMEOUT_MS}`, (value) => integerIn(value, 100, MAX_SHUTDOWN_TIMEOUT_MS));
  const corsOrigins = optional<readonly string[]>('CORS_ORIGINS', [], 'comma-separated origins such as https://app.example.test (no *)', (value) => {
    const origins = value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
    return origins.every((origin) => urlWith(origin, ['https:', 'http:']) && new URL(origin).origin === origin) ? origins : undefined;
  });
  const webBaseUrl = read('WEB_BASE_URL');
  if (webBaseUrl !== undefined && !(urlWith(webBaseUrl, ['https:', 'http:']) && new URL(webBaseUrl).origin === webBaseUrl)) fail('WEB_BASE_URL', 'malformed', 'the origin of the web application such as https://app.example.test (no path)');
  const exporter = optional<TelemetryExporterKind>('TELEMETRY_EXPORTER', 'none', 'none, console or otlp', (value) => (value === 'none' || value === 'console' || value === 'otlp' ? value : undefined));
  const otlpEndpoint = read('OTLP_ENDPOINT');
  if (exporter === 'otlp' && otlpEndpoint === undefined) fail('OTLP_ENDPOINT', 'missing', 'an http(s) URL of the collector when TELEMETRY_EXPORTER is otlp');
  else if (otlpEndpoint !== undefined && !urlWith(otlpEndpoint, ['https:', 'http:'])) fail('OTLP_ENDPOINT', 'malformed', 'an http(s) URL of the collector');

  const workersEnabled = optional('WORKERS_ENABLED', true, 'true, false, 1 or 0', (value) => {
    const word = value.toLowerCase();
    if (word === 'true' || word === '1') return true;
    return word === 'false' || word === '0' ? false : undefined;
  });

  const alertWebhookUrl = read('ALERT_WEBHOOK_URL');
  if (alertWebhookUrl !== undefined && !urlWith(alertWebhookUrl, ['https:', 'http:'])) fail('ALERT_WEBHOOK_URL', 'malformed', 'an http(s) URL of the alert webhook');

  if (problems.length > 0) throw new ConfigError(problems);
  return {
    port,
    databaseUrls: { app: app as string, control: control as string, outboxRelay: outboxRelay as string },
    oidc: { issuer: issuer as string, identityAudience: identityAudience as string, controlAudience: controlAudience as string, jwksUri },
    tenantToken: { issuer: tenantIssuer as string, signingKeyPem: signingKeyPem as string, keyId: keyId as string, retired },
    outboxSigningKey: Buffer.from(outboxSigningKey as string, 'base64'),
    corsOrigins,
    webBaseUrl,
    maxBodyBytes,
    shutdownTimeoutMs,
    // A default is looked for from the working directory upwards; when it is nowhere, the relative name stays and the
    // startup failure (or the readiness probe) names the file that is missing.
    migrationsDir: read('MIGRATIONS_DIR') ?? io.locate?.(DEFAULT_MIGRATIONS_DIR) ?? DEFAULT_MIGRATIONS_DIR,
    errorCodesPath: read('ERROR_CODES_PATH') ?? io.locate?.(DEFAULT_ERROR_CODES_PATH) ?? DEFAULT_ERROR_CODES_PATH,
    alertWebhookUrl,
    telemetry: { exporter, otlpEndpoint, serviceName: read('OTEL_SERVICE_NAME') ?? 'machvon-api' },
    workersEnabled,
    licenseKeys: {
      keyId: read('LICENSE_SIGNING_KEY_ID'),
      keyPath: read('LICENSE_SIGNING_KEY_PEM_PATH'),
      retiredKeyId: read('LICENSE_RETIRED_KEY_ID'),
      retiredPublicKeyPath: read('LICENSE_RETIRED_KEY_PUBLIC_PEM_PATH'),
    },
  };
}
