import type { AssetLine } from '../../ast/asset/model';
import type { HandoverLine } from '../../ast/handover/model';
import type { WarrantyLine } from '../../ast/warranty/model';
import type { NcrLine } from '../../qms/nonconformance/model';
import type { Settlement } from '../../pay/settlement/model';
import { isUuid } from '../change/model';
import type { ContractLine } from '../model';

/** The six read-only views of a contract over the data of QMS, AST and PAY (ST-CTR-017). Each is opened for one contract, named by `id` as the workspace of the contract is. */
export const DIARY_PATH = '/ctr/ctr-09';
export const QUALITY_PATH = '/ctr/ctr-11';
export const HANDOVER_PATH = '/ctr/ctr-15';
export const WARRANTY_PATH = '/ctr/ctr-16';
export const SETTLEMENT_PATH = '/ctr/ctr-17';
export const ASSET_PATH = '/ctr/ctr-18';

/** The contract a view is opened for; an address that names none, or names something that is not an identifier, names no contract. */
export const contractIdOf = (value: string | null): string | null => (value !== null && isUuid(value) ? value.trim() : null);

const linkTo = (path: string, params: Record<string, string>): string => `${path}?${new URLSearchParams(params).toString()}`;

/** The address of one of the six views for a contract. */
export const viewLink = (path: string, contractId: string): string => linkTo(path, { id: contractId });

/** Where the owner of the data shows it: the screens of QMS, AST and PAY, which are the only ones that change it. */
export const ownerLink = {
  coverage: (contractId: string): string => linkTo('/qms/qms-11', { contract: contractId }),
  nonconformances: (contractId: string): string => linkTo('/qms/qms-07', { contract: contractId }),
  inspections: (contractId: string): string => linkTo('/qms/qms-04', { contract: contractId }),
  handovers: (): string => '/ast/ast-01',
  handover: (id: string): string => linkTo('/ast/ast-02', { id }),
  warranties: (handoverId?: string): string => (handoverId === undefined ? '/ast/ast-04' : linkTo('/ast/ast-04', { handover: handoverId })),
  assets: (handoverId?: string): string => (handoverId === undefined ? '/ast/ast-03' : linkTo('/ast/ast-03', { handover: handoverId })),
};

/**
 * Whether the reader sees the money of the contract. The register leaves the internal fields (the estimate ceiling) out of the answer for a guest contractor, so a contract read
 * without one is read by a guest; such a reader sees none of the financial columns of the six views, whatever the owner module answers.
 */
export const seesFinancials = (contract: Pick<ContractLine, 'estimateCeilingVnd'>): boolean => contract.estimateCeilingVnd !== undefined;

/** The non-conformances that stand in the way of the acceptance of the work: the server flags them (a critical one that is not closed). */
export const blockingNcrs = (lines: readonly NcrLine[]): NcrLine[] => lines.filter((line) => line.blocksAcceptance);

/** The handovers of a contract that were accepted: the completion of the contract stands on one. */
export const acceptedHandovers = (lines: readonly HandoverLine[]): HandoverLine[] => lines.filter((line) => line.status === 'ACCEPTED');

/** The warranty obligations that are in force today. */
export const runningWarranties = (lines: readonly WarrantyLine[]): WarrantyLine[] => lines.filter((line) => line.status === 'ACTIVE');

/** The settlements that concern the contract: its own, and those of the whole project it belongs to. The read is narrowed by project, so the rest is the other contracts' own. */
export const settlementsOf = (lines: readonly Settlement[], contract: { id: string; projectId: string }): Settlement[] =>
  lines.filter((line) => line.projectId === contract.projectId && (line.contractId === contract.id || line.contractId === null));

const AMOUNT = /^(0|[1-9]\d{0,23})$/;

/** What the assets of the contract come to; an asset the reader may not value counts for nothing. */
export const assetsTotal = (lines: readonly AssetLine[]): bigint => lines.reduce((sum, line) => (line.valueVnd !== null && AMOUNT.test(line.valueVnd) ? sum + BigInt(line.valueVnd) : sum), 0n);

/** BR-CTR-18: the value of the assets does not exceed the value of the contract. */
export const withinContractValue = (total: bigint, contractValueVnd: string): boolean => !AMOUNT.test(contractValueVnd) || total <= BigInt(contractValueVnd);
