import type { Translator } from '../../i18n';
import type { Decision, Kind, PublicationReason, RequestProblem, Status, TileField } from './publication-model';

type T = Translator['t'];

export function kindLabel(t: T, kind: Kind): string {
  switch (kind) {
    case 'METRIC':
      return t('bi.pub.kind.metric');
    case 'DASHBOARD':
      return t('bi.pub.kind.dashboard');
    case 'ACCESS_POLICY':
      return t('bi.pub.kind.policy');
  }
}

export function statusLabel(t: T, status: Status): string {
  switch (status) {
    case 'PENDING':
      return t('bi.pub.status.pending');
    case 'DECIDED':
      return t('bi.pub.status.decided');
    case 'WITHDRAWN':
      return t('bi.pub.status.withdrawn');
  }
}

export const decisionLabel = (t: T, decision: Decision): string => (decision === 'APPROVED' ? t('bi.pub.decision.approved') : t('bi.pub.decision.rejected'));

/** The name of a check the server made; one this screen does not know is shown by its code. */
export function checkLabel(t: T, code: string): string {
  switch (code) {
    case 'FORMULA_COMPUTABLE':
      return t('bi.pub.check.formula');
    case 'FROZEN_VERSION_EXISTS':
      return t('bi.pub.check.frozen');
    case 'ROWS_MATCH_SNAPSHOT':
      return t('bi.pub.check.rows');
    case 'GROUPS_ADD_UP':
      return t('bi.pub.check.groups');
    case 'METRICS_CERTIFIED':
      return t('bi.pub.check.metrics');
    case 'DATASET_VERSIONS_FROZEN':
      return t('bi.pub.check.versions');
    case 'POLICY_IS_DRAFT':
      return t('bi.pub.check.policy');
    case 'DATASET_ACTIVE':
      return t('bi.pub.check.dataset');
    default:
      return code;
  }
}

export function refusalMessage(t: T, reason: PublicationReason, detail: string): string {
  switch (reason) {
    case 'self':
      return t('bi.pub.refusal.self');
    case 'reproduction':
      return t('bi.pub.refusal.reproduction', { check: checkLabel(t, detail) });
    case 'notCertified':
      return t('bi.pub.refusal.notCertified');
    case 'notFrozen':
      return t('bi.pub.refusal.notFrozen');
    case 'pending':
      return t('bi.pub.refusal.pending');
    case 'conflict':
      return t('bi.pub.refusal.conflict');
    case 'decided':
      return t('bi.pub.refusal.decided');
    case 'invalid':
      return t('bi.pub.refusal.invalid');
    case 'scope':
      return t('bi.pub.refusal.scope');
    case 'notFound':
      return t('bi.pub.refusal.notFound');
    case 'general':
      return t('bi.pub.refusal.general');
  }
}

export const requestProblemMessage = (t: T, problem: RequestProblem): string => (problem === 'required' ? t('bi.pub.request.object.required') : t('bi.pub.request.object.invalid'));

export function tileFieldLabel(t: T, field: TileField): string {
  switch (field) {
    case 'kind':
      return t('bi.cmp.field.kind');
    case 'title':
      return t('bi.cmp.field.title');
    case 'metric':
      return t('bi.cmp.field.metric');
    case 'dimension':
      return t('bi.cmp.field.dimension');
    case 'grid':
      return t('bi.cmp.field.grid');
  }
}

/** The name of a setting of a version in the comparison: a breakpoint or a filter is named by its key. */
export function settingLabel(t: T, key: string): string {
  if (key === 'columns') return t('bi.cmp.setting.columns');
  if (key === 'policy') return t('bi.cmp.setting.policy');
  if (key === 'pinned') return t('bi.cmp.setting.pinned');
  if (key.startsWith('breakpoint:'))
    return t('bi.cmp.setting.breakpoint', {
      key: key.slice('breakpoint:'.length),
    });
  return t('bi.cmp.setting.filter', { key: key.slice('filter:'.length) });
}
