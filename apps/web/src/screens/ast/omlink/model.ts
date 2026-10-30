import { ApiError } from '@machvon/api-client';

/** The permissions of AST-06 (x-permission of the operations in openapi.json); the server judges each command again, with the scope of the contract and of the receiving unit. */
export const READ_PERMISSION = 'asset_record.read';
export const MANAGE_PERMISSION = 'asset.manage';

export const MAX_CYCLE_MONTHS = 120;
const MAX_TEXT = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

export interface OmLink {
  operatorUnit: string;
  omPlanDocumentVersionId: string | undefined;
  omContractId: string | undefined;
  maintenanceCycleMonths: number | undefined;
  nextMaintenanceDue: string | undefined;
  externalSystemRef: string | undefined;
}

/** The asset as AST-06 shows it: what it is, whether it was handed to the unit that operates it, its link, and whether the caller may make one. */
export interface OmAsset {
  id: string;
  assetCode: string;
  name: string | undefined;
  status: string;
  contractCode: string;
  recipientUnit: string;
  externalAssetId: string | undefined;
  omLink: OmLink | undefined;
  canLink: boolean;
}

export function toOmAsset(raw: unknown): OmAsset | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const status = text(row?.status);
  if (row === undefined || id === undefined || status === undefined) return undefined;
  const link = asRecord(row.om_link);
  return {
    id,
    assetCode: text(row.asset_code) ?? '',
    name: text(row.name),
    status,
    contractCode: text(asRecord(row.contract)?.code) ?? '',
    recipientUnit: text(asRecord(row.recipient_unit)?.name) ?? '',
    externalAssetId: text(row.external_asset_id),
    omLink:
      link === undefined
        ? undefined
        : {
            operatorUnit: text(asRecord(link.operator_unit)?.name) ?? '',
            omPlanDocumentVersionId: text(link.om_plan_document_version_id),
            omContractId: text(link.om_contract_id),
            maintenanceCycleMonths: typeof link.maintenance_cycle_months === 'number' ? link.maintenance_cycle_months : undefined,
            nextMaintenanceDue: text(link.next_maintenance_due),
            externalSystemRef: text(link.external_system_ref),
          },
    canLink: asRecord(row.allowed)?.link_om === true,
  };
}

/** Whether the asset was handed to the unit that operates it: only such an asset takes a link. */
export const isOperated = (asset: Pick<OmAsset, 'status'>): boolean => asset.status === 'TRANSFERRED' || asset.status === 'IN_OPERATION';

// ---- the form -------------------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'uuid' | 'cycle' | 'date' | 'tooLong';

export interface LinkForm {
  operatorUnitId: string;
  documentVersionId: string;
  omContractId: string;
  cycle: string;
  nextDue: string;
  externalRef: string;
}

export const emptyLink = (): LinkForm => ({ operatorUnitId: '', documentVersionId: '', omContractId: '', cycle: '', nextDue: '', externalRef: '' });

const isDate = (value: string): boolean => DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export function validateLink(form: LinkForm): Partial<Record<keyof LinkForm, FormProblem>> {
  const problems: Partial<Record<keyof LinkForm, FormProblem>> = {};
  if (form.operatorUnitId === '') problems.operatorUnitId = 'required';
  if (form.documentVersionId.trim() !== '' && !UUID.test(form.documentVersionId.trim())) problems.documentVersionId = 'uuid';
  if (form.omContractId.trim() !== '' && !UUID.test(form.omContractId.trim())) problems.omContractId = 'uuid';
  const cycle = form.cycle.trim();
  if (cycle !== '' && (!/^\d{1,3}$/.test(cycle) || Number(cycle) < 1 || Number(cycle) > MAX_CYCLE_MONTHS)) problems.cycle = 'cycle';
  if (form.nextDue.trim() !== '' && !isDate(form.nextDue.trim())) problems.nextDue = 'date';
  if (form.externalRef.trim().length > MAX_TEXT) problems.externalRef = 'tooLong';
  return problems;
}

export interface LinkBody {
  operator_unit_id: string;
  om_plan_document_version_id?: string;
  om_contract_id?: string;
  maintenance_cycle_months?: number;
  next_maintenance_due?: string;
  external_system_ref?: string;
}

export function linkBody(form: LinkForm): LinkBody {
  const document = form.documentVersionId.trim();
  const contract = form.omContractId.trim();
  const cycle = form.cycle.trim();
  const due = form.nextDue.trim();
  const reference = form.externalRef.trim();
  return {
    operator_unit_id: form.operatorUnitId,
    ...(document === '' ? {} : { om_plan_document_version_id: document.toLowerCase() }),
    ...(contract === '' ? {} : { om_contract_id: contract.toLowerCase() }),
    ...(cycle === '' ? {} : { maintenance_cycle_months: Number(cycle) }),
    ...(due === '' ? {} : { next_maintenance_due: due }),
    ...(reference === '' ? {} : { external_system_ref: reference }),
  };
}

// ---- refusals -------------------------------------------------------------------------------------------------------------------

export type Problem = 'notTransferred' | 'linked' | 'notClean' | 'validation' | 'notFound' | 'denied' | 'session' | 'general';

export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'ASSET_NOT_TRANSFERRED':
      return 'notTransferred';
    case 'OM_LINK_EXISTS':
      return 'linked';
    case 'DOCUMENT_NOT_CLEAN':
      return 'notClean';
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return 'validation';
    case 'RESOURCE_NOT_FOUND':
      return 'notFound';
    case 'SCOPE_DENIED':
    case 'ENTITLEMENT_DENIED':
      return 'denied';
    case 'SESSION_EXPIRED':
      return 'session';
    default:
      return 'general';
  }
}
