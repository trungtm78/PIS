import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from './canonical-json.ts';
import { DomainError } from './errors.ts';
import { readTabularFile } from './tabular-file.ts';

/**
 * The transport protocols of the Integration Hub (HUB-1, owner addition 2026-11-08): the ways data reaches the platform or leaves it, each one a PORT with a definition (its security needs, its egress class, its
 * failure semantics). A connector names the protocols it uses in its descriptor; the hub reads the definitions, never the code of an adapter. Only FILE_DROP, WEBHOOK_INBOUND and GENERATOR are implemented end to end
 * (they need no outgoing connection); HTTPS_REST, SOAP_XML, SFTP, DB_READ, MESSAGE_QUEUE and EMAIL_INBOX are contract-tested ports whose real adapter is a REFUSING stub until a tenant-approved egress exception
 * exists (`protocolPortFor`), with an in-memory fake that proves the contract. The registry is open (`registerProtocol`) like the governance rule type registry.
 *
 * This module is pure: it imports no module that opens a connection, and the fake adapters keep everything in memory.
 */

export const TRANSPORT_PROTOCOLS = ['HTTPS_REST', 'SOAP_XML', 'FILE_DROP', 'SFTP', 'DB_READ', 'MESSAGE_QUEUE', 'WEBHOOK_INBOUND', 'EMAIL_INBOX', 'GENERATOR'] as const;
export type BuiltInProtocol = (typeof TRANSPORT_PROTOCOLS)[number];

/** NONE: nothing leaves the machine. ALLOWLISTED_HOST: a named host of the public network. CUSTOMER_NETWORK: a host inside the customer's own network (a government exchange platform, a replica, a broker). */
export const EGRESS_CLASSES = ['NONE', 'ALLOWLISTED_HOST', 'CUSTOMER_NETWORK'] as const;
export type EgressClass = (typeof EGRESS_CLASSES)[number];

export const PROTOCOL_AUTH_TYPES = ['NONE', 'API_KEY', 'BEARER_TOKEN', 'BASIC', 'OAUTH_CLIENT', 'MUTUAL_TLS', 'WS_SECURITY', 'SSH_KEY', 'DB_CREDENTIALS', 'HMAC_SIGNATURE', 'SASL'] as const;
export type ProtocolAuthType = (typeof PROTOCOL_AUTH_TYPES)[number];

export const FILE_FORMATS = ['CSV', 'XLSX', 'XML', 'JSON'] as const;
export type FileFormat = (typeof FILE_FORMATS)[number];

export type ProtocolDirection = 'INBOUND' | 'OUTBOUND';
export type ProtocolImplementation = 'END_TO_END' | 'PORT_ONLY';
export type ProtocolTransport = 'FILE' | 'API_PULL' | 'API_PUSH' | 'GENERATOR';

export interface ProtocolFailureSemantics {
  /** What a caller may do after a failure: retry with backoff, replay the same idempotency key, wait for redelivery by the sender, or nothing. */
  retry: 'BACKOFF' | 'REPLAY_BY_IDEMPOTENCY_KEY' | 'REDELIVERY_BY_SENDER' | 'NONE';
  maxAttempts: number;
  /** Whether a repeated delivery of the same message must be harmless (a key or a hash decides). */
  idempotencyRequired: boolean;
  delivery: 'AT_LEAST_ONCE' | 'AT_MOST_ONCE' | 'EXACTLY_ONCE_BY_KEY';
  /** The watermark of a read stays where it was until the load of what was read succeeded. */
  watermarkAfterLoadOnly: boolean;
}

export interface ProtocolDefinition {
  code: string;
  name: string;
  directions: readonly ProtocolDirection[];
  /** The legacy transport word of the descriptor: how the data moves. */
  transport: ProtocolTransport;
  security: {
    /** The authentication types a connector may choose from (one of them is configured; the secret itself is a vault reference). */
    auth: readonly ProtocolAuthType[];
    tls: 'REQUIRED' | 'NOT_APPLICABLE';
    signature: 'NONE' | 'OPTIONAL' | 'REQUIRED';
  };
  egress: EgressClass;
  failure: ProtocolFailureSemantics;
  /** The file formats a file based protocol reads (empty for the others). */
  formats: readonly FileFormat[];
  /** The names of the configuration items the protocol needs (never a secret). */
  configuration: readonly string[];
  implementation: ProtocolImplementation;
}

const CODE = /^[A-Z][A-Z0-9_]{1,39}$/;

const backoff = (maxAttempts: number, watermarkAfterLoadOnly = true): ProtocolFailureSemantics => ({ retry: 'BACKOFF', maxAttempts, idempotencyRequired: true, delivery: 'AT_LEAST_ONCE', watermarkAfterLoadOnly });

