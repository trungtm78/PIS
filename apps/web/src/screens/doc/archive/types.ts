/** The permissions of DOC-17 and DOC-18 (x-permission in openapi.json). */
export const READ_DOSSIER_PERMISSION = 'doc.dossier.read';
export const ARCHIVE_PERMISSION = 'doc.dossier.archive';
export const DISPOSE_PERMISSION = 'doc.dossier.dispose';
export const READ_RULE_PERMISSION = 'doc.retention.read';
export const MANAGE_RULE_PERMISSION = 'doc.retention.manage';
export const APPROVE_RULE_PERMISSION = 'doc.retention.approve';
export const CONFIRM_RULE_PERMISSION = 'doc.template.confirm_legal';

export const DOSSIER_STATUSES = ['OPEN', 'CLOSED', 'HANDED_OVER', 'ARCHIVED', 'DISPOSAL_PROPOSED', 'DISPOSED'] as const;
export type DossierStatus = (typeof DOSSIER_STATUSES)[number];

export const RETENTION_CLASSES = ['PERMANENT', 'Y70', 'Y20', 'Y10', 'Y5'] as const;
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

export const RULE_SETS = ['TT74_2025_BTC', 'TT10_2022_BNV', 'TENANT_CUSTOM'] as const;
export type RuleSet = (typeof RULE_SETS)[number];

export const START_BASES = ['FROM_CLOSED', 'FROM_SETTLEMENT', 'FROM_ISSUED'] as const;
export type StartBasis = (typeof START_BASES)[number];

export const RULE_STATUSES = ['DRAFT', 'PUBLISHED', 'SUPERSEDED'] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];

export const DISPOSAL_BLOCKERS = ['DOSSIER_NOT_CLOSED', 'RETENTION_PROVISIONAL', 'LEGAL_HOLD_ACTIVE', 'RETENTION_NOT_EXPIRED'] as const;
export type DisposalBlocker = (typeof DISPOSAL_BLOCKERS)[number];

export interface DisposalFacts {
  proposedBy: string;
  proposedAt: string;
  reason: string;
  fromStatus: DossierStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  councilDecisionDocumentId: string | null;
  comment: string | null;
}

/** One dossier as `listDossiers` returns it, with what the caller may do now (the server decides; the screen only offers it). */
export interface Dossier {
  id: string;
  dossierCode: string;
  year: number;
  title: string;
  unitName: string;
  categoryCode: string;
  status: DossierStatus;
  retentionClass: RetentionClass | null;
  provisional: boolean;
  retentionEndsOn: string | null;
  handoverDueOn: string | null;
  handedOverAt: string | null;
  archiveRef: string | null;
  disposal: DisposalFacts | null;
  /** A legal hold that is Active now contains the dossier, and what stops its disposal now, if anything (the hold indicator of the list). */
  holdActive: boolean;
  disposalBlocker: DisposalBlocker | null;
  itemCount: number;
  version: number;
  mayHandover: boolean;
  mayProposeDisposal: boolean;
  mayDecideDisposal: boolean;
}

export interface Member {
  id: string;
  name: string | null;
}

/** One retention rule as `listDocumentRetentionRules` returns it. */
export interface RetentionRule {
  id: string;
  ruleSet: RuleSet;
  categoryCode: string;
  classCode: RetentionClass;
  retentionYears: number | null;
  startBasis: StartBasis;
  handoverMonths: number;
  legalBasis: string;
  legalConfirmationRef: string | null;
  confirmationStatus: 'CONFIRMED' | 'PENDING_CONFIRMATION';
  precedence: number;
  effectiveFrom: string;
  /** Exclusive: the first day the rule no longer applies. */
  effectiveUntil: string | null;
  status: RuleStatus;
  createdBy: Member | null;
  approvedBy: Member | null;
  legalConfirmedBy: Member | null;
  version: number;
}

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const nullableCount = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => allowed.find((candidate) => candidate === value) ?? fallback;

function disposalOf(value: unknown): DisposalFacts | null {
  if (!isRecord(value)) return null;
  return {
    proposedBy: text(value.proposed_by),
    proposedAt: text(value.proposed_at),
    reason: text(value.reason),
    fromStatus: oneOf(value.from_status, DOSSIER_STATUSES, 'CLOSED'),
    decidedBy: nullableText(value.decided_by),
    decidedAt: nullableText(value.decided_at),
    councilDecisionDocumentId: nullableText(value.council_decision_document_id),
    comment: nullableText(value.comment),
  };
}

export function toDossier(raw: unknown): Dossier {
  const row: Raw = isRecord(raw) ? raw : {};
  const unit: Raw = isRecord(row.organization_unit) ? row.organization_unit : {};
  const retention: Raw = isRecord(row.retention) ? row.retention : {};
  const actions: Raw = isRecord(row.actions) ? row.actions : {};
  return {
    id: text(row.id),
    dossierCode: text(row.dossier_code),
    year: count(row.year),
    title: text(row.title),
    unitName: text(unit.name),
    categoryCode: text(row.category_code),
    status: oneOf(row.status, DOSSIER_STATUSES, 'OPEN'),
    retentionClass: RETENTION_CLASSES.find((candidate) => candidate === retention.class_code) ?? null,
    provisional: retention.provisional === true,
    retentionEndsOn: nullableText(retention.ends_on),
    handoverDueOn: nullableText(row.handover_due_on),
    handedOverAt: nullableText(row.handed_over_at),
    archiveRef: nullableText(row.archive_ref),
    disposal: disposalOf(row.disposal),
    holdActive: row.legal_hold_active === true,
    disposalBlocker: DISPOSAL_BLOCKERS.find((candidate) => candidate === row.disposal_blocker) ?? null,
    itemCount: count(row.item_count),
    version: count(row.version),
    mayHandover: actions.handover === true,
    mayProposeDisposal: actions.proposeDisposal === true,
    mayDecideDisposal: actions.decideDisposal === true,
  };
}

function memberOf(value: unknown): Member | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  return { id: value.id, name: nullableText(value.name) };
}

export function toRule(raw: unknown): RetentionRule {
  const row: Raw = isRecord(raw) ? raw : {};
  return {
    id: text(row.id),
    ruleSet: oneOf(row.rule_set, RULE_SETS, 'TENANT_CUSTOM'),
    categoryCode: text(row.category_code),
    classCode: oneOf(row.class_code, RETENTION_CLASSES, 'PERMANENT'),
    retentionYears: nullableCount(row.retention_years),
    startBasis: oneOf(row.start_basis, START_BASES, 'FROM_CLOSED'),
    handoverMonths: count(row.handover_months),
    legalBasis: text(row.legal_basis),
    legalConfirmationRef: nullableText(row.legal_confirmation_ref),
    confirmationStatus: row.confirmation_status === 'CONFIRMED' ? 'CONFIRMED' : 'PENDING_CONFIRMATION',
    precedence: count(row.precedence),
    effectiveFrom: text(row.effective_from),
    effectiveUntil: nullableText(row.effective_until),
    status: oneOf(row.status, RULE_STATUSES, 'DRAFT'),
    createdBy: memberOf(row.created_by),
    approvedBy: memberOf(row.approved_by),
    legalConfirmedBy: memberOf(row.legal_confirmed_by),
    version: count(row.version),
  };
}
