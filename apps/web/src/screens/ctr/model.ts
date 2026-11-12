import { ApiError } from '@machvon/api-client';

/** The permissions that gate the buttons of these screens; the server decides again on every request (scope included). */
export const READ_PERMISSION = 'contract.read';
export const CREATE_PERMISSION = 'contract.create';
export const UPDATE_PERMISSION = 'contract.update';

export const LIST_PATH = '/ctr/ctr-01';
export const DRAFT_PATH = '/ctr/ctr-02';
export const PARTIES_PATH = '/ctr/ctr-25';
export const WORKSPACE_PATH = '/ctr/ctr-03';
export const HALT_PATH = '/ctr/ctr-22';

export const CONTRACT_STATUSES = ['DRAFT', 'IN_REVIEW', 'SIGNED', 'ACTIVE', 'SUSPENDED', 'TERMINATED', 'COMPLETED', 'CLOSED', 'CANCELLED'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];
export const CONTRACT_TYPES = ['LUMP_SUM', 'UNIT_PRICE', 'ADJUSTABLE_PRICE', 'TIME_BASED', 'COST_PLUS_FEE', 'EPC', 'ESTIMATE_BASED'] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];
export const ADVANCE_CATEGORIES = ['CONSTRUCTION', 'EQUIPMENT', 'CONSULTING', 'EPC', 'LAND_CLEARANCE', 'OTHER'] as const;
export type AdvanceCategory = (typeof ADVANCE_CATEGORIES)[number];
export const PARTY_ROLES = ['LEAD', 'MEMBER'] as const;
export type PartyRole = (typeof PARTY_ROLES)[number];

export const CODE_MAX_LENGTH = 50;
export const TITLE_MAX_LENGTH = 500;
const AMOUNT = /^(0|[1-9]\d{0,23})$/;
const SHARE = /^\d{1,3}(\.\d{1,4})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** 100 percent in ten-thousandths: the shares are held with four digits after the point. */
const FULL_SHARE = 1_000_000n;
const SHARE_SCALE = 4;

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);

// ---- what the server answers ----------------------------------------------------------------------------------------

/** One line of the register (CTR-01). The ceiling is left out of the answer for a guest contractor, and is then undefined. */
export interface ContractLine {
  id: string;
  code: string;
  title: string | null;
  status: ContractStatus;
  type: ContractType;
  projectId: string;
  projectCode: string;
  projectName: string;
  packageId: string;
  contractorId: string;
  contractorName: string | null;
  isJointVenture: boolean;
  /** Exact decimal strings in VND; the screens never turn an amount into a number. */
  contractValueVnd: string;
  estimateCeilingVnd: string | null | undefined;
  completionDue: string | null;
  version: number;
}

export interface RevisionLine {
  id: string;
  revision: number;
  kind: string;
  status: string;
  amountVnd: string;
  documentVersionId: string;
  validFrom: string;
  /** The first day of the revision that took over from this one; null while it is in force or waiting for its day. */
  validUntil: string | null;
  /** A revision that reaches back before the day it was approved; only the adjustment of its own makes one. */
  retroactive: boolean;
  /** The revision this one follows, and the change order that made it; null for the first revision. */
  supersedesId: string | null;
  changeRequest: { id: string; code: string | null } | null;
  /** The version of the revision that a command on it (the import of its BOQ) must name. */
  version: number;
  /** What the lines of its BOQ add up to and how many there are, as the server counted them (BR-CTR-02); undefined when the answer has none. */
  boqTotalVnd: string | undefined;
  boqLineCount: number | undefined;
}

/** One balance of the ledger that a retroactive adjustment moved: an item of an acceptance (and member), what it was accepted for and what it is worth at the new price. Exact decimal strings in VND. */
export interface AdjustedLine {
  id: string;
  acceptanceId: string;
  acceptanceNo: string | null;
  boqItemKey: string;
  partyId: string | null;
  quantity: string;
  oldAmountVnd: string;
  newUnitPrice: string;
  newAmountVnd: string;
  /** New less old, signed: positive when the price rose, negative when it fell. */
  deltaVnd: string;
}

