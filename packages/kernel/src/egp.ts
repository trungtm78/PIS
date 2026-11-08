import { canonicalJson, sha256Hex } from './canonical-json.ts';
import { hasControlChar, hasControlCharExceptWhitespace } from './control-chars.ts';
import { compareDecimal, subtractDecimal } from './decimal.ts';
import { DomainError } from './errors.ts';
import { accept, planFileImport, reject, sourceRowsOfTable } from './file-import.ts';
import type { FileImportFormat, SourceRow } from './file-import.ts';
import { PROCUREMENT_SOURCE_SYSTEM, momentOf, vietnamDayOf } from './procurement-file.ts';
import { CALENDAR_TIMEZONES, DAY_MS, dayOf, isoOf } from './reporting-calendar.ts';
import { findingOf } from './rule-findings.ts';
import type { RuleFinding } from './rule-findings.ts';
import { readTabularFile } from './tabular-file.ts';
import { DEFAULT_WORKING_INTERVALS, WORKING_TIME_ZONE, isWorkingDay } from './working-time.ts';
import type { WorkCalendarContent, WorkCalendarSource, WorkingInterval } from './working-time.ts';
import type { AdapterStatus, ConnectorMode } from './connector.ts';
import { message } from './messages.ts';

/**
 * The connector to the national e-procurement network, muasamcong.mof.gov.vn (EGP-1, EGP-2; plan "EGP-1 muasamcong inbound"; spec docs/egp-connector.md).
 *
 * THIS MODULE IS PURE AND NEVER OPENS A CONNECTION. It imports no network module and calls no `fetch`: the file adapter reads bytes a person hands over, the API adapter is a stub that
 * refuses (`EGP_API_UNAVAILABLE`) until the operator of the network publishes a specification and gives the agency access. A test (packages/kernel/test/egp.test.ts) proves both: it
 * replaces `fetch`, `net`, `tls`, `http`, `https` and `dns` with functions that fail, runs every operation of the file adapter, and also reads this file for any import of them.
 *
 * EVERYTHING HERE THAT DEPENDS ON THE OFFICIAL FORMAT IS A WORKING ASSUMPTION and is PENDING-EXTERNAL (eng-review R18): no official sample file and no specification of the network were
 * available, so the layouts below (`WORKING-ASSUMPTION-2026.2`) are the smallest ones that carry what the register needs. They are versioned and kept with every import; a deliverable that
 * rests on them cannot be accepted until the official fixture and the confirmation of the recipient exist (`egpAcceptance`). The legal deadlines are configuration flagged UNVERIFIED.
 */

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Names.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The entry of the connector registry (ADM connectors, ST-ADM-018). It stays Draft while its adapter is PROPOSED: only a VERIFIED adapter may be Active (`activationBlock`). */
export const EGP_CONNECTOR_CODE = 'egp.muasamcong';
/** The source system written on the rows of `master_crosswalk` and on `procurement_external_link`: the same word the file of BID-17/19 already uses. */
export const EGP_SOURCE_SYSTEM = PROCUREMENT_SOURCE_SYSTEM;
/** The layout version of every file of this module. `WORKING-ASSUMPTION` says it is not the official one. */
export const EGP_LAYOUT_VERSION = 'WORKING-ASSUMPTION-2026.2';
export const EGP_LAYOUT_VERSIONS: readonly string[] = [EGP_LAYOUT_VERSION];
/** Until the owner of the network confirms a layout the adapter is a proposal, as in BID-19. */
export const EGP_ADAPTER_STATUS: AdapterStatus = 'PROPOSED';
export const EGP_API_UNAVAILABLE_CODE = 'EGP_API_UNAVAILABLE';
/** The most rows of one file (the file import framework's limit). */
export const EGP_MAX_ROWS = 5000;

export const isWorkingAssumptionLayout = (version: string): boolean => version.startsWith('WORKING-ASSUMPTION');

/** What the acceptance of a deliverable that rests on a layout or a number says (R18). */
export type EgpAcceptance = 'PENDING_EXTERNAL' | 'ACCEPTABLE';

/** A deliverable built on a working-assumption layout is PENDING-EXTERNAL: UAT may run it but its verdict excludes it explicitly until the official sample file and the confirmation of the recipient exist. */
export const egpAcceptance = (layoutVersion: string): EgpAcceptance => (isWorkingAssumptionLayout(layoutVersion) ? 'PENDING_EXTERNAL' : 'ACCEPTABLE');

/** The inputs from outside the agency this lane waits for (the register of external dependencies, R1): who gives it, and what switches when it arrives. */
export interface EgpPendingExternalItem {
  code: string;
  what: string;
  owner: string;
  workingAssumption: string;
  switchesWhenItArrives: string;
}

export const EGP_PENDING_EXTERNAL_ITEMS: readonly EgpPendingExternalItem[] = [
  { code: 'SAMPLE_KHLCNT', what: 'Official sample file of the plan (KHLCNT) and its column specification', owner: 'Operator of the national network', workingAssumption: 'Layout KHLCNT of WORKING-ASSUMPTION-2026.2', switchesWhenItArrives: 'The KHLCNT layout of packages/kernel/src/egp.ts; BID-24 shows the official version' },
  { code: 'SAMPLE_TBMT', what: 'Official sample file of the notice of invitation (TBMT)', owner: 'Operator of the national network', workingAssumption: 'Layout TBMT of WORKING-ASSUMPTION-2026.2', switchesWhenItArrives: 'The TBMT layout' },
  { code: 'SAMPLE_RESULT', what: 'Official sample file of the result of the choice of contractor', owner: 'Operator of the national network', workingAssumption: 'Layout RESULT of WORKING-ASSUMPTION-2026.2', switchesWhenItArrives: 'The RESULT layout' },
  { code: 'SAMPLE_CONTRACTOR', what: message('egp.egp_pending_external_items.what.sample_contractor'), owner: 'Operator of the national network', workingAssumption: 'Layout CONTRACTOR of WORKING-ASSUMPTION-2026.2', switchesWhenItArrives: 'The CONTRACTOR layout' },
  { code: 'SAMPLE_RESTRICTION', what: 'Official sample of the list of contractors under restriction', owner: 'Operator of the national network', workingAssumption: 'Layout RESTRICTION of WORKING-ASSUMPTION-2026.2', switchesWhenItArrives: 'The RESTRICTION layout' },
  { code: 'API_SPECIFICATION', what: 'API specification, credentials and a test environment of the network', owner: 'Operator of the national network', workingAssumption: 'None: the API adapter refuses with EGP_API_UNAVAILABLE', switchesWhenItArrives: 'EgpApiAdapter is implemented; the connector may become VERIFIED' },
  { code: 'POSTING_RECEIPT_FORMAT', what: 'The receipt the network gives for a posting (number, time)', owner: 'Operator of the national network', workingAssumption: 'A free reference typed by the person who posted', switchesWhenItArrives: 'The receipt reference of an obligation is checked against the format' },
  { code: 'LEGAL_TEXT_DEADLINES', what: message('egp.egp_pending_external_items.what.legal_text_deadlines'), owner: 'Legal staff of the customer', workingAssumption: 'Rule EGP_POSTING_DEADLINES default, flagged UNVERIFIED', switchesWhenItArrives: 'The tenant approves its own EGP_POSTING_DEADLINES rule and the flag clears' },
];

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Small readers of a cell.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const MONEY = /^\d{1,18}(\.\d{1,2})?$/;
const TAX_CODE = /^\d{10}(-\d{3})?$/;

const realDate = (year: number, month: number, day: number): boolean => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

