import { ApiError } from '@machvon/api-client';

/** The permissions that gate the buttons of these screens; the server decides again on every request. */
export const READ_PERMISSION = 'capital.read';
export const MANAGE_PERMISSION = 'capital.appropriation.manage';
export const APPROVE_PERMISSION = 'capital.appropriation.approve';

export const BOOK_PATH = '/cap/cap-16';
export const FUND_PATH = '/cap/cap-04';
export const SUPPORT_PATH = '/cap/cap-14';

/** The origins the public form offers and the public filters list. */
export const ORIGINS = ['PM_ASSIGNED', 'LOCAL_ADDED', 'CARRYOVER', 'CENTRAL_SUPPORT', 'REVENUE_INCREASE'] as const;
/** The origins of the enterprise pack (ENT-3e): the resolution of the group and the decision of the company. The register shows them when the server returns them; the public form never offers them. */
export const ENTERPRISE_ORIGINS = ['GROUP_ASSIGNED', 'BOARD_APPROVED'] as const;
export type Origin = (typeof ORIGINS)[number] | (typeof ENTERPRISE_ORIGINS)[number];
export const ALL_ORIGINS: readonly Origin[] = [...ORIGINS, ...ENTERPRISE_ORIGINS];
export const BUDGET_LEVELS = ['CENTRAL', 'LOCAL'] as const;
/** The single level of the enterprise pack. */
export const ENTERPRISE_LEVEL = 'ALL';
/**
 * The origins the form of the enterprise edition offers: the enterprise pack lists the resolution of the group, the decision of the company and the carry-over, and refuses the five public ones (CAP, ENT-3e; the order is the one of
 * `enterprisePackParams`). The test `enterprise-origin.test.ts` keeps this list and the kinds below equal to the built-in pack of the kernel.
 */
export const ENTERPRISE_FORM_ORIGINS = ['GROUP_ASSIGNED', 'BOARD_APPROVED', 'CARRYOVER'] as const;
/** The kinds of decision document (codes of the legal-document catalogue) that may back an appropriation of each origin of the enterprise pack; the register refuses an enterprise appropriation without one of them. */
export const ENTERPRISE_DECISION_KINDS: Readonly<Record<(typeof ENTERPRISE_FORM_ORIGINS)[number], readonly string[]>> = {
  GROUP_ASSIGNED: ['GROUP_RESOLUTION', 'GROUP_DECISION'],
  BOARD_APPROVED: ['COMPANY_RESOLUTION', 'COMPANY_DECISION'],
  CARRYOVER: ['GROUP_RESOLUTION', 'GROUP_DECISION', 'COMPANY_RESOLUTION', 'COMPANY_DECISION'],
};
/** The kinds of decision document an origin of the enterprise pack takes; none for an origin the pack does not list (the public ones bind no kind). */
export const decisionKindsOf = (origin: string): readonly string[] => (ENTERPRISE_DECISION_KINDS as Readonly<Record<string, readonly string[] | undefined>>)[origin] ?? [];
export type BudgetLevel = (typeof BUDGET_LEVELS)[number] | typeof ENTERPRISE_LEVEL;
export type AppropriationStatus = 'DRAFT' | 'APPROVED' | 'PUBLISHED' | 'SUPERSEDED' | 'REJECTED';
const STATUSES: readonly string[] = ['DRAFT', 'APPROVED', 'PUBLISHED', 'SUPERSEDED', 'REJECTED'];

/** The origins CAP-14 shows: the capital that is not assigned by the Prime Minister nor added by the province (CAP 3.1 BR-CAP-11). */
export const SUPPORT_ORIGINS: readonly Origin[] = ['CENTRAL_SUPPORT', 'REVENUE_INCREASE'];

/** The fund source categories of the tree of CAP-04, in the order of the screen; CTMTQG is a subset of its parent and is never added. */
export const CATEGORIES = ['NSTW', 'NSDP', 'ODA', 'CTMTQG', 'OTHER'] as const;
export type Category = (typeof CATEGORIES)[number];

export const REASON_MIN_LENGTH = 5;
export const REASON_MAX_LENGTH = 2000;
export const AUTHORITY_MIN_LENGTH = 2;
export const AUTHORITY_MAX_LENGTH = 300;
export const MIN_YEAR = 1990;
export const MAX_YEAR = 2100;
const MILLION = 1_000_000n;
const MILLION_DIGITS = 6;
const MAX_VND_DIGITS = 24;
const VND = /^(0|[1-9]\d*)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const YEAR = /^\d{4}$/;

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);

