import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { objectKey } from '@machvon/kernel';
import type { ObjectStoragePort, ProviderSigningKey, TenantContext } from '@machvon/kernel';
import { FsObjectStorage } from '../../modules/files/fs-object-storage';

/** Injection token of the resolver of the signing keys of a channel account. */
export const WEBHOOK_SECRETS = Symbol('WEBHOOK_SECRETS');
/** Injection token of the store of the raw bodies of provider callbacks. */
export const WEBHOOK_PAYLOADS = Symbol('WEBHOOK_PAYLOADS');

/** Turns a vault reference of a channel account (`webhook_secret_ref`) into the keys the provider may sign with. */
export interface WebhookSecretResolver {
  /** The keys in force (two while a provider rotates), or none when the reference names nothing the process can read. */
  resolve(secretRef: string): Promise<ProviderSigningKey[]>;
}

/**
 * Reads the keys from the environment of the process until the vault of the platform exists: `secret://<environment>/<path>` is the variable
 * `MACHVON_SECRET_<ENVIRONMENT>_<PATH>` (upper case, every other character an underscore) holding `keyId:secret`, several separated by commas.
 * A reference that is not set resolves to no key, so every callback for that account is refused (401): nothing is ever accepted unsigned.
 */
export class EnvironmentWebhookSecrets implements WebhookSecretResolver {
  constructor(private readonly environment: Readonly<Record<string, string | undefined>> = process.env) {}

  resolve(secretRef: string): Promise<ProviderSigningKey[]> {
    const name = `MACHVON_SECRET_${secretRef.replace(/^secret:\/\//, '').replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
    const value = this.environment[name];
    if (value === undefined || value === '') return Promise.resolve([]);
    const keys = value.split(',').flatMap((entry) => {
      const separator = entry.indexOf(':');
      const keyId = entry.slice(0, separator).trim();
      const secret = entry.slice(separator + 1);
      return separator > 0 && secret !== '' ? [{ keyId, secret: Buffer.from(secret, 'utf8') }] : [];
    });
    return Promise.resolve(keys);
  }
}

/** Where the raw body of a verified callback is kept: the inbox keeps its hash and the reference, never the body (NOT 9, BR-OMNI-04). */
export interface WebhookPayloadStore {
  /** Stores the body under a key that depends on the provider and the event id only, so a repeat of the event does not store a second copy. */
  put(tenant: TenantContext, provider: string, eventKey: string, rawBody: Buffer): Promise<string>;
  /** The body a reference names, or undefined when it is gone (purged by retention). */
  read(tenant: TenantContext, reference: string): Promise<Buffer | undefined>;
}

const PAYLOAD_KIND = 'webhook';
const PAYLOAD_CONTENT_TYPE = 'application/json';
/** The folder the FILES module uses when the environment names none: both services share it, so the retention job can remove a payload through FILES. */
const DEFAULT_OBJECT_ROOT = join(tmpdir(), 'machvon-objects');

export class ObjectWebhookPayloads implements WebhookPayloadStore {
  constructor(private readonly storage: ObjectStoragePort) {}

  async put(tenant: TenantContext, provider: string, eventKey: string, rawBody: Buffer): Promise<string> {
    const key = objectKey(tenant.tenantId, PAYLOAD_KIND, createHash('sha256').update(`${provider}\n${eventKey}`, 'utf8').digest('hex'));
    // The first body of an event is the evidence: a repeat with other bytes (a provider that reuses an id) never replaces it.
    if ((await this.storage.head(tenant, key)) === undefined) await this.storage.put(tenant, key, rawBody, { contentType: PAYLOAD_CONTENT_TYPE });
    return key;
  }

  async read(tenant: TenantContext, reference: string): Promise<Buffer | undefined> {
    const stored = await this.storage.get(tenant, reference);
    return stored === undefined ? undefined : Buffer.from(stored.bytes);
  }
}

/** The default store: the same folder as the FILES module (`MACHVON_OBJECT_ROOT`), under its own kind. */
export function defaultWebhookPayloads(): WebhookPayloadStore {
  return new ObjectWebhookPayloads(new FsObjectStorage(process.env.MACHVON_OBJECT_ROOT ?? DEFAULT_OBJECT_ROOT));
}