/** A retroactive adjustment of a change order (ST-CTR-016): the day it reaches back to, the revision it made, what it rests on and the balances it moved. Read by right of the ledger. */
export interface AdjustmentRecord {
  id: string;
  changeRequestId: string;
  changeRequestCode: string | null;
  revisionId: string;
  effectiveOn: string;
  approvedOn: string;
  basis: string;
  decisionDocumentVersionId: string;
  totalDeltaVnd: string;
  affected: AdjustedLine[];
}

export interface PartyLine {
  id: string;
  contractorId: string;
  contractorName: string | null;
  role: PartyRole | 'SOLE';
  sharePct: string;
  workValueVnd: string;
}

export interface StatusChangeLine {
  id: string;
  fromStatus: string;
  toStatus: string;
  reason: string;
  effectiveOn: string;
}

/** The contract with its terms, its revisions and its members (CTR-02, CTR-25). */
export interface ContractView extends ContractLine {
  advanceCategory: AdvanceCategory;
  requiresQualityAcceptance: boolean;
  statusReason: string | null;
  documentVersionId: string | null;
  revisions: RevisionLine[];
  /** The retroactive adjustments of the contract, oldest first; empty for a reader without the right to the ledger. */
  retroactiveAdjustments: AdjustmentRecord[];
  parties: PartyLine[];
  /** Whether the work the members take adds up to the value of the contract, as the server counted it. */
  workMatchesValue: boolean;
  statusChanges: StatusChangeLine[];
}

const isOneOf = <T extends string>(values: readonly T[], value: string | undefined): value is T => value !== undefined && (values as readonly string[]).includes(value);

export function toContractLine(raw: unknown): ContractLine | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  const id = text(row.id);
  const code = text(row.code);
  const status = text(row.status);
  const type = text(row.type);
  const value = text(row.contract_value_vnd);
  const version = whole(row.version);
  if (id === undefined || code === undefined || value === undefined || version === undefined || !isOneOf(CONTRACT_STATUSES, status) || !isOneOf(CONTRACT_TYPES, type)) return undefined;
  return {
    id,
    code,
    title: nullableText(row.title),
    status,
    type,
    projectId: text(row.project_id) ?? '',
    projectCode: text(row.project_code) ?? '',
    projectName: text(row.project_name) ?? '',
    packageId: text(row.package_id) ?? '',
    contractorId: text(row.contractor_id) ?? '',
    contractorName: nullableText(row.contractor_name),
    isJointVenture: row.is_joint_venture === true,
    contractValueVnd: value,
    estimateCeilingVnd: 'estimate_ceiling_vnd' in row ? nullableText(row.estimate_ceiling_vnd) : undefined,
    completionDue: nullableText(row.completion_due),
    version,
  };
}

function toRevision(raw: unknown): RevisionLine[] {
  const row = asRecord(raw);
  const id = text(row?.id);
  const revision = whole(row?.revision);
  const amount = text(row?.amount_vnd);
  if (row === undefined || id === undefined || revision === undefined || amount === undefined) return [];
  return [
    {
      id,
      revision,
      kind: text(row.kind) ?? '',
      status: text(row.status) ?? '',
      amountVnd: amount,
      documentVersionId: text(row.document_version_id) ?? '',
      validFrom: text(row.valid_from) ?? '',
      validUntil: nullableText(row.valid_until),
      retroactive: row.retroactive === true,
      supersedesId: nullableText(row.supersedes_id),
      changeRequest: text(row.change_request_id) === undefined ? null : { id: text(row.change_request_id) ?? '', code: nullableText(row.change_request_code) },
      version: whole(row.version) ?? 1,
      boqTotalVnd: text(row.boq_total_vnd),
      boqLineCount: whole(row.boq_line_count),
    },
  ];
}

