import { ApiError } from '@machvon/api-client';
import { businessToday } from '../../adm/org-tree/business-date';
import type { QualityBadge } from '../model';

export const CERTIFY_PERMISSION = 'data.product.certify';
export const READ_PERMISSION = 'data.catalog.read';

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0);

export type ProductStatus = 'NOT_ASSESSED' | 'PROVISIONAL' | 'CERTIFIED' | 'REVOKED';
export type Decision = 'CERTIFIED' | 'PROVISIONAL' | 'REVOKED';
const STATUSES: readonly ProductStatus[] = ['NOT_ASSESSED', 'PROVISIONAL', 'CERTIFIED', 'REVOKED'];

const BADGES: readonly QualityBadge[] = ['NOT_ASSESSED', 'PASSED', 'WARNING', 'FAILED', 'STALE'];
/** The badge a dataset carries; anything the server might add later reads as not assessed rather than as a pass. */
export const badgeOf = (value: string): QualityBadge => BADGES.find((badge) => badge === value) ?? 'NOT_ASSESSED';

export interface ProductDatasetView {
  id: string;
  datasetCode: string;
  title: string;
  contractPublished: boolean;
  qualityBadge: string;
}

export interface ProductView {
  id: string;
  code: string;
  title: string;
  owner: string;
  datasets: ProductDatasetView[];
  hidden: number;
  status: ProductStatus;
  certifiedBy: string | null;
  expiresOn: string | null;
  evidenceCount: number;
  revokeReason: string | null;
  version: number;
}

function toDataset(raw: unknown): ProductDatasetView[] {
  const row = asRecord(raw);
  const id = text(row?.id);
  const datasetCode = text(row?.dataset_code);
  if (row === undefined || id === undefined || datasetCode === undefined) return [];
  return [{ id, datasetCode, title: text(row.title) ?? '', contractPublished: row.contract_published === true, qualityBadge: text(row.quality_badge) ?? 'NOT_ASSESSED' }];
}

function toProduct(raw: unknown): ProductView[] {
  const row = asRecord(raw);
  const id = text(row?.id);
  const code = text(row?.code);
  const status = STATUSES.find((known) => known === row?.certification_status);
  if (row === undefined || id === undefined || code === undefined || status === undefined || typeof row.version !== 'number') return [];
  const owner = asRecord(row.owner);
  const certifier = asRecord(row.certified_by);
  return [
    {
      id,
      code,
      title: text(row.title) ?? code,
      owner: text(owner?.display_name) ?? text(owner?.membership_id) ?? '',
      datasets: (Array.isArray(row.datasets) ? row.datasets : []).flatMap(toDataset),
      hidden: whole(row.datasets_hidden),
      status,
      certifiedBy: certifier === undefined ? null : (text(certifier.display_name) ?? text(certifier.membership_id) ?? null),
      expiresOn: nullableText(row.certification_expires_on),
      evidenceCount: whole(row.evidence_count),
      revokeReason: nullableText(row.revoke_reason),
      version: row.version,
    },
  ];
}

export function toProducts(raw: unknown): ProductView[] {
  const page = asRecord(raw);
  return (Array.isArray(page?.items) ? page.items : []).flatMap(toProduct);
}

/** The decisions that may follow the status: a product is certified or kept provisional, a certification is renewed or withdrawn, a withdrawn one is final. */
export function decisionsAfter(status: ProductStatus): readonly Decision[] {
  switch (status) {
    case 'NOT_ASSESSED':
      return ['PROVISIONAL', 'CERTIFIED'];
    case 'PROVISIONAL':
      return ['CERTIFIED'];
    case 'CERTIFIED':
      return ['CERTIFIED', 'REVOKED'];
    case 'REVOKED':
      return [];
  }
}

/** A certification whose last day has gone and which the job has not yet turned back into a provisional one: shown as run out. */
export const hasRunOut = (product: ProductView, today: string = businessToday()): boolean => product.status === 'CERTIFIED' && product.expiresOn !== null && product.expiresOn < today;

