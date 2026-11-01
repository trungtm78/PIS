import type { useTranslation } from '../../../i18n';
import type { Classification, CollectionStatus, ItemStatus, KnowledgeProblem } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function classificationLabel(t: Translate, classification: Classification): string {
  switch (classification) {
    case 'PUBLIC':
      return t('llm.knowledge.class.public');
    case 'INTERNAL':
      return t('llm.knowledge.class.internal');
    case 'CONFIDENTIAL':
      return t('llm.knowledge.class.confidential');
    case 'PERSONAL':
      return t('llm.knowledge.class.personal');
    case 'IMPORTANT_CORE':
      return t('llm.knowledge.class.core');
  }
}

export function collectionStatusLabel(t: Translate, status: CollectionStatus): string {
  switch (status) {
    case 'ACTIVE':
      return t('llm.knowledge.status.active');
    case 'REINDEXING':
      return t('llm.knowledge.status.reindexing');
    case 'RETIRED':
      return t('llm.knowledge.status.retired');
  }
}

export function itemStatusLabel(t: Translate, status: ItemStatus): string {
  switch (status) {
    case 'PENDING':
      return t('llm.knowledge.item.pending');
    case 'INDEXED':
      return t('llm.knowledge.item.indexed');
    case 'FAILED':
      return t('llm.knowledge.item.failed');
    case 'REMOVED':
      return t('llm.knowledge.item.removed');
  }
}

export function problemMessage(t: Translate, problem: KnowledgeProblem): string {
  switch (problem.reason) {
    case 'model':
      return t('llm.knowledge.problem.model');
    case 'classification':
      return t('llm.knowledge.problem.classification');
    case 'scan':
      return t('llm.knowledge.problem.scan');
    case 'infected':
      return t('llm.knowledge.problem.infected');
    case 'state':
      return t('llm.knowledge.problem.state');
    case 'duplicate':
      return t('llm.knowledge.problem.duplicate');
    case 'scope':
      return t('llm.knowledge.problem.scope');
    case 'notFound':
      return t('llm.knowledge.problem.notfound');
    case 'validation':
      return t('llm.knowledge.problem.validation', { field: problem.detail });
    case 'general':
      return t('llm.knowledge.problem.general');
  }
}
