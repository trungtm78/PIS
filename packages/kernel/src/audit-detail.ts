import { canonicalJson, sha256Hex } from './canonical-json.ts';

/**
 * Full before and after values of a business object in the audit trail (HT.06, ENT-4e). The sealed `safe_diff` of an audit row stays a
 * sanitised diff; when a tenant opts in for a class of business object, the complete values go to a side record whose SHA-256 the sealed
 * row carries (`detail_ref`), so the trail commits to them without a change to the seal or to the export format.
 *
 * This file is pure: it redacts, bounds and hashes. Whether a class is opted in, and where the record is written, is the database's business.
 */

export const REDACTED_VALUE = '[REDACTED]';
export const PERSONAL_VALUE = '[PERSONAL]';
export const TRUNCATED_VALUE = '[TRUNCATED]';

export const AUDIT_DETAIL_MIN_BYTES = 1024;
export const AUDIT_DETAIL_DEFAULT_BYTES = 16_384;
export const AUDIT_DETAIL_MAX_BYTES = 262_144;
/** A key that may name a secret, at any depth. */
const SECRET_KEY = /pass(word)?|secret|token|authorization|api[_-]?key|private[_-]?key|credential|signature_secret/i;
/** A key that holds a fact about a natural person: kept in the object, replaced in the trail. */
const PERSONAL_KEY = /^(national_id|citizen_id|id_card|cccd|cmnd|passport|passport_no|date_of_birth|dob|phone|mobile|home_address|personal_address|bank_account|bank_account_no|iban)$/i;
/** A value that is a secret whatever its key: a bearer credential, a signed token, a private key block. */
const SECRET_VALUE = /^(Bearer\s+\S{8,}|eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*)$/;
const KEY_ENTRY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
export const AUDIT_DETAIL_MAX_EXTRA_KEYS = 50;

export interface AuditDetailPolicy {
  enabled: boolean;
  /** The most bytes the canonical JSON of `{ before, after }` may take after redaction. */
  maxBytes: number;
  /** Keys (any depth, case-insensitive) that the tenant adds to the built-in secret rule. */
  sensitiveKeys: readonly string[];
}

export interface AuditDetailInput {
  before?: unknown;
  after?: unknown;
}

export interface PreparedAuditDetail {
  before: unknown;
  after: unknown;
  /** Dot paths (`after.owner.token`) whose value was replaced by a marker for a secret or a personal fact. */
  redactedPaths: string[];
  truncated: boolean;
  droppedPaths: string[];
  /** Size in bytes (UTF-8) of the canonical JSON of the detail that is stored. */
  bytes: number;
  /** SHA-256 hex of that canonical JSON: the sealed row carries it. */
  sha256: string;
}

/** What the sealed `safe_diff` of the audit row carries about its detail. */
export interface AuditDetailRef {
  sha256: string;
  bytes: number;
  redacted_paths: string[];
  truncated: boolean;
}

export type AuditDetailFindingCode = 'MAX_BYTES_RANGE' | 'SENSITIVE_KEY_FORMAT' | 'SENSITIVE_KEYS_TOO_MANY' | 'RESOURCE_TYPE_FORMAT' | 'REASON_REQUIRED';

export interface AuditDetailFinding {
  field: string;
  code: AuditDetailFindingCode;
  /** The i18n key of the sentence the screen shows. */
  message: string;
}

const FINDING_MESSAGES: Readonly<Record<AuditDetailFindingCode, string>> = {
  MAX_BYTES_RANGE: 'adm.auditDetail.error.maxBytes',
  SENSITIVE_KEY_FORMAT: 'adm.auditDetail.error.sensitiveKey',
  SENSITIVE_KEYS_TOO_MANY: 'adm.auditDetail.error.sensitiveKeysMany',
  RESOURCE_TYPE_FORMAT: 'adm.auditDetail.error.resourceType',
  REASON_REQUIRED: 'adm.auditDetail.error.reason',
};

const RESOURCE_TYPE = /^[a-z][a-z0-9_]{1,79}$/;
const finding = (field: string, code: AuditDetailFindingCode): AuditDetailFinding => ({ field, code, message: FINDING_MESSAGES[code] });

/** The rules of one policy row that the request schema cannot state; an empty list means it is valid. */
export function auditDetailPolicyFindings(input: { resourceType: string; maxBytes: number; sensitiveKeys: readonly string[]; reason: string }): AuditDetailFinding[] {
  const found: AuditDetailFinding[] = [];
  if (!RESOURCE_TYPE.test(input.resourceType)) found.push(finding('resource_type', 'RESOURCE_TYPE_FORMAT'));
  if (!Number.isInteger(input.maxBytes) || input.maxBytes < AUDIT_DETAIL_MIN_BYTES || input.maxBytes > AUDIT_DETAIL_MAX_BYTES) found.push(finding('max_bytes', 'MAX_BYTES_RANGE'));
  if (input.sensitiveKeys.length > AUDIT_DETAIL_MAX_EXTRA_KEYS) found.push(finding('sensitive_keys', 'SENSITIVE_KEYS_TOO_MANY'));
  if (input.sensitiveKeys.some((key) => !KEY_ENTRY.test(key))) found.push(finding('sensitive_keys', 'SENSITIVE_KEY_FORMAT'));
  if (input.reason.trim().length < 5) found.push(finding('reason', 'REASON_REQUIRED'));
  return found;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

interface Walk {
  extra: ReadonlySet<string>;
  paths: string[];
}

/** A deep copy in which secrets and personal facts are replaced by markers; the paths replaced are collected. */
function redact(value: unknown, path: string, walk: Walk): unknown {
  if (Array.isArray(value)) return value.map((item: unknown, index) => redact(item, `${path}[${index}]`, walk));
  if (typeof value === 'string') {
    if (SECRET_VALUE.test(value)) {
      walk.paths.push(path);
      return REDACTED_VALUE;
    }
    return value;
  }
  if (!isObject(value)) return value === undefined ? null : value;
  const result: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) {
    const here = `${path}.${key}`;
    if (SECRET_KEY.test(key) || walk.extra.has(key.toLowerCase())) {
      walk.paths.push(here);
      result[key] = REDACTED_VALUE;
    } else if (PERSONAL_KEY.test(key) && member !== null && member !== undefined) {
      walk.paths.push(here);
      result[key] = PERSONAL_VALUE;
    } else {
      result[key] = redact(member, here, walk);
    }
  }
  return result;
}