function toAdjustedLine(raw: unknown): AdjustedLine[] {
  const row = asRecord(raw);
  const id = text(row?.id);
  const acceptanceId = text(row?.acceptance_id);
  const oldAmount = text(row?.old_amount_vnd);
  const newAmount = text(row?.new_amount_vnd);
  const delta = text(row?.delta_vnd);
  if (row === undefined || id === undefined || acceptanceId === undefined || oldAmount === undefined || newAmount === undefined || delta === undefined) return [];
  return [
    {
      id,
      acceptanceId,
      acceptanceNo: nullableText(row.acceptance_no),
      boqItemKey: text(row.boq_item_key) ?? '',
      partyId: nullableText(row.party_id),
      quantity: text(row.quantity) ?? '',
      oldAmountVnd: oldAmount,
      newUnitPrice: text(row.new_unit_price) ?? '',
      newAmountVnd: newAmount,
      deltaVnd: delta,
    },
  ];
}

function toAdjustment(raw: unknown): AdjustmentRecord[] {
  const row = asRecord(raw);
  const id = text(row?.id);
  const changeRequestId = text(row?.change_request_id);
  const revisionId = text(row?.revision_id);
  const effectiveOn = text(row?.effective_on);
  const total = text(row?.total_delta_vnd);
  if (row === undefined || id === undefined || changeRequestId === undefined || revisionId === undefined || effectiveOn === undefined || total === undefined) return [];
  return [
    {
      id,
      changeRequestId,
      changeRequestCode: nullableText(row.change_request_code),
      revisionId,
      effectiveOn,
      approvedOn: text(row.approved_on) ?? '',
      basis: text(row.basis) ?? '',
      decisionDocumentVersionId: text(row.decision_document_version_id) ?? '',
      totalDeltaVnd: total,
      affected: listOf(row.affected, toAdjustedLine),
    },
  ];
}

function toParty(raw: unknown): PartyLine[] {
  const row = asRecord(raw);
  const id = text(row?.id);
  const contractorId = text(row?.contractor_id);
  const role = text(row?.role);
  const share = text(row?.share_pct);
  const work = text(row?.work_value_vnd);
  if (row === undefined || id === undefined || contractorId === undefined || share === undefined || work === undefined || !isOneOf([...PARTY_ROLES, 'SOLE'] as const, role)) return [];
  return [{ id, contractorId, contractorName: nullableText(row.contractor_name), role, sharePct: share, workValueVnd: work }];
}

function toStatusChange(raw: unknown): StatusChangeLine[] {
  const row = asRecord(raw);
  const id = text(row?.id);
  if (row === undefined || id === undefined) return [];
  return [{ id, fromStatus: text(row.from_status) ?? '', toStatus: text(row.to_status) ?? '', reason: text(row.reason) ?? '', effectiveOn: text(row.effective_on) ?? '' }];
}

const listOf = <T>(value: unknown, read: (raw: unknown) => T[]): T[] => (Array.isArray(value) ? value.flatMap(read) : []);

export function toContractView(raw: unknown): ContractView | undefined {
  const line = toContractLine(raw);
  const row = asRecord(raw);
  const category = text(row?.advance_category);
  if (line === undefined || row === undefined || !isOneOf(ADVANCE_CATEGORIES, category)) return undefined;
  const revisions = listOf(row.revisions, toRevision);
  const current = revisions.find((revision) => revision.status === 'DRAFT') ?? revisions[revisions.length - 1];
  return {
    ...line,
    advanceCategory: category,
    requiresQualityAcceptance: row.requires_quality_acceptance !== false,
    statusReason: nullableText(row.status_reason),
    documentVersionId: current?.documentVersionId ?? null,
    revisions,
    retroactiveAdjustments: listOf(row.retroactive_adjustments, toAdjustment),
    parties: listOf(row.parties, toParty),
    workMatchesValue: asRecord(row.parties_check)?.work_matches_value === true,
    statusChanges: listOf(row.status_changes, toStatusChange),
  };
}