export const BUILT_IN_PROTOCOLS: readonly ProtocolDefinition[] = [
  {
    code: 'HTTPS_REST',
    name: 'HTTPS REST (pull and push)',
    directions: ['INBOUND', 'OUTBOUND'],
    transport: 'API_PULL',
    security: { auth: ['API_KEY', 'BEARER_TOKEN', 'OAUTH_CLIENT', 'MUTUAL_TLS', 'BASIC'], tls: 'REQUIRED', signature: 'OPTIONAL' },
    egress: 'ALLOWLISTED_HOST',
    failure: backoff(5),
    formats: [],
    configuration: ['base_url', 'pagination', 'timeout_seconds', 'rate_limit_per_minute'],
    implementation: 'PORT_ONLY',
  },
  {
    code: 'SOAP_XML',
    name: 'SOAP XML web service (government exchange platforms)',
    directions: ['INBOUND', 'OUTBOUND'],
    transport: 'API_PULL',
    security: { auth: ['WS_SECURITY', 'MUTUAL_TLS', 'BASIC', 'BEARER_TOKEN'], tls: 'REQUIRED', signature: 'OPTIONAL' },
    egress: 'CUSTOMER_NETWORK',
    failure: backoff(3),
    formats: ['XML'],
    configuration: ['endpoint', 'soap_version', 'soap_action', 'ws_security_mode', 'timestamp_ttl_seconds', 'envelope_namespace'],
    implementation: 'PORT_ONLY',
  },
  {
    code: 'FILE_DROP',
    name: 'Drop folder (a file handed over, with checksum and manifest)',
    directions: ['INBOUND', 'OUTBOUND'],
    transport: 'FILE',
    security: { auth: ['NONE'], tls: 'NOT_APPLICABLE', signature: 'OPTIONAL' },
    egress: 'NONE',
    failure: { retry: 'REDELIVERY_BY_SENDER', maxAttempts: 1, idempotencyRequired: true, delivery: 'EXACTLY_ONCE_BY_KEY', watermarkAfterLoadOnly: true },
    formats: ['CSV', 'XLSX', 'XML', 'JSON'],
    configuration: ['folder', 'manifest_name', 'stable_polls', 'layout_version'],
    implementation: 'END_TO_END',
  },
  {
    code: 'SFTP',
    name: 'SFTP (a remote drop folder)',
    directions: ['INBOUND', 'OUTBOUND'],
    transport: 'FILE',
    security: { auth: ['SSH_KEY', 'BASIC'], tls: 'NOT_APPLICABLE', signature: 'OPTIONAL' },
    egress: 'ALLOWLISTED_HOST',
    failure: backoff(5),
    formats: ['CSV', 'XLSX', 'XML', 'JSON'],
    configuration: ['host', 'port', 'remote_folder', 'manifest_name', 'host_key_fingerprint'],
    implementation: 'PORT_ONLY',
  },
  {
    code: 'DB_READ',
    name: 'Database read (read-only views or a replica)',
    directions: ['INBOUND'],
    transport: 'API_PULL',
    security: { auth: ['DB_CREDENTIALS', 'MUTUAL_TLS'], tls: 'REQUIRED', signature: 'NONE' },
    egress: 'CUSTOMER_NETWORK',
    failure: backoff(3),
    formats: [],
    configuration: ['driver', 'host', 'database', 'view', 'fetch_size', 'watermark_column'],
    implementation: 'PORT_ONLY',
  },
  {
    code: 'MESSAGE_QUEUE',
    name: 'Message queue consumer (AMQP or Kafka style)',
    directions: ['INBOUND', 'OUTBOUND'],
    transport: 'API_PULL',
    security: { auth: ['SASL', 'MUTUAL_TLS', 'BASIC'], tls: 'REQUIRED', signature: 'OPTIONAL' },
    egress: 'CUSTOMER_NETWORK',
    failure: { retry: 'REDELIVERY_BY_SENDER', maxAttempts: 5, idempotencyRequired: true, delivery: 'AT_LEAST_ONCE', watermarkAfterLoadOnly: true },
    formats: ['JSON', 'XML'],
    configuration: ['brokers', 'topic', 'consumer_group', 'dead_letter_topic', 'prefetch'],
    implementation: 'PORT_ONLY',
  },
  {
    code: 'WEBHOOK_INBOUND',
    name: 'Inbound webhook (signed payload, replay protection)',
    directions: ['INBOUND'],
    transport: 'API_PUSH',
    security: { auth: ['HMAC_SIGNATURE'], tls: 'REQUIRED', signature: 'REQUIRED' },
    egress: 'NONE',
    failure: { retry: 'REDELIVERY_BY_SENDER', maxAttempts: 1, idempotencyRequired: true, delivery: 'EXACTLY_ONCE_BY_KEY', watermarkAfterLoadOnly: true },
    formats: ['JSON'],
    configuration: ['signature_header', 'timestamp_header', 'idempotency_header', 'tolerance_seconds'],
    implementation: 'END_TO_END',
  },
  {
    code: 'EMAIL_INBOX',
    name: 'E-mail inbox (attachments)',
    directions: ['INBOUND'],
    transport: 'FILE',
    security: { auth: ['BASIC', 'OAUTH_CLIENT'], tls: 'REQUIRED', signature: 'OPTIONAL' },
    egress: 'ALLOWLISTED_HOST',
    failure: backoff(3),
    formats: ['CSV', 'XLSX', 'XML', 'JSON'],
    configuration: ['mailbox', 'allowed_senders', 'subject_pattern', 'attachment_pattern'],
    implementation: 'PORT_ONLY',
  },
  {
    code: 'GENERATOR',
    name: 'Generator (a deterministic producer of a file for the other side)',
    directions: ['OUTBOUND'],
    transport: 'GENERATOR',
    security: { auth: ['NONE'], tls: 'NOT_APPLICABLE', signature: 'OPTIONAL' },
    egress: 'NONE',
    failure: { retry: 'NONE', maxAttempts: 1, idempotencyRequired: false, delivery: 'AT_MOST_ONCE', watermarkAfterLoadOnly: true },
    formats: ['CSV', 'XLSX', 'XML', 'JSON'],
    configuration: ['template_version'],
    implementation: 'END_TO_END',
  },
];

