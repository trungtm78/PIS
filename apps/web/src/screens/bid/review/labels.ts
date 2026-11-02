import type { useTranslation } from '../../../i18n';
import type { DraftProblem, ReviewDecision, ReviewProblem } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

/** What an expert did with what the model said. */
export function decisionLabel(t: Translate, decision: ReviewDecision): string {
  switch (decision) {
    case 'ACCEPTED':
      return t('bid.review.decision.accepted');
    case 'ACCEPTED_WITH_CHANGE':
      return t('bid.review.decision.acceptedWithChange');
    case 'REJECTED':
      return t('bid.review.decision.rejected');
  }
}

export function draftProblemMessage(t: Translate, problem: DraftProblem): string {
  switch (problem) {
    case 'reasonTooShort':
      return t('bid.review.reasonProblem.tooShort');
    case 'reasonTooLong':
      return t('bid.review.reasonProblem.tooLong');
    case 'scoreInvalid':
      return t('bid.review.scoreProblem.invalid');
  }
}

/** What a refusal of the server says. */
export function problemMessage(t: Translate, problem: ReviewProblem): string {
  switch (problem) {
    case 'reasonRequired':
      return t('bid.review.error.reasonRequired');
    case 'runNotCompleted':
      return t('bid.review.error.runNotCompleted');
    case 'undeclared':
      return t('bid.review.error.undeclared');
    case 'conflict':
      return t('bid.review.error.conflict');
    case 'validation':
      return t('bid.review.error.validation');
    case 'notFound':
      return t('bid.review.error.notFound');
    case 'denied':
      return t('bid.review.error.denied');
    case 'session':
      return t('bid.review.error.session');
    case 'general':
      return t('bid.review.error.general');
  }
}
