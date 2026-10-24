import { camel } from './catalogues';

/** One attribute of a catalogue type as the form shows it; the server judges the value, the form only helps to write it. */
export type AttributeSpec =
  | { name: string; kind: 'text' }
  | { name: string; kind: 'integer' }
  | { name: string; kind: 'boolean' }
  | { name: string; kind: 'choice'; family: string; choices: readonly string[] }
  | { name: string; kind: 'identifiers' }
  /** A list of words (media types, ...) typed with commas. */
  | { name: string; kind: 'words' }
  | { name: string; kind: 'ref'; refType: string }
  | { name: string; kind: 'refs'; refType: string };

/** The attributes of each type that has a form; the other types (the rule data) are written as JSON. */
export const TYPE_FORMS: Readonly<Record<string, readonly AttributeSpec[]>> = {
  FUND_SOURCE: [
    { name: 'category', kind: 'choice', family: 'category', choices: ['NSTW', 'NSDP', 'ODA', 'CTMTQG', 'OTHER'] },
    { name: 'relation', kind: 'choice', family: 'relation', choices: ['ADDITIVE', 'SUBSET_OF'] },
    { name: 'onlending', kind: 'boolean' },
  ],
  PROGRAM: [
    { name: 'kind', kind: 'choice', family: 'programKind', choices: ['CTMTQG', 'NATIONAL_TARGET', 'SECTORAL', 'LOCAL'] },
    { name: 'period_from', kind: 'integer' },
    { name: 'period_to', kind: 'integer' },
    { name: 'fund_source_key', kind: 'ref', refType: 'FUND_SOURCE' },
  ],
  SECTOR: [{ name: 'sort_order', kind: 'integer' }],
  PROJECT_GROUP: [{ name: 'rank', kind: 'integer' }],
  PROJECT_TYPE: [{ name: 'kind', kind: 'choice', family: 'projectKind', choices: ['CAPITAL_WORKS', 'PROCUREMENT', 'PREPARATION', 'OTHER'] }],
  PROJECT_STAGE: [
    { name: 'sequence', kind: 'integer' },
    { name: 'allowed_next', kind: 'refs', refType: 'PROJECT_STAGE' },
    { name: 'terminal', kind: 'boolean' },
  ],
  DECISION_TYPE: [
    { name: 'required_fields', kind: 'identifiers' },
    { name: 'template', kind: 'text' },
  ],
  UNIT: [
    { name: 'dimension', kind: 'choice', family: 'dimension', choices: ['LENGTH', 'AREA', 'VOLUME', 'MASS', 'COUNT', 'OTHER'] },
    { name: 'factor', kind: 'text' },
    { name: 'scale', kind: 'integer' },
    { name: 'rounding', kind: 'choice', family: 'rounding', choices: ['HALF_UP', 'HALF_EVEN', 'DOWN', 'UP'] },
  ],
  CURRENCY: [
    { name: 'iso_code', kind: 'text' },
    { name: 'scale', kind: 'integer' },
    { name: 'rounding', kind: 'choice', family: 'rounding', choices: ['HALF_UP', 'HALF_EVEN', 'DOWN', 'UP'] },
  ],
  CALENDAR: [
    { name: 'owner_module', kind: 'choice', family: 'ownerModule', choices: ['PRJ', 'CAP', 'DIS', 'PAY', 'CTR', 'MNE', 'DOC', 'DGV'] },
    { name: 'awaiting_confirmation', kind: 'boolean' },
    { name: 'cxn', kind: 'text' },
    { name: 'week_starts_on', kind: 'choice', family: 'weekday', choices: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] },
    { name: 'deadline_weekday', kind: 'choice', family: 'weekday', choices: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] },
    { name: 'deadline_time', kind: 'text' },
    { name: 'timezone', kind: 'choice', family: 'timezone', choices: ['Asia/Ho_Chi_Minh'] },
  ],
  DOCUMENT_TYPE: [
    { name: 'checklist', kind: 'identifiers' },
    { name: 'mime_types', kind: 'words' },
    { name: 'max_size_mb', kind: 'integer' },
  ],
  CONTRACT_TYPE: [
    { name: 'required_fields', kind: 'identifiers' },
    { name: 'version_policy', kind: 'choice', family: 'versionPolicy', choices: ['NEW_REVISION', 'ANNEX_ONLY', 'LOCKED_AFTER_SIGNING'] },
    { name: 'is_annex', kind: 'boolean' },
  ],
  PAYMENT_TYPE: [
    { name: 'kind', kind: 'choice', family: 'paymentKind', choices: ['PAYMENT', 'ADVANCE', 'RETENTION_RELEASE'] },
    { name: 'conditions', kind: 'identifiers' },
    { name: 'rule_set_key', kind: 'text' },
  ],
  PRIORITY: [
    { name: 'rank', kind: 'integer' },
    { name: 'response_hours', kind: 'integer' },
    { name: 'resolution_hours', kind: 'integer' },
    { name: 'working_calendar', kind: 'choice', family: 'workingCalendar', choices: ['ALL_DAYS', 'WORKING_DAYS'] },
    { name: 'escalate_after_hours', kind: 'integer' },
  ],
  ISSUE_CATEGORY: [
    { name: 'handler_unit_key', kind: 'text' },
    { name: 'sla_priority_key', kind: 'ref', refType: 'PRIORITY' },
  ],
  CONTRACTOR_CRITERION: [
    { name: 'category', kind: 'choice', family: 'criterionCategory', choices: ['QUALITY', 'SCHEDULE', 'SAFETY', 'COST', 'COMPLIANCE'] },
    { name: 'scale_max', kind: 'integer' },
    { name: 'evidence_required', kind: 'boolean' },
  ],
  EXPERT_ROLE: [
    { name: 'specialty', kind: 'text' },
    { name: 'conditions', kind: 'identifiers' },
  ],
  CONTACT_PURPOSE: [
    { name: 'consent', kind: 'choice', family: 'consent', choices: ['NOT_REQUIRED', 'EXPLICIT'] },
    { name: 'security_level', kind: 'choice', family: 'securityLevel', choices: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL'] },
  ],
  LANGUAGE: [{ name: 'native_name', kind: 'text' }],
  TREASURY_OFFICE: [
    { name: 'level', kind: 'choice', family: 'treasuryLevel', choices: ['CENTRAL', 'PROVINCE', 'DISTRICT'] },
    { name: 'province', kind: 'text' },
  ],
  RETENTION_POLICY: [
    { name: 'owner_module', kind: 'choice', family: 'ownerModule', choices: ['PRJ', 'CAP', 'DIS', 'PAY', 'CTR', 'MNE', 'DOC', 'DGV'] },
    { name: 'awaiting_confirmation', kind: 'boolean' },
    { name: 'cxn', kind: 'text' },
    { name: 'data_class', kind: 'text' },
    { name: 'classification', kind: 'choice', family: 'classification', choices: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] },
    { name: 'retention_years', kind: 'integer' },
    { name: 'permanent', kind: 'boolean' },
    { name: 'legal_hold_allowed', kind: 'boolean' },
  ],
  DECISION_AUTHORITY: [
    { name: 'agency_key', kind: 'text' },
    { name: 'decision_type_key', kind: 'ref', refType: 'DECISION_TYPE' },
    { name: 'scope', kind: 'choice', family: 'authorityScope', choices: ['NATIONAL', 'MINISTRY', 'PROVINCE', 'COMMUNE'] },
  ],
};

