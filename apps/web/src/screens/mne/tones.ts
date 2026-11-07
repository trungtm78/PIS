import type { Tone } from '../../ui';
import type { FormStatus, ReportStatus } from './types';

/** The tone of the pill of a report state: the state is always written, the tone is only the second cue. */
const TONES: Readonly<Record<ReportStatus, Tone>> = {
  DRAFT: 'neutral',
  IN_REVIEW: 'info',
  APPROVED: 'success',
  ISSUING: 'info',
  ISSUED: 'success',
  EXPORTED: 'success',
  SUBMITTED_EXTERNAL: 'success',
  RETURNED: 'warning',
  SUPERSEDED: 'neutral',
};

export const reportStatusTone = (status: ReportStatus): Tone => TONES[status];

/** The lifecycle of a form revision: a published revision is in force, a retired one is over, a draft is not yet anything. */
const FORM_TONES: Readonly<Record<FormStatus, Tone>> = { DRAFT: 'neutral', PUBLISHED: 'success', RETIRED: 'neutral' };

export const formStatusTone = (status: FormStatus): Tone => FORM_TONES[status];