export interface MasterRef {
  versionId: string;
  businessKey: string;
  label: string;
}

export interface FundSource extends MasterRef {
  category: string | null;
  relation: string | null;
  onLending: boolean | null;
  validFrom: string;
  validUntil: string | null;
}

/** One line of the register (CAP-16), and the row the fund and support views are built from. */
export interface AppropriationLine {
  id: string;
  fundSource: FundSource;
  program: MasterRef | null;
  planYear: number;
  origin: Origin;
  budgetLevel: BudgetLevel;
  /** Exact decimal strings in whole VND, never a number. */
  amountVnd: string;
  allocatedTotalVnd: string;
  remainingVnd: string;
  decisionDocumentId: string;
  decisionSymbol: string | null;
  decisionIssuedOn: string | null;
  issuingAuthority: string;
  sourceYear: number;
  isExtended: boolean;
  extendedTo: string | null;
  extensionDocumentId: string | null;
  revision: number;
  supersedesId: string | null;
  status: AppropriationStatus;
  createdBy: string;
  approvedBy: string | null;
  version: number;
  /** The kind of the decision document that backs the line: the enterprise pack requires one, the public pack has none. */
  decisionKind: string | null;
}

function masterRefOf(value: unknown): MasterRef | null {
  const row = asRecord(value);
  const versionId = text(row?.version_id);
  const businessKey = text(row?.business_key);
  if (row === undefined || versionId === undefined || businessKey === undefined) return null;
  return { versionId, businessKey, label: text(row.label) ?? businessKey };
}

function fundSourceOf(value: unknown): FundSource | null {
  const row = asRecord(value);
  const ref = masterRefOf(value);
  const validFrom = text(row?.valid_from);
  if (row === undefined || ref === null || validFrom === undefined) return null;
  return { ...ref, category: nullableText(row.category), relation: nullableText(row.relation), onLending: typeof row.onlending === 'boolean' ? row.onlending : null, validFrom, validUntil: nullableText(row.valid_until) };
}

export function toAppropriation(raw: unknown): AppropriationLine | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  const id = text(row.id);
  const fundSource = fundSourceOf(row.fund_source);
  const origin = text(row.origin);
  const level = text(row.budget_level);
  const status = text(row.status);
  const planYear = whole(row.plan_year);
  const version = whole(row.version);
  const amount = text(row.amount_vnd);
  const allocated = text(row.allocated_total_vnd);
  const remaining = text(row.remaining_vnd);
  const decision = asRecord(row.decision_document);
  const decisionId = text(decision?.id);
  if (
    id === undefined ||
    fundSource === null ||
    origin === undefined ||
    !(ALL_ORIGINS as readonly string[]).includes(origin) ||
    level === undefined ||
    !([...BUDGET_LEVELS, ENTERPRISE_LEVEL] as readonly string[]).includes(level) ||
    status === undefined ||
    !STATUSES.includes(status) ||
    planYear === undefined ||
    version === undefined ||
    amount === undefined ||
    allocated === undefined ||
    remaining === undefined ||
    decision === undefined ||
    decisionId === undefined
  ) {
    return undefined;
  }
  return {
    id,
    fundSource,
    program: masterRefOf(row.program),
    planYear,
    origin: origin as Origin,
    budgetLevel: level as BudgetLevel,
    amountVnd: amount,
    allocatedTotalVnd: allocated,
    remainingVnd: remaining,
    decisionDocumentId: decisionId,
    decisionSymbol: nullableText(decision.symbol),
    decisionIssuedOn: nullableText(decision.issued_on),
    issuingAuthority: text(row.issuing_authority) ?? '',
    sourceYear: whole(row.source_year) ?? planYear,
    isExtended: row.is_extended === true,
    extendedTo: nullableText(row.extended_to),
    extensionDocumentId: nullableText(row.extension_document_id),
    revision: whole(row.revision) ?? 1,
    supersedesId: nullableText(row.supersedes_id),
    status: status as AppropriationStatus,
    createdBy: text(row.created_by) ?? '',
    approvedBy: nullableText(row.approved_by),
    version,
    decisionKind: nullableText(row.decision_kind),
  };
}

// ---- money --------------------------------------------------------------------------------------------------------------

