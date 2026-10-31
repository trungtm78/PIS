import type { Translator } from '../../i18n';
import type { Audience, CreateProblem, DashboardReason, DashboardStatus, DatasetPolicy, VersionProblem, VersionState, WidgetKind } from './dashboard-model';

type T = Translator['t'];

export function kindLabel(t: T, kind: WidgetKind): string {
  switch (kind) {
    case 'KPI':
      return t('bi.dash.kind.kpi');
    case 'BAR':
      return t('bi.dash.kind.bar');
    case 'LINE':
      return t('bi.dash.kind.line');
    case 'AREA':
      return t('bi.dash.kind.area');
    case 'PIE':
      return t('bi.dash.kind.pie');
    case 'TABLE':
      return t('bi.dash.kind.table');
  }
}

export function dashboardStatusLabel(t: T, status: DashboardStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('bi.dash.status.draft');
    case 'PUBLISHED':
      return t('bi.dash.status.published');
    case 'ARCHIVED':
      return t('bi.dash.status.archived');
  }
}

export function audienceLabel(t: T, audience: Audience): string {
  switch (audience) {
    case 'PRIVATE':
      return t('bi.dash.audience.private');
    case 'SHARED':
      return t('bi.dash.audience.shared');
    case 'TENANT_LIBRARY':
      return t('bi.dash.audience.library');
  }
}

export function versionStateLabel(t: T, state: VersionState): string {
  switch (state) {
    case 'DRAFT':
      return t('bi.dash.version.draft');
    case 'PUBLISHED':
      return t('bi.dash.version.published');
    case 'SUPERSEDED':
      return t('bi.dash.version.superseded');
  }
}

export function policyLabel(t: T, policy: DatasetPolicy): string {
  return policy === 'PINNED' ? t('bi.dash.policy.pinned') : t('bi.dash.policy.latest');
}

export function createProblemMessage(t: T, problem: CreateProblem): string {
  switch (problem) {
    case 'codeRequired':
      return t('bi.dash.create.code.required');
    case 'codeInvalid':
      return t('bi.dash.create.code.invalid');
    case 'titleRequired':
      return t('bi.dash.create.title.required');
    case 'titleLong':
      return t('bi.dash.create.title.long');
  }
}

export function versionProblemMessage(t: T, problem: VersionProblem): string {
  switch (problem) {
    case 'widgetId':
      return t('bi.dash.problem.widgetId');
    case 'widgetIdTaken':
      return t('bi.dash.problem.widgetIdTaken');
    case 'metric':
      return t('bi.dash.problem.metric');
    case 'dimension':
      return t('bi.dash.problem.dimension');
    case 'grid':
      return t('bi.dash.problem.grid');
    case 'overlap':
      return t('bi.dash.problem.overlap');
    case 'tooMany':
      return t('bi.dash.problem.tooMany');
    case 'breakpoint':
      return t('bi.dash.problem.breakpoint');
    case 'filter':
      return t('bi.dash.problem.filter');
    case 'filterTaken':
      return t('bi.dash.problem.filterTaken');
    case 'pinned':
      return t('bi.dash.problem.pinned');
    case 'title':
      return t('bi.dash.problem.title');
  }
}

export function refusalMessage(t: T, reason: DashboardReason): string {
  switch (reason) {
    case 'notCertified':
      return t('bi.dash.refusal.notCertified');
    case 'notFrozen':
      return t('bi.dash.refusal.notFrozen');
    case 'duplicate':
      return t('bi.dash.refusal.duplicate');
    case 'invalid':
      return t('bi.dash.refusal.invalid');
    case 'conflict':
      return t('bi.dash.refusal.conflict');
    case 'archived':
      return t('bi.dash.refusal.archived');
    case 'scope':
      return t('bi.dash.refusal.scope');
    case 'notFound':
      return t('bi.dash.refusal.notFound');
    case 'general':
      return t('bi.dash.refusal.general');
  }
}

export function sideLabel(t: T, side: 'x' | 'y' | 'w' | 'h'): string {
  switch (side) {
    case 'x':
      return t('bi.dash.side.x');
    case 'y':
      return t('bi.dash.side.y');
    case 'w':
      return t('bi.dash.side.w');
    case 'h':
      return t('bi.dash.side.h');
  }
}