export type Readiness = 'ready' | 'blocked' | 'unknown';

/** Whether every dataset of the product is on a published contract (`contract`) and its latest run passed (`quality`); a dataset the caller cannot see leaves the answer unknown unless one that is seen already blocks it. */
export function readinessOf(product: ProductView): { contract: Readiness; quality: Readiness } {
  const judge = (ok: (dataset: ProductDatasetView) => boolean): Readiness => (product.datasets.some((dataset) => !ok(dataset)) ? 'blocked' : product.hidden > 0 ? 'unknown' : 'ready');
  return { contract: judge((dataset) => dataset.contractPublished), quality: judge((dataset) => dataset.qualityBadge === 'PASSED') };
}

type Mode = 'FULL' | 'READ_ONLY' | undefined;
export const holds = (permissions: readonly string[] | undefined, permission: string, mode: Mode): boolean => (permissions === undefined || permissions.includes(permission)) && mode !== 'READ_ONLY';

// ---- the form ----------------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'invalid';
export type DecisionField = 'reason' | 'evidence' | 'expiresOn';

export interface DecisionForm {
  reason: string;
  /** One piece of evidence a line: a reference to a run, a document or a record. */
  evidence: string;
  expiresOn: string;
}

export const EMPTY_DECISION: DecisionForm = { reason: '', evidence: '', expiresOn: '' };

export const MAX_EVIDENCE_LINES = 500;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const evidenceLines = (form: DecisionForm): string[] =>
  form.evidence
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

export function validateDecision(decision: Decision, form: DecisionForm, today: string = businessToday()): Partial<Record<DecisionField, FormProblem>> {
  const found: Partial<Record<DecisionField, FormProblem>> = {};
  const reason = form.reason.trim();
  if (reason === '') found.reason = 'required';
  else if (reason.length < 10 || reason.length > 2000) found.reason = 'invalid';
  if (decision === 'CERTIFIED') {
    const lines = evidenceLines(form);
    if (lines.length === 0) found.evidence = 'required';
    else if (lines.length > MAX_EVIDENCE_LINES || lines.some((line) => line.length > 1000)) found.evidence = 'invalid';
    const day = form.expiresOn.trim();
    if (day === '') found.expiresOn = 'required';
    else if (!DAY.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day || day <= today) found.expiresOn = 'invalid';
  } else if (decision === 'PROVISIONAL' && evidenceLines(form).length > MAX_EVIDENCE_LINES) {
    found.evidence = 'invalid';
  }
  return found;
}

export function decisionBody(decision: Decision, form: DecisionForm): Record<string, unknown> {
  const lines = decision === 'REVOKED' ? [] : evidenceLines(form);
  return {
    decision,
    reason: form.reason.trim(),
    evidence_refs: lines.map((line) => ({ description: line })),
    ...(decision === 'CERTIFIED' ? { certification_expires_on: form.expiresOn.trim() } : {}),
  };
}

// ---- what the server refuses ---------------------------------------------------------------------------------------------------

export type DecisionProblem = 'selfApproval' | 'qualityNotPassed' | 'contractNotPublished' | 'stale' | 'stateInvalid' | 'scopeDenied' | 'notFound' | 'validation' | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, DecisionProblem>> = {
  SELF_APPROVAL_DENIED: 'selfApproval',
  QUALITY_NOT_PASSED: 'qualityNotPassed',
  CONTRACT_NOT_PUBLISHED: 'contractNotPublished',
  VERSION_CONFLICT: 'stale',
  PRODUCT_STATE_INVALID: 'stateInvalid',
  SCOPE_DENIED: 'scopeDenied',
  RESOURCE_NOT_FOUND: 'notFound',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
};

export const describeDecision = (error: unknown): DecisionProblem => (error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general');
