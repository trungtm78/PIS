import type { Translator } from '../../../i18n';
import type { ApprovalDecision, ChangeKind, Compatibility, ConsumerKind, ContractReason, RevisionStatus } from './model';

type T = Translator['t'];

export function compatibilityLabel(t: T, compatibility: Compatibility | null): string {
  switch (compatibility) {
    case 'INITIAL':
      return t('dgv.contract.compat.initial');
    case 'BACKWARD_COMPATIBLE':
      return t('dgv.contract.compat.backward');
    case 'BREAKING':
      return t('dgv.contract.compat.breaking');
    case null:
      return t('dgv.contract.none');
  }
}

export function statusLabel(t: T, status: RevisionStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('dgv.contract.status.draft');
    case 'IN_REVIEW':
      return t('dgv.contract.status.inReview');
    case 'PUBLISHED':
      return t('dgv.contract.status.published');
    case 'SUPERSEDED':
      return t('dgv.contract.status.superseded');
    case 'REJECTED':
      return t('dgv.contract.status.rejected');
    case 'RETURNED':
      return t('dgv.contract.status.returned');
  }
}

export function kindLabel(t: T, kind: ConsumerKind): string {
  switch (kind) {
    case 'MODULE':
      return t('dgv.contract.kind.module');
    case 'BI_DATASET':
      return t('dgv.contract.kind.bi');
    case 'EXPORT':
      return t('dgv.contract.kind.export');
    case 'EXTERNAL':
      return t('dgv.contract.kind.external');
  }
}

export function decisionLabel(t: T, decision: ApprovalDecision): string {
  switch (decision) {
    case 'PENDING':
      return t('dgv.contract.decision.pending');
    case 'APPROVED':
      return t('dgv.contract.decision.approved');
    case 'REJECTED':
      return t('dgv.contract.decision.rejected');
  }
}

export function changeLabel(t: T, kind: ChangeKind, column: string): string {
  switch (kind) {
    case 'COLUMN_REMOVED':
      return t('dgv.contract.change.removed', { column });
    case 'COLUMN_ADDED_REQUIRED':
      return t('dgv.contract.change.added.required', { column });
    case 'COLUMN_ADDED_OPTIONAL':
      return t('dgv.contract.change.added.optional', { column });
    case 'TYPE_CHANGED':
      return t('dgv.contract.change.type', { column });
    case 'MADE_REQUIRED':
      return t('dgv.contract.change.required', { column });
    case 'MADE_OPTIONAL':
      return t('dgv.contract.change.optional', { column });
    case 'GRAIN_CHANGED':
      return t('dgv.contract.change.grain', { column });
    case 'UNIT_CHANGED':
      return t('dgv.contract.change.unit', { column });
    case 'CLASSIFICATION_RAISED':
      return t('dgv.contract.change.class.up', { column });
    case 'CLASSIFICATION_LOWERED':
      return t('dgv.contract.change.class.down', { column });
  }
}

export function problemMessage(t: T, reason: ContractReason, detail: string): string {
  switch (reason) {
    case 'schema':
      return t('dgv.contract.problem.schema', { path: detail });
    case 'open':
      return t('dgv.contract.problem.open');
    case 'pending':
      return t('dgv.contract.problem.pending');
    case 'window':
      return t('dgv.contract.problem.window');
    case 'self':
      return t('dgv.contract.problem.self');
    case 'notOwner':
      return t('dgv.contract.problem.notOwner');
    case 'stale':
      return t('dgv.contract.problem.stale');
    case 'state':
      return t('dgv.contract.problem.state');
    case 'notFound':
      return t('dgv.contract.problem.notFound');
    case 'scope':
      return t('dgv.contract.problem.scope');
    case 'validation':
      return t('dgv.contract.problem.validation', { field: detail });
    case 'general':
      return t('dgv.contract.problem.general');
  }
}