const REGISTRY = new Map<string, ProtocolDefinition>(BUILT_IN_PROTOCOLS.map((definition) => [definition.code, definition]));

const flaw = (code: string, text: string): Error => new Error(`protocol ${code}: ${text}`);

/** Judges a definition (a plain Error: a defect of the lane that wrote it). */
export function assertProtocolDefinition(definition: ProtocolDefinition): ProtocolDefinition {
  const code = String(definition.code);
  if (!CODE.test(code)) throw flaw(code, 'code must be an upper case word');
  if (definition.name.trim() === '') throw flaw(code, 'name is required');
  if (definition.directions.length === 0) throw flaw(code, 'at least one direction');
  if (!definition.security.auth.every((auth) => (PROTOCOL_AUTH_TYPES as readonly string[]).includes(auth)) || definition.security.auth.length === 0) throw flaw(code, 'auth types must be known');
  if (!(EGRESS_CLASSES as readonly string[]).includes(definition.egress)) throw flaw(code, 'egress class is unknown');
  if (definition.egress !== 'NONE' && definition.security.tls === 'NOT_APPLICABLE' && !definition.security.auth.includes('SSH_KEY')) throw flaw(code, 'a protocol that leaves the machine needs TLS or an SSH key');
  if (definition.egress === 'NONE' && definition.implementation !== 'END_TO_END') throw flaw(code, 'a protocol with no egress is implemented end to end');
  if (definition.failure.maxAttempts < 1 || definition.failure.maxAttempts > 20) throw flaw(code, 'maxAttempts is 1 to 20');
  if (definition.failure.delivery === 'AT_LEAST_ONCE' && !definition.failure.idempotencyRequired) throw flaw(code, 'at-least-once delivery requires idempotent handling');
  return definition;
}

export function registerProtocol(definition: ProtocolDefinition): void {
  assertProtocolDefinition(definition);
  if (REGISTRY.has(definition.code)) throw flaw(definition.code, 'is already registered');
  REGISTRY.set(definition.code, definition);
}

export const protocolDefinitions = (): ProtocolDefinition[] => [...REGISTRY.values()];
export const protocolDefinition = (code: string): ProtocolDefinition | undefined => REGISTRY.get(code);
export const isProtocolCode = (value: unknown): value is string => typeof value === 'string' && REGISTRY.has(value);

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The port.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type SourceValue = string | number | boolean | null;

/** One record of the source as it arrived, before any rule: its key (what identifies it in the source), the place it came from (a file and a line, a message id) and its fields. */
export interface SourceRecord {
  key: string;
  sourceRef: string;
  line: number | null;
  fields: Readonly<Record<string, SourceValue>>;
}

export type ExtractMode = 'INCREMENTAL' | 'FULL_SNAPSHOT' | 'CHANGE_FEED';

export interface ExtractRequest {
  pipeline: string;
  mode: ExtractMode;
  /** Where the last successful load stopped (opaque to the hub); null for the first read or a full snapshot. */
  watermark: string | null;
  limit?: number;
  layoutVersion?: string;
}

export interface ExtractBatch {
  records: readonly SourceRecord[];
  /** The watermark to store once the load of this batch succeeded; null when the source gave nothing new. */
  nextWatermark: string | null;
  /** The hash of the batch: the records in order, canonical. The same bytes always give the same hash. */
  batchSha256: string;
  /** For a change feed, a record may be a deletion mark; the hub passes it on, the target decides. */
  complete: boolean;
}