/** Whether the text is an amount of whole VND that the ledger holds (24 digits at most). */
export const isVnd = (value: string): boolean => VND.test(value) && value.length <= MAX_VND_DIGITS;

/** The exact sum of amounts of whole VND; an amount that is not one is left out of the sum, never guessed. */
export function sumVnd(amounts: readonly string[]): string {
  return amounts.filter((amount) => VND.test(amount)).reduce((total, amount) => total + BigInt(amount), 0n).toString();
}

function separatorOf(locale: string): string {
  return new Intl.NumberFormat(locale).formatToParts(1.1).find((part) => part.type === 'decimal')?.value ?? '.';
}

/**
 * An amount of whole VND in millions of dong, exactly: the division by 1,000,000 is done on integers, so no float is involved and no
 * dong is lost (six decimals hold every dong). The digits are grouped and the decimal mark is the one of the language.
 */
export function millionsText(vnd: string, locale: string): string {
  if (!VND.test(vnd)) return vnd;
  const value = BigInt(vnd);
  const fraction = (value % MILLION).toString().padStart(MILLION_DIGITS, '0').replace(/0+$/, '');
  const grouped = new Intl.NumberFormat(locale).format(value / MILLION);
  return fraction === '' ? grouped : `${grouped}${separatorOf(locale)}${fraction}`;
}

/** An amount of whole VND as it is typed in millions: digits and the decimal mark of the language, no grouping. */
export function millionsInput(vnd: string, locale: string): string {
  if (!VND.test(vnd)) return vnd;
  const value = BigInt(vnd);
  const fraction = (value % MILLION).toString().padStart(MILLION_DIGITS, '0').replace(/0+$/, '');
  const integer = (value / MILLION).toString();
  return fraction === '' ? integer : `${integer}${separatorOf(locale)}${fraction}`;
}

/** The whole VND in an amount grouped by the language, for the line that confirms what will be sent. */
export function vndText(vnd: string, locale: string): string {
  return VND.test(vnd) ? new Intl.NumberFormat(locale).format(BigInt(vnd)) : vnd;
}

/**
 * The exact VND for an amount typed in millions of dong: digits, and after the decimal mark of the language up to six more (every dong).
 * Grouping marks are not accepted, so "10.000" is never read as ten million when the language writes ten thousand with a point.
 * Returns undefined when the text is not such an amount or is zero.
 */
export function vndOfMillions(input: string, locale: string): string | undefined {
  const mark = separatorOf(locale);
  const typed = input.trim();
  const parts = typed.split(mark);
  if (parts.length > 2) return undefined;
  const [integerPart = '', fractionPart = ''] = parts;
  if (!/^\d+$/.test(integerPart) || !/^\d{0,6}$/.test(fractionPart)) return undefined;
  const vnd = (BigInt(integerPart) * MILLION + BigInt(fractionPart.padEnd(MILLION_DIGITS, '0'))).toString();
  return vnd !== '0' && isVnd(vnd) ? vnd : undefined;
}

// ---- the views ----------------------------------------------------------------------------------------------------------

export interface Totals {
  amountVnd: string;
  allocatedVnd: string;
  remainingVnd: string;
}

export function totalsOf(lines: readonly AppropriationLine[]): Totals {
  return {
    amountVnd: sumVnd(lines.map((line) => line.amountVnd)),
    allocatedVnd: sumVnd(lines.map((line) => line.allocatedTotalVnd)),
    remainingVnd: sumVnd(lines.map((line) => line.remainingVnd)),
  };
}

export interface BookFilter {
  year: string;
  origin: Origin | '';
  budgetLevel: BudgetLevel | '';
}

export const EMPTY_FILTER: BookFilter = { year: '', origin: '', budgetLevel: '' };

export function filterLines(lines: readonly AppropriationLine[], filter: BookFilter): AppropriationLine[] {
  return lines.filter(
    (line) => (filter.year === '' || String(line.planYear) === filter.year) && (filter.origin === '' || line.origin === filter.origin) && (filter.budgetLevel === '' || line.budgetLevel === filter.budgetLevel),
  );
}

/** The years the register has lines for, the newest first: the options of the year filter. */
export function yearsOf(lines: readonly AppropriationLine[]): number[] {
  return [...new Set(lines.map((line) => line.planYear))].sort((a, b) => b - a);
}