/** `YYYY-MM-DD` or `DD/MM/YYYY` as the calendar day `YYYY-MM-DD` (years 2000 to 2100, a day that exists); undefined for anything else, a date-time included. */
export function egpDayOf(cell: string): string | undefined {
  const text = cell.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const vn = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  const parts = iso !== null ? [Number(iso[1]), Number(iso[2]), Number(iso[3])] : vn !== null ? [Number(vn[3]), Number(vn[2]), Number(vn[1])] : undefined;
  if (parts === undefined) return undefined;
  const [year, month, day] = parts as [number, number, number];
  if (year < 2000 || year > 2100 || !realDate(year, month, day)) return undefined;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The tax code (the tax number) of a contractor: 10 digits, or 10 digits and a 3 digit branch (`0101234567-001`, also written as 13 digits). Spaces are dropped. A contractor is identified by it,
 * never by name (BR-BID-01, MDM F5); the check digit is not verified (the algorithm is not in the sources read).
 */
export function normaliseTaxCode(raw: string): string | undefined {
  const text = raw.replace(/\s+/g, '');
  if (/^\d{13}$/.test(text)) return `${text.slice(0, 10)}-${text.slice(10)}`;
  return TAX_CODE.test(text) ? text : undefined;
}

/** An amount in VND as plain digits with at most two decimals and no thousands separator (a comma or a dot between thousands is ambiguous, so it is refused); leading zeros and trailing decimal zeros are dropped. */
export function egpMoneyOf(cell: string): string | undefined {
  const text = cell.trim();
  if (!MONEY.test(text)) return undefined;
  const [integer = '0', fraction = ''] = text.split('.');
  const whole = integer.replace(/^0+(?=\d)/, '');
  const decimals = fraction.replace(/0+$/, '');
  return decimals === '' ? whole : `${whole}.${decimals}`;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The layouts of the files (WORKING-ASSUMPTION-2026.2): KHLCNT, TBMT, RESULT, CONTRACTOR, RESTRICTION.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const EGP_LAYOUT_KINDS = ['KHLCNT', 'TBMT', 'RESULT', 'CONTRACTOR', 'RESTRICTION'] as const;
export type EgpLayoutKind = (typeof EGP_LAYOUT_KINDS)[number];

/** The methods of choosing a contractor (Law 22/2023, written in the words of the register: `procurement_package.method` reads OPEN_BIDDING). */
export const EGP_SELECTION_METHODS = ['OPEN_BIDDING', 'LIMITED_BIDDING', 'DIRECT_APPOINTMENT', 'COMPETITIVE_QUOTATION', 'DIRECT_PURCHASE', 'SELF_EXECUTION', 'COMMUNITY_PARTICIPATION', 'SPECIAL_CASE'] as const;
export const EGP_NOTICE_KINDS = ['INVITATION', 'MODIFICATION', 'CANCELLATION'] as const;
export const EGP_RESULT_KINDS = ['AWARDED', 'NO_QUALIFIED_BID', 'CANCELLED'] as const;
export const EGP_LEGAL_STATUSES = ['ACTIVE', 'SUSPENDED', 'DISSOLVED', 'UNKNOWN'] as const;
export const EGP_RESTRICTION_KINDS = ['DEBARMENT', 'REPUTATION_LISTED'] as const;
export const EGP_RESTRICTION_SCOPES = ['NATIONWIDE', 'MINISTRY', 'PROVINCE'] as const;

type ColumnKind = 'code' | 'text' | 'day' | 'moment' | 'money' | 'int' | 'enum' | 'taxCode';

interface ColumnSpec {
  name: string;
  kind: ColumnKind;
  /** A row without a value is refused. */
  required: boolean;
  /** The header must name the column although a row may leave it empty (the columns a cross-field rule needs). Defaults to `required`. */
  headerRequired?: boolean;
  max?: number;
  values?: readonly string[];
  /** What an empty optional cell becomes. */
  fallback?: string;
}

const CODE_MAX = 100;
const OUR_CODE_MAX = 50;
const col = (name: string, kind: ColumnKind, required: boolean, extra: Partial<ColumnSpec> = {}): ColumnSpec => ({ name, kind, required, ...extra });
const choice = (name: string, values: readonly string[], required: boolean, extra: Partial<ColumnSpec> = {}): ColumnSpec => col(name, 'enum', required, { values, ...extra });

type Cells = Readonly<Record<string, string>>;

export interface EgpPlanRecord {
  planCode: string;
  packageExternalCode: string;
  packageName: string | null;
  estimatedPrice: string | null;
  selectionMethod: string | null;
  approvedOn: string | null;
  decisionNo: string | null;
  projectCode: string | null;
  packageCode: string | null;
}

export interface EgpNoticeRecord {
  noticeCode: string;
  noticeVersion: number;
  noticeKind: string;
  packageExternalCode: string;
  planCode: string | null;
  /** Moments as ISO date-times in UTC. */
  publishedAt: string;
  bidClosingAt: string | null;
  bidOpeningAt: string | null;
  estimatedPrice: string | null;
  bidSecurityAmount: string | null;
  projectCode: string | null;
  packageCode: string | null;
}

export interface EgpResultRecord {
  resultCode: string;
  noticeCode: string;
  packageExternalCode: string;
  resultKind: string;
  publishedAt: string;
  approvedOn: string | null;
  contractorTaxCode: string | null;
  contractorName: string | null;
  awardPrice: string | null;
  projectCode: string | null;
  packageCode: string | null;
}

export interface EgpContractorRecord {
  contractorTaxCode: string;
  contractorName: string;
  externalContractorCode: string | null;
  legalStatus: string | null;
  registeredAddress: string | null;
  violationCount: number | null;
  asOf: string;
}

export interface EgpRestrictionRecord {
  restrictionCode: string;
  contractorTaxCode: string;
  contractorName: string | null;
  restrictionKind: string;
  scope: string | null;
  validFrom: string;
  validUntil: string;
  decisionNo: string;
  decisionDate: string | null;
  legalBasis: string | null;
}

export interface EgpRecordByKind {
  KHLCNT: EgpPlanRecord;
  TBMT: EgpNoticeRecord;
  RESULT: EgpResultRecord;
  CONTRACTOR: EgpContractorRecord;
  RESTRICTION: EgpRestrictionRecord;
}

interface Layout<K extends EgpLayoutKind> {
  kind: K;
  /** The position in `integration_cursor` and `file_import.connector_code` of the files of this layout. */
  connectorCode: string;
  columns: readonly ColumnSpec[];
  /** The business key from the cells (raw or normalised: it must give the same answer for both); empty when a part is missing. */
  keyOf: (cells: Cells) => string;
  /** A rule across the normalised values that a cell alone cannot state. */
  cross: (values: Cells) => { code: string; field: string } | undefined;
  build: (values: Cells) => EgpRecordByKind[K];
}

const opt = (value: string | undefined): string | null => (value === undefined || value === '' ? null : value);
const get = (cells: Cells, name: string): string => cells[name] ?? '';
const taxOf = (cells: Cells, name = 'contractor_tax_code'): string => normaliseTaxCode(get(cells, name)) ?? get(cells, name).trim();
const keyOfParts = (parts: readonly string[]): string => (parts.some((part) => part === '') ? '' : parts.join('|'));

const KHLCNT: Layout<'KHLCNT'> = {
  kind: 'KHLCNT',
  connectorCode: 'EGP_KHLCNT_FILE',
  columns: [
    col('plan_code', 'code', true),
    col('package_external_code', 'code', true),
    col('package_name', 'text', false, { max: 500 }),
    col('estimated_price', 'money', false),
    choice('selection_method', EGP_SELECTION_METHODS, false),
    col('approved_on', 'day', false),
    col('decision_no', 'text', false, { max: 100 }),
    col('project_code', 'code', false, { max: OUR_CODE_MAX }),
    col('package_code', 'code', false, { max: OUR_CODE_MAX }),
  ],
  keyOf: (cells) => keyOfParts([get(cells, 'plan_code').trim(), get(cells, 'package_external_code').trim()]),
  cross: () => undefined,
  build: (v) => ({
    planCode: get(v, 'plan_code'),
    packageExternalCode: get(v, 'package_external_code'),
    packageName: opt(v['package_name']),
    estimatedPrice: opt(v['estimated_price']),
    selectionMethod: opt(v['selection_method']),
    approvedOn: opt(v['approved_on']),
    decisionNo: opt(v['decision_no']),
    projectCode: opt(v['project_code']),
    packageCode: opt(v['package_code']),
  }),
};

const TBMT: Layout<'TBMT'> = {
  kind: 'TBMT',
  connectorCode: 'EGP_TBMT_FILE',
  columns: [
    col('notice_code', 'code', true),
    col('notice_version', 'int', false, { fallback: '0', max: 99 }),
    choice('notice_kind', EGP_NOTICE_KINDS, false, { fallback: 'INVITATION' }),
    col('package_external_code', 'code', true),
    col('plan_code', 'code', false),
    col('published_at', 'moment', true),
    col('bid_closing_at', 'moment', false),
    col('bid_opening_at', 'moment', false),
    col('estimated_price', 'money', false),
    col('bid_security_amount', 'money', false),
    col('project_code', 'code', false, { max: OUR_CODE_MAX }),
    col('package_code', 'code', false, { max: OUR_CODE_MAX }),
  ],
  keyOf: (cells) => {
    const code = get(cells, 'notice_code').trim();
    const version = get(cells, 'notice_version').trim();
    return code === '' ? '' : `${code}|${version === '' ? '0' : String(Number(version) || 0)}`;
  },
  // The notice is published before the bid closes, and the bid closes before it opens (the same moment is allowed: BID 3 F8).
  cross: (v) => {
    const published = get(v, 'published_at');
    const closing = get(v, 'bid_closing_at');
    const opening = get(v, 'bid_opening_at');
    if (closing !== '' && published > closing) return { code: 'BID_DATES_ORDER_INVALID', field: 'bid_closing_at' };
    if (opening !== '' && closing !== '' && closing > opening) return { code: 'BID_DATES_ORDER_INVALID', field: 'bid_opening_at' };
    if (opening !== '' && closing === '' && published > opening) return { code: 'BID_DATES_ORDER_INVALID', field: 'bid_opening_at' };
    return undefined;
  },
  build: (v) => ({
    noticeCode: get(v, 'notice_code'),
    noticeVersion: Number(get(v, 'notice_version')),
    noticeKind: get(v, 'notice_kind'),
    packageExternalCode: get(v, 'package_external_code'),
    planCode: opt(v['plan_code']),
    publishedAt: get(v, 'published_at'),
    bidClosingAt: opt(v['bid_closing_at']),
    bidOpeningAt: opt(v['bid_opening_at']),
    estimatedPrice: opt(v['estimated_price']),
    bidSecurityAmount: opt(v['bid_security_amount']),
    projectCode: opt(v['project_code']),
    packageCode: opt(v['package_code']),
  }),
};

const RESULT: Layout<'RESULT'> = {
  kind: 'RESULT',
  connectorCode: 'EGP_RESULT_FILE',
  columns: [
    col('result_code', 'code', true),
    col('notice_code', 'code', true),
    col('package_external_code', 'code', true),
    choice('result_kind', EGP_RESULT_KINDS, true),
    col('published_at', 'moment', true),
    col('approved_on', 'day', false),
    col('contractor_tax_code', 'taxCode', false, { headerRequired: true }),
    col('contractor_name', 'text', false, { max: 300 }),
    col('award_price', 'money', false, { headerRequired: true }),
    col('project_code', 'code', false, { max: OUR_CODE_MAX }),
    col('package_code', 'code', false, { max: OUR_CODE_MAX }),
  ],
  // A joint venture or a package of lots has one row for each winner: the key is the result and the winner (a result nobody won is keyed by the result).
  keyOf: (cells) => {
    const code = get(cells, 'result_code').trim();
    return code === '' ? '' : `${code}|${taxOf(cells)}`;
  },
  cross: (v) => {
    const awarded = get(v, 'result_kind') === 'AWARDED';
    const tax = get(v, 'contractor_tax_code');
    const price = get(v, 'award_price');
    if (awarded && tax === '') return { code: 'AWARD_FIELDS_REQUIRED', field: 'contractor_tax_code' };
    if (awarded && price === '') return { code: 'AWARD_FIELDS_REQUIRED', field: 'award_price' };
    if (!awarded && tax !== '') return { code: 'AWARD_FIELDS_NOT_ALLOWED', field: 'contractor_tax_code' };
    if (!awarded && price !== '') return { code: 'AWARD_FIELDS_NOT_ALLOWED', field: 'award_price' };
    const approved = get(v, 'approved_on');
    if (approved !== '' && approved > vietnamDayOf(get(v, 'published_at'))) return { code: 'RESULT_DATES_ORDER_INVALID', field: 'approved_on' };
    return undefined;
  },
  build: (v) => ({
    resultCode: get(v, 'result_code'),
    noticeCode: get(v, 'notice_code'),
    packageExternalCode: get(v, 'package_external_code'),
    resultKind: get(v, 'result_kind'),
    publishedAt: get(v, 'published_at'),
    approvedOn: opt(v['approved_on']),
    contractorTaxCode: opt(v['contractor_tax_code']),
    contractorName: opt(v['contractor_name']),
    awardPrice: opt(v['award_price']),
    projectCode: opt(v['project_code']),
    packageCode: opt(v['package_code']),
  }),
};

const CONTRACTOR: Layout<'CONTRACTOR'> = {
  kind: 'CONTRACTOR',
  connectorCode: 'EGP_CONTRACTOR_FILE',
  columns: [
    col('contractor_tax_code', 'taxCode', true),
    col('contractor_name', 'text', true, { max: 300 }),
    col('external_contractor_code', 'code', false),
    choice('legal_status', EGP_LEGAL_STATUSES, false),
    col('registered_address', 'text', false, { max: 500 }),
    col('violation_count', 'int', false, { max: 9999 }),
    col('as_of', 'day', true),
  ],
  keyOf: (cells) => taxOf(cells),
  cross: () => undefined,
  build: (v) => ({
    contractorTaxCode: get(v, 'contractor_tax_code'),
    contractorName: get(v, 'contractor_name'),
    externalContractorCode: opt(v['external_contractor_code']),
    legalStatus: opt(v['legal_status']),
    registeredAddress: opt(v['registered_address']),
    violationCount: opt(v['violation_count']) === null ? null : Number(get(v, 'violation_count')),
    asOf: get(v, 'as_of'),
  }),
};

const RESTRICTION: Layout<'RESTRICTION'> = {
  kind: 'RESTRICTION',
  connectorCode: 'EGP_RESTRICTION_FILE',
  columns: [
    col('restriction_code', 'code', true),
    col('contractor_tax_code', 'taxCode', true),
    col('contractor_name', 'text', false, { max: 300 }),
    choice('restriction_kind', EGP_RESTRICTION_KINDS, true),
    choice('scope', EGP_RESTRICTION_SCOPES, false),
    col('valid_from', 'day', true),
    col('valid_until', 'day', true),
    col('decision_no', 'text', true, { max: 100 }),
    col('decision_date', 'day', false),
    col('legal_basis', 'text', false, { max: 300 }),
  ],
  // A decision may name every member of a joint venture: the key is the decision and the contractor.
  keyOf: (cells) => {
    const code = get(cells, 'restriction_code').trim();
    const tax = taxOf(cells);
    return code === '' || tax === '' ? '' : `${code}|${tax}`;
  },
  cross: (v) => {
    if (get(v, 'valid_until') < get(v, 'valid_from')) return { code: 'VALID_RANGE_INVALID', field: 'valid_until' };
    // A ban read as nationwide when it is the ban of a province would block the contractor everywhere: the scope is never guessed.
    if (get(v, 'restriction_kind') === 'DEBARMENT' && get(v, 'scope') === '') return { code: 'SCOPE_REQUIRED', field: 'scope' };
    return undefined;
  },
  build: (v) => ({
    restrictionCode: get(v, 'restriction_code'),
    contractorTaxCode: get(v, 'contractor_tax_code'),
    contractorName: opt(v['contractor_name']),
    restrictionKind: get(v, 'restriction_kind'),
    scope: opt(v['scope']),
    validFrom: get(v, 'valid_from'),
    validUntil: get(v, 'valid_until'),
    decisionNo: get(v, 'decision_no'),
    decisionDate: opt(v['decision_date']),
    legalBasis: opt(v['legal_basis']),
  }),
};

export const EGP_LAYOUTS: { readonly [K in EgpLayoutKind]: Layout<K> } = { KHLCNT, TBMT, RESULT, CONTRACTOR, RESTRICTION };

/** The columns of a layout as the screen and the documentation list them: name, kind, whether a row must fill it, the allowed words. */
export function egpLayoutColumns(kind: EgpLayoutKind): Array<{ name: string; kind: string; required: boolean; headerRequired: boolean; values?: readonly string[] }> {
  return EGP_LAYOUTS[kind].columns.map((column) => ({
    name: column.name,
    kind: column.kind,
    required: column.required,
    headerRequired: column.headerRequired ?? column.required,
    ...(column.values === undefined ? {} : { values: column.values }),
  }));
}

type CellReading = { ok: true; value: string } | { ok: false; code: string };

function readCell(spec: ColumnSpec, raw: string): CellReading {
  const text = raw.trim();
  if (text === '') return spec.required ? { ok: false, code: 'FIELD_REQUIRED' } : { ok: true, value: spec.fallback ?? '' };
  // A name or an address may run over lines (a quoted cell); a code, a number or a date may not hold any control character.
  if (spec.kind === 'text' ? hasControlCharExceptWhitespace(text) : hasControlChar(text)) return { ok: false, code: 'CHARACTER_INVALID' };
  switch (spec.kind) {
    case 'code':
    case 'text': {
      const max = spec.max ?? (spec.kind === 'code' ? CODE_MAX : 500);
      return text.length > max ? { ok: false, code: 'FIELD_TOO_LONG' } : { ok: true, value: text.replace(/\s+/g, ' ') };
    }
    case 'taxCode': {
      const tax = normaliseTaxCode(text);
      return tax === undefined ? { ok: false, code: 'TAX_CODE_INVALID' } : { ok: true, value: tax };
    }
    case 'day': {
      const day = egpDayOf(text);
      return day === undefined ? { ok: false, code: 'DAY_INVALID' } : { ok: true, value: day };
    }
    case 'moment': {
      const moment = momentOf(text);
      return moment === undefined ? { ok: false, code: 'MOMENT_INVALID' } : { ok: true, value: moment };
    }
    case 'money': {
      const money = egpMoneyOf(text);
      return money === undefined ? { ok: false, code: 'MONEY_INVALID' } : { ok: true, value: money };
    }
    case 'int': {
      if (!/^\d{1,4}$/.test(text) || Number(text) > (spec.max ?? 9999)) return { ok: false, code: 'INTEGER_INVALID' };
      return { ok: true, value: String(Number(text)) };
    }
    case 'enum': {
      const word = text.toUpperCase().replace(/[\s-]+/g, '_');
      return (spec.values ?? []).includes(word) ? { ok: true, value: word } : { ok: false, code: 'ENUM_INVALID' };
    }
  }
}

type RowReading = { ok: true; values: Record<string, string> } | { ok: false; code: string; field: string };

/** Reads every cell of a row, in the order of the layout, then the rules across cells. The first fault is the answer. */
function readRow(layout: Layout<EgpLayoutKind>, cells: Cells): RowReading {
  const values: Record<string, string> = {};
  for (const spec of layout.columns) {
    const reading = readCell(spec, get(cells, spec.name));
    if (!reading.ok) return { ok: false, code: reading.code, field: spec.name };
    values[spec.name] = reading.value;
  }
  const crossed = layout.cross(values);
  return crossed === undefined ? { ok: true, values } : { ok: false, code: crossed.code, field: crossed.field };
}

/** A header as it is compared: trimmed, lower case, spaces and hyphens as underscores ("Plan Code" is `plan_code`). */
export const egpHeaderOf = (header: string): string => header.trim().toLowerCase().replace(/[\s-]+/g, '_');

const DUPLICATE_MARK = '__duplicate';
const CONFLICT_MARK = '__conflict';

function formatOf<K extends EgpLayoutKind>(layout: Layout<K>): FileImportFormat<EgpRecordByKind[K]> {
  const keyField = layout.columns[0]?.name ?? 'file';
  const textual = new Set(layout.columns.filter((column) => column.kind === 'text').map((column) => column.name));
  return {
    connectorCode: layout.connectorCode,
    formatVersion: EGP_LAYOUT_VERSION,

    parse(bytes: Uint8Array): SourceRow[] {
      const table = readTabularFile(bytes);
      const headers = table.headers.map(egpHeaderOf);
      if (new Set(headers.filter((header) => header !== '')).size !== headers.filter((header) => header !== '').length) {
        throw new DomainError('IMPORT_SCHEMA_INVALID', 422, 'file', { extensions: { duplicate_columns: true } });
      }
      const missing = layout.columns.filter((column) => (column.headerRequired ?? column.required) && !headers.includes(column.name)).map((column) => column.name);
      if (missing.length > 0) throw new DomainError('IMPORT_SCHEMA_INVALID', 422, 'file', { extensions: { missing_columns: missing } });
      const first = new Map<string, { line: number; signature: string }>();
      return sourceRowsOfTable({ ...table, headers }).map((row) => {
        const key = layout.keyOf(row.values);
        if (key === '') return row;
        const reading = readRow(layout, row.values);
        // What counts as the same content is what the row says once normalised (2026-01-05 and 05/01/2026 are one day); a row that cannot be read is told apart by its raw cells.
        const signature = reading.ok ? JSON.stringify(reading.values) : `?${layout.columns.map((column) => get(row.values, column.name).trim()).join('␟')}`;
        const earlier = first.get(key);
        if (earlier === undefined) {
          first.set(key, { line: row.line, signature });
          return row;
        }
        return { line: row.line, values: { ...row.values, [earlier.signature === signature ? DUPLICATE_MARK : CONFLICT_MARK]: String(earlier.line) } };
      });
    },

    judge(row: SourceRow) {
      const reading = readRow(layout, row.values);
      const key = layout.keyOf(row.values);
      if (!reading.ok) return reject<EgpRecordByKind[K]>(reading.code, reading.field, key === '' ? undefined : key);
      if (row.values[DUPLICATE_MARK] !== undefined) return reject<EgpRecordByKind[K]>('ROW_DUPLICATE', keyField, key);
      if (row.values[CONFLICT_MARK] !== undefined) return reject<EgpRecordByKind[K]>('ROW_CONFLICT', keyField, key);
      return accept<EgpRecordByKind[K]>({ businessKey: layout.keyOf(reading.values), fields: reading.values, record: layout.build(reading.values) });
    },

    /** Codes, dates, amounts and words may be shown beside an error; free text (names, addresses, decisions) is left out: a sole trader's address is personal. */
    mask(values: Readonly<Record<string, string>>): Record<string, string> {
      const shown: Record<string, string> = {};
      for (const column of layout.columns) if (!textual.has(column.name)) shown[column.name] = get(values, column.name).trim();
      return shown;
    },
  };
}

/** The file formats as the file import framework takes them (`planFileImport`, `previewFileImport`): the same pure layouts the dry run reads. */
export const EGP_FORMATS: { readonly [K in EgpLayoutKind]: FileImportFormat<EgpRecordByKind[K]> } = {
  KHLCNT: formatOf(KHLCNT),
  TBMT: formatOf(TBMT),
  RESULT: formatOf(RESULT),
  CONTRACTOR: formatOf(CONTRACTOR),
  RESTRICTION: formatOf(RESTRICTION),
};

/** A request that names another `mapping_version` is refused before the file is opened (422 `VALIDATION_FAILED`, `mapping_version`), as the file of BID-19 does. */
export function assertEgpLayoutVersion(version: string): void {
  if (!EGP_LAYOUT_VERSIONS.includes(version)) throw new DomainError('VALIDATION_FAILED', 422, 'mapping_version');
}

export type EgpRowStatus = 'VALID' | 'ERROR' | 'DUPLICATE' | 'CONFLICT';

/** The verdict on one row of a dry run. `record` is set for a valid row only. */
export interface EgpDryRunRow<R> {
  line: number;
  status: EgpRowStatus;
  businessKey: string | null;
  rowHash: string;
  code?: string;
  field?: string;
  record?: R;
}

export interface EgpDryRun<R> {
  kind: EgpLayoutKind;
  layoutVersion: string;
  fileSha256: string;
  rows: Array<EgpDryRunRow<R>>;
  counts: { total: number; valid: number; errors: number; duplicates: number; conflicts: number };
  /** The layout is a working assumption: what was read stays PENDING-EXTERNAL (R18). */
  acceptance: EgpAcceptance;
}

/**
 * Reads a file as it would be applied and writes nothing (a dry run, BR-BID-13): row by row VALID, ERROR (with the field and a code the screen translates), DUPLICATE (a later row with the
 * same key and the same content as an earlier one: harmless, ignored) or CONFLICT (a later row with the same key and other content: refused, the first row stands). A file that cannot be read, or
 * that lacks a required column, is 422 `IMPORT_SCHEMA_INVALID`; one with no row is 422 `IMPORT_EMPTY`.
 */
export function dryRunEgpFile<K extends EgpLayoutKind>(kind: K, bytes: Uint8Array, layoutVersion: string = EGP_LAYOUT_VERSION): EgpDryRun<EgpRecordByKind[K]> {
  assertEgpLayoutVersion(layoutVersion);
  const plan = planFileImport(EGP_FORMATS[kind] as FileImportFormat<EgpRecordByKind[K]>, bytes, EGP_MAX_ROWS);
  const rows = plan.rows.map((row): EgpDryRunRow<EgpRecordByKind[K]> => {
    if (row.accepted) return { line: row.line, status: 'VALID', businessKey: row.row.businessKey, rowHash: row.rowHash, record: row.row.record };
    const { code, field } = row.rejection;
    const status: EgpRowStatus = code === 'ROW_DUPLICATE' ? 'DUPLICATE' : code === 'ROW_CONFLICT' ? 'CONFLICT' : 'ERROR';
    return { line: row.line, status, businessKey: row.businessKey, rowHash: row.rowHash, code, field };
  });
  const count = (status: EgpRowStatus): number => rows.filter((row) => row.status === status).length;
  return {
    kind,
    layoutVersion,
    fileSha256: plan.fileSha256,
    rows,
    counts: { total: rows.length, valid: count('VALID'), errors: count('ERROR'), duplicates: count('DUPLICATE'), conflicts: count('CONFLICT') },
    acceptance: egpAcceptance(layoutVersion),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The id mapping on top of `master_crosswalk` (structure answer B: no new table).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * What an external code can stand for. `master_crosswalk` keeps `(source_system, external_type, external_code)` with a validity range, a match method, a confidence and ACTIVE/RETIRED (V002, unique
 * ACTIVE). Its subject is today a `master_record`; EGP-1 part 2 adds `subject_type` and `subject_id` for the entities that are not master records (a package, a notice, a contract) and lets
 * `master_record_id` be empty when they are set. This module is the model of that extension; the migration is not part of this round.
 */
export const EGP_SUBJECT_TYPES = ['PROJECT', 'PLAN', 'PACKAGE', 'NOTICE', 'RESULT', 'CONTRACT', 'CONTRACTOR'] as const;
export type EgpSubjectType = (typeof EGP_SUBJECT_TYPES)[number];

/** The `external_type` written on the crosswalk for each subject. */
export const EGP_EXTERNAL_TYPES: Readonly<Record<EgpSubjectType, string>> = {
  PROJECT: 'EGP_PROJECT',
  PLAN: 'EGP_PLAN',
  PACKAGE: 'EGP_PACKAGE',
  NOTICE: 'EGP_NOTICE',
  RESULT: 'EGP_RESULT',
  CONTRACT: 'EGP_CONTRACT',
  CONTRACTOR: 'EGP_CONTRACTOR',
};
export const egpExternalTypeOf = (subject: EgpSubjectType): string => EGP_EXTERNAL_TYPES[subject];

/**
 * How a mapping was made. EXACT_CODE: the file names both our code and theirs. TAX_CODE: a contractor matched by its tax code (deterministic, never by name). NAME_SUGGESTION: a person confirmed
 * a suggestion the system made from the name and the price (the system never links on its own). MANUAL: a person typed it.
 */
export const EGP_MATCH_METHODS = ['EXACT_CODE', 'TAX_CODE', 'NAME_SUGGESTION', 'MANUAL'] as const;
export type EgpMatchMethod = (typeof EGP_MATCH_METHODS)[number];

/** The `match_method` the crosswalk can hold today (`MANUAL`, `IMPORT`, `RULE`). */
export function crosswalkMethodOf(method: EgpMatchMethod): 'MANUAL' | 'IMPORT' | 'RULE' {
  switch (method) {
    case 'EXACT_CODE':
      return 'IMPORT';
    case 'TAX_CODE':
      return 'RULE';
    default:
      return 'MANUAL';
  }
}

export interface EgpIdMapping {
  subjectType: EgpSubjectType;
  /** The id of our row (a uuid) or its business key (a package code): whatever the store resolves the subject by. */
  subjectId: string;
  sourceSystem: string;
  externalType: string;
  externalCode: string;
  /** The first day the mapping holds (`YYYY-MM-DD`) and the day it no longer does; null while it has no end. */
  validFrom: string;
  validUntil: string | null;
  matchMethod: EgpMatchMethod;
  /** Set only for NAME_SUGGESTION, above 0 and at most 1. */
  confidence: number | null;
  status: 'ACTIVE' | 'RETIRED';
}

const mappingFinding = (field: string, code: string): RuleFinding => findingOf('egp.mapping.error', field, code);

/** Every rule of a mapping that the database CHECKs cannot state; an empty list means the mapping may be written. */
export function validateEgpMapping(mapping: EgpIdMapping): RuleFinding[] {
  const found: RuleFinding[] = [];
  if (!(EGP_SUBJECT_TYPES as readonly string[]).includes(mapping.subjectType)) found.push(mappingFinding('subject_type', 'SUBJECT_TYPE_INVALID'));
  else if (mapping.externalType !== egpExternalTypeOf(mapping.subjectType)) found.push(mappingFinding('external_type', 'EXTERNAL_TYPE_MISMATCH'));
  if (mapping.sourceSystem !== EGP_SOURCE_SYSTEM) found.push(mappingFinding('source_system', 'SOURCE_SYSTEM_INVALID'));
  if (mapping.subjectId.trim() === '' || mapping.subjectId.length > 100 || hasControlChar(mapping.subjectId)) found.push(mappingFinding('subject_id', 'SUBJECT_ID_INVALID'));
  const code = mapping.externalCode;
  if (code.trim() === '' || code !== code.trim() || code.length > CODE_MAX || hasControlChar(code)) found.push(mappingFinding('external_code', 'EXTERNAL_CODE_INVALID'));
  if (egpDayOf(mapping.validFrom) !== mapping.validFrom) found.push(mappingFinding('valid_from', 'DAY_INVALID'));
  else if (mapping.validUntil !== null && (egpDayOf(mapping.validUntil) !== mapping.validUntil || mapping.validUntil <= mapping.validFrom)) found.push(mappingFinding('valid_until', 'VALID_RANGE_INVALID'));
  if (!(EGP_MATCH_METHODS as readonly string[]).includes(mapping.matchMethod)) found.push(mappingFinding('match_method', 'MATCH_METHOD_INVALID'));
  else if (mapping.matchMethod === 'NAME_SUGGESTION') {
    if (mapping.confidence === null || !(mapping.confidence > 0 && mapping.confidence <= 1)) found.push(mappingFinding('confidence', 'CONFIDENCE_INVALID'));
  } else if (mapping.confidence !== null) found.push(mappingFinding('confidence', 'CONFIDENCE_NOT_ALLOWED'));
  if (mapping.subjectType === 'CONTRACTOR' && mapping.matchMethod === 'NAME_SUGGESTION') found.push(mappingFinding('match_method', 'CONTRACTOR_BY_TAX_CODE_ONLY'));
  return found;
}

const overlaps = (a: Pick<EgpIdMapping, 'validFrom' | 'validUntil'>, b: Pick<EgpIdMapping, 'validFrom' | 'validUntil'>): boolean =>
  (b.validUntil === null || a.validFrom < b.validUntil) && (a.validUntil === null || b.validFrom < a.validUntil);

export type EgpMappingOutcome = 'CREATE' | 'UNCHANGED' | 'EXTERNAL_CODE_TAKEN' | 'SUBJECT_HAS_OTHER_CODE';

/**
 * What writing `proposed` would do against the ACTIVE mappings that exist. UNCHANGED: the same subject already holds the same code (a second import is a no-op). EXTERNAL_CODE_TAKEN: another subject
 * holds the code (409 `CROSSWALK_DUPLICATE`). SUBJECT_HAS_OTHER_CODE: the subject is mapped to another code in an overlapping period; it is never relinked silently, the disagreement goes to
 * reconciliation (as `EXTERNAL_CODE_MISMATCH` does for the packages of BID-19).
 */
export function egpMappingOutcome(existing: readonly EgpIdMapping[], proposed: EgpIdMapping): EgpMappingOutcome {
  const active = existing.filter((mapping) => mapping.status === 'ACTIVE' && mapping.sourceSystem === proposed.sourceSystem);
  const sameCode = active.find((mapping) => mapping.externalType === proposed.externalType && mapping.externalCode === proposed.externalCode);
  if (sameCode !== undefined) return sameCode.subjectType === proposed.subjectType && sameCode.subjectId === proposed.subjectId ? 'UNCHANGED' : 'EXTERNAL_CODE_TAKEN';
  const other = active.find((mapping) => mapping.externalType === proposed.externalType && mapping.subjectType === proposed.subjectType && mapping.subjectId === proposed.subjectId && overlaps(mapping, proposed));
  return other === undefined ? 'CREATE' : 'SUBJECT_HAS_OTHER_CODE';
}

/** The ACTIVE mapping of an external code on a day, or undefined. */
export function resolveEgpMapping(mappings: readonly EgpIdMapping[], query: { subjectType: EgpSubjectType; externalCode: string; onDay: string }): EgpIdMapping | undefined {
  return mappings.find(
    (mapping) =>
      mapping.status === 'ACTIVE' &&
      mapping.subjectType === query.subjectType &&
      mapping.externalCode === query.externalCode &&
      mapping.validFrom <= query.onDay &&
      (mapping.validUntil === null || query.onDay < mapping.validUntil),
  );
}

/** Our row's code on the network on a day, or undefined. */
export function externalCodeOf(mappings: readonly EgpIdMapping[], query: { subjectType: EgpSubjectType; subjectId: string; onDay: string }): string | undefined {
  return mappings.find(
    (mapping) =>
      mapping.status === 'ACTIVE' &&
      mapping.subjectType === query.subjectType &&
      mapping.subjectId === query.subjectId &&
      mapping.validFrom <= query.onDay &&
      (mapping.validUntil === null || query.onDay < mapping.validUntil),
  )?.externalCode;
}

/** A mapping that a valid row of a file asks for, before it is resolved against our register: `ourCode` is the business key of our row (a package code, a project code, a tax code). */
export interface EgpMappingProposal {
  subjectType: EgpSubjectType;
  ourCode: string | null;
  ourProjectCode: string | null;
  externalType: string;
  externalCode: string;
  method: EgpMatchMethod;
}

const proposal = (subjectType: EgpSubjectType, ourCode: string | null, ourProjectCode: string | null, externalCode: string, method: EgpMatchMethod): EgpMappingProposal => ({
  subjectType,
  ourCode,
  ourProjectCode,
  externalType: egpExternalTypeOf(subjectType),
  externalCode,
  method,
});

/**
 * The mappings a valid row asks for. A row that names our code gives an EXACT_CODE proposal; a row that does not gives one with `ourCode` null, which the screen (BID-23) answers with suggestions
 * for a person to confirm. A contractor is mapped by its tax code only (TAX_CODE). Nothing here links anything: the store decides, and writes through `egpMappingOutcome`.
 */
export function egpMappingProposals<K extends EgpLayoutKind>(kind: K, record: EgpRecordByKind[K]): EgpMappingProposal[] {
  switch (kind) {
    case 'KHLCNT': {
      const r = record as EgpPlanRecord;
      return [proposal('PACKAGE', r.packageCode, r.projectCode, r.packageExternalCode, 'EXACT_CODE'), proposal('PLAN', r.projectCode, r.projectCode, r.planCode, 'EXACT_CODE')];
    }
    case 'TBMT': {
      const r = record as EgpNoticeRecord;
      return [proposal('PACKAGE', r.packageCode, r.projectCode, r.packageExternalCode, 'EXACT_CODE'), proposal('NOTICE', r.packageCode, r.projectCode, r.noticeCode, 'EXACT_CODE')];
    }
    case 'RESULT': {
      const r = record as EgpResultRecord;
      return [proposal('PACKAGE', r.packageCode, r.projectCode, r.packageExternalCode, 'EXACT_CODE'), proposal('RESULT', r.packageCode, r.projectCode, r.resultCode, 'EXACT_CODE')];
    }
    case 'CONTRACTOR': {
      const r = record as EgpContractorRecord;
      return [proposal('CONTRACTOR', r.contractorTaxCode, null, r.externalContractorCode ?? r.contractorTaxCode, 'TAX_CODE')];
    }
    case 'RESTRICTION':
      return [];
    default:
      return [];
  }
}

/** The default line a suggestion must reach: a hint to a person, never a link (the number is ours, unverified, and the person confirms). */
export const EGP_SUGGESTION_THRESHOLD = 0.8;

const wordsOf = (name: string): Set<string> =>
  new Set(
    name
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(/\u0111/gi, 'd')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word !== ''),
  );

/** The share of words two names have in common (Jaccard, diacritics and case ignored), 0 to 1, at three decimals. */
export function egpNameSimilarity(a: string, b: string): number {
  const left = wordsOf(a);
  const right = wordsOf(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return Math.round((shared / (left.size + right.size - shared)) * 1000) / 1000;
}

export interface EgpPackageCandidate {
  id: string;
  code: string;
  name: string;
  budget: string | null;
}

/**
 * Packages of ours that an imported package may be: the price must be the same to the unit and the names must be alike (never the name alone: a name is not an identity, MDM F5). Sorted by
 * likeness then code. A package with no price on either side is never suggested.
 */
export function suggestPackageMatches(imported: { name: string | null; estimatedPrice: string | null }, ours: readonly EgpPackageCandidate[], threshold: number = EGP_SUGGESTION_THRESHOLD): Array<{ id: string; code: string; confidence: number }> {
  if (imported.name === null || imported.estimatedPrice === null) return [];
  const price = imported.estimatedPrice;
  return ours
    .filter((candidate) => candidate.budget !== null && compareDecimal(candidate.budget, price) === 0)
    .map((candidate) => ({ id: candidate.id, code: candidate.code, confidence: egpNameSimilarity(imported.name as string, candidate.name) }))
    .filter((candidate) => candidate.confidence >= threshold)
    .sort((a, b) => b.confidence - a.confidence || a.code.localeCompare(b.code));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Reconciliation: our record against the imported one, field by field.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

type CompareKind = 'TEXT' | 'MONEY' | 'DAY' | 'ENUM' | 'CODE';
export interface EgpCompareField {
  field: string;
  kind: CompareKind;
}

/** The fields compared for each subject: a field outside this list is never a difference. DAY compares the Vietnam day, as the milestones of BID-19 do. */
export const EGP_COMPARE_FIELDS: Readonly<Record<EgpSubjectType, readonly EgpCompareField[]>> = {
  PROJECT: [
    { field: 'project_name', kind: 'TEXT' },
    { field: 'total_investment', kind: 'MONEY' },
  ],
  PLAN: [
    { field: 'decision_no', kind: 'CODE' },
    { field: 'approved_on', kind: 'DAY' },
  ],
  PACKAGE: [
    { field: 'package_name', kind: 'TEXT' },
    { field: 'estimated_price', kind: 'MONEY' },
    { field: 'selection_method', kind: 'ENUM' },
  ],
  NOTICE: [
    { field: 'published_at', kind: 'DAY' },
    { field: 'bid_closing_at', kind: 'DAY' },
    { field: 'bid_opening_at', kind: 'DAY' },
  ],
  RESULT: [
    { field: 'result_kind', kind: 'ENUM' },
    { field: 'contractor_tax_code', kind: 'CODE' },
    { field: 'award_price', kind: 'MONEY' },
    { field: 'published_at', kind: 'DAY' },
  ],
  CONTRACT: [
    { field: 'contract_price', kind: 'MONEY' },
    { field: 'contractor_tax_code', kind: 'CODE' },
    { field: 'signed_on', kind: 'DAY' },
  ],
  CONTRACTOR: [
    { field: 'contractor_name', kind: 'TEXT' },
    { field: 'legal_status', kind: 'ENUM' },
    { field: 'registered_address', kind: 'TEXT' },
  ],
};

export type EgpDifferenceKind = 'VALUE_MISMATCH' | 'MISSING_OURS' | 'MISSING_THEIRS';

export interface EgpFieldDifference {
  field: string;
  kind: EgpDifferenceKind;
  ours: string | null;
  theirs: string | null;
  /** For an amount: theirs minus ours, signed, exact. */
  delta: string | null;
}

const present = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim());
const dayKey = (value: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? value : Number.isNaN(Date.parse(value)) ? value : vietnamDayOf(value));
const textKey = (value: string): string => value.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
const isDecimal = (value: string): boolean => /^-?(0|[1-9]\d*)(\.\d+)?$/.test(value);

function sameValue(kind: CompareKind, ours: string, theirs: string): boolean {
  switch (kind) {
    case 'TEXT':
      return textKey(ours) === textKey(theirs);
    case 'MONEY':
      return isDecimal(ours) && isDecimal(theirs) ? compareDecimal(ours, theirs) === 0 : ours === theirs;
    case 'DAY':
      return dayKey(ours) === dayKey(theirs);
    case 'ENUM':
      return ours.toUpperCase() === theirs.toUpperCase();
    case 'CODE':
      return (normaliseTaxCode(ours) ?? ours) === (normaliseTaxCode(theirs) ?? theirs);
  }
}

/**
 * The differences between our record and the imported one, in the order of `EGP_COMPARE_FIELDS`. Two empty values are no difference; a value on one side only is MISSING_OURS or MISSING_THEIRS;
 * text ignores case and spacing, an amount is compared as an exact decimal, a day by its Vietnam calendar day.
 */
export function diffEgpRecords(subject: EgpSubjectType, ours: Readonly<Record<string, string | null | undefined>>, theirs: Readonly<Record<string, string | null | undefined>>): EgpFieldDifference[] {
  const found: EgpFieldDifference[] = [];
  for (const { field, kind } of EGP_COMPARE_FIELDS[subject]) {
    const mine = present(ours[field]);
    const other = present(theirs[field]);
    if (mine === null && other === null) continue;
    if (mine === null) found.push({ field, kind: 'MISSING_OURS', ours: null, theirs: other, delta: null });
    else if (other === null) found.push({ field, kind: 'MISSING_THEIRS', ours: mine, theirs: null, delta: null });
    else if (!sameValue(kind, mine, other)) found.push({ field, kind: 'VALUE_MISMATCH', ours: mine, theirs: other, delta: kind === 'MONEY' && isDecimal(mine) && isDecimal(other) ? subtractDecimal(other, mine) : null });
  }
  return found;
}

/** How a person settles a difference (EGP-2): take the value of the network, keep ours and correct the network, contest it with the operator, or leave it with a reason and a review day. */
export const EGP_RESOLUTION_KINDS = ['ACCEPT_EXTERNAL', 'CORRECT_OURS', 'DISPUTE', 'WAIVE'] as const;
export type EgpResolutionKind = (typeof EGP_RESOLUTION_KINDS)[number];

/** What each resolution makes the next step, so a screen can say it and a store can do it. The resolution itself never edits the other module's record: the owner's own command does. */
export const EGP_RESOLUTION_FOLLOW_UP: Readonly<Record<EgpResolutionKind, 'CHANGE_OURS_BY_OWNER_COMMAND' | 'CHECK_POSTING_CORRECTION_DUE' | 'ESCALATE_TO_OPERATOR' | 'REVIEW_ON_DAY'>> = {
  ACCEPT_EXTERNAL: 'CHANGE_OURS_BY_OWNER_COMMAND',
  CORRECT_OURS: 'CHECK_POSTING_CORRECTION_DUE',
  DISPUTE: 'ESCALATE_TO_OPERATOR',
  WAIVE: 'REVIEW_ON_DAY',
};

/** The shortest reason of a resolution: leaving a difference or contesting it must be explained in a sentence (20 characters), the other two in a few words (10). */
export const EGP_RESOLUTION_MIN_REASON: Readonly<Record<EgpResolutionKind, number>> = { ACCEPT_EXTERNAL: 10, CORRECT_OURS: 10, DISPUTE: 20, WAIVE: 20 };
/** A waiver is looked at again within a year at most. */
export const EGP_WAIVER_MAX_DAYS = 365;

export interface EgpResolution {
  kind: EgpResolutionKind;
  resolvedById: string;
  resolvedAt: string;
  reason: string;
  /** A document or a reference that backs the decision (the letter to the operator for a DISPUTE). */
  evidenceRef: string | null;
  /** Required for WAIVE: the day the waiver is looked at again. */
  reviewOn: string | null;
}

export interface EgpReconciliationItem {
  subjectType: EgpSubjectType;
  subjectKey: string;
  field: string;
  differenceKind: EgpDifferenceKind;
  ours: string | null;
  theirs: string | null;
  delta: string | null;
  state: 'OPEN' | 'RESOLVED';
  /** The person accountable for settling it. Never one of the people who made the record or loaded the file. */
  ownerId: string;
  /** The people who made our record and who loaded the file: none of them may settle the item (maker is not checker). */
  makerIds: readonly string[];
  openedAt: string;
  dueAt: string;
  resolution: EgpResolution | null;
}

/** The first of the candidates (in the order of preference) who is not a maker; undefined when every candidate is, and the caller escalates to a data steward group. */
export function pickReconciliationOwner(candidates: readonly string[], makerIds: readonly string[]): string | undefined {
  return candidates.find((candidate) => !makerIds.includes(candidate));
}

/** One OPEN item for each difference, every one with an owner. The owner is never a maker (422 `VALIDATION_FAILED`, `owner_id`) and the due time is after the opening (`due_at`). */
export function openReconciliationItems(input: { subjectType: EgpSubjectType; subjectKey: string; differences: readonly EgpFieldDifference[]; ownerId: string; makerIds: readonly string[]; openedAt: Date; dueAt: Date }): EgpReconciliationItem[] {
  if (input.ownerId.trim() === '' || input.makerIds.includes(input.ownerId)) throw new DomainError('VALIDATION_FAILED', 422, 'owner_id');
  if (!(input.dueAt.getTime() > input.openedAt.getTime())) throw new DomainError('VALIDATION_FAILED', 422, 'due_at');
  return input.differences.map((difference) => ({
    subjectType: input.subjectType,
    subjectKey: input.subjectKey,
    field: difference.field,
    differenceKind: difference.kind,
    ours: difference.ours,
    theirs: difference.theirs,
    delta: difference.delta,
    state: 'OPEN',
    ownerId: input.ownerId,
    makerIds: [...input.makerIds],
    openedAt: input.openedAt.toISOString(),
    dueAt: input.dueAt.toISOString(),
    resolution: null,
  }));
}

/**
 * Settles an item. Refusals, in order: already settled (409 `EGP_RECONCILIATION_STATE_INVALID`); the person made the record or loaded the file (403 `SELF_APPROVAL_DENIED`); a reason shorter than the
 * kind needs, a WAIVE without a review day inside a year, a DISPUTE without a reference (422 `VALIDATION_FAILED` naming `reason`, `review_on` or `evidence_ref`). The audit event (ADM-11) is written
 * by the store from the returned item.
 */
export function resolveReconciliationItem(item: EgpReconciliationItem, resolution: { kind: EgpResolutionKind; resolvedById: string; at: Date; reason: string; evidenceRef?: string | null; reviewOn?: string | null }): EgpReconciliationItem {
  if (item.state !== 'OPEN') throw new DomainError('EGP_RECONCILIATION_STATE_INVALID', 409, 'state', { extensions: { state: item.state } });
  if (!(EGP_RESOLUTION_KINDS as readonly string[]).includes(resolution.kind)) throw new DomainError('VALIDATION_FAILED', 422, 'kind');
  if (item.makerIds.includes(resolution.resolvedById)) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'resolved_by');
  const reason = resolution.reason.trim();
  if (reason.length < EGP_RESOLUTION_MIN_REASON[resolution.kind] || reason.length > 1000 || hasControlCharExceptWhitespace(reason)) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
  const evidence = present(resolution.evidenceRef ?? null);
  if (resolution.kind === 'DISPUTE' && evidence === null) throw new DomainError('VALIDATION_FAILED', 422, 'evidence_ref');
  if (evidence !== null && (evidence.length > 200 || hasControlChar(evidence))) throw new DomainError('VALIDATION_FAILED', 422, 'evidence_ref');
  let reviewOn: string | null = null;
  if (resolution.kind === 'WAIVE') {
    const day = resolution.reviewOn === undefined || resolution.reviewOn === null ? undefined : egpDayOf(resolution.reviewOn);
    const today = vietnamDayOf(resolution.at.toISOString());
    if (day === undefined || day <= today || dayOf(day) - dayOf(today) > EGP_WAIVER_MAX_DAYS) throw new DomainError('VALIDATION_FAILED', 422, 'review_on');
    reviewOn = day;
  }
  return { ...item, state: 'RESOLVED', resolution: { kind: resolution.kind, resolvedById: resolution.resolvedById, resolvedAt: resolution.at.toISOString(), reason, evidenceRef: evidence, reviewOn } };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The obligations to post (Article 19-20 of Decree 214/2025): kinds, deadlines read from the rule EGP_POSTING_DEADLINES, states, the clock.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const EGP_POSTING_KINDS = ['PLAN', 'NOTICE', 'RESULT', 'CONTRACT_INFO', 'CONTRACTOR_PERFORMANCE', 'VIOLATION', 'REPUTATION_EVENT', 'CONTRACTOR_RESPONSE'] as const;
export type EgpPostingKind = (typeof EGP_POSTING_KINDS)[number];

/** The rule type that holds the deadlines (registered in `governance-rules.ts`, lane INT) and the code of each kind under it: the same word as the kind. */
export const EGP_POSTING_RULE_TYPE = 'EGP_POSTING_DEADLINES';
export const egpPostingRuleCode = (kind: EgpPostingKind): string => kind;
/** The rule type and the code that say how old the last import may be before the connector is stale (`CONNECTOR_FRESHNESS`, code `EGP_FILE`). */
export const EGP_FRESHNESS_RULE_TYPE = 'CONNECTOR_FRESHNESS';
export const EGP_FRESHNESS_RULE_CODE = 'EGP_FILE';

/** What each obligation is about: the subject whose posting it is. */
export const EGP_POSTING_SUBJECTS: Readonly<Record<EgpPostingKind, EgpSubjectType>> = {
  PLAN: 'PLAN',
  NOTICE: 'NOTICE',
  RESULT: 'RESULT',
  CONTRACT_INFO: 'CONTRACT',
  CONTRACTOR_PERFORMANCE: 'CONTRACT',
  VIOLATION: 'CONTRACTOR',
  REPUTATION_EVENT: 'CONTRACTOR',
  CONTRACTOR_RESPONSE: 'CONTRACTOR',
};

export const EGP_DEADLINE_UNITS = ['WORKING_DAYS', 'CALENDAR_DAYS', 'MONTHS'] as const;
export type EgpDeadlineUnit = (typeof EGP_DEADLINE_UNITS)[number];
/** The facts that start a clock, as the rule names them. */
export const EGP_POSTING_STARTS = ['DECISION_APPROVED', 'RESULT_ISSUED', 'CONTRACT_SIGNED', 'CONTRACT_COMPLETED', 'EVENT_OCCURRED', 'CONTRACTOR_NOTIFIED'] as const;
export type EgpPostingStart = (typeof EGP_POSTING_STARTS)[number];

/** The params of one code of the rule `EGP_POSTING_DEADLINES`: `due_in` of `due_unit` after the day `starts_on` happened, a reminder `remind_before_days` before. */
export interface EgpPostingRule {
  obligation: string;
  due_in: number;
  due_unit: EgpDeadlineUnit;
  starts_on: EgpPostingStart;
  remind_before_days: number;
  legal_basis: string;
}

/**
 * The rule as the module reads it. `ResolvedGovernanceRule` of `governance-rules.ts` has these members; the module does not import the registry, so it stays pure and a test hands it a rule.
 * `unverified` is true while the numbers are a default nobody confirmed against the legal text: the obligation carries it as `legalStatus: 'UNVERIFIED'`.
 */
export interface EgpResolvedRule {
  code: string;
  version: number;
  params: Readonly<Record<string, unknown>>;
  unverified: boolean;
}

const paramsInvalid = (path: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, path);

/** Narrows the params of a code of `EGP_POSTING_DEADLINES` to the shape this module uses (the registry has already checked them; this is the type, and a defence against a stale row): 422 `GOVERNANCE_RULE_PARAMS_INVALID` naming the field. */
export function egpPostingRuleOf(params: Readonly<Record<string, unknown>>): EgpPostingRule {
  const text = (key: string): string => {
    const value = params[key];
    if (typeof value !== 'string' || value === '') throw paramsInvalid(key);
    return value;
  };
  const whole = (key: string, min: number): number => {
    const value = params[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > 3650) throw paramsInvalid(key);
    return value;
  };
  const unit = text('due_unit');
  const starts = text('starts_on');
  if (!(EGP_DEADLINE_UNITS as readonly string[]).includes(unit)) throw paramsInvalid('due_unit');
  if (!(EGP_POSTING_STARTS as readonly string[]).includes(starts)) throw paramsInvalid('starts_on');
  return { obligation: text('obligation'), due_in: whole('due_in', 1), due_unit: unit as EgpDeadlineUnit, starts_on: starts as EgpPostingStart, remind_before_days: whole('remind_before_days', 0), legal_basis: text('legal_basis') };
}

/**
 * Counting rules that are policy of this module, not parameters: the day of the trigger is not counted; a deadline by CALENDAR_DAYS or MONTHS that ends on a day nobody works moves to the next working
 * day (the usual rule of counting time; unverified for this use, so it is written here and in docs/egp-connector.md rather than hidden); the person who submits a posting is not the person who prepared it.
 */
export const EGP_ROLLS_TO_WORKING_DAY: Readonly<Record<EgpDeadlineUnit, boolean>> = { WORKING_DAYS: false, CALENDAR_DAYS: true, MONTHS: true };

const MAX_SCAN_DAYS = 3 * 366;
const asSource = (calendars: WorkCalendarContent | WorkCalendarSource): WorkCalendarSource => ('forYear' in calendars ? calendars : { forYear: (year) => (year === calendars.year ? calendars : undefined) });

function workedOn(source: WorkCalendarSource, day: number): boolean {
  const calendar = source.forYear(new Date(day * DAY_MS).getUTCFullYear());
  if (calendar === undefined) throw new DomainError('CALENDAR_NOT_EFFECTIVE', 422, 'year');
  return isWorkingDay(calendar, isoOf(day));
}

const clockMinutes = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/**
 * The instant a posting falls due. The day of the trigger is not counted; the deadline is the end of the working window of the last day (17:00 in Vietnam by default: the office day ends, so the alert comes
 * before a person has left). WORKING_DAYS counts the working days of the calendar, a holiday never counts; CALENDAR_DAYS and MONTHS count every day (a month that is too short ends on its last day: 31 August
 * plus 6 months is 28 February) and then move to the next working day when the last one is not worked (`EGP_ROLLS_TO_WORKING_DAY`). A zero amount is the trigger instant itself. The calendar of each year the
 * deadline passes through must be given: a year without one fails with 422 `CALENDAR_NOT_EFFECTIVE`, a deadline is never guessed with a weekly pattern (the same rule as `addWorkingTime`).
 */
export function postingDeadline(spec: { unit: EgpDeadlineUnit; amount: number }, triggeredAt: Date, calendars: WorkCalendarContent | WorkCalendarSource, intervals: readonly WorkingInterval[] = DEFAULT_WORKING_INTERVALS): Date {
  if (Number.isNaN(triggeredAt.getTime())) throw new DomainError('VALIDATION_FAILED', 422, 'triggered_at');
  if (!Number.isInteger(spec.amount) || spec.amount < 0) throw new DomainError('VALIDATION_FAILED', 422, 'amount');
  if (spec.amount === 0) return new Date(triggeredAt.getTime());
  const source = asSource(calendars);
  const triggerDay = dayOf(vietnamDayOf(triggeredAt.toISOString()));
  let day: number;
  if (spec.unit === 'WORKING_DAYS') {
    day = triggerDay;
    for (let counted = 0, scanned = 0; counted < spec.amount; scanned += 1) {
      if (scanned > MAX_SCAN_DAYS) throw new DomainError('CALENDAR_NOT_EFFECTIVE', 422, 'duration');
      day += 1;
      if (workedOn(source, day)) counted += 1;
    }
  } else {
    if (spec.unit === 'CALENDAR_DAYS') day = triggerDay + spec.amount;
    else {
      const start = new Date(triggerDay * DAY_MS);
      const target = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + spec.amount, 1));
      const lastOfMonth = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
      day = Math.floor(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(start.getUTCDate(), lastOfMonth)) / DAY_MS);
    }
    if (EGP_ROLLS_TO_WORKING_DAY[spec.unit]) {
      for (let scanned = 0; !workedOn(source, day); scanned += 1) {
        if (scanned > MAX_SCAN_DAYS) throw new DomainError('CALENDAR_NOT_EFFECTIVE', 422, 'duration');
        day += 1;
      }
    }
  }
  const end = intervals[intervals.length - 1]?.to ?? '17:00';
  const offsetMinutes = CALENDAR_TIMEZONES[WORKING_TIME_ZONE] as number;
  return new Date(day * DAY_MS + (clockMinutes(end) - offsetMinutes) * 60_000);
}

export const EGP_OBLIGATION_STATES = ['DUE', 'PREPARED', 'SUBMITTED', 'RECEIPTED', 'REJECTED', 'CANCELLED'] as const;
export type EgpObligationState = (typeof EGP_OBLIGATION_STATES)[number];

export interface EgpObligation {
  kind: EgpPostingKind;
  subjectType: EgpSubjectType;
  subjectId: string;
  /** The fact that started the clock, as the rule names it (`starts_on`). */
  triggerEvent: EgpPostingStart;
  triggeredAt: string;
  dueAt: string;
  /** The rule that decided the deadline, kept so the figure can be explained later. */
  ruleCode: string;
  ruleVersion: number;
  /** The reminder window of the rule: the obligation is DUE_SOON this many calendar days before the deadline. */
  remindBeforeDays: number;
  /** UNVERIFIED while the deadline comes from a default nobody confirmed against the legal text. */
  legalStatus: 'UNVERIFIED' | 'VERIFIED';
  state: EgpObligationState;
  ownerId: string;
  preparedById: string | null;
  preparedAt: string | null;
  submittedById: string | null;
  submittedAt: string | null;
  receiptRef: string | null;
  receiptedAt: string | null;
  rejectionReason: string | null;
  cancelReason: string | null;
}

/**
 * Opens the obligation that a fact creates, DUE, with its deadline from the rule. The rule must be the one of the kind (code = kind) and must start its clock on the fact `triggerEvent` names; a rule that does
 * not is 422 `VALIDATION_FAILED` on `rule`.
 */
export function openObligation(input: {
  kind: EgpPostingKind;
  subjectId: string;
  triggeredAt: Date;
  ownerId: string;
  rule: EgpResolvedRule;
  calendars: WorkCalendarContent | WorkCalendarSource;
  intervals?: readonly WorkingInterval[];
}): EgpObligation {
  if (input.subjectId.trim() === '' || input.subjectId.length > 100 || hasControlChar(input.subjectId)) throw new DomainError('VALIDATION_FAILED', 422, 'subject_id');
  if (input.ownerId.trim() === '') throw new DomainError('VALIDATION_FAILED', 422, 'owner_id');
  if (input.rule.code !== egpPostingRuleCode(input.kind)) throw new DomainError('VALIDATION_FAILED', 422, 'rule');
  const rule = egpPostingRuleOf(input.rule.params);
  const due = postingDeadline({ unit: rule.due_unit, amount: rule.due_in }, input.triggeredAt, input.calendars, input.intervals);
  return {
    kind: input.kind,
    subjectType: EGP_POSTING_SUBJECTS[input.kind],
    subjectId: input.subjectId,
    triggerEvent: rule.starts_on,
    triggeredAt: input.triggeredAt.toISOString(),
    dueAt: due.toISOString(),
    ruleCode: input.rule.code,
    ruleVersion: input.rule.version,
    remindBeforeDays: rule.remind_before_days,
    legalStatus: input.rule.unverified ? 'UNVERIFIED' : 'VERIFIED',
    state: 'DUE',
    ownerId: input.ownerId,
    preparedById: null,
    preparedAt: null,
    submittedById: null,
    submittedAt: null,
    receiptRef: null,
    receiptedAt: null,
    rejectionReason: null,
    cancelReason: null,
  };
}

export type EgpObligationMove =
  | { move: 'PREPARE'; actorId: string; at: Date }
  | { move: 'SUBMIT'; actorId: string; at: Date }
  | { move: 'RECEIPT'; actorId: string; at: Date; receiptRef: string }
  | { move: 'REJECT'; actorId: string; at: Date; reason: string }
  | { move: 'CANCEL'; actorId: string; at: Date; reason: string };

/** The states each move may start from. A rejected posting is prepared again (corrected and sent again); RECEIPTED and CANCELLED are final. */
export const EGP_OBLIGATION_MOVES: Readonly<Record<EgpObligationMove['move'], { from: readonly EgpObligationState[]; to: EgpObligationState }>> = {
  PREPARE: { from: ['DUE', 'REJECTED'], to: 'PREPARED' },
  SUBMIT: { from: ['PREPARED'], to: 'SUBMITTED' },
  RECEIPT: { from: ['SUBMITTED'], to: 'RECEIPTED' },
  REJECT: { from: ['SUBMITTED'], to: 'REJECTED' },
  CANCEL: { from: ['DUE', 'PREPARED', 'REJECTED'], to: 'CANCELLED' },
};

const reasonOf = (text: string, field: string, min: number): string => {
  const reason = text.trim();
  if (reason.length < min || reason.length > 1000 || hasControlCharExceptWhitespace(reason)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return reason;
};

/**
 * Moves an obligation DUE to PREPARED to SUBMITTED to RECEIPTED or REJECTED. A move from a state it does not start from is 409 `EGP_OBLIGATION_STATE_INVALID`. Submitting needs a person other than the one who
 * prepared (403 `SELF_APPROVAL_DENIED`: what goes to the national network under the name of the agency is looked at by a second person). A receipt needs the reference the network gave (at most 100 characters)
 * and a time not before the submission; a rejection needs a reason (10 characters); a cancellation needs a reason (20). Returns a new obligation; the clock keeps running while a posting is rejected.
 */
export function moveObligation(obligation: EgpObligation, step: EgpObligationMove): EgpObligation {
  const edge = EGP_OBLIGATION_MOVES[step.move];
  if (!edge.from.includes(obligation.state)) throw new DomainError('EGP_OBLIGATION_STATE_INVALID', 409, 'state', { extensions: { state: obligation.state, move: step.move } });
  const at = step.at.toISOString();
  const base = { ...obligation, state: edge.to };
  switch (step.move) {
    case 'PREPARE':
      return { ...base, preparedById: step.actorId, preparedAt: at, rejectionReason: null };
    case 'SUBMIT':
      if (step.actorId === obligation.preparedById) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'submitted_by');
      return { ...base, submittedById: step.actorId, submittedAt: at };
    case 'RECEIPT': {
      const ref = step.receiptRef.trim();
      if (ref === '' || ref.length > 100 || hasControlChar(ref)) throw new DomainError('VALIDATION_FAILED', 422, 'receipt_ref');
      if (obligation.submittedAt !== null && at < obligation.submittedAt) throw new DomainError('VALIDATION_FAILED', 422, 'receipted_at');
      return { ...base, receiptRef: ref, receiptedAt: at };
    }
    case 'REJECT':
      return { ...base, rejectionReason: reasonOf(step.reason, 'reason', 10) };
    case 'CANCEL':
      return { ...base, cancelReason: reasonOf(step.reason, 'reason', 20) };
  }
}

export type EgpClockStatus = 'ON_TIME' | 'DUE_SOON' | 'OVERDUE' | 'MET' | 'MET_LATE' | 'CANCELLED';

export interface EgpClock {
  status: EgpClockStatus;
  dueAt: string;
  /** Milliseconds to the deadline (negative once past) while the obligation is open, null once it is met or cancelled. */
  msToDue: number | null;
}

/**
 * Where an obligation stands against its deadline at `now`. Open (DUE, PREPARED, REJECTED): OVERDUE past the deadline, DUE_SOON within `remindBeforeDays` calendar days of it, else ON_TIME. SUBMITTED and
 * RECEIPTED: MET when the submission was at or before the deadline, MET_LATE after it (the posting is made when it is submitted; the receipt only confirms it). A rejected posting is open again: its
 * submission did not count. CANCELLED: no clock.
 */
export function egpObligationClock(obligation: Pick<EgpObligation, 'state' | 'dueAt' | 'submittedAt' | 'remindBeforeDays'>, now: Date): EgpClock {
  const due = Date.parse(obligation.dueAt);
  const base = { dueAt: obligation.dueAt };
  if (obligation.state === 'CANCELLED') return { ...base, status: 'CANCELLED', msToDue: null };
  if (obligation.state === 'SUBMITTED' || obligation.state === 'RECEIPTED') {
    const submitted = Date.parse(obligation.submittedAt ?? obligation.dueAt);
    return { ...base, status: submitted <= due ? 'MET' : 'MET_LATE', msToDue: null };
  }
  const left = due - now.getTime();
  if (left < 0) return { ...base, status: 'OVERDUE', msToDue: left };
  return { ...base, status: left <= obligation.remindBeforeDays * DAY_MS ? 'DUE_SOON' : 'ON_TIME', msToDue: left };
}

/** The alert types of the lane, registered in `governance-rules.ts` under `ALERT_TYPE` with owner, expected action and consequence (G0-3). */
export const EGP_ALERT_CODES = ['EGP_POSTING_DUE', 'EGP_POSTING_OVERDUE'] as const;
export type EgpAlertCode = (typeof EGP_ALERT_CODES)[number];

/** The alert an obligation raises now: EGP_POSTING_DUE when it is DUE_SOON, EGP_POSTING_OVERDUE when it is overdue, none otherwise (and none once met, late or not: the lateness is a figure, not an alert). */
export function egpAlertFor(clock: EgpClock): EgpAlertCode | undefined {
  if (clock.status === 'DUE_SOON') return 'EGP_POSTING_DUE';
  if (clock.status === 'OVERDUE') return 'EGP_POSTING_OVERDUE';
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The health of the connector: the age of the last import against the rule CONNECTOR_FRESHNESS (code EGP_FILE).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The params of `CONNECTOR_FRESHNESS`: a warning after `warn_after_hours`, stale after `max_age_hours` (raising CONNECTOR_STALE at `stale_severity`), and whether the figures that rest on it are blocked while it is stale. */
export interface EgpFreshnessParams {
  max_age_hours: number;
  warn_after_hours: number;
  stale_severity: 'URGENT' | 'ACTION' | 'WATCH';
  figures_blocked_when_stale: boolean;
}

export type EgpHealthStatus = 'NEVER_IMPORTED' | 'FRESH' | 'AGING' | 'STALE';

export interface EgpConnectorHealth {
  status: EgpHealthStatus;
  /** Hours since the last import, or null when there has been none. */
  ageHours: number | null;
  adapterStatus: AdapterStatus;
  layoutVersion: string;
  /** What the data rests on is a working assumption: it cannot be accepted yet. */
  acceptance: EgpAcceptance;
  /** CONNECTOR_STALE while STALE, at the severity of the rule; none otherwise. A connector never used raises nothing (a tenant that does not use the network is not nagged) but says so. */
  alert: { code: 'CONNECTOR_STALE'; severity: EgpFreshnessParams['stale_severity'] } | null;
  /** The figures that rest on the files are blocked (shown as not up to date) while the connector is stale and the rule says so. */
  figuresBlocked: boolean;
}

/**
 * Formula: age = now - the time the last file was applied. FRESH up to `warn_after_hours`, AGING up to `max_age_hours`, STALE beyond, NEVER_IMPORTED when no file has been applied. A stale or never-imported
 * connector is shown as it is, never as "no data". Source of the age: the `file_import` row of the last applied file (BID-24).
 */
export function egpConnectorHealth(input: { lastImportAt: Date | null; now: Date; params: EgpFreshnessParams; adapterStatus?: AdapterStatus; layoutVersion?: string }): EgpConnectorHealth {
  const layoutVersion = input.layoutVersion ?? EGP_LAYOUT_VERSION;
  const base = { adapterStatus: input.adapterStatus ?? EGP_ADAPTER_STATUS, layoutVersion, acceptance: egpAcceptance(layoutVersion) };
  if (input.lastImportAt === null) return { ...base, status: 'NEVER_IMPORTED', ageHours: null, alert: null, figuresBlocked: false };
  const age = Math.max(0, (input.now.getTime() - input.lastImportAt.getTime()) / 3_600_000);
  const status: EgpHealthStatus = age <= input.params.warn_after_hours ? 'FRESH' : age <= input.params.max_age_hours ? 'AGING' : 'STALE';
  const stale = status === 'STALE';
  return {
    ...base,
    status,
    ageHours: Math.round(age * 10) / 10,
    alert: stale ? { code: 'CONNECTOR_STALE', severity: input.params.stale_severity } : null,
    figuresBlocked: stale && input.params.figures_blocked_when_stale,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The port, the file adapter and the refusing API adapter.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** What a read asks for. The file adapter needs `file`; the API adapter, when there is one, will take `since`. */
export interface EgpReadRequest {
  file?: Uint8Array;
  layoutVersion?: string;
  since?: string;
}

/** The fields an outbound posting must carry for each kind: what a person needs to post it on the network. */
export const EGP_POSTING_FIELDS: Readonly<Record<EgpPostingKind, readonly string[]>> = {
  PLAN: ['plan_name', 'decision_no', 'approved_on'],
  NOTICE: ['package_code', 'published_at', 'bid_closing_at'],
  RESULT: ['package_code', 'decision_no', 'approved_on', 'result_kind'],
  CONTRACT_INFO: ['contract_no', 'signed_on', 'contractor_tax_code', 'contract_price'],
  CONTRACTOR_PERFORMANCE: ['contract_no', 'contractor_tax_code', 'completed_on', 'schedule_rating', 'quality_rating'],
  VIOLATION: ['contractor_tax_code', 'behaviour_code', 'occurred_on', 'evidence_ref'],
  REPUTATION_EVENT: ['contractor_tax_code', 'behaviour_code', 'occurred_on', 'evidence_ref'],
  CONTRACTOR_RESPONSE: ['contractor_tax_code', 'response_received_on', 'outcome'],
};

export interface EgpPublishRequest {
  obligation: Pick<EgpObligation, 'kind' | 'subjectType' | 'subjectId' | 'dueAt'>;
  fields: Readonly<Record<string, string>>;
}

/** What a person takes to the network to post an obligation: the fields in a fixed order and the hash of the content (the proof of what was posted). */
export interface EgpPostingPacket {
  layoutVersion: string;
  kind: EgpPostingKind;
  subjectType: EgpSubjectType;
  subjectId: string;
  dueAt: string;
  fields: Record<string, string>;
  payloadSha256: string;
  acceptance: EgpAcceptance;
}

export type EgpPublishOutcome = { outcome: 'PREPARED'; packet: EgpPostingPacket };

/** Builds the packet of a posting: every required field present (422 `VALIDATION_FAILED`, `fields.<name>`), no other field, no control character. */
export function prepareEgpPostingPacket(request: EgpPublishRequest): EgpPostingPacket {
  const required = EGP_POSTING_FIELDS[request.obligation.kind];
  const fields: Record<string, string> = {};
  for (const name of Object.keys(request.fields)) if (!required.includes(name)) throw new DomainError('VALIDATION_FAILED', 422, `fields.${name}`);
  for (const name of required) {
    const value = (request.fields[name] ?? '').trim();
    if (value === '' || value.length > 2000 || hasControlChar(value)) throw new DomainError('VALIDATION_FAILED', 422, `fields.${name}`);
    fields[name] = value;
  }
  return {
    layoutVersion: EGP_LAYOUT_VERSION,
    kind: request.obligation.kind,
    subjectType: request.obligation.subjectType,
    subjectId: request.obligation.subjectId,
    dueAt: request.obligation.dueAt,
    fields,
    payloadSha256: sha256Hex(canonicalJson({ kind: request.obligation.kind, subjectId: request.obligation.subjectId, fields })),
    acceptance: egpAcceptance(EGP_LAYOUT_VERSION),
  };
}

/**
 * The port to the national network. Reads return the dry-run reading of the data (never a write: the store decides what to apply) and `publish` hands back what is to be posted. Two adapters exist:
 * `EgpFileAdapter`, which works today, and `EgpApiAdapter`, which refuses until the operator publishes a specification.
 */
export interface EgpPort {
  readonly code: string;
  readonly mode: ConnectorMode;
  readonly adapterStatus: AdapterStatus;
  /** Whether the adapter ever opens a connection. Neither does today. */
  readonly opensNetwork: boolean;
  readPlans(request: EgpReadRequest): Promise<EgpDryRun<EgpPlanRecord>>;
  readNotices(request: EgpReadRequest): Promise<EgpDryRun<EgpNoticeRecord>>;
  readResults(request: EgpReadRequest): Promise<EgpDryRun<EgpResultRecord>>;
  readContractors(request: EgpReadRequest): Promise<EgpDryRun<EgpContractorRecord>>;
  readRestrictions(request: EgpReadRequest): Promise<EgpDryRun<EgpRestrictionRecord>>;
  publish(request: EgpPublishRequest): Promise<EgpPublishOutcome>;
}

/**
 * Reads the files a person hands over (downloaded from the network, or exported from it by the operator) and prepares the postings a person makes by hand. It has no constructor argument and holds
 * no client: it CANNOT open a connection, and the test proves it opens none.
 */
export class EgpFileAdapter implements EgpPort {
  readonly code = EGP_CONNECTOR_CODE;
  readonly mode: ConnectorMode = 'FILE_IMPORT';
  readonly adapterStatus: AdapterStatus = EGP_ADAPTER_STATUS;
  readonly opensNetwork = false;

  private read<K extends EgpLayoutKind>(kind: K, request: EgpReadRequest): Promise<EgpDryRun<EgpRecordByKind[K]>> {
    try {
      if (request.file === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'file');
      return Promise.resolve(dryRunEgpFile(kind, request.file, request.layoutVersion));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  readPlans(request: EgpReadRequest): Promise<EgpDryRun<EgpPlanRecord>> {
    return this.read('KHLCNT', request);
  }
  readNotices(request: EgpReadRequest): Promise<EgpDryRun<EgpNoticeRecord>> {
    return this.read('TBMT', request);
  }
  readResults(request: EgpReadRequest): Promise<EgpDryRun<EgpResultRecord>> {
    return this.read('RESULT', request);
  }
  readContractors(request: EgpReadRequest): Promise<EgpDryRun<EgpContractorRecord>> {
    return this.read('CONTRACTOR', request);
  }
  readRestrictions(request: EgpReadRequest): Promise<EgpDryRun<EgpRestrictionRecord>> {
    return this.read('RESTRICTION', request);
  }

  publish(request: EgpPublishRequest): Promise<EgpPublishOutcome> {
    try {
      return Promise.resolve({ outcome: 'PREPARED', packet: prepareEgpPostingPacket(request) });
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

const apiUnavailable = (): Promise<never> =>
  Promise.reject(new DomainError(EGP_API_UNAVAILABLE_CODE, 503, 'adapter', { extensions: { adapter_status: 'MISSING', reason: 'OPERATOR_SPECIFICATION_PENDING' } }));

/**
 * The adapter for the API of the network: a stub that refuses every call with 503 `EGP_API_UNAVAILABLE` (adapter status MISSING). The operator has published no specification, so there is nothing to
 * call; the port is here so that the day it does, this class is the only thing that changes (and the connector may then become VERIFIED).
 */
export class EgpApiAdapter implements EgpPort {
  readonly code = EGP_CONNECTOR_CODE;
  readonly mode: ConnectorMode = 'API';
  readonly adapterStatus: AdapterStatus = 'MISSING';
  readonly opensNetwork = false;

  readPlans(): Promise<EgpDryRun<EgpPlanRecord>> {
    return apiUnavailable();
  }
  readNotices(): Promise<EgpDryRun<EgpNoticeRecord>> {
    return apiUnavailable();
  }
  readResults(): Promise<EgpDryRun<EgpResultRecord>> {
    return apiUnavailable();
  }
  readContractors(): Promise<EgpDryRun<EgpContractorRecord>> {
    return apiUnavailable();
  }
  readRestrictions(): Promise<EgpDryRun<EgpRestrictionRecord>> {
    return apiUnavailable();
  }
  publish(): Promise<EgpPublishOutcome> {
    return apiUnavailable();
  }
}

/** The adapter for the mode of a connector: the file modes read files, API and LGSP are not available. */
export function egpPortFor(mode: ConnectorMode): EgpPort {
  return mode === 'FILE_IMPORT' || mode === 'FILE_EXPORT' ? new EgpFileAdapter() : new EgpApiAdapter();
}