export interface OutboundMessage {
  pipeline: string;
  idempotencyKey: string;
  body: Uint8Array;
  contentType: string;
}

export interface InboundProtocolPort {
  readonly protocol: string;
  extract(request: ExtractRequest): Promise<ExtractBatch>;
}

export interface OutboundProtocolPort {
  readonly protocol: string;
  send(message: OutboundMessage): Promise<{ receipt: string }>;
}

export const batchHashOf = (records: readonly SourceRecord[]): string => createHash('sha256').update(canonicalJson(records.map((record) => ({ key: record.key, ref: record.sourceRef, fields: record.fields })))).digest('hex');

export const makeBatch = (records: readonly SourceRecord[], nextWatermark: string | null, complete = true): ExtractBatch => ({ records, nextWatermark, batchSha256: batchHashOf(records), complete });

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The egress gate and the refusing adapter.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** A tenant-approved exception that lets a protocol reach a host (decided by an administrator with a reason, logged in the audit log ADM-11, expiring). The hub asks this port, it never stores the decision itself. */
export interface EgressExceptionPort {
  isApproved(request: { connectorCode: string; protocol: string; host: string; now: Date }): boolean;
}

export const NO_EGRESS_EXCEPTIONS: EgressExceptionPort = { isApproved: () => false };

/** Why a call to a host is refused, or null when it may go: a protocol with egress NONE never needs a host; any other needs an approved exception for that host. */
export function egressVerdict(input: { connectorCode: string; protocol: string; host: string | null; now: Date; exceptions: EgressExceptionPort }): 'NOT_NEEDED' | 'APPROVED' | 'EXCEPTION_REQUIRED' | 'UNKNOWN_PROTOCOL' {
  const definition = REGISTRY.get(input.protocol);
  if (definition === undefined) return 'UNKNOWN_PROTOCOL';
  if (definition.egress === 'NONE') return 'NOT_NEEDED';
  if (input.host === null) return 'EXCEPTION_REQUIRED';
  return input.exceptions.isApproved({ connectorCode: input.connectorCode, protocol: input.protocol, host: input.host, now: input.now }) ? 'APPROVED' : 'EXCEPTION_REQUIRED';
}

/**
 * The adapter of a protocol that cannot run yet: every call is refused with 503 `HUB_PROTOCOL_UNAVAILABLE` (`extensions.reason` says why: `EGRESS_EXCEPTION_REQUIRED` while no tenant exception exists, `ADAPTER_NOT_IMPLEMENTED`
 * once one does). It holds no client and imports nothing that opens a connection.
 */
export class RefusingProtocolAdapter implements InboundProtocolPort, OutboundProtocolPort {
  readonly protocol: string;
  private readonly reason: 'EGRESS_EXCEPTION_REQUIRED' | 'ADAPTER_NOT_IMPLEMENTED';

  constructor(protocol: string, reason: 'EGRESS_EXCEPTION_REQUIRED' | 'ADAPTER_NOT_IMPLEMENTED') {
    this.protocol = protocol;
    this.reason = reason;
  }

  private failure(): DomainError {
    return new DomainError('HUB_PROTOCOL_UNAVAILABLE', 503, 'protocol', { extensions: { protocol: this.protocol, reason: this.reason } });
  }

  extract(): Promise<ExtractBatch> {
    return Promise.reject(this.failure());
  }

  send(): Promise<{ receipt: string }> {
    return Promise.reject(this.failure());
  }
}

/** The port for a protocol: the refusing adapter, because no real network adapter exists in this build; the reason says whether an exception is missing. Implemented protocols are built by their own factories. */
export function protocolPortFor(input: { connectorCode: string; protocol: string; host: string | null; now: Date; exceptions?: EgressExceptionPort }): RefusingProtocolAdapter {
  const verdict = egressVerdict({ connectorCode: input.connectorCode, protocol: input.protocol, host: input.host, now: input.now, exceptions: input.exceptions ?? NO_EGRESS_EXCEPTIONS });
  if (verdict === 'UNKNOWN_PROTOCOL') throw new DomainError('VALIDATION_FAILED', 422, 'protocol');
  return new RefusingProtocolAdapter(input.protocol, verdict === 'EXCEPTION_REQUIRED' ? 'EGRESS_EXCEPTION_REQUIRED' : 'ADAPTER_NOT_IMPLEMENTED');
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// FILE_DROP: the drop folder (end to end, no network).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface DropEntry {
  name: string;
  size: number;
  /** Milliseconds since the epoch of the last change. */
  modifiedAtMs: number;
}

