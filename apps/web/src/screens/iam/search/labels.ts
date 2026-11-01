import type { Translator } from '../../../i18n';
import type { Classification } from './model';

/** The name of a kind of record the search knows how to open; any other kind is shown by its own identifier. */
export function typeLabel(t: Translator['t'], type: string): string {
  switch (type) {
    case 'project':
      return t('iam.search.type.project');
    case 'issue':
      return t('iam.search.type.issue');
    case 'conversation':
      return t('iam.search.type.conversation');
    default:
      return type;
  }
}

export function classificationLabel(t: Translator['t'], classification: Classification): string {
  switch (classification) {
    case 'PUBLIC':
      return t('iam.search.class.public');
    case 'INTERNAL':
      return t('iam.search.class.internal');
    case 'CONFIDENTIAL':
      return t('iam.search.class.confidential');
    case 'PERSONAL':
      return t('iam.search.class.personal');
  }
}