/** An option of a select: the id the command takes and the words the person reads. */
export interface Option {
  id: string;
  label: string;
}

export function toProjectOption(raw: unknown): Option[] {
  const row = asRecord(raw);
  const id = text(row?.id);
  const code = text(row?.code);
  return row === undefined || id === undefined || code === undefined ? [] : [{ id, label: `${code} · ${text(row.name) ?? ''}` }];
}

/** A contractor the form offers: only a verified one can hold a contract. */
export function toContractorOption(raw: unknown): Option[] {
  const row = asRecord(raw);
  const id = text(row?.id);
  if (row === undefined || id === undefined || row.verification_status !== 'VERIFIED') return [];
  return [{ id, label: text(row.legal_name) ?? id }];
}

/** An amount in VND from its decimal string: the digits are grouped by the language of the screen and the string is never turned into a float. */
export function amountText(amount: string, locale: string): string {
  const [integer = ''] = amount.split('.');
  return /^\d+$/.test(integer) ? new Intl.NumberFormat(locale).format(BigInt(integer)) : amount;
}

// ---- the form of the draft (CTR-02) ----------------------------------------------------------------------------------

export interface ContractForm {
  projectId: string;
  packageId: string;
  contractorId: string;
  code: string;
  title: string;
  type: ContractType;
  advanceCategory: AdvanceCategory;
  isJointVenture: boolean;
  requiresQualityAcceptance: boolean;
  contractValue: string;
  estimateCeiling: string;
  completionDue: string;
  documentVersionId: string;
}

export type ContractField = keyof ContractForm;

export const EMPTY_FORM: ContractForm = {
  projectId: '',
  packageId: '',
  contractorId: '',
  code: '',
  title: '',
  type: 'LUMP_SUM',
  advanceCategory: 'CONSTRUCTION',
  isJointVenture: false,
  requiresQualityAcceptance: true,
  contractValue: '',
  estimateCeiling: '',
  completionDue: '',
  documentVersionId: '',
};

export type FieldProblem = 'required' | 'tooLong' | 'invalidAmount' | 'zeroAmount' | 'invalidId' | 'invalidDate' | 'aboveCeiling';

const isAmount = (value: string): boolean => AMOUNT.test(value.trim());

/** What is wrong with the fields of the form, before anything is sent; the server judges the same rules again. */
export function validateForm(form: ContractForm, mode: 'create' | 'revise', ceiling?: string | null): Partial<Record<ContractField, FieldProblem>> {
  const problems: Partial<Record<ContractField, FieldProblem>> = {};
  if (mode === 'create') {
    for (const field of ['projectId', 'packageId', 'contractorId'] as const) {
      if (form[field] === '') problems[field] = 'required';
      else if (!UUID.test(form[field].trim())) problems[field] = 'invalidId';
    }
    const code = form.code.trim();
    if (code === '') problems.code = 'required';
    else if (code.length > CODE_MAX_LENGTH) problems.code = 'tooLong';
  }
  const title = form.title.trim();
  if (title === '') problems.title = 'required';
  else if (title.length > TITLE_MAX_LENGTH) problems.title = 'tooLong';
  const value = form.contractValue.trim();
  if (value === '') problems.contractValue = 'required';
  else if (!isAmount(value)) problems.contractValue = 'invalidAmount';
  else if (BigInt(value) === 0n) problems.contractValue = 'zeroAmount';
  const own = form.estimateCeiling.trim();
  if (own !== '' && !isAmount(own)) problems.estimateCeiling = 'invalidAmount';
  // The ceiling in force is the lower of the one typed and the one the server holds; a value above it is refused before it is sent.
  const bound = [own !== '' && isAmount(own) ? own : null, ceiling ?? null].filter((item): item is string => item !== null).reduce<string | null>((low, item) => (low === null || BigInt(item) < BigInt(low) ? item : low), null);
  if (problems.contractValue === undefined && bound !== null && BigInt(value) > BigInt(bound)) problems.contractValue = 'aboveCeiling';
  if (form.completionDue !== '' && !DATE.test(form.completionDue)) problems.completionDue = 'invalidDate';
  if (form.documentVersionId === '') problems.documentVersionId = 'required';
  else if (!UUID.test(form.documentVersionId.trim())) problems.documentVersionId = 'invalidId';
  return problems;
}