/** `PROJECT_STAGE` → `projectStage`, `fund_source_key` → `fundSourceKey`: the form of a name inside a translation key. */
export const keyPart = camel;

/** Every (type, attribute) pair and every choice value that a form shows, for the check that each has its text in both languages. */
export function formKeys(): { labels: Array<[string, string]>; values: Array<[string, string]> } {
  const labels: Array<[string, string]> = [];
  const values: Array<[string, string]> = [];
  for (const [type, specs] of Object.entries(TYPE_FORMS)) {
    for (const spec of specs) {
      labels.push([type, spec.name]);
      if (spec.kind === 'choice') for (const choice of spec.choices) values.push([spec.family, choice]);
    }
  }
  return { labels, values };
}

/** The attributes object that the JSON text holds, or undefined when the text is not an object (the typed fields wait until it is). */
export function attributesOf(json: string): Record<string, unknown> | undefined {
  if (json.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The JSON text of the attributes with one attribute set (an empty value removes it, so an optional attribute is never sent as an empty string). */
export function withAttribute(json: string, name: string, value: unknown): string {
  const current = { ...(attributesOf(json) ?? {}) };
  if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) delete current[name];
  else current[name] = value;
  return Object.keys(current).length === 0 ? '' : JSON.stringify(current, null, 2);
}

/** The words of a comma-separated list; empty items are dropped. */
export const wordsOf = (text: string): string[] =>
  text
    .split(',')
    .map((word) => word.trim())
    .filter((word) => word !== '');
