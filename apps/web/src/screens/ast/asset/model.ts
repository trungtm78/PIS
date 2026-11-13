import { ApiError } from '@machvon/api-client';

/** The permissions of AST-03 (x-permission of the operations in openapi.json); the server judges each command again, with the scope of the contract and of the receiving unit. */
export const READ_PERMISSION = 'asset_record.read';
export const MANAGE_PERMISSION = 'asset.manage';

export const ASSET_STATUSES = ['DRAFT', 'REGISTERED', 'TRANSFERRED', 'IN_OPERATION', 'DISPOSED'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];
export const VALUE_BASES = ['CONTRACT_VALUE', 'SETTLED_VALUE', 'APPRAISED_VALUE'] as const;
export type ValueBasis = (typeof VALUE_BASES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT = /^\d{1,24}$/;
const MAX_TEXT = 2000;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined => values.find((candidate) => candidate === value);

/** One asset as AST-03 shows it; the figures are null for whoever does not register or transfer assets. */
export interface AssetLine {
  id: string;
  assetCode: string;
  name: string | null;
  handover: { id: string; handoverNo: string | null; status: string };
  contract: { id: string; code: string; valueVnd: string | null };
  recipientUnit: { id: string; name: string };
  valueVnd: string | null;
  valueBasis: ValueBasis | null;
  contractAssetsVnd: string | null;
  status: AssetStatus;
  registeredOn: string | null;
  transferredOn: string | null;
  warrantyUntil: string | null;
  externalAssetId: string | null;
  /** The asset class of the master data (its version), the group the asset belongs to; null until it is classified. */
  assetClassId: string | null;
  /** Where the asset comes from (the funding that formed it), as the register recorded it. */
  fundingOrigin: string | null;
  canTransfer: boolean;
  version: number;
}

export function toAsset(raw: unknown): AssetLine | undefined {
  const row = asRecord(raw);
  const handover = asRecord(row?.handover);
  const contract = asRecord(row?.contract);
  const unit = asRecord(row?.recipient_unit);
  const id = text(row?.id);
  const status = oneOf(ASSET_STATUSES, row?.status);
  const version = whole(row?.version);
  const contractId = text(contract?.id);
  if (row === undefined || id === undefined || status === undefined || version === undefined || contractId === undefined) return undefined;
  return {
    id,
    assetCode: text(row.asset_code) ?? '',
    name: nullableText(row.name),
    handover: { id: text(handover?.id) ?? '', handoverNo: nullableText(handover?.handover_no), status: text(handover?.status) ?? '' },
    contract: { id: contractId, code: text(contract?.code) ?? '', valueVnd: nullableText(contract?.value_vnd) },
    recipientUnit: { id: text(unit?.id) ?? '', name: text(unit?.name) ?? '' },
    valueVnd: nullableText(row.value_vnd),
    valueBasis: oneOf(VALUE_BASES, row.value_basis) ?? null,
    contractAssetsVnd: nullableText(row.contract_assets_vnd),
    status,
    registeredOn: nullableText(row.registered_on),
    transferredOn: nullableText(row.transferred_on),
    warrantyUntil: nullableText(row.warranty_until),
    externalAssetId: nullableText(row.external_asset_id),
    assetClassId: nullableText(row.asset_class_master_version_id),
    fundingOrigin: nullableText(row.funding_origin),
    canTransfer: asRecord(row.allowed)?.transfer === true,
    version,
  };
}

export function toAssetList(raw: unknown): AssetLine[] {
  const items = asRecord(raw)?.items;
  return Array.isArray(items) ? items.flatMap((item) => toAsset(item) ?? []) : [];
}

/** What is left of the value of a contract once its assets are registered, as whole VND text; undefined when the figures are not shown to the caller. */
export function remainingVnd(line: AssetLine): string | undefined {
  if (line.contract.valueVnd === null || line.contractAssetsVnd === null || !/^\d+$/.test(line.contract.valueVnd) || !/^\d+$/.test(line.contractAssetsVnd)) return undefined;
  const left = BigInt(line.contract.valueVnd) - BigInt(line.contractAssetsVnd);
  return (left < 0n ? 0n : left).toString();
}

// ---- who may do what ------------------------------------------------------------------------------------------------------------

/** Whether the caller may register an asset: the permission is held (or not yet known) and the session is not read-only. The server judges the scope again. */
export const canRegister = (permissions: readonly string[] | undefined, mode: 'FULL' | 'READ_ONLY' | undefined): boolean =>
  mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(MANAGE_PERMISSION));

// ---- forms ----------------------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'date' | 'uuid' | 'tooLong' | 'amount' | 'future';

const isDate = (value: string): boolean => DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

const wordsProblem = (value: string, required: boolean): FormProblem | undefined => {
  const trimmed = value.trim();
  if (trimmed === '') return required ? 'required' : undefined;
  return trimmed.length > MAX_TEXT ? 'tooLong' : undefined;
};

/** The Vietnam date of `now`: an asset is transferred on a day that is not in the future. */
export const vietnamToday = (now: Date = new Date()): string => new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

export interface RegisterForm {
  handoverId: string;
  assetCode: string;
  name: string;
  recipientUnitId: string;
  valueVnd: string;
  valueBasis: ValueBasis | '';
  fundingOrigin: string;
  warrantyUntil: string;
}