/** The body of `createContract` for a form that passed `validateForm`: what was left empty is not sent. */
export function createBody(form: ContractForm) {
  return {
    project_id: form.projectId.trim(),
    package_id: form.packageId.trim(),
    contractor_id: form.contractorId.trim(),
    code: form.code.trim(),
    title: form.title.trim(),
    type: form.type,
    advance_category: form.advanceCategory,
    is_joint_venture: form.isJointVenture,
    requires_quality_acceptance: form.requiresQualityAcceptance,
    contract_value_vnd: form.contractValue.trim(),
    document_version_id: form.documentVersionId.trim(),
    ...(form.estimateCeiling.trim() === '' ? {} : { estimate_ceiling_vnd: form.estimateCeiling.trim() }),
    ...(form.completionDue === '' ? {} : { completion_due: form.completionDue }),
  };
}

export type CreateBody = ReturnType<typeof createBody>;

/** The form as it stands for a draft that is opened to be revised. */
export function formOf(contract: ContractView): ContractForm {
  return {
    projectId: contract.projectId,
    packageId: contract.packageId,
    contractorId: contract.contractorId,
    code: contract.code,
    title: contract.title ?? '',
    type: contract.type,
    advanceCategory: contract.advanceCategory,
    isJointVenture: contract.isJointVenture,
    requiresQualityAcceptance: contract.requiresQualityAcceptance,
    contractValue: contract.contractValueVnd,
    estimateCeiling: contract.estimateCeilingVnd ?? '',
    completionDue: contract.completionDue ?? '',
    documentVersionId: contract.documentVersionId ?? '',
  };
}

export interface ReviseBody {
  title?: string;
  completion_due?: string;
  contract_value_vnd?: string;
  estimate_ceiling_vnd?: string;
  requires_quality_acceptance?: boolean;
  document_version_id?: string;
}

/** The body of `reviseContractDraft`: only what differs from the draft, and only the fields of the allowlist (no code, no status, no contractor). */
export function reviseBody(contract: ContractView, form: ContractForm): ReviseBody {
  const body: ReviseBody = {};
  const title = form.title.trim();
  if (title !== (contract.title ?? '')) body.title = title;
  if (form.completionDue !== '' && form.completionDue !== (contract.completionDue ?? '')) body.completion_due = form.completionDue;
  const value = String(BigInt(form.contractValue.trim()));
  if (value !== contract.contractValueVnd) body.contract_value_vnd = value;
  const ceiling = form.estimateCeiling.trim();
  if (ceiling !== '' && String(BigInt(ceiling)) !== (contract.estimateCeilingVnd ?? '')) body.estimate_ceiling_vnd = String(BigInt(ceiling));
  if (form.requiresQualityAcceptance !== contract.requiresQualityAcceptance) body.requires_quality_acceptance = form.requiresQualityAcceptance;
  const documentVersionId = form.documentVersionId.trim();
  if (documentVersionId !== '' && documentVersionId !== (contract.documentVersionId ?? '')) body.document_version_id = documentVersionId;
  return body;
}

// ---- the members of a joint venture (CTR-25) -------------------------------------------------------------------------

export interface PartyDraft {
  /** Local key of the row, so a row keeps its place while it is edited. */
  key: number;
  contractorId: string;
  role: PartyRole;
  sharePct: string;
  workValueVnd: string;
}