/** The folder a file is handed over in. The in-memory one is for tests and demos; an adapter over a real directory (or an SFTP session) implements the same three calls. */
export interface DropFolder {
  list(): Promise<DropEntry[]>;
  read(name: string): Promise<Uint8Array>;
  /** Moves a file that was taken (or refused) out of the way, to the processed or rejected area. */
  settle(name: string, outcome: 'PROCESSED' | 'REJECTED'): Promise<void>;
}

export class InMemoryDropFolder implements DropFolder {
  private readonly files = new Map<string, { bytes: Uint8Array; modifiedAtMs: number }>();
  readonly settled: Array<{ name: string; outcome: 'PROCESSED' | 'REJECTED' }> = [];

  put(name: string, bytes: Uint8Array | string, modifiedAtMs = 0): void {
    this.files.set(name, { bytes: typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes, modifiedAtMs });
  }

  async list(): Promise<DropEntry[]> {
    return [...this.files.entries()].map(([name, file]) => ({ name, size: file.bytes.length, modifiedAtMs: file.modifiedAtMs })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async read(name: string): Promise<Uint8Array> {
    const file = this.files.get(name);
    if (file === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'file');
    return file.bytes;
  }

  async settle(name: string, outcome: 'PROCESSED' | 'REJECTED'): Promise<void> {
    this.files.delete(name);
    this.settled.push({ name, outcome });
  }
}

/** A manifest lists one file per line: `<sha256>  <name>` (the layout of `sha256sum`), blank lines and `#` lines ignored. A line that is not that, or a name listed twice, refuses the manifest. */
export function parseManifest(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = /^([0-9a-f]{64}) [ *]?(.+)$/.exec(trimmed);
    if (match === null || entries.has(match[2] as string)) throw new DomainError('HUB_MANIFEST_INVALID', 422, 'manifest');
    entries.set(match[2] as string, match[1] as string);
  }
  return entries;
}

export interface ArrivalState {
  /** What each file looked like at the last poll: a file has arrived when it looked the same on `stablePolls` polls in a row. */
  seen: ReadonlyMap<string, { size: number; modifiedAtMs: number; stable: number }>;
}

/**
 * Arrival detection: a file counts as arrived once its size and time of change were the same at `stablePolls` successive polls (a file still being copied keeps changing), and, when a manifest exists, once the
 * manifest lists it. Returns the names that arrived and the state to keep for the next poll. A file without a manifest line is held back while the manifest exists (it is not part of the delivery).
 */
export function detectArrivals(entries: readonly DropEntry[], previous: ArrivalState, options: { stablePolls: number; manifestName: string }): { arrived: string[]; state: ArrivalState } {
  const next = new Map<string, { size: number; modifiedAtMs: number; stable: number }>();
  for (const entry of entries) {
    const before = previous.seen.get(entry.name);
    const stable = before !== undefined && before.size === entry.size && before.modifiedAtMs === entry.modifiedAtMs ? before.stable + 1 : 1;
    next.set(entry.name, { size: entry.size, modifiedAtMs: entry.modifiedAtMs, stable });
  }
  const settled = (name: string): boolean => (next.get(name)?.stable ?? 0) >= options.stablePolls;
  const arrived = entries.map((entry) => entry.name).filter((name) => name !== options.manifestName && settled(name));
  return { arrived, state: { seen: next } };
}

export type FileLayout = { format: FileFormat; version: string; keyColumns: readonly string[] };

const ENTITY = /<!DOCTYPE|<!ENTITY/i;

const XML_NAME = '[A-Za-z_][\\w.-]*';
const XML_EMPTY = new RegExp(`^<(${XML_NAME})\\s*/>`);
const XML_OPEN = new RegExp(`^<(${XML_NAME})(?:\\s[^<>]*)?>`);

const xmlRefusal = (): DomainError => new DomainError('IMPORT_SCHEMA_INVALID', 422, 'xml');

/** The elements that make up a text, one after the other, and nothing else: a stray character, an unclosed tag or a nested element of the same name is refused, never skipped. */
function xmlElements(text: string): Array<{ name: string; inner: string }> {
  const found: Array<{ name: string; inner: string }> = [];
  let rest = text.trim();
  while (rest !== '') {
    const empty = XML_EMPTY.exec(rest);
    if (empty !== null) {
      found.push({ name: empty[1] as string, inner: '' });
      rest = rest.slice(empty[0].length).trimStart();
      continue;
    }
    const open = XML_OPEN.exec(rest);
    if (open === null) throw xmlRefusal();
    const name = open[1] as string;
    const close = rest.indexOf(`</${name}>`, open[0].length);
    if (close === -1) throw xmlRefusal();
    const inner = rest.slice(open[0].length, close);
    if (new RegExp(`<${name}[\\s>/]`).test(inner)) throw xmlRefusal();
    found.push({ name, inner });
    rest = rest.slice(close + name.length + 3).trimStart();
  }
  return found;
}

/**
 * Reads a flat XML file: one root, then one element per record, each with child elements that hold text only. A DOCTYPE or an entity is refused (no external entity, no expansion). Anything that is not exactly
 * that (an unclosed element, text between elements, a field that holds elements, a repeated field) is 422 IMPORT_SCHEMA_INVALID: a malformed file is never read as a shorter one.
 */
export function readFlatXml(text: string): Array<Record<string, string>> {
  if (ENTITY.test(text)) throw xmlRefusal();
  const body = text.replace(/^\uFEFF/, '').replace(/<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '');
  const roots = xmlElements(body);
  if (roots.length !== 1) throw xmlRefusal();
  const unescape = (value: string): string => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  return xmlElements((roots[0] as { inner: string }).inner).map((record) => {
    const row: Record<string, string> = {};
    for (const field of xmlElements(record.inner)) {
      if (field.inner.includes('<') || field.name in row) throw xmlRefusal();
      row[field.name] = unescape(field.inner.trim());
    }
    return row;
  });
}

/** The records of a file in the format of its layout, each with the line it came from. CSV and XLSX go through the framework reader; JSON is an array of flat objects; XML is the flat form above. */
export function recordsOfFile(name: string, bytes: Uint8Array, layout: FileLayout): SourceRecord[] {
  const toRecord = (fields: Record<string, SourceValue>, index: number, line: number | null): SourceRecord => {
    const key = layout.keyColumns.map((column) => String(fields[column] ?? '')).join('|');
    if (key === '' || layout.keyColumns.some((column) => fields[column] === undefined || fields[column] === null || fields[column] === '')) throw new DomainError('IMPORT_SCHEMA_INVALID', 422, 'key');
    return { key, sourceRef: `${name}#${line ?? index + 1}`, line, fields };
  };
  if (layout.format === 'CSV' || layout.format === 'XLSX') {
    const table = readTabularFile(bytes);
    return table.rows.map((cells, index) => {
      const fields: Record<string, SourceValue> = {};
      table.headers.forEach((header, column) => {
        fields[header.trim().toLowerCase().replace(/[\s-]+/g, '_')] = cells[column] ?? '';
      });
      return toRecord(fields, index, table.lines[index] ?? null);
    });
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (layout.format === 'JSON') {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new DomainError('IMPORT_SCHEMA_INVALID', 422, 'json');
    return parsed.map((item, index) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new DomainError('IMPORT_SCHEMA_INVALID', 422, 'json');
      const fields: Record<string, SourceValue> = {};
      for (const [field, value] of Object.entries(item)) {
        if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw new DomainError('IMPORT_SCHEMA_INVALID', 422, 'json');
        fields[field] = value;
      }
      return toRecord(fields, index, null);
    });
  }
  return readFlatXml(text).map((fields, index) => toRecord(fields, index, null));
}

/**
 * The adapter of the drop folder (end to end): detects the arrival of files (stable on `stablePolls` polls, listed in the manifest when there is one), checks each file against the checksum of the manifest (a file
 * whose bytes differ is REJECTED and named, never read), reads the records in the format of the layout and gives them with a batch hash. A file is settled (moved to the processed area) only by `confirm`, after the
 * load succeeded: until then the same file is read again, so a failed load loses nothing. No network is opened, ever.
 */
export class FileDropAdapter implements InboundProtocolPort {
  readonly protocol = 'FILE_DROP';
  private arrival: ArrivalState = { seen: new Map() };
  readonly rejected: Array<{ name: string; reason: 'CHECKSUM_MISMATCH' | 'NOT_IN_MANIFEST' | 'LAYOUT_INVALID' }> = [];

