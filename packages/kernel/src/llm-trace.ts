import { randomUUID } from 'node:crypto';

/**
 * The trace of one request to a model, as it is handed to the store of traces (Langfuse, ST-KERNEL-046). The text of
 * the request and of the answer is in it, so personal data can be too: nothing leaves the process except through
 * `SanitisingTraceExporter`, which masks it first.
 */
export interface LlmTrace {
  id: string;
  name: string;
  timestamp?: string;
  userId?: string;
  sessionId?: string;
  input?: unknown;
  output?: unknown;
  metadata?: unknown;
  tags?: readonly string[];
}

/** The port a trace store sits behind. */
export interface TraceExporter {
  export(trace: LlmTrace): Promise<void>;
}

export type PiiKind = 'EMAIL' | 'NATIONAL_ID' | 'PHONE';

export interface PiiMatch {
  kind: PiiKind;
  /** Where the match starts in the text. */
  index: number;
  text: string;
}

// A number is personal data only on its own: not inside a longer number, not glued to letters, and not the last group of
// an identifier (`8000-000000000001` is the end of a UUID, not a national id).
const START = '(?<![0-9A-Za-z]-?)';
const END = '(?![0-9A-Za-z])';

// In the order they claim a text: the national id of twelve digits (which may start with 0, like a phone number) before the phone number.
const DETECTORS: ReadonlyArray<{ kind: PiiKind; pattern: RegExp }> = [
  { kind: 'EMAIL', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g },
  // The citizen identity card: twelve digits, written whole or in groups of three. A dot is not a separator here, because it groups amounts of money.
  { kind: 'NATIONAL_ID', pattern: new RegExp(`${START}\\d{3}[ -]?\\d{3}[ -]?\\d{3}[ -]?\\d{3}${END}`, 'g') },
  { kind: 'PHONE', pattern: new RegExp(`${START}(?:\\+84|0)[ .-]?\\d(?:[ .-]?\\d){8}${END}`, 'g') },
  // The old identity card: nine digits. A bare nine-digit amount is masked too, which is the safe side for a trace.
  { kind: 'NATIONAL_ID', pattern: new RegExp(`${START}\\d{9}${END}`, 'g') },
];

const PLACEHOLDER: Record<PiiKind, string> = { EMAIL: '[EMAIL]', NATIONAL_ID: '[NATIONAL_ID]', PHONE: '[PHONE]' };
const REDACTED = '[REDACTED]';
const SECRET_KEY = /pass(word|wd)|secret|authorization|api[_-]?key|private[_-]?key|(access|refresh|id|auth|bearer|session)[_-]?token|^token$/i;

/** Every national id, email address and phone number in the text, in the order they appear, none overlapping another. */
export function piiMatches(text: string): PiiMatch[] {
  const claimed: PiiMatch[] = [];
  for (const { kind, pattern } of DETECTORS) {
    for (const found of text.matchAll(pattern)) {
      const start = found.index;
      const end = start + found[0].length;
      if (!claimed.some((other) => start < other.index + other.text.length && other.index < end)) claimed.push({ kind, index: start, text: found[0] });
    }
  }
  return claimed.sort((a, b) => a.index - b.index);
}

/** The text with each national id, email address and phone number replaced by a placeholder that names the kind. */
export function maskPii(text: string): string {
  let masked = text;
  for (const match of piiMatches(text).reverse()) masked = masked.slice(0, match.index) + PLACEHOLDER[match.kind] + masked.slice(match.index + match.text.length);
  return masked;
}

function maskDeep(value: unknown): unknown {
  if (typeof value === 'string') return maskPii(value);
  if (Array.isArray(value)) return value.map(maskDeep);
  if (typeof value !== 'object' || value === null) return value;
  const masked: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) masked[maskPii(key)] = SECRET_KEY.test(key) ? REDACTED : maskDeep(member);
  return masked;
}

const bigintAsText = (_key: string, value: unknown): unknown => (typeof value === 'bigint' ? value.toString() : value);

/**
 * A copy of the trace in which every text, at every depth and under every name, has its national ids, emails and phone
 * numbers masked and the value under a name that holds a credential is `[REDACTED]`. Dates and big numbers become text and
 * what JSON cannot hold is left out; a trace that cannot be copied (it refers to itself) throws, and so is never exported.
 */
export function sanitizeTrace(trace: LlmTrace): LlmTrace {
  return maskDeep(JSON.parse(JSON.stringify(trace, bigintAsText))) as LlmTrace;
}

/** The processor in front of the store: a trace is masked before the store sees it, and nothing is exported when masking fails. */
export class SanitisingTraceExporter implements TraceExporter {
  private readonly next: TraceExporter;

  constructor(next: TraceExporter) {
    this.next = next;
  }

  async export(trace: LlmTrace): Promise<void> {
    await this.next.export(sanitizeTrace(trace));
  }
}

export interface LangfuseOptions {
  /** Address of the Langfuse server, inside the country (`infra/components/litellm-langfuse.json`). */
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  fetchImpl?: typeof fetch;
  newId?: () => string;
  now?: () => Date;
}

/**
 * Sends a trace to Langfuse as a `trace-create` event of its ingestion API. It does not mask anything itself: put it
 * behind `SanitisingTraceExporter`. A refusal is reported by its status only, never by the body, which can echo the trace.
 */
export class LangfuseTraceExporter implements TraceExporter {
  private readonly endpoint: string;
  private readonly authorization: string;
  private readonly fetchImpl: typeof fetch;
  private readonly newId: () => string;
  private readonly now: () => Date;

  constructor(options: LangfuseOptions) {
    this.endpoint = `${options.baseUrl.replace(/\/+$/, '')}/api/public/ingestion`;
    this.authorization = `Basic ${Buffer.from(`${options.publicKey}:${options.secretKey}`).toString('base64')}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.newId = options.newId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async export(trace: LlmTrace): Promise<void> {
    const event = { id: this.newId(), type: 'trace-create', timestamp: this.now().toISOString(), body: trace };
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: this.authorization },
      body: JSON.stringify({ batch: [event] }),
    });
    if (!response.ok) throw new Error(`LANGFUSE_HTTP_${response.status}`);
    // A batch is answered 207 with the events it refused; the ones it took are not in the list.
    const answer = (await response.json().catch(() => ({}))) as { errors?: unknown[] };
    if (Array.isArray(answer.errors) && answer.errors.length > 0) throw new Error('LANGFUSE_EVENT_REFUSED');
  }
}
