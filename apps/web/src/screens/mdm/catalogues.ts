import type { RecordView } from './model';

/** What a cell of a catalogue table can look up: the other entries by id, and the name of a value of a closed list. */
export interface CellContext {
  byId: ReadonlyMap<string, RecordView>;
  /** The name of a value of a closed list (a text, a flag): its own text in the language of the screen, the value itself when it has none. */
  value(family: string, raw: unknown): string;
  /** What a rule still waits for ("awaiting confirmation CXN-05"), or nothing once it is confirmed. */
  awaiting(record: RecordView): string;
}

export interface CatalogueColumn {
  key: string;
  read(record: RecordView, context: CellContext): string;
}

export interface CatalogueConfig {
  id: string;
  /** The segment of the keys of the screen: `mdm.<slug>.page.title`. */
  slug: string;
  types: readonly string[];
  /** The entries are shown as a tree under their parents. */
  tree: boolean;
  columns: readonly CatalogueColumn[];
  /** The rule data that applies to these entries, shown below them with its legal basis. */
  rules: readonly string[];
}

const attribute = (record: RecordView, name: string): unknown => record.attributes[name];
const plain = (value: unknown): string => {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' || typeof item === 'number').join(', ');
  return '';
};
const column = (key: string, read: CatalogueColumn['read']): CatalogueColumn => ({ key, read });

const KEY = column('key', (record) => record.businessKey);
const NAME = column('name', (record) => record.label ?? '');
const PARENT = column('parent', (record, { byId }) => (record.parentRecordId === null ? '' : (byId.get(record.parentRecordId)?.businessKey ?? '')));
const VALIDITY = column('validity', (record) => (record.validFrom === null ? '' : `${record.validFrom} → ${record.validUntil ?? ''}`));
const BASIS = column('basis', (record) => [record.revision === null ? '' : `v${record.revision}`, record.legalBasis ?? ''].filter((part) => part !== '').join(' · '));

const yesNo = (name: string): CatalogueColumn['read'] => (record, { value }) => value('boolean', attribute(record, name));
const field = (key: string, name: string): CatalogueColumn => column(key, (record) => plain(attribute(record, name)));
const choice = (key: string, family: string, name: string): CatalogueColumn => column(key, (record, { value }) => value(family, attribute(record, name)));