  private readonly folder: DropFolder;
  private readonly layout: FileLayout;
  private readonly options: { stablePolls?: number; manifestName?: string; requireManifest?: boolean };

  constructor(folder: DropFolder, layout: FileLayout, options: { stablePolls?: number; manifestName?: string; requireManifest?: boolean } = {}) {
    this.folder = folder;
    this.layout = layout;
    this.options = options;
  }

  async extract(request: ExtractRequest): Promise<ExtractBatch> {
    const manifestName = this.options.manifestName ?? 'MANIFEST.sha256';
    const entries = await this.folder.list();
    const detected = detectArrivals(entries, this.arrival, { stablePolls: this.options.stablePolls ?? 2, manifestName });
    this.arrival = detected.state;
    const hasManifest = entries.some((entry) => entry.name === manifestName);
    if (this.options.requireManifest === true && !hasManifest) return makeBatch([], request.watermark);
    const manifest = hasManifest ? parseManifest(new TextDecoder().decode(await this.folder.read(manifestName))) : null;
    const records: SourceRecord[] = [];
    const taken: string[] = [];
    for (const name of detected.arrived) {
      if (request.layoutVersion !== undefined && request.layoutVersion !== this.layout.version) throw new DomainError('EGP_LAYOUT_VERSION_UNKNOWN', 422, 'layout_version', { extensions: { layout_version: request.layoutVersion, supported: [this.layout.version] } });
      const bytes = await this.folder.read(name);
      if (manifest !== null) {
        const expected = manifest.get(name);
        if (expected === undefined) {
          this.rejected.push({ name, reason: 'NOT_IN_MANIFEST' });
          continue;
        }
        if (createHash('sha256').update(bytes).digest('hex') !== expected) {
          this.rejected.push({ name, reason: 'CHECKSUM_MISMATCH' });
          await this.folder.settle(name, 'REJECTED');
          continue;
        }
      }
      try {
        records.push(...recordsOfFile(name, bytes, this.layout));
        taken.push(name);
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        this.rejected.push({ name, reason: 'LAYOUT_INVALID' });
        await this.folder.settle(name, 'REJECTED');
      }
    }
    this.pending = taken;
    const watermark = taken.length === 0 ? request.watermark : taken[taken.length - 1] ?? request.watermark;
    return makeBatch(records, taken.length === 0 ? null : watermark);
  }

