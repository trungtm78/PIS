import type { useTranslation } from '../../../i18n';
import type { DraftProblem, OcrStatus, Problem, TextState } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function statusLabel(t: Translate, status: OcrStatus): string {
  switch (status) {
    case 'AUTO_ACCEPTED':
      return t('bid.ocr.status.autoAccepted');
    case 'NEEDS_REVIEW':
      return t('bid.ocr.status.needsReview');
    case 'CONFIRMED':
      return t('bid.ocr.status.confirmed');
    case 'CORRECTED':
      return t('bid.ocr.status.corrected');
  }
}

/** Why the text of a page is not shown: it was changed after it was read, or it is gone. */
export function textStateMessage(t: Translate, state: Exclude<TextState, 'READABLE'>): string {
  switch (state) {
    case 'DIGEST_MISMATCH':
      return t('bid.ocr.textState.digestMismatch');
    case 'MISSING':
      return t('bid.ocr.textState.missing');
  }
}

export function draftProblemMessage(t: Translate, problem: DraftProblem): string {
  switch (problem) {
    case 'required':
      return t('bid.ocr.problem.required');
    case 'unchanged':
      return t('bid.ocr.problem.unchanged');
    case 'tooLong':
      return t('bid.ocr.problem.tooLong');
    case 'noteTooLong':
      return t('bid.ocr.problem.noteTooLong');
  }
}

/** What a refusal of the server says. */
export function problemMessage(t: Translate, problem: Problem): string {
  switch (problem) {
    case 'state':
      return t('bid.ocr.error.state');
    case 'undeclared':
      return t('bid.ocr.error.undeclared');
    case 'file':
      return t('bid.ocr.error.file');
    case 'fileType':
      return t('bid.ocr.error.fileType');
    case 'tooLarge':
      return t('bid.ocr.error.tooLarge');
    case 'notClean':
      return t('bid.ocr.error.notClean');
    case 'scan':
      return t('bid.ocr.error.scan');
    case 'validation':
      return t('bid.ocr.error.validation');
    case 'notFound':
      return t('bid.ocr.error.notFound');
    case 'denied':
      return t('bid.ocr.error.denied');
    case 'session':
      return t('bid.ocr.error.session');
    case 'general':
      return t('bid.ocr.error.general');
  }
}
