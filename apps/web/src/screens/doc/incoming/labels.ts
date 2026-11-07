import type { useTranslation } from '../../../i18n';
import type { Tone } from '../../../ui';
import type { Channel, FormProblem, IncomingStatus, Problem, Urgency } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function statusLabel(t: Translate, status: IncomingStatus): string {
  switch (status) {
    case 'RECEIVED':
      return t('doc.incoming.status.received');
    case 'REGISTERED':
      return t('doc.incoming.status.registered');
    case 'ASSIGNED':
      return t('doc.incoming.status.assigned');
    case 'PROCESSING':
      return t('doc.incoming.status.processing');
    case 'RESOLVED':
      return t('doc.incoming.status.resolved');
    case 'FILED':
      return t('doc.incoming.status.filed');
    case 'REJECTED':
      return t('doc.incoming.status.rejected');
  }
}

/** The tone of the pill of a state of a letter: received and registered are plain, in work is blue, done is green, refused is red. */
export function statusTone(status: IncomingStatus): Tone {
  switch (status) {
    case 'RECEIVED':
    case 'REGISTERED':
    case 'FILED':
      return 'neutral';
    case 'ASSIGNED':
    case 'PROCESSING':
      return 'info';
    case 'RESOLVED':
      return 'success';
    case 'REJECTED':
      return 'danger';
  }
}

export function channelLabel(t: Translate, channel: Channel): string {
  switch (channel) {
    case 'PAPER_SCAN':
      return t('doc.incoming.channel.paperScan');
    case 'EMAIL':
      return t('doc.incoming.channel.email');
    case 'LGSP':
      return t('doc.incoming.channel.lgsp');
    case 'PORTAL':
      return t('doc.incoming.channel.portal');
    case 'UPLOAD':
      return t('doc.incoming.channel.upload');
  }
}

export function urgencyLabel(t: Translate, urgency: Urgency): string {
  switch (urgency) {
    case 'NORMAL':
      return t('doc.incoming.urgency.normal');
    case 'KHAN':
      return t('doc.incoming.urgency.khan');
    case 'THUONG_KHAN':
      return t('doc.incoming.urgency.thuongKhan');
    case 'HOA_TOC':
      return t('doc.incoming.urgency.hoaToc');
  }
}

export function formProblemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('doc.incoming.problem.required');
    case 'tooShort':
      return t('doc.incoming.problem.tooShort');
    case 'tooLong':
      return t('doc.incoming.problem.tooLong');
    case 'invalidDate':
      return t('doc.incoming.problem.invalidDate');
    case 'futureDate':
      return t('doc.incoming.problem.futureDate');
    case 'pastDate':
      return t('doc.incoming.problem.pastDate');
    case 'invalidId':
      return t('doc.incoming.problem.invalidId');
    case 'notPdf':
      return t('doc.incoming.problem.notPdf');
  }
}

/** What a refusal of a command says. */
export function problemMessage(t: Translate, problem: Problem): string {
  switch (problem) {
    case 'duplicate':
      return t('doc.incoming.error.duplicate');
    case 'notPdf':
      return t('doc.incoming.error.notPdf');
    case 'scanPending':
      return t('doc.incoming.error.scanPending');
    case 'infected':
      return t('doc.incoming.error.infected');
    case 'stateSecret':
      return t('doc.incoming.error.stateSecret');
    case 'wrongState':
      return t('doc.incoming.error.wrongState');
    case 'registerNotOpen':
      return t('doc.incoming.error.registerNotOpen');
    case 'registerBusy':
      return t('doc.incoming.error.registerBusy');
    case 'outOfScope':
      return t('doc.incoming.error.outOfScope');
    case 'dueInPast':
      return t('doc.incoming.error.dueInPast');
    case 'notAssignee':
      return t('doc.incoming.error.notAssignee');
    case 'responseNotIssued':
      return t('doc.incoming.error.responseNotIssued');
    case 'versionConflict':
      return t('doc.incoming.error.versionConflict');
    case 'validation':
      return t('doc.incoming.error.validation');
    case 'registerChoice':
      return t('doc.incoming.error.registerChoice');
    case 'notFound':
      return t('doc.incoming.error.notFound');
    case 'denied':
      return t('doc.incoming.error.denied');
    case 'session':
      return t('doc.incoming.error.session');
    case 'general':
      return t('doc.incoming.error.general');
  }
}
