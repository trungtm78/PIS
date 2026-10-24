import { DomainError, normalisePayload } from '@machvon/kernel';
import type { RenderBlock, RenderContent } from '@machvon/kernel';
import type { StateText } from './pdf-renderer';

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

export interface TemplateBody {
  title: string;
  docTypeCode: string;
  bodyBlocks: readonly RenderBlock[];
  placeholderSchema: { required?: readonly string[] | undefined };
}

export interface ContentSource {
  template: TemplateBody;
  payload: unknown;
  asOfDate: string;
}

function invalid(fields: readonly string[]): DomainError {
  return new DomainError('PAYLOAD_SCHEMA_INVALID', 422, fields[0], { extensions: { fields: [...fields] } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The member at a dotted path, own properties only: a path never reaches into a prototype. */
function lookup(payload: Record<string, unknown>, path: string): unknown {
  let current: unknown = payload;
  for (const part of path.split('.')) {
    if (!isRecord(current) || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

/** A scalar of the payload as text: strings in NFC, numbers as decimal text without an exponent, nothing for null. */
function scalarText(value: unknown, path: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.normalize('NFC');
  if (typeof value === 'number') return String(normalisePayload(value));
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  throw invalid([path]);
}

/**
 * BR-DOC-09: fills the `{{name}}` placeholders of a template body from the payload. Every required field must be
 * present and not empty; an optional placeholder with no value becomes empty text. Values are inserted once (a value
 * that looks like a placeholder stays text).
 */
export function fillPlaceholders(blocks: readonly RenderBlock[], payload: unknown, schema: { required?: readonly string[] | undefined }): RenderBlock[] {
  const data = isRecord(payload) ? payload : {};
  const missing = (schema.required ?? []).filter((path) => {
    const value = lookup(data, path);
    return value === undefined || value === null || value === '';
  });
  if (missing.length > 0) throw invalid(missing);
  return blocks.map((block) => ({ kind: block.kind, text: block.text.replace(PLACEHOLDER, (_match, path: string) => scalarText(lookup(data, path), path)) }));
}

/** Every field a payload still lacks for a template: the two fixed required members and the required placeholders, all at once. */
export function missingPayloadFields(payload: unknown, schema: { required?: readonly string[] | undefined }): string[] {
  const data = isRecord(payload) ? payload : {};
  const fixed = ['agency', 'place'].filter((field) => typeof data[field] !== 'string' || data[field].trim() === '');
  const placeholders = (schema.required ?? []).filter((path) => {
    const value = lookup(data, path);
    return value === undefined || value === null || value === '';
  });
  return [...new Set([...fixed, ...placeholders])];
}

function requiredText(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || value.trim() === '') throw invalid([field]);
  return value.normalize('NFC');
}

function optionalText(payload: Record<string, unknown>, field: string): string | null {
  const value = payload[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalid([field]);
  return value === '' ? null : value.normalize('NFC');
}

function recipientsOf(payload: Record<string, unknown>): string[] {
  const value = payload.recipients;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw invalid(['recipients']);
  return (value as string[]).map((item) => item.normalize('NFC'));
}

/** Decree 30/2020: a day below 10 and the months 1 and 2 are written with a leading zero. */
function placeDateOf(format: string, place: string, asOfDate: string): string {
  const [year = '', month = '', day = ''] = asOfDate.split('-');
  const padded = (text: string, limit: number): string => (Number(text) < limit ? `0${Number(text)}` : String(Number(text)));
  return format.replace('{place}', place).replace('{day}', padded(day, 10)).replace('{month}', padded(month, 3)).replace('{year}', year);
}

/**
 * The content a renderer draws, from a template and a payload. The members of the payload that are not placeholders
 * of the body fill the fixed parts of the document: `agency` and `place` are required; `parent_agency`,
 * `doc_type_name`, `summary`, `number`, `signer_title`, `signer_name` and the list `recipients` are optional.
 */
export function buildContent(source: ContentSource, text: Pick<StateText, 'numberPrefix' | 'placeDateFormat'>): RenderContent {
  const { payload } = source;
  if (!isRecord(payload)) throw invalid(['payload']);
  const agency = requiredText(payload, 'agency');
  const place = requiredText(payload, 'place');
  const blocks = fillPlaceholders(source.template.bodyBlocks, payload, source.template.placeholderSchema);
  const number = optionalText(payload, 'number');
  return {
    parentAgency: optionalText(payload, 'parent_agency'),
    agency,
    docTypeName: optionalText(payload, 'doc_type_name') ?? source.template.title,
    numberText: number === null ? text.numberPrefix : `${text.numberPrefix} ${number}`,
    placeDate: placeDateOf(text.placeDateFormat, place, source.asOfDate),
    summary: optionalText(payload, 'summary'),
    blocks,
    signerTitle: optionalText(payload, 'signer_title'),
    signerName: optionalText(payload, 'signer_name'),
    recipients: recipientsOf(payload),
  };
}
