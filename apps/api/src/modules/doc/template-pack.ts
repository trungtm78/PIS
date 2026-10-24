import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DocumentStore, DocumentTemplateStore } from '@machvon/db';
import type { PackLoadResult, PackTemplate, TemplatePack, TenantTx } from '@machvon/db';
import { resourceDirectory } from './pdf-renderer';

const PACK_FILE = 'template-pack.json';
const GROUPS: readonly string[] = ['DECISION', 'OFFICIAL_LETTER', 'REPORT_DISBURSEMENT', 'REPORT_MONITORING', 'TREASURY_FORM', 'SETTLEMENT_FORM', 'AUDIT_FOLLOWUP', 'OTHER'];

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);

function text(entry: Raw, field: string, where: string): string {
  const value = entry[field];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`template pack: ${where} needs ${field}`);
  return value;
}

function optionalText(entry: Raw, field: string, where: string): string | undefined {
  const value = entry[field];
  if (value === undefined || value === null) return undefined;
  return text(entry, field, where);
}

function templateOf(raw: unknown, index: number): PackTemplate {
  const where = `template ${index + 1}`;
  if (!isRecord(raw)) throw new Error(`template pack: ${where} is not an object`);
  const group = text(raw, 'group_code', where);
  if (!GROUPS.includes(group)) throw new Error(`template pack: ${where} has an unknown group`);
  return {
    templateCode: text(raw, 'template_code', where),
    groupCode: group as PackTemplate['groupCode'],
    docTypeCode: text(raw, 'doc_type_code', where),
    formCode: optionalText(raw, 'form_code', where),
    title: text(raw, 'title', where),
    sourceModule: optionalText(raw, 'source_module', where),
    layoutProfileCode: text(raw, 'layout_profile_code', where),
    bodyBlocks: raw.body_blocks,
    placeholderSchema: raw.placeholder_schema,
    legalBasis: text(raw, 'legal_basis', where),
    watermarkText: text(raw, 'watermark_text', where),
    effectiveFrom: text(raw, 'effective_from', where),
    effectiveUntil: optionalText(raw, 'effective_until', where),
  };
}

/** Reads the pack as the file holds it (snake_case, like the API): every template needs its legal basis, watermark and start date. */
export function parseTemplatePack(raw: unknown): TemplatePack {
  if (!isRecord(raw) || !Array.isArray(raw.templates)) throw new Error('template pack: the file has no templates');
  const templates = raw.templates.map(templateOf);
  const codes = templates.map((template) => template.templateCode);
  if (new Set(codes).size !== codes.length) throw new Error('template pack: a template code appears twice');
  return { packVersion: text(raw, 'pack_version', 'the pack'), templates };
}

/** The platform pack of decision, letter and monitoring-report templates (data: its legal text lives in template-pack.json). */
export function loadTemplatePack(directory: string = resourceDirectory()): TemplatePack {
  return parseTemplatePack(JSON.parse(readFileSync(join(directory, PACK_FILE), 'utf8')));
}

/**
 * Gives a tenant the layout profile of Decree 30/2020 and the platform pack, published and waiting for legal confirmation
 * (every render then carries the watermark). Running it again changes nothing. A tenant is provisioned with it (DOC F12).
 */
export async function loadPlatformTemplates(tx: TenantTx, actor: string, pack: TemplatePack = loadTemplatePack()): Promise<PackLoadResult> {
  await new DocumentStore().seedDefaults(tx, actor);
  return new DocumentTemplateStore().loadPack(tx, pack, actor);
}