export const emptyRegister = (handoverId = ''): RegisterForm => ({ handoverId, assetCode: '', name: '', recipientUnitId: '', valueVnd: '', valueBasis: '', fundingOrigin: '', warrantyUntil: '' });

/** What is wrong with the registration before it is sent: the whole VND is digits, with no sign or decimal. */
export function validateRegister(form: RegisterForm): Partial<Record<keyof RegisterForm, FormProblem>> {
  const problems: Partial<Record<keyof RegisterForm, FormProblem>> = {};
  if (form.handoverId === '') problems.handoverId = 'required';
  const code = wordsProblem(form.assetCode, true);
  if (code !== undefined) problems.assetCode = code;
  const name = wordsProblem(form.name, true);
  if (name !== undefined) problems.name = name;
  if (form.recipientUnitId === '') problems.recipientUnitId = 'required';
  if (form.valueVnd.trim() === '') problems.valueVnd = 'required';
  else if (!AMOUNT.test(form.valueVnd.trim())) problems.valueVnd = 'amount';
  if (form.valueBasis === '') problems.valueBasis = 'required';
  const funding = wordsProblem(form.fundingOrigin, false);
  if (funding !== undefined) problems.fundingOrigin = funding;
  const warranty = form.warrantyUntil.trim();
  if (warranty !== '' && !isDate(warranty)) problems.warrantyUntil = 'date';
  return problems;
}

export interface RegisterBody {
  project_id: string;
  handover_id: string;
  asset_code: string;
  name: string;
  recipient_unit_id: string;
  value_vnd: string;
  value_basis: ValueBasis;
  funding_origin?: string;
  warranty_until?: string;
}

export function registerBody(form: RegisterForm, projectId: string): RegisterBody {
  const funding = form.fundingOrigin.trim();
  const warranty = form.warrantyUntil.trim();
  return {
    project_id: projectId,
    handover_id: form.handoverId,
    asset_code: form.assetCode.trim(),
    name: form.name.trim(),
    recipient_unit_id: form.recipientUnitId,
    value_vnd: form.valueVnd.trim(),
    value_basis: form.valueBasis === '' ? 'CONTRACT_VALUE' : form.valueBasis,
    ...(funding === '' ? {} : { funding_origin: funding }),
    ...(warranty === '' ? {} : { warranty_until: warranty }),
  };
}

export interface TransferForm {
  transferredOn: string;
  documentVersionId: string;
  externalAssetId: string;
}

export const emptyTransfer = (today: string): TransferForm => ({ transferredOn: today, documentVersionId: '', externalAssetId: '' });

export function validateTransfer(form: TransferForm, today: string): Partial<Record<keyof TransferForm, FormProblem>> {
  const problems: Partial<Record<keyof TransferForm, FormProblem>> = {};
  const day = form.transferredOn.trim();
  if (day === '') problems.transferredOn = 'required';
  else if (!isDate(day)) problems.transferredOn = 'date';
  else if (day > today) problems.transferredOn = 'future';
  const document = form.documentVersionId.trim();
  if (document === '') problems.documentVersionId = 'required';
  else if (!UUID.test(document)) problems.documentVersionId = 'uuid';
  const external = wordsProblem(form.externalAssetId, false);
  if (external !== undefined) problems.externalAssetId = external;
  return problems;
}

export interface TransferBody {
  transferred_on: string;
  commissioning_document_version_id: string;
  external_asset_id?: string;
}

export function transferBody(form: TransferForm): TransferBody {
  const external = form.externalAssetId.trim();
  return { transferred_on: form.transferredOn.trim(), commissioning_document_version_id: form.documentVersionId.trim().toLowerCase(), ...(external === '' ? {} : { external_asset_id: external }) };
}

// ---- refusals ---------------------------------------------------------------------------------------------------------------------

export type Problem =
  'handoverState' | 'valueExceeds' | 'duplicate' | 'assetState' | 'handoverNotAccepted' | 'notClean' | 'versionConflict' | 'validation' | 'notFound' | 'denied' | 'session' | 'general';

export interface ProblemView {
  problem: Problem;
  /** What the sentence adds to the code: what the assets would come to and what the contract is worth. */
  detail: { total: string; contract: string } | undefined;
}

export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { problem: 'general', detail: undefined };
  const none = (problem: Problem): ProblemView => ({ problem, detail: undefined });
  switch (error.code) {
    case 'HANDOVER_STATE_INVALID':
      return none('handoverState');
    case 'VALUE_EXCEEDS_CONTRACT': {
      const total = error.extensions.total_vnd;
      const contract = error.extensions.contract_value_vnd;
      return typeof total === 'string' && typeof contract === 'string' ? { problem: 'valueExceeds', detail: { total, contract } } : none('valueExceeds');
    }
    case 'ASSET_CODE_DUPLICATE':
      return none('duplicate');
    case 'ASSET_STATE_INVALID':
      return none('assetState');
    case 'HANDOVER_NOT_ACCEPTED':
      return none('handoverNotAccepted');
    case 'DOCUMENT_NOT_CLEAN':
      return none('notClean');
    case 'VERSION_CONFLICT':
      return none('versionConflict');
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return none('validation');
    case 'RESOURCE_NOT_FOUND':
      return none('notFound');
    case 'SCOPE_DENIED':
    case 'ENTITLEMENT_DENIED':
      return none('denied');
    case 'SESSION_EXPIRED':
      return none('session');
    default:
      return none('general');
  }
}
