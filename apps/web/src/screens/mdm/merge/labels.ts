import type { Translator } from '../../../i18n';
import type { DecisionBy, MergeProblem, MergeStatus, RuleStatus, Side, Strategy } from './model';

type T = Translator['t'];

export function strategyLabel(t: T, strategy: Strategy): string {
  switch (strategy) {
    case 'SOURCE_PRIORITY':
      return t('mdm.merge.strategy.sourcePriority');
    case 'MOST_RECENT':
      return t('mdm.merge.strategy.mostRecent');
    case 'MOST_COMPLETE':
      return t('mdm.merge.strategy.mostComplete');
    case 'STEWARD_DECISION':
      return t('mdm.merge.strategy.steward');
  }
}

export function ruleStatusLabel(t: T, status: RuleStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('mdm.merge.rule.status.draft');
    case 'PUBLISHED':
      return t('mdm.merge.rule.status.published');
    case 'RETIRED':
      return t('mdm.merge.rule.status.retired');
  }
}

export function mergeStatusLabel(t: T, status: MergeStatus): string {
  return status === 'APPLIED' ? t('mdm.merge.status.applied') : t('mdm.merge.status.reverted');
}

export function sideLabel(t: T, side: Side): string {
  return side === 'SURVIVOR' ? t('mdm.merge.side.survivor') : t('mdm.merge.side.merged');
}

export function byLabel(t: T, by: DecisionBy): string {
  switch (by) {
    case 'ONLY_ONE':
      return t('mdm.merge.by.onlyOne');
    case 'EQUAL':
      return t('mdm.merge.by.equal');
    case 'RULE':
      return t('mdm.merge.by.rule');
    case 'OVERRIDE':
      return t('mdm.merge.by.override');
  }
}

export function problemMessage(t: T, problem: MergeProblem): string {
  switch (problem.reason) {
    case 'conflict':
      return t('mdm.merge.problem.conflict', { attributes: problem.attributes.join(', ') });
    case 'unmergeConflict':
      return t('mdm.merge.problem.unmergeConflict', { attributes: problem.attributes.join(', ') });
    case 'alreadyReverted':
      return t('mdm.merge.problem.alreadyReverted');
    case 'locked':
      return t('mdm.merge.problem.locked');
    case 'self':
      return t('mdm.merge.problem.self');
    case 'scope':
      return t('mdm.merge.problem.scope');
    case 'stale':
      return t('mdm.merge.problem.stale');
    case 'state':
      return t('mdm.merge.problem.state');
    case 'notFound':
      return t('mdm.merge.problem.notFound');
    case 'validation':
      return t('mdm.merge.problem.validation', { field: problem.detail });
    case 'general':
      return t('mdm.merge.problem.general');
  }
}