export type PartyProblem = 'contractorRequired' | 'contractorTwice' | 'invalidShare' | 'invalidAmount';

/** The rows of the editor for a contract: the members it has, or the lead alone with the whole of it when it has none yet. */
export function draftsOf(contract: ContractView): PartyDraft[] {
  if (contract.parties.length === 0) {
    return [{ key: 0, contractorId: contract.contractorId, role: 'LEAD', sharePct: '100', workValueVnd: contract.contractValueVnd }];
  }
  return contract.parties.map((party, index) => ({
    key: index,
    contractorId: party.contractorId,
    role: party.role === 'LEAD' ? 'LEAD' : 'MEMBER',
    sharePct: party.sharePct,
    workValueVnd: party.workValueVnd,
  }));
}

/** A share in ten-thousandths of a percent from its decimal text; undefined when it is not a share of at most four digits after the point. */
function shareUnits(value: string): bigint | undefined {
  const trimmed = value.trim();
  if (!SHARE.test(trimmed)) return undefined;
  const [integer = '0', fraction = ''] = trimmed.split('.');
  return BigInt(integer) * 10n ** BigInt(SHARE_SCALE) + BigInt(fraction.padEnd(SHARE_SCALE, '0'));
}

export interface PartyTotals {
  /** The shares as a percentage with four digits after the point; undefined while a row holds no share. */
  share: string | undefined;
  work: string | undefined;
  sharesComplete: boolean;
  workMatchesValue: boolean;
}

/** The sums the editor shows live, in exact arithmetic over integers: shares in ten-thousandths, work in whole VND. */
export function partyTotals(rows: readonly PartyDraft[], contractValueVnd: string): PartyTotals {
  const shares = rows.map((row) => shareUnits(row.sharePct));
  const works = rows.map((row) => (isAmount(row.workValueVnd) ? BigInt(row.workValueVnd.trim()) : undefined));
  const shareSum = shares.every((item): item is bigint => item !== undefined) ? shares.reduce((total, item) => total + item, 0n) : undefined;
  const workSum = works.every((item): item is bigint => item !== undefined) ? works.reduce((total, item) => total + item, 0n) : undefined;
  const fraction = 10n ** BigInt(SHARE_SCALE);
  return {
    share: shareSum === undefined ? undefined : `${shareSum / fraction}.${String(shareSum % fraction).padStart(SHARE_SCALE, '0')}`,
    work: workSum === undefined ? undefined : workSum.toString(),
    sharesComplete: shareSum === FULL_SHARE,
    workMatchesValue: workSum !== undefined && workSum === BigInt(contractValueVnd),
  };
}

/** What is wrong with each row, by its key, before anything is sent. */
export function validateParties(rows: readonly PartyDraft[]): Map<number, PartyProblem> {
  const problems = new Map<number, PartyProblem>();
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.contractorId === '') problems.set(row.key, 'contractorRequired');
    else if (seen.has(row.contractorId)) problems.set(row.key, 'contractorTwice');
    else if (shareUnits(row.sharePct) === undefined || shareUnits(row.sharePct) === 0n || (shareUnits(row.sharePct) ?? 0n) > FULL_SHARE) problems.set(row.key, 'invalidShare');
    else if (!isAmount(row.workValueVnd)) problems.set(row.key, 'invalidAmount');
    seen.add(row.contractorId);
  }
  return problems;
}

export interface PartiesBody {
  parties: Array<{ contractor_id: string; role: PartyRole; share_pct: string; work_value_vnd: string }>;
}

export function partiesBody(rows: readonly PartyDraft[]): PartiesBody {
  return {
    parties: rows.map((row) => ({ contractor_id: row.contractorId, role: row.role, share_pct: row.sharePct.trim(), work_value_vnd: String(BigInt(row.workValueVnd.trim())) })),
  };
}

// ---- refusals ---------------------------------------------------------------------------------------------------------