  private pending: string[] = [];

  /** The load succeeded: the files of the last batch leave the folder. */
  async confirm(): Promise<void> {
    for (const name of this.pending) await this.folder.settle(name, 'PROCESSED');
    this.pending = [];
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// WEBHOOK_INBOUND: signed payloads, replay protection, idempotency (end to end, no network of our own).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface WebhookDelivery {
  body: Uint8Array;
  /** Seconds since the epoch the sender signed at. */
  timestamp: number;
  /** Lower case hex HMAC-SHA256 of `<timestamp>.<body>`. */
  signature: string;
  idempotencyKey: string;
}

export const webhookSignatureOf = (secret: string, timestamp: number, body: Uint8Array): string => createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');

export type WebhookVerdict = 'ACCEPTED' | 'DUPLICATE';

/**
 * Judges a delivery: the signature must be the HMAC of the timestamp and the exact bytes (compared in constant time), the timestamp must be within `toleranceSeconds` of now either way (a captured delivery cannot be
 * replayed later), and the idempotency key must be new (a repeat inside the window is `DUPLICATE`, answered as a success so the sender stops, and never loaded twice). A bad signature or time is 401
 * `WEBHOOK_SIGNATURE_INVALID` and says nothing about which part was wrong.
 */
export function verifyWebhook(delivery: WebhookDelivery, options: { secret: string; now: Date; toleranceSeconds: number; seenKeys: ReadonlySet<string> }): WebhookVerdict {
  if (!/^[A-Za-z0-9][A-Za-z0-9:_./-]{7,119}$/.test(delivery.idempotencyKey)) throw new DomainError('VALIDATION_FAILED', 422, 'idempotency_key');
  const expected = Buffer.from(webhookSignatureOf(options.secret, delivery.timestamp, delivery.body), 'hex');
  const given = /^[0-9a-f]{64}$/.test(delivery.signature) ? Buffer.from(delivery.signature, 'hex') : Buffer.alloc(0);
  const signatureOk = given.length === expected.length && timingSafeEqual(given, expected);
  const timeOk = Number.isFinite(delivery.timestamp) && Math.abs(options.now.getTime() / 1000 - delivery.timestamp) <= options.toleranceSeconds;
  if (!signatureOk || !timeOk) throw new DomainError('WEBHOOK_SIGNATURE_INVALID', 401);
  return options.seenKeys.has(delivery.idempotencyKey) ? 'DUPLICATE' : 'ACCEPTED';
}

/** The adapter of verified deliveries: `receive` verifies and keeps a delivery once; `extract` hands the kept deliveries over as records (one per JSON object) and drops them only when `confirm` is called. */
export class WebhookInboundAdapter implements InboundProtocolPort {
  readonly protocol = 'WEBHOOK_INBOUND';
  private readonly seen = new Set<string>();
  private queue: Array<{ key: string; fields: Record<string, SourceValue> }> = [];

  private readonly options: { secret: string; toleranceSeconds: number; now: () => Date };

  constructor(options: { secret: string; toleranceSeconds: number; now: () => Date }) {
    this.options = options;
  }

  receive(delivery: WebhookDelivery): WebhookVerdict {
    const verdict = verifyWebhook(delivery, { secret: this.options.secret, now: this.options.now(), toleranceSeconds: this.options.toleranceSeconds, seenKeys: this.seen });
    if (verdict === 'DUPLICATE') return verdict;
    const parsed: unknown = JSON.parse(new TextDecoder().decode(delivery.body));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new DomainError('VALIDATION_FAILED', 422, 'body');
    const fields: Record<string, SourceValue> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw new DomainError('VALIDATION_FAILED', 422, 'body');
      fields[name] = value;
    }
    this.seen.add(delivery.idempotencyKey);
    this.queue.push({ key: delivery.idempotencyKey, fields });
    return verdict;
  }

