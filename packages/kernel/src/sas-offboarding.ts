import { constants, createHash, createPublicKey, publicEncrypt, randomBytes, createCipheriv } from 'node:crypto';
import { DomainError } from './errors.ts';

/**
 * Offboarding of a tenant and the export of its data (ST-SAS-016, SAS.md 3.2 and 3.10, BR-SAS-03): a tenant that leaves is read-only and can export; it is archived only once its export is delivered or the window
 * to export has ended; the export is a bundle of the rows of every table of the tenant, with a manifest that lets the owner check each file. The rules below are pure.
 */

export const MIN_EXPORT_WINDOW_DAYS = 30;
export const MAX_EXPORT_WINDOW_DAYS = 180;
/** SAS.md 3.2: 90 days unless the System Admin says otherwise [assumption pending the contract template]. */
export const DEFAULT_EXPORT_WINDOW_DAYS = 90;
export const MIN_OFFBOARDING_REASON = 10;
export const MAX_OFFBOARDING_REASON = 2000;
/** The link to an export lives 72 hours from the moment it is ready (SAS.md 3.10); every download asks for the right again. */
export const EXPORT_LINK_TTL_MS = 72 * 3_600_000;
export const MANIFEST_SCHEMA_VERSION = 1;
const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface OffboardingInput {
  contractEndDate: string;
  exportWindowDays: number;
  reason: string;
}

/** The fields of an offboarding request that cannot be accepted (the contract refuses most already; the store relies on this). */
export function offboardingDefects(input: OffboardingInput): string[] {
  const defects: string[] = [];
  if (!DATE.test(input.contractEndDate) || Number.isNaN(Date.parse(`${input.contractEndDate}T00:00:00Z`)) || new Date(`${input.contractEndDate}T00:00:00Z`).toISOString().slice(0, 10) !== input.contractEndDate) defects.push('contract_end_date');
  if (!Number.isInteger(input.exportWindowDays) || input.exportWindowDays < MIN_EXPORT_WINDOW_DAYS || input.exportWindowDays > MAX_EXPORT_WINDOW_DAYS) defects.push('export_window_days');
  const reason = input.reason.trim();
  if (reason.length < MIN_OFFBOARDING_REASON || reason.length > MAX_OFFBOARDING_REASON) defects.push('reason');
  return defects;
}

/**
 * When the window to export ends: the window starts at the later of the end of the contract and the moment offboarding starts (a tenant is not cut off from its data before its contract ends, and one whose contract
 * ended long ago still gets the whole window), and lasts the days agreed. The end of the contract day is the end of that day in UTC.
 */
export function exportWindowEnd(contractEndDate: string, startedAt: Date, days: number): Date {
  const contractEnds = new Date(`${contractEndDate}T00:00:00Z`).getTime() + DAY_MS;
  return new Date(Math.max(contractEnds, startedAt.getTime()) + days * DAY_MS);
}

/** Archiving needs an export that was Delivered or a window that has ended (409 `EXPORT_NOT_CONFIRMED`). */
export function assertArchivable(facts: { deliveredExport: boolean; windowEndsAt: Date | null }, now: Date): void {
  if (facts.deliveredExport) return;
  if (facts.windowEndsAt !== null && facts.windowEndsAt.getTime() <= now.getTime()) return;
  throw new DomainError('EXPORT_NOT_CONFIRMED', 409);
}

/** A tenant comes back from Offboarding to Active only inside the window to export (a renewal of the contract); a tenant with no window recorded has none open. */
export function isWithinExportWindow(windowEndsAt: Date | null, now: Date): boolean {
  return windowEndsAt !== null && now.getTime() < windowEndsAt.getTime();
}

export type ExportScopeKind = 'FULL' | 'BUSINESS_DATA_ONLY';

/** Tables that are never in an export: the machinery of the platform and what is secret (the sessions and devices of people, the stored answers of commands, the events not yet relayed, the export jobs themselves). */
const NEVER_EXPORTED: ReadonlySet<string> = new Set(['idempotency_record', 'outbox_event', 'integration_event_inbox', 'user_session', 'device_registration', 'tenant_export_job', 'tenant_restore_request']);
/** Tables that describe who may do what and what was done, not the business data of the tenant: only a FULL export holds them. */
const TECHNICAL_PREFIXES: readonly string[] = ['audit_', 'role_', 'membership', 'delegation_', 'support_', 'security_policy', 'signing_', 'notification_', 'delivery_', 'invitation', 'legal_hold'];

/** The tables an export of this scope holds, sorted. */
export function tablesToExport(tables: readonly string[], scope: ExportScopeKind): string[] {
  return tables
    .filter((table) => !NEVER_EXPORTED.has(table))
    .filter((table) => scope === 'FULL' || !TECHNICAL_PREFIXES.some((prefix) => table === prefix || table.startsWith(prefix)))
    .sort();
}

/** Kinds of stored file that record what was done in the tenant, not its business data: only a FULL export copies them (the audit exports are files of the audit trail). */
const TECHNICAL_ATTACHMENT_KINDS: readonly string[] = ['audit_export'];