export const CATALOGUES: Readonly<Record<string, CatalogueConfig>> = {
  'MDM-13': {
    id: 'MDM-13',
    slug: 'documentType',
    types: ['DOCUMENT_TYPE'],
    tree: false,
    columns: [KEY, NAME, field('checklist', 'checklist'), field('mimeTypes', 'mime_types'), field('maxSize', 'max_size_mb')],
    rules: [],
  },
  'MDM-14': {
    id: 'MDM-14',
    slug: 'contractType',
    types: ['CONTRACT_TYPE'],
    tree: false,
    columns: [KEY, NAME, field('requiredFields', 'required_fields'), choice('versionPolicy', 'versionPolicy', 'version_policy'), column('annex', yesNo('is_annex'))],
    rules: [],
  },
  'MDM-15': {
    id: 'MDM-15',
    slug: 'paymentType',
    types: ['PAYMENT_TYPE'],
    tree: false,
    columns: [KEY, NAME, choice('paymentKind', 'paymentKind', 'kind'), field('conditions', 'conditions'), field('ruleSet', 'rule_set_key')],
    rules: [],
  },
  'MDM-17': {
    id: 'MDM-17',
    slug: 'issueCategory',
    types: ['ISSUE_CATEGORY'],
    tree: true,
    columns: [KEY, NAME, PARENT, field('handlerUnit', 'handler_unit_key'), field('slaPriority', 'sla_priority_key')],
    rules: [],
  },
  'MDM-18': {
    id: 'MDM-18',
    slug: 'priority',
    types: ['PRIORITY'],
    tree: false,
    columns: [
      KEY,
      NAME,
      field('rank', 'rank'),
      column('response', (record) => `${plain(attribute(record, 'response_hours'))} / ${plain(attribute(record, 'resolution_hours'))}`),
      choice('calendar', 'workingCalendar', 'working_calendar'),
      field('escalation', 'escalate_after_hours'),
    ],
    rules: [],
  },
  'MDM-19': {
    id: 'MDM-19',
    slug: 'contractorCriterion',
    types: ['CONTRACTOR_CRITERION'],
    tree: false,
    columns: [KEY, NAME, choice('criterionCategory', 'criterionCategory', 'category'), field('scaleMax', 'scale_max'), column('evidence', yesNo('evidence_required')), BASIS],
    rules: [],
  },
  'MDM-20': {
    id: 'MDM-20',
    slug: 'expertRole',
    types: ['EXPERT_ROLE'],
    tree: false,
    columns: [KEY, NAME, field('specialty', 'specialty'), field('conditions', 'conditions'), VALIDITY],
    rules: [],
  },
  'MDM-21': {
    id: 'MDM-21',
    slug: 'contactPurpose',
    types: ['CONTACT_PURPOSE'],
    tree: false,
    columns: [KEY, NAME, choice('consent', 'consent', 'consent'), choice('securityLevel', 'securityLevel', 'security_level')],
    rules: [],
  },
  'MDM-22': {
    id: 'MDM-22',
    slug: 'sharedText',
    types: ['LANGUAGE', 'SHARED_TEXT'],
    tree: false,
    columns: [
      column('type', (record) => record.masterType),
      KEY,
      NAME,
      column('translations', (record) => {
        const translations = attribute(record, 'translations');
        if (record.masterType === 'LANGUAGE') return plain(attribute(record, 'native_name'));
        return typeof translations === 'object' && translations !== null ? Object.keys(translations).sort().join(', ') : '';
      }),
      BASIS,
    ],
    rules: [],
  },
  'MDM-23': {
    id: 'MDM-23',
    slug: 'retention',
    types: ['RETENTION_POLICY'],
    tree: false,
    columns: [
      KEY,
      NAME,
      choice('classification', 'classification', 'classification'),
      column('retention', (record, { value }) => (attribute(record, 'permanent') === true ? value('retention', 'PERMANENT') : plain(attribute(record, 'retention_years')))),
      column('legalHold', yesNo('legal_hold_allowed')),
      column('confirmation', (record, { awaiting }) => awaiting(record)),
    ],
    rules: [],
  },
  'MDM-04': {
    id: 'MDM-04',
    slug: 'fundSource',
    types: ['FUND_SOURCE'],
    tree: true,
    columns: [
      KEY,
      NAME,
      column('category', (record, { value }) => value('category', attribute(record, 'category'))),
      PARENT,
      column('relation', (record, { value }) => value('relation', attribute(record, 'relation'))),
      VALIDITY,
    ],
    rules: [],
  },
  'MDM-05': {
    id: 'MDM-05',
    slug: 'program',
    types: ['PROGRAM'],
    tree: false,
    columns: [
      KEY,
      NAME,
      column('kind', (record, { value }) => value('programKind', attribute(record, 'kind'))),
      column('period', (record) => `${plain(attribute(record, 'period_from'))} – ${plain(attribute(record, 'period_to'))}`),
      column('source', (record) => plain(attribute(record, 'fund_source_key'))),
      BASIS,
    ],
    rules: [],
  },
  'MDM-06': {
    id: 'MDM-06',
    slug: 'sector',
    types: ['SECTOR'],
    tree: true,
    columns: [KEY, NAME, PARENT, column('order', (record) => plain(attribute(record, 'sort_order'))), VALIDITY],
    rules: [],
  },
  'MDM-07': {
    id: 'MDM-07',
    slug: 'projectGroup',
    types: ['PROJECT_GROUP', 'PROJECT_TYPE'],
    tree: false,
    columns: [
      column('type', (record) => record.masterType),
      KEY,
      NAME,
      column('criteria', (record, { value }) => (record.masterType === 'PROJECT_GROUP' ? `#${plain(attribute(record, 'rank'))}` : value('projectKind', attribute(record, 'kind')))),
      BASIS,
    ],
    rules: ['PROJECT_GROUP_THRESHOLDS', 'APPRAISAL_CRITERIA'],
  },
  'MDM-08': {
    id: 'MDM-08',
    slug: 'stage',
    types: ['PROJECT_STAGE'],
    tree: false,
    columns: [KEY, NAME, column('sequence', (record) => plain(attribute(record, 'sequence'))), column('allowedNext', (record) => plain(attribute(record, 'allowed_next'))), VALIDITY],
    rules: ['NATIONAL_CODE_REQUIRED', 'NATIONAL_CODE_FORMAT'],
  },
  'MDM-09': {
    id: 'MDM-09',
    slug: 'authority',
    types: ['DECISION_AUTHORITY'],
    tree: false,
    columns: [
      KEY,
      column('agency', (record) => plain(attribute(record, 'agency_key'))),
      column('decisionType', (record) => plain(attribute(record, 'decision_type_key'))),
      column('scope', (record, { value }) => value('authorityScope', attribute(record, 'scope'))),
      VALIDITY,
    ],
    rules: [],
  },
  'MDM-12': {
    id: 'MDM-12',
    slug: 'unit',
    types: ['UNIT', 'CURRENCY'],
    tree: false,
    columns: [
      column('type', (record) => record.masterType),
      KEY,
      NAME,
      column('dimension', (record, { value }) => (record.masterType === 'CURRENCY' ? plain(attribute(record, 'iso_code')) : value('dimension', attribute(record, 'dimension')))),
      column('factor', (record) => plain(attribute(record, 'factor'))),
      column('scale', (record) => plain(attribute(record, 'scale'))),
      column('rounding', (record, { value }) => value('rounding', attribute(record, 'rounding'))),
    ],
    rules: [],
  },
  'MDM-10': {
    id: 'MDM-10',
    slug: 'decisionType',
    types: ['DECISION_TYPE'],
    tree: false,
    columns: [KEY, NAME, column('requiredFields', (record) => plain(attribute(record, 'required_fields'))), column('template', (record) => plain(attribute(record, 'template')))],
    rules: [],
  },
};