  async extract(request: ExtractRequest): Promise<ExtractBatch> {
    const records = this.queue.map((item, index) => ({ key: item.key, sourceRef: `webhook:${item.key}`, line: index + 1, fields: item.fields }));
    this.taken = records.length;
    return makeBatch(records, records.length === 0 ? request.watermark : (records[records.length - 1] as SourceRecord).key);
  }

  private taken = 0;

  async confirm(): Promise<void> {
    this.queue = this.queue.slice(this.taken);
    this.taken = 0;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// GENERATOR: the deterministic producer (end to end).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** A generator produces the same bytes for the same inputs (no clock, no randomness inside): the hash of what it gave is the proof of what was handed to the other side. */
export class GeneratorAdapter {
  readonly protocol = 'GENERATOR';

  private readonly produce: (input: Readonly<Record<string, unknown>>) => Uint8Array;

  constructor(produce: (input: Readonly<Record<string, unknown>>) => Uint8Array) {
    this.produce = produce;
  }

  generate(input: Readonly<Record<string, unknown>>): { bytes: Uint8Array; sha256: string } {
    const bytes = this.produce(input);
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The in-memory fakes of the ports that are not implemented: they prove the contract (a batch, a hash, a watermark that moves forward) without any connection.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** A scripted source for HTTPS_REST, SOAP_XML, SFTP, DB_READ, MESSAGE_QUEUE and EMAIL_INBOX: records in order, each with a position; `extract` gives the ones after the watermark (all of them for a full snapshot). */
export class InMemorySourceFake implements InboundProtocolPort {
  readonly protocol: string;
  private readonly rows: readonly SourceRecord[];
  private readonly pageSize: number;

  constructor(protocol: string, rows: readonly SourceRecord[], pageSize = 100) {
    if (!REGISTRY.has(protocol)) throw new Error(`unknown protocol ${protocol}`);
    this.protocol = protocol;
    this.rows = rows;
    this.pageSize = pageSize;
  }

  async extract(request: ExtractRequest): Promise<ExtractBatch> {
    const start = request.mode === 'FULL_SNAPSHOT' || request.watermark === null ? 0 : this.rows.findIndex((row) => row.key === request.watermark) + 1;
    const page = this.rows.slice(start, start + Math.min(request.limit ?? this.pageSize, this.pageSize));
    return makeBatch(page, page.length === 0 ? null : (page[page.length - 1] as SourceRecord).key, start + page.length >= this.rows.length);
  }
}

/** A sink fake for the outbound side: remembers what it was sent and answers a repeated idempotency key with the receipt of the first send. */
export class InMemorySinkFake implements OutboundProtocolPort {
  readonly sent: OutboundMessage[] = [];
  private readonly receipts = new Map<string, string>();

  readonly protocol: string;

  constructor(protocol: string) {
    this.protocol = protocol;
  }

  async send(message: OutboundMessage): Promise<{ receipt: string }> {
    const known = this.receipts.get(message.idempotencyKey);
    if (known !== undefined) return { receipt: known };
    const receipt = createHash('sha256').update(message.body).digest('hex').slice(0, 16);
    this.receipts.set(message.idempotencyKey, receipt);
    this.sent.push(message);
    return { receipt };
  }
}

/** SOAP: the envelope of a request, built the same way every time (namespaces fixed, the body escaped). WS-Security is configuration: the mode names what the header carries, the secret never enters the envelope. */
export function soapEnvelope(input: { version: '1.1' | '1.2'; body: string; securityMode?: 'NONE' | 'USERNAME_TOKEN' | 'TIMESTAMP_SIGNATURE'; createdAt?: string }): string {
  const ns = input.version === '1.2' ? 'http://www.w3.org/2003/05/soap-envelope' : 'http://schemas.xmlsoap.org/soap/envelope/';
  const escape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const mode = input.securityMode ?? 'NONE';
  const header = mode === 'NONE' ? '' : `<soap:Header><wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" mode="${mode}">${input.createdAt === undefined ? '' : `<wsu:Timestamp xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"><wsu:Created>${escape(input.createdAt)}</wsu:Created></wsu:Timestamp>`}</wsse:Security></soap:Header>`;
  return `<soap:Envelope xmlns:soap="${ns}">${header}<soap:Body>${escape(input.body)}</soap:Body></soap:Envelope>`;
}

/** DB_READ never writes: only a single SELECT (or WITH ... SELECT) statement is accepted, with no second statement and no data-changing keyword. */
export function assertReadOnlyStatement(sql: string): void {
  const text = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').trim().replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(text) || text.includes(';') || /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|call|copy|into)\b/i.test(text)) throw new DomainError('VALIDATION_FAILED', 422, 'statement');
}