/** The lines of the book in the order of the table: the newest year first, then the origin in the order of the register, then the fund source. */
export function sortLines(lines: readonly AppropriationLine[]): AppropriationLine[] {
  return [...lines].sort(
    (a, b) =>
      b.planYear - a.planYear ||
      ALL_ORIGINS.indexOf(a.origin) - ALL_ORIGINS.indexOf(b.origin) ||
      a.fundSource.businessKey.localeCompare(b.fundSource.businessKey) ||
      a.id.localeCompare(b.id),
  );
}

/** Only an appropriation that is published draws plan lines; a draft waits for its decision. */
export const isPublished = (line: AppropriationLine): boolean => line.status === 'PUBLISHED';

export interface OriginGroup {
  origin: Origin;
  lines: AppropriationLine[];
  totals: Totals;
}

/** The published lines of some origins, one group per origin that has any: groups are never merged into one another (CAP 3.1 BR-CAP-11). */
export function groupByOrigin(lines: readonly AppropriationLine[], origins: readonly Origin[] = ALL_ORIGINS): OriginGroup[] {
  return origins
    .map((origin) => {
      const own = sortLines(lines.filter((line) => line.origin === origin && isPublished(line)));
      return { origin, lines: own, totals: totalsOf(own) };
    })
    .filter((group) => group.lines.length > 0);
}

export interface FundNode {
  fundSource: FundSource;
  /** The published lines drawn from this source, by origin. */
  groups: OriginGroup[];
  totals: Totals;
}

export interface CategoryNode {
  category: Category;
  sources: FundNode[];
  totals: Totals;
}

export function categoryOf(fundSource: FundSource): Category {
  return (CATEGORIES as readonly (string | null)[]).includes(fundSource.category) ? (fundSource.category as Category) : 'OTHER';
}

/**
 * The tree of CAP-04: the category of the fund source, the fund source, the origin. Only published lines count. A category that has no
 * line is not drawn, except CTMTQG, which the screen explains: it is part of its parent and is never added again.
 */
export function fundTree(lines: readonly AppropriationLine[]): CategoryNode[] {
  const published = lines.filter(isPublished);
  const byCategory = new Map<Category, Map<string, AppropriationLine[]>>();
  for (const line of published) {
    const category = categoryOf(line.fundSource);
    const sources = byCategory.get(category) ?? new Map<string, AppropriationLine[]>();
    sources.set(line.fundSource.businessKey, [...(sources.get(line.fundSource.businessKey) ?? []), line]);
    byCategory.set(category, sources);
  }
  return CATEGORIES.flatMap((category) => {
    const sources = byCategory.get(category);
    if (sources === undefined) return [];
    const nodes: FundNode[] = [...sources.values()]
      .map((own) => ({ fundSource: (own[0] as AppropriationLine).fundSource, groups: groupByOrigin(own), totals: totalsOf(own) }))
      .sort((a, b) => a.fundSource.businessKey.localeCompare(b.fundSource.businessKey));
    return [{ category, sources: nodes, totals: totalsOf(nodes.flatMap((node) => node.groups.flatMap((group) => group.lines))) }];
  });
}

// ---- the form -----------------------------------------------------------------------------------------------------------

export interface AppropriationForm {
  fundSourceVersionId: string;
  programVersionId: string;
  planYear: string;
  origin: Origin;
  budgetLevel: BudgetLevel;
  /** Millions of dong as typed. */
  amount: string;
  decisionDocumentId: string;
  issuingAuthority: string;
  sourceYear: string;
  extendedTo: string;
  extensionDocumentId: string;
  /** The kind of the decision document (enterprise edition only; empty in the public one, which binds none). */
  decisionKind: string;
}

export type FormField = keyof AppropriationForm;
export type FieldProblem = 'required' | 'invalidYear' | 'invalidAmount' | 'invalidId' | 'invalidDate' | 'tooShort' | 'tooLong' | 'sourceYear';

export const EMPTY_FORM: AppropriationForm = {
  fundSourceVersionId: '',
  programVersionId: '',
  planYear: '',
  origin: 'PM_ASSIGNED',
  budgetLevel: 'CENTRAL',
  amount: '',
  decisionDocumentId: '',
  issuingAuthority: '',
  sourceYear: '',
  extendedTo: '',
  extensionDocumentId: '',
  decisionKind: '',
};