export type ProblemReason =
  | 'duplicateCode'
  | 'exceedsCeiling'
  | 'planNotApproved'
  | 'packageNotAwarded'
  | 'contractorNotVerified'
  | 'contractorRestricted'
  | 'shareNot100'
  | 'workMismatch'
  | 'stateInvalid'
  | 'versionConflict'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'general';

export interface ProblemView {
  reason: ProblemReason;
  field: string | undefined;
  /** The ceiling the server named, an exact decimal string in VND. */
  ceiling: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  CONTRACT_CODE_DUPLICATE: 'duplicateCode',
  CONTRACT_VALUE_EXCEEDS_CEILING: 'exceedsCeiling',
  CAPITAL_PLAN_NOT_APPROVED: 'planNotApproved',
  PACKAGE_NOT_AWARDED: 'packageNotAwarded',
  CONTRACTOR_NOT_VERIFIED: 'contractorNotVerified',
  CONTRACTOR_RESTRICTED: 'contractorRestricted',
  JV_SHARE_NOT_100: 'shareNot100',
  BOQ_TOTAL_MISMATCH: 'workMismatch',
  CONTRACT_STATE_INVALID: 'stateInvalid',
  VERSION_CONFLICT: 'versionConflict',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
};

/** Maps the error of a command of these screens to what they show; an unknown failure is the general message. */
export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined, ceiling: undefined };
  const ceiling = error.extensions.ceiling_vnd;
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail, ceiling: typeof ceiling === 'string' ? ceiling : undefined };
}

// ---- the register ------------------------------------------------------------------------------------------------------

export interface ListFilter {
  query: string;
  status: ContractStatus | '';
}

export const EMPTY_FILTER: ListFilter = { query: '', status: '' };

export function filterContracts(contracts: readonly ContractLine[], filter: ListFilter): ContractLine[] {
  const query = filter.query.trim().toLowerCase();
  return contracts.filter(
    (contract) =>
      (query === '' ||
        contract.code.toLowerCase().includes(query) ||
        (contract.title ?? '').toLowerCase().includes(query) ||
        contract.projectCode.toLowerCase().includes(query) ||
        (contract.contractorName ?? '').toLowerCase().includes(query)) &&
      (filter.status === '' || contract.status === filter.status),
  );
}

const linkTo = (path: string, contractId: string): string => `${path}?${new URLSearchParams({ id: contractId }).toString()}`;
/** The address of the draft of a contract (CTR-02) and of its members (CTR-25). */
export const draftLink = (contractId: string): string => linkTo(DRAFT_PATH, contractId);
export const partiesLink = (contractId: string): string => linkTo(PARTIES_PATH, contractId);
/** The address of the workspace of a contract (CTR-03): its review, its signing and its activation. */
export const workspaceLink = (contractId: string): string => linkTo(WORKSPACE_PATH, contractId);

/** The address of the screen that suspends, resumes or terminates a contract (CTR-22). */
export const haltLink = (contractId: string): string => linkTo(HALT_PATH, contractId);

/** The stages in which a contract no longer runs: it is ended, stopped for good or cancelled. */
const ENDED_STATUSES: readonly ContractStatus[] = ['COMPLETED', 'CLOSED', 'TERMINATED', 'CANCELLED'];

/**
 * The contract a screen of one contract shows when it is opened without one: the largest by value among those in force (ACTIVE), else the largest that has not ended, else the largest of the
 * register. Undefined when the register is empty. Ties keep the order of the register (by code).
 */
export function defaultContract(lines: readonly ContractLine[]): ContractLine | undefined {
  const inForce = lines.filter((line) => line.status === 'ACTIVE');
  const alive = lines.filter((line) => !ENDED_STATUSES.includes(line.status));
  const pool = inForce.length > 0 ? inForce : alive.length > 0 ? alive : lines;
  return pool.reduce<ContractLine | undefined>((best, line) => (best === undefined || Number(line.contractValueVnd) > Number(best.contractValueVnd) ? line : best), undefined);
}
