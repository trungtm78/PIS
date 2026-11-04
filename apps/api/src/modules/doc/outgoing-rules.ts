import { DomainError, normalisePayload, parseVnd, payloadSha256 } from '@machvon/kernel';
import type { DraftRecipient } from '@machvon/db';

/** The items a reviewer confirms before the final PDF is locked (DOC.md F3, BR-DOC-13): each is a key of the i18n catalogue `doc.review.checklist.<key>`. */
export const REVIEW_CHECKLIST = ['national_title', 'motto', 'agency_name', 'number_symbol', 'summary', 'body', 'signer_title', 'recipients'] as const;
export type ReviewChecklistKey = (typeof REVIEW_CHECKLIST)[number];

/** One reason a draft cannot go on: the field the screen marks and a code it can explain. */
export interface FormatFailure {
  field: string;
  code: string;
}

const MAX_PAYLOAD_CHARS = 200_000;
const MAX_NAME_CHARS = 300;
const MAX_CODE_CHARS = 60;
const MAX_DEPTH = 12;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECIPIENT_KINDS: readonly string[] = ['INTERNAL_UNIT', 'EXTERNAL_AGENCY', 'PERSON'];
const RECIPIENT_MEMBERS: readonly string[] = ['kind', 'name', 'code', 'unit_id'];

// Members of a payload that declare the level of secrecy of a document, and the words of the three levels of state secret (Mat, Toi mat, Tuyet mat).
const SECRECY_KEYS: ReadonlySet<string> = new Set(['secrecy_level', 'secret_level', 'security_level', 'confidentiality_level', 'do_mat', 'mat_level', 'state_secret', 'state_secret_level', 'classification_level']);
const SECRET_LEVELS: ReadonlySet<string> = new Set(['mat', 'toi mat', 'tuyet mat', 'secret', 'top secret', 'state secret', 'true']);

const plain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Lower case, without diacritics, single spaces: a word with accents and capitals and the same word typed without them are the same word. */
function foldText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\u0111/gi, 'd') // U+0111/U+0110, the Vietnamese d with a stroke, which NFD does not decompose
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * BR-DOC-20: whether the payload declares a level of state secret (Mat, Toi mat, Tuyet mat). The platform stores no such document, so a
 * declaration is refused before anything is written. Returns the path of the first declaring member, or undefined.
 */