/** The form of the enterprise edition opens on a line its pack accepts: the resolution of the group, the single level and the first kind of document that backs it. */
export const ENTERPRISE_EMPTY_FORM: AppropriationForm = {
  ...EMPTY_FORM,
  origin: ENTERPRISE_FORM_ORIGINS[0],
  budgetLevel: ENTERPRISE_LEVEL,
  decisionKind: decisionKindsOf(ENTERPRISE_FORM_ORIGINS[0])[0] ?? '',
};

/** The empty form of the edition: the origin, the level and the kind of document are ones the register of the edition accepts, so a form that is only filled in is never refused for them. */
export const emptyFormOf = (enterprise: boolean): AppropriationForm => (enterprise ? ENTERPRISE_EMPTY_FORM : EMPTY_FORM);

/** The origins and the levels the form of the edition offers. */
export const formOriginsOf = (enterprise: boolean): readonly Origin[] => (enterprise ? ENTERPRISE_FORM_ORIGINS : ORIGINS);
export const formLevelsOf = (enterprise: boolean): readonly BudgetLevel[] => (enterprise ? [ENTERPRISE_LEVEL] : BUDGET_LEVELS);

/** The form after a change of one field: a new origin of the enterprise pack takes the first kind of document it accepts when the kind chosen does not fit it. */
export function changeField(form: AppropriationForm, field: FormField, value: string, enterprise: boolean): AppropriationForm {
  const next = { ...form, [field]: value, ...(field === 'planYear' && form.origin !== 'CARRYOVER' ? { sourceYear: value } : {}) };
  if (!enterprise || field !== 'origin') return next;
  const kinds = decisionKindsOf(value);
  return kinds.includes(next.decisionKind) ? next : { ...next, decisionKind: kinds[0] ?? '' };
}

const yearOf = (value: string): number | undefined => (YEAR.test(value.trim()) && Number(value) >= MIN_YEAR && Number(value) <= MAX_YEAR ? Number(value) : undefined);

/** What is wrong with the fields of the form, before anything is sent; the server judges the same rules again. */
export function validateForm(form: AppropriationForm, locale: string, enterprise = false): Partial<Record<FormField, FieldProblem>> {
  const problems: Partial<Record<FormField, FieldProblem>> = {};
  if (form.fundSourceVersionId === '') problems.fundSourceVersionId = 'required';
  const planYear = yearOf(form.planYear);
  if (form.planYear.trim() === '') problems.planYear = 'required';
  else if (planYear === undefined) problems.planYear = 'invalidYear';
  if (form.amount.trim() === '') problems.amount = 'required';
  else if (vndOfMillions(form.amount, locale) === undefined) problems.amount = 'invalidAmount';
  if (form.decisionDocumentId.trim() === '') problems.decisionDocumentId = 'required';
  else if (!UUID.test(form.decisionDocumentId.trim())) problems.decisionDocumentId = 'invalidId';
  const authority = form.issuingAuthority.trim();
  if (authority === '') problems.issuingAuthority = 'required';
  else if (authority.length < AUTHORITY_MIN_LENGTH) problems.issuingAuthority = 'tooShort';
  else if (authority.length > AUTHORITY_MAX_LENGTH) problems.issuingAuthority = 'tooLong';
  if (enterprise && !decisionKindsOf(form.origin).includes(form.decisionKind)) problems.decisionKind = 'required';
  if (form.origin === 'CARRYOVER') {
    const sourceYear = yearOf(form.sourceYear);
    if (form.sourceYear.trim() === '') problems.sourceYear = 'required';
    else if (sourceYear === undefined || (planYear !== undefined && sourceYear >= planYear)) problems.sourceYear = sourceYear === undefined ? 'invalidYear' : 'sourceYear';
    if (form.extensionDocumentId.trim() === '') problems.extensionDocumentId = 'required';
    else if (!UUID.test(form.extensionDocumentId.trim())) problems.extensionDocumentId = 'invalidId';
    if (form.extendedTo.trim() === '') problems.extendedTo = 'required';
    else if (!DATE.test(form.extendedTo.trim()) || Number.isNaN(Date.parse(form.extendedTo.trim()))) problems.extendedTo = 'invalidDate';
  }
  return problems;
}

const optional = <T extends string>(value: string, key: T): Partial<Record<T, string>> => (value.trim() === '' ? {} : ({ [key]: value.trim().toLowerCase() } as Record<T, string>));

