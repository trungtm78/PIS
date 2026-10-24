import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MneFormStore, MneObligationRuleStore } from '@machvon/db';
import type { MneFormPackEntry, MneFormPackResult, MneRulePackEntry, MneRulePackResult, TenantTx } from '@machvon/db';

const PACK_FILE = 'form-pack.json';
const RESOURCE_CANDIDATES = [
  ['src', 'modules', 'mne'],
  ['apps', 'api', 'src', 'modules', 'mne'],
] as const;

type Raw = Record<string, unknown>;

export interface MneFormPack {
  packVersion: string;
  forms: readonly MneFormPackEntry[];
  rules: readonly MneRulePackEntry[];
}

export interface MnePackLoadResult {
  forms: MneFormPackResult;
  rules: MneRulePackResult;
}

const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);

function text(entry: Raw, field: string, where: string): string {
  const value = entry[field];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`MNE form pack: ${where} needs ${field}`);
  return value;
}

function optionalText(entry: Raw, field: string, where: string): string | undefined {
  const value = entry[field];
  return value === undefined || value === null ? undefined : text(entry, field, where);
}

function formOf(raw: unknown, index: number): MneFormPackEntry {
  const where = `form ${index + 1}`;
  if (!isRecord(raw)) throw new Error(`MNE form pack: ${where} is not an object`);
  const formats = raw.export_formats;
  if (!Array.isArray(formats)) throw new Error(`MNE form pack: ${where} needs export_formats`);
  return {
    formCode: text(raw, 'form_code', where),
    title: text(raw, 'title', where),
    reportKind: text(raw, 'report_kind', where),
    legalBasis: text(raw, 'legal_basis', where),
    legalConfirmationRef: optionalText(raw, 'legal_confirmation_ref', where),
    effectiveFrom: text(raw, 'effective_from', where),
    effectiveUntil: optionalText(raw, 'effective_until', where),
    schemaJson: raw.schema_json,
    docTemplateCode: text(raw, 'doc_template_code', where),
    exportFormats: formats as string[],
    watermarkText: text(raw, 'watermark_text', where),
  };
}

function ruleOf(raw: unknown, index: number): MneRulePackEntry {
  const where = `rule ${index + 1}`;
  if (!isRecord(raw)) throw new Error(`MNE form pack: ${where} is not an object`);
  return {
    ruleCode: text(raw, 'rule_code', where),
    formCode: text(raw, 'form_code', where),
    reportingRole: text(raw, 'reporting_role', where),
    recipient: text(raw, 'recipient', where),
    frequency: text(raw, 'frequency', where),
    dueRuleJson: raw.due_rule_json,
    legalBasis: text(raw, 'legal_basis', where),
    legalConfirmationRef: optionalText(raw, 'legal_confirmation_ref', where),
    effectiveFrom: text(raw, 'effective_from', where),
    effectiveUntil: optionalText(raw, 'effective_until', where),
  };
}

/** Reads the pack as the file holds it (snake_case, like the API): every form and rule needs its legal basis and its start date. */
export function parseFormPack(raw: unknown): MneFormPack {
  if (!isRecord(raw) || !Array.isArray(raw.forms) || !Array.isArray(raw.rules)) throw new Error('MNE form pack: the file has no forms or no rules');
  const forms = raw.forms.map(formOf);
  const rules = raw.rules.map(ruleOf);
  if (new Set(forms.map((form) => form.formCode)).size !== forms.length) throw new Error('MNE form pack: a form code appears twice');
  if (new Set(rules.map((rule) => rule.ruleCode)).size !== rules.length) throw new Error('MNE form pack: a rule code appears twice');
  return { packVersion: text(raw, 'pack_version', 'the pack'), forms, rules };
}

/** The platform pack of report forms and obligation rules (data: the legal text lives in form-pack.json, never in code). */
export function loadFormPack(cwd: string = process.cwd()): MneFormPack {
  const directory = RESOURCE_CANDIDATES.map((parts) => join(cwd, ...parts)).find((candidate) => existsSync(join(candidate, PACK_FILE)));
  if (directory === undefined) throw new Error('MNE form pack not found');
  return parseFormPack(JSON.parse(readFileSync(resolve(directory, PACK_FILE), 'utf8')));
}

/**
 * Gives a tenant the forms and rules of the platform pack, published and waiting for their legal confirmation (BR-MNE-01): the exported
 * files carry the watermark and the screens carry the label of the confirmation. A form whose DOC template is not in the library is
 * left out and reported, and so is the rule of that form; running it again changes nothing.
 */
export async function loadMnePack(tx: TenantTx, actor: string, pack: MneFormPack = loadFormPack()): Promise<MnePackLoadResult> {
  const forms = await new MneFormStore().loadPack(tx, pack.packVersion, pack.forms, actor);
  const rules = await new MneObligationRuleStore().loadPack(tx, pack.packVersion, pack.rules, actor);
  return { forms, rules };
}