export function stateSecretDeclaration(value: unknown, path = 'payload', depth = 0): string | undefined {
  if (depth > MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = stateSecretDeclaration(item, `${path}[${index}]`, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!plain(value)) return undefined;
  for (const [key, member] of Object.entries(value)) {
    const name = foldText(key).replace(/ /g, '_');
    const declared = SECRECY_KEYS.has(name) && (typeof member === 'boolean' ? member : typeof member === 'string' && SECRET_LEVELS.has(foldText(member)));
    if (declared) return `${path}.${key}`;
    const found = stateSecretDeclaration(member, `${path}.${key}`, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

export interface NormalisedPayload {
  payload: Record<string, unknown>;
  sha256: string;
  /** Whole VND declared by the payload for the DoA band, as decimal text; null when it declares none. */
  amountVnd: string | null;
}

/** The stored form of a payload (BR-DOC-11): normalised, hashed, bounded; `amount_vnd`, when present, is a whole number of VND. */
export function normalisedPayload(raw: unknown, field = 'payload'): NormalisedPayload {
  if (!plain(raw)) throw new DomainError('PAYLOAD_SCHEMA_INVALID', 422, field, { extensions: { fields: [field] } });
  const payload = normalisePayload(raw) as Record<string, unknown>;
  if (JSON.stringify(payload).length > MAX_PAYLOAD_CHARS) throw new DomainError('PAYLOAD_SCHEMA_INVALID', 422, field, { extensions: { fields: [field] } });
  const amount = payload.amount_vnd;
  let amountVnd: string | null = null;
  if (amount !== undefined && amount !== null) {
    if (typeof amount !== 'string' || parseVnd(amount) === undefined) throw new DomainError('PAYLOAD_SCHEMA_INVALID', 422, 'amount_vnd', { extensions: { fields: ['amount_vnd'] } });
    amountVnd = amount;
  }
  return { payload, sha256: payloadSha256(payload), amountVnd };
}

/** The payload of a draft with its `content_blocks` (when given) under that name: `{{content_blocks.x}}` then reaches them. */
export function payloadWithBlocks(payload: unknown, blocks: unknown): unknown {
  if (blocks === undefined) return payload;
  if (!plain(payload) && payload !== undefined) return payload;
  const base = payload === undefined ? {} : payload;
  if (Object.hasOwn(base as Record<string, unknown>, 'content_blocks')) throw new DomainError('PAYLOAD_SCHEMA_INVALID', 422, 'content_blocks', { extensions: { fields: ['content_blocks'] } });
  return { ...(base as Record<string, unknown>), content_blocks: blocks };
}

function recipientProblem(index: number, member: string): DomainError {
  return new DomainError('VALIDATION_FAILED', 422, `recipients[${index}].${member}`);
}

/** The stored recipients: known members only, trimmed, a kind for each, repeated entries once. Units are checked by the caller. */
export function normaliseRecipients(raw: readonly object[] | undefined): DraftRecipient[] {
  const result: DraftRecipient[] = [];
  const seen = new Set<string>();
  for (const [index, item] of (raw ?? []).entries()) {
    if (!plain(item)) throw recipientProblem(index, 'name');
    for (const key of Object.keys(item)) if (!RECIPIENT_MEMBERS.includes(key)) throw recipientProblem(index, key);
    const name = typeof item.name === 'string' ? item.name.normalize('NFC').trim() : '';
    if (name === '' || name.length > MAX_NAME_CHARS) throw recipientProblem(index, 'name');
    const code = item.code === undefined ? undefined : typeof item.code === 'string' ? item.code.normalize('NFC').trim() : '';
    if (code !== undefined && (code === '' || code.length > MAX_CODE_CHARS)) throw recipientProblem(index, 'code');
    const unitId = item.unit_id === undefined ? undefined : typeof item.unit_id === 'string' && UUID.test(item.unit_id) ? item.unit_id.toLowerCase() : '';
    if (unitId === '') throw recipientProblem(index, 'unit_id');
    const kind = item.kind ?? (unitId === undefined ? 'EXTERNAL_AGENCY' : 'INTERNAL_UNIT');
    if (typeof kind !== 'string' || !RECIPIENT_KINDS.includes(kind)) throw recipientProblem(index, 'kind');
    const recipient: DraftRecipient = { kind: kind as DraftRecipient['kind'], name, ...(code === undefined ? {} : { code }), ...(unitId === undefined ? {} : { unit_id: unitId }) };
    const key = `${recipient.kind}|${name.toLowerCase()}|${code ?? ''}|${unitId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(recipient);
  }
  return result;
}

/** The names the face of the document prints under "Noi nhan" (BR-DOC-13). */
export const recipientNames = (recipients: readonly DraftRecipient[]): string[] => recipients.map((recipient) => recipient.name);

export interface DraftFacts {
  recipientCount: number;
  signerUserId: string | null;
  signingMode: string;
  delegationId: string | null;
}

/** The reasons a draft is not ready for review, before the payload is read against the template. */
export function readinessFailures(facts: DraftFacts): FormatFailure[] {
  const failures: FormatFailure[] = [];
  if (facts.recipientCount === 0) failures.push({ field: 'recipients', code: 'RECIPIENTS_REQUIRED' });
  if (facts.signerUserId === null) failures.push({ field: 'signer_user_id', code: 'SIGNER_REQUIRED' });
  if (facts.signingMode !== 'DIRECT' && facts.delegationId === null) failures.push({ field: 'delegation_id', code: 'DELEGATION_REQUIRED' });
  return failures;
}

/** The checklist as the reviewer sent it: every item of the catalogue must be confirmed with `true`; anything else fails that item. */
export function checklistFailures(checklist: Record<string, unknown> | undefined): FormatFailure[] {
  const sent = checklist ?? {};
  return REVIEW_CHECKLIST.filter((key) => sent[key] !== true).map((key) => ({ field: `format_checklist.${key}`, code: 'CHECK_NOT_CONFIRMED' }));
}

/** The checklist kept in the history: the catalogue's keys with their answers, nothing the caller added. */
export function storedChecklist(checklist: Record<string, unknown> | undefined): Record<ReviewChecklistKey, boolean> {
  const sent = checklist ?? {};
  return Object.fromEntries(REVIEW_CHECKLIST.map((key) => [key, sent[key] === true])) as Record<ReviewChecklistKey, boolean>;
}

export function formatCheckFailed(failures: readonly FormatFailure[]): DomainError {
  return new DomainError('FORMAT_CHECK_FAILED', 422, failures[0]?.field, { extensions: { failures: [...failures] } });
}