/** The body of `registerAppropriation` for a form that passed `validateForm`: the amount is sent as exact VND, what was left empty is not sent. */
export function registerBody(form: AppropriationForm, locale: string, supersedesId?: string) {
  const planYear = Number(form.planYear.trim());
  const carryover = form.origin === 'CARRYOVER';
  return {
    fund_source_version_id: form.fundSourceVersionId,
    plan_year: planYear,
    origin: form.origin,
    budget_level: form.budgetLevel,
    amount_vnd: vndOfMillions(form.amount, locale) as string,
    decision_document_id: form.decisionDocumentId.trim().toLowerCase(),
    issuing_authority: form.issuingAuthority.trim(),
    source_year: carryover ? Number(form.sourceYear.trim()) : planYear,
    ...(form.decisionKind === '' ? {} : { decision_kind: form.decisionKind }),
    ...optional(form.programVersionId, 'program_master_version_id'),
    ...(carryover ? { extended_to: form.extendedTo.trim(), ...optional(form.extensionDocumentId, 'extension_document_id') } : {}),
    ...(supersedesId === undefined ? {} : { supersedes_id: supersedesId }),
  };
}

export type RegisterBody = ReturnType<typeof registerBody>;

/** The form of a revision: everything of the appropriation it replaces, ready for the new amount, the new document and the new authority. */
export function formOfRevision(line: AppropriationLine, locale: string): AppropriationForm {
  return {
    fundSourceVersionId: line.fundSource.versionId,
    programVersionId: line.program?.versionId ?? '',
    planYear: String(line.planYear),
    origin: line.origin,
    budgetLevel: line.budgetLevel,
    amount: millionsInput(line.amountVnd, locale),
    decisionDocumentId: '',
    issuingAuthority: line.issuingAuthority,
    sourceYear: String(line.sourceYear),
    extendedTo: line.extendedTo ?? '',
    extensionDocumentId: line.extensionDocumentId ?? '',
    decisionKind: line.decisionKind ?? '',
  };
}

// ---- the options of the form --------------------------------------------------------------------------------------------

export interface MasterOption extends MasterRef {
  category: string | null;
}

/** The entries in force of a type that the form offers, by the version a line stores; a fund source that is a subset of another is not offered (it is part of its parent). */
export function toMasterOption(raw: unknown): MasterOption[] {
  const row = asRecord(raw);
  const versionId = text(row?.version_id);
  const businessKey = text(row?.business_key);
  if (row === undefined || versionId === undefined || businessKey === undefined || row.status !== 'EFFECTIVE') return [];
  const attributes = asRecord(row.attributes) ?? {};
  if (attributes.relation === 'SUBSET_OF') return [];
  return [{ versionId, businessKey, label: text(row.label) ?? businessKey, category: nullableText(attributes.category) }];
}

// ---- refusals -----------------------------------------------------------------------------------------------------------

export type ProblemReason =
  | 'belowAllocated'
  | 'decisionRequired'
  | 'extensionRequired'
  | 'duplicate'
  | 'revisionPending'
  | 'selfApproval'
  | 'versionConflict'
  | 'stateInvalid'
  | 'yearLocked'
  | 'masterNotEffective'
  | 'subsetSource'
  | 'notAllowed'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'general';

export interface ProblemView {
  reason: ProblemReason;
  field: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  APPROPRIATION_BELOW_ALLOCATED: 'belowAllocated',
  DECISION_REQUIRED: 'decisionRequired',
  EXTENSION_DOCUMENT_REQUIRED: 'extensionRequired',
  APPROPRIATION_DUPLICATE: 'duplicate',
  REVISION_PENDING_EXISTS: 'revisionPending',
  SELF_APPROVAL_DENIED: 'selfApproval',
  VERSION_CONFLICT: 'versionConflict',
  STAGE_TRANSITION_DENIED: 'stateInvalid',
  FISCAL_YEAR_LOCKED: 'yearLocked',
  MASTER_NOT_EFFECTIVE: 'masterNotEffective',
  SUBSET_SOURCE_NOT_ADDITIVE: 'subsetSource',
  FIELD_NOT_ALLOWED: 'notAllowed',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
};

/** Maps the error of a command of these screens to what they show; an unknown failure is the general message. */
export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined };
  if (error.status === 403 && error.code !== 'SELF_APPROVAL_DENIED') return { reason: 'denied', field: undefined };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail };
}
