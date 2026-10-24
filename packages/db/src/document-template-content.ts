import { DomainError, canonicalJson, sha256Hex } from '@machvon/kernel';
import type { TemplateBlock, TemplateGroup } from './document-store.ts';

const MAX_BLOCKS = 200;
const MAX_BLOCK_TEXT = 5000;
/** The same syntax the renderer fills (template-render.ts): `{{ name }}` with letters, digits, underscores and dots. */
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;
/** A placeholder path: dotted names, never an empty segment. */
const PATH = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;
const BLOCK_KINDS: readonly string[] = ['heading', 'paragraph'];

export interface TemplateContent {
  blocks: TemplateBlock[];
  placeholderSchema: { required: string[] };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function invalidBody(): DomainError {
  return new DomainError('VALIDATION_FAILED', 422, 'body_blocks');
}

function invalidSchema(): DomainError {
  return new DomainError('PLACEHOLDER_SCHEMA_INVALID', 422, 'placeholder_schema');
}

/** The names of the `{{placeholders}}` of a text, or undefined when a brace is left that no placeholder owns. */
function placeholdersOf(text: string): string[] | undefined {
  const names = [...text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '');
  return /\{\{|\}\}/.test(text.replace(PLACEHOLDER, '')) ? undefined : names;
}

/**
 * Checks the body and the placeholder schema of a template revision before it is stored (BR-DOC-09): a body is a list of
 * headings and paragraphs, every placeholder is a well formed path, and every required field of the schema is a placeholder
 * of the body (a required field the body never uses would refuse payloads for nothing).
 */
export function validateTemplateContent(bodyBlocks: unknown, placeholderSchema: unknown): TemplateContent {
  if (!Array.isArray(bodyBlocks) || bodyBlocks.length === 0 || bodyBlocks.length > MAX_BLOCKS) throw invalidBody();
  const blocks: TemplateBlock[] = [];
  const used = new Set<string>();
  for (const raw of bodyBlocks as unknown[]) {
    if (!isRecord(raw) || Object.keys(raw).some((key) => key !== 'kind' && key !== 'text')) throw invalidBody();
    const { kind, text } = raw;
    if (typeof kind !== 'string' || !BLOCK_KINDS.includes(kind) || typeof text !== 'string') throw invalidBody();
    if (text.trim() === '' || text.length > MAX_BLOCK_TEXT || CONTROL.test(text)) throw invalidBody();
    const names = placeholdersOf(text);
    if (names === undefined || names.some((name) => !PATH.test(name))) throw new DomainError('PLACEHOLDER_SCHEMA_INVALID', 422, 'body_blocks');
    for (const name of names) used.add(name);
    blocks.push({ kind: kind as TemplateBlock['kind'], text });
  }
  if (!isRecord(placeholderSchema) || Object.keys(placeholderSchema).some((key) => key !== 'required')) throw invalidSchema();
  const required = placeholderSchema.required ?? [];
  if (!Array.isArray(required) || required.some((name) => typeof name !== 'string' || !PATH.test(name)) || new Set(required as string[]).size !== required.length) {
    throw invalidSchema();
  }
  if ((required as string[]).some((name) => !used.has(name))) throw invalidSchema();
  return { blocks, placeholderSchema: { required: [...(required as string[])] } };
}

/** The digest the renderer keeps with a render (`templateContentSha256`): the body, the schema, the type and the group. */
export function templateContentSha256(content: TemplateContent, docTypeCode: string, groupCode: TemplateGroup): string {
  return sha256Hex(canonicalJson({ blocks: content.blocks, placeholderSchema: content.placeholderSchema, docTypeCode, groupCode }));
}