interface Node {
  path: string;
  size: number;
  parent: Record<string, unknown> | unknown[];
  slot: string | number;
}

function collect(value: unknown, path: string, parent: Node['parent'] | undefined, slot: string | number, out: Node[]): void {
  if (Array.isArray(value)) {
    if (parent !== undefined) out.push({ path, size: Buffer.byteLength(canonicalJson(value), 'utf8'), parent, slot });
    value.forEach((item: unknown, index) => collect(item, `${path}[${index}]`, value, index, out));
  } else if (isObject(value)) {
    if (parent !== undefined) out.push({ path, size: Buffer.byteLength(canonicalJson(value), 'utf8'), parent, slot });
    for (const [key, member] of Object.entries(value)) collect(member, `${path}.${key}`, value, key, out);
  } else if (parent !== undefined && typeof value === 'string') {
    out.push({ path, size: Buffer.byteLength(JSON.stringify(value), 'utf8'), parent, slot });
  }
}

const MARKER_BYTES = Buffer.byteLength(JSON.stringify(TRUNCATED_VALUE), 'utf8');
const sizeOf = (envelope: { before: unknown; after: unknown }): number => Buffer.byteLength(canonicalJson(envelope), 'utf8');

/**
 * Redacts the values, bounds them to the policy's byte cap and hashes the result. Bounding replaces the largest subtrees by the marker
 * `[TRUNCATED]` until the canonical JSON fits (a row is never refused for its size: an audit write must not fail the command), and lists
 * the paths it dropped. The same input and policy always give the same hash.
 */
export function prepareAuditDetail(input: AuditDetailInput, policy: AuditDetailPolicy): PreparedAuditDetail {
  const walk: Walk = { extra: new Set(policy.sensitiveKeys.map((key) => key.toLowerCase())), paths: [] };
  const envelope = { before: redact(input.before ?? null, 'before', walk), after: redact(input.after ?? null, 'after', walk) };
  let bytes = sizeOf(envelope);
  const dropped: string[] = [];
  if (bytes > policy.maxBytes) {
    const nodes: Node[] = [];
    collect(envelope.before, 'before', undefined, '', nodes);
    collect(envelope.after, 'after', undefined, '', nodes);
    nodes.sort((left, right) => right.size - left.size || (left.path < right.path ? -1 : 1));
    const gone: string[] = [];
    for (const node of nodes) {
      if (bytes <= policy.maxBytes) break;
      if (gone.some((prefix) => node.path.startsWith(`${prefix}.`) || node.path.startsWith(`${prefix}[`))) continue;
      if (node.size <= MARKER_BYTES) break;
      (node.parent as Record<string | number, unknown>)[node.slot] = TRUNCATED_VALUE;
      gone.push(node.path);
      dropped.push(node.path);
      bytes = sizeOf(envelope);
    }
    if (bytes > policy.maxBytes) {
      // The envelope itself does not fit (the cap is tiny against many small members): keep nothing but the markers.
      envelope.before = TRUNCATED_VALUE;
      envelope.after = TRUNCATED_VALUE;
      dropped.push('before', 'after');
      bytes = sizeOf(envelope);
    }
  }
  const text = canonicalJson(envelope);
  return { before: envelope.before, after: envelope.after, redactedPaths: [...new Set(walk.paths)].sort(), truncated: dropped.length > 0, droppedPaths: dropped.sort(), bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256Hex(text) };
}

/** The member `detail_ref` of the sealed diff: the hash that commits the trail to the side record. */
export function auditDetailRef(prepared: PreparedAuditDetail): AuditDetailRef {
  return { sha256: prepared.sha256, bytes: prepared.bytes, redacted_paths: prepared.redactedPaths.slice(0, 50), truncated: prepared.truncated };
}

/** Whether a stored detail still matches the hash the sealed row carries (the check a reader or an auditor runs). */
export function auditDetailMatches(detail: { before: unknown; after: unknown }, ref: Pick<AuditDetailRef, 'sha256'>): boolean {
  return sha256Hex(canonicalJson({ before: detail.before, after: detail.after })) === ref.sha256;
}

/** A field-by-field comparison of two stored values for the viewer: the dot paths whose value differs, sorted. */
export function auditDetailChangedPaths(before: unknown, after: unknown): string[] {
  const changed: string[] = [];
  const visit = (left: unknown, right: unknown, path: string): void => {
    if (isObject(left) && isObject(right)) {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) visit(left[key], right[key], path === '' ? key : `${path}.${key}`);
      return;
    }
    if (Array.isArray(left) && Array.isArray(right)) {
      const longest = Math.max(left.length, right.length);
      for (let index = 0; index < longest; index += 1) visit(left[index], right[index], `${path}[${index}]`);
      return;
    }
    if (canonicalJson(left ?? null) !== canonicalJson(right ?? null)) changed.push(path === '' ? '(value)' : path);
  };
  visit(before, after, '');
  return changed.sort();
}