/** Whether files of this kind belong in an export of this scope. */
export function attachmentKindInScope(kind: string, scope: ExportScopeKind): boolean {
  return scope === 'FULL' || !TECHNICAL_ATTACHMENT_KINDS.includes(kind);
}

/** A column that holds a secret is left out of the rows, and the manifest says which were left out. */
const SECRET_COLUMN = /(secret|password|private_key|token_hash|token_fingerprint|api_key)/i;

export function splitColumns(columns: readonly string[]): { kept: string[]; omitted: string[] } {
  return { kept: columns.filter((column) => !SECRET_COLUMN.test(column)), omitted: columns.filter((column) => SECRET_COLUMN.test(column)) };
}

export interface ManifestFile {
  path: string;
  bytes: number;
  sha256: string;
  /** The table the file holds, for a data file; absent for an attachment. */
  table?: string;
  rows?: number;
  /** Present when the file is encrypted for the customer: how its key was wrapped, and the hash of the file before encryption. */
  encryption?: { algorithm: string; wrapped_key: string; plaintext_sha256: string };
}

export interface ExportManifest {
  schema_version: number;
  job_id: string;
  tenant_id: string;
  scope: ExportScopeKind;
  snapshot_at: string;
  files: ManifestFile[];
  row_counts: Record<string, number>;
  omitted_columns: Record<string, string[]>;
  /** Objects that rows of the tables refer to and no store returned: the export holds the reference without the file, and says so. */
  missing_files: string[];
  /** Objects that rows refer to and the antivirus has not passed (pending or infected): they are not in the export. */
  withheld_files: string[];
  /** Tables of the tenant that the export could not read, so they are not in it (an empty file would say there is nothing in them). */
  unreadable_tables: string[];
  encryption_key_fingerprint: string | null;
}

export const bytesSha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export function buildManifest(input: Omit<ExportManifest, 'schema_version' | 'row_counts'>): ExportManifest {
  const row_counts: Record<string, number> = {};
  for (const file of input.files) if (file.table !== undefined) row_counts[file.table] = file.rows ?? 0;
  return { schema_version: MANIFEST_SCHEMA_VERSION, ...input, files: [...input.files].sort((a, b) => (a.path < b.path ? -1 : 1)), row_counts };
}

/** The manifest as stored: the same text always, so its hash can be compared. */
export const manifestText = (manifest: ExportManifest): string => `${JSON.stringify(manifest, null, 2)}\n`;

/** Whether the bytes of a file are what the manifest says (the check the owner makes after a download). */
export function fileMatchesManifest(manifest: Pick<ExportManifest, 'files'>, path: string, bytes: Uint8Array): boolean {
  const entry = manifest.files.find((file) => file.path === path);
  return entry !== undefined && entry.bytes === bytes.length && entry.sha256 === bytesSha256(bytes);
}

const MIN_RSA_BITS = 2048;

/** The key the customer gave, if it is one we can wrap a key for (an RSA public key of at least 2048 bits); 422 on the field `encryption_public_key_pem` otherwise. */
export function parseCustomerKey(pem: string): { pem: string; fingerprint: string } {
  try {
    // Only a public key is taken: a private key would be derived into its public half by the parser, and the secret itself kept with the export it opens. What is kept is the public key as the parser exports it.
    if (!/^-----BEGIN (RSA )?PUBLIC KEY-----[\s\S]+-----END (RSA )?PUBLIC KEY-----\s*$/.test(pem.trim())) throw new Error('not a public key');
    const key = createPublicKey(pem.trim());
    const bits = key.asymmetricKeyType === 'rsa' ? (key.asymmetricKeyDetails?.modulusLength ?? 0) : 0;
    if (bits < MIN_RSA_BITS) throw new Error('weak');
    return { pem: key.export({ type: 'spki', format: 'pem' }).toString(), fingerprint: bytesSha256(key.export({ type: 'spki', format: 'der' })) };
  } catch {
    throw new DomainError('VALIDATION_FAILED', 422, 'encryption_public_key_pem');
  }
}

/**
 * Encrypts a file for the customer: AES-256-GCM under a key of its own, wrapped with their RSA key (OAEP, SHA-256). The stored bytes are the nonce, the tag and the ciphertext; the entry of the manifest holds the wrapped key and
 * the hash of the plain file, so the customer checks the file they download before they decrypt it and the plain text after.
 */
export function encryptForCustomer(bytes: Uint8Array, key: { pem: string }): { stored: Buffer; encryption: NonNullable<ManifestFile['encryption']> } {
  const fileKey = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', fileKey, nonce);
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const wrapped = publicEncrypt({ key: key.pem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, fileKey);
  return { stored: Buffer.concat([nonce, cipher.getAuthTag(), body]), encryption: { algorithm: 'AES-256-GCM+RSA-OAEP-SHA256', wrapped_key: wrapped.toString('base64'), plaintext_sha256: bytesSha256(bytes) } };
}