/** The keys of the columns, for the check that every one of them has a heading in both languages. */
export const COLUMN_KEYS: readonly string[] = [...new Set(Object.values(CATALOGUES).flatMap((config) => config.columns.map((item) => item.key)))];

/** `SUBSET_OF` → `subsetOf`, `Asia/Ho_Chi_Minh` → `asiaHoChiMinh`: the form of a value inside a translation key. */
export function camel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
}

/** The entries in the order of the tree: each one under its parent, siblings by key; entries whose parent is not listed start a branch of their own. */
export function inTreeOrder(records: readonly RecordView[]): Array<{ record: RecordView; depth: number }> {
  const ids = new Set(records.map((record) => record.id));
  const children = new Map<string | null, RecordView[]>();
  for (const record of records) {
    const parent = record.parentRecordId !== null && ids.has(record.parentRecordId) && record.parentRecordId !== record.id ? record.parentRecordId : null;
    children.set(parent, [...(children.get(parent) ?? []), record]);
  }
  const ordered: Array<{ record: RecordView; depth: number }> = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number): void => {
    for (const record of [...(children.get(parent) ?? [])].sort((left, right) => left.businessKey.localeCompare(right.businessKey))) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      ordered.push({ record, depth });
      walk(record.id, depth + 1);
    }
  };
  walk(null, 0);
  // A ring of entries that are each other's parent has no top; none of them is dropped.
  for (const record of records) {
    if (!seen.has(record.id)) {
      seen.add(record.id);
      ordered.push({ record, depth: 0 });
      walk(record.id, 1);
    }
  }
  return ordered;
}

const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;
/** The byte order mark that makes a spreadsheet read the file as UTF-8, so that the accents survive. */
const BYTE_ORDER_MARK = '﻿';

/**
 * The rows as a CSV text. A cell that starts like a formula is written as text, so that a catalogue entry cannot run anything on the
 * machine of the person who exports it.
 */
export function toCsv(headings: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const cell = (value: string): string => {
    const safe = FORMULA_START.test(value) ? `'${value}` : value;
    return NEEDS_QUOTES.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
  };
  return `${BYTE_ORDER_MARK}${[headings, ...rows].map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
}

