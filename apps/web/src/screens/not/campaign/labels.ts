import type { Translator } from '../../../i18n';
import type { CampaignProblem, CampaignPurpose, CampaignStatus, Exclusion, ProblemView } from './model';

type T = Translator['t'];

export function statusLabel(t: T, status: CampaignStatus): string {
  switch (status) {
    case 'Draft':
      return t('not.campaign.status.draft');
    case 'Previewed':
      return t('not.campaign.status.previewed');
    case 'PendingApproval':
      return t('not.campaign.status.pendingApproval');
    case 'Approved':
      return t('not.campaign.status.approved');
    case 'Scheduled':
      return t('not.campaign.status.scheduled');
    case 'Sending':
      return t('not.campaign.status.sending');
    case 'Completed':
      return t('not.campaign.status.completed');
    case 'Rejected':
      return t('not.campaign.status.rejected');
    case 'Cancelled':
      return t('not.campaign.status.cancelled');
  }
}

export function purposeLabel(t: T, purpose: CampaignPurpose): string {
  switch (purpose) {
    case 'ANNOUNCEMENT':
      return t('not.campaign.purpose.announcement');
    case 'REMINDER':
      return t('not.campaign.purpose.reminder');
    case 'OPERATIONAL':
      return t('not.campaign.purpose.operational');
  }
}

export function exclusionLabel(t: T, reason: Exclusion): string {
  switch (reason) {
    case 'opted_out':
      return t('not.campaign.excluded.optedOut');
    case 'no_consent':
      return t('not.campaign.excluded.noConsent');
    case 'inactive':
      return t('not.campaign.excluded.inactive');
    case 'duplicate':
      return t('not.campaign.excluded.duplicate');
  }
}

export function formProblemMessage(t: T, problem: CampaignProblem): string {
  switch (problem) {
    case 'name':
      return t('not.segment.form.name.invalid');
    case 'template':
      return t('not.segment.form.template.invalid');
    case 'segment':
      return t('not.segment.form.segment.invalid');
    case 'roles':
      return t('not.segment.form.roles.invalid');
    case 'schedule':
      return t('not.segment.form.schedule.invalid');
  }
}

export function problemMessage(t: T, problem: ProblemView): string {
  switch (problem.reason) {
    case 'invalid':
      return problem.field === undefined ? t('not.campaign.problem.invalid') : t('not.campaign.problem.invalidAt', { field: problem.field });
    case 'segment':
      return t('not.campaign.problem.segment');
    case 'template':
      return t('not.campaign.problem.template');
    case 'stale':
      return t('not.campaign.problem.stale');
    case 'self':
      return t('not.campaign.problem.self');
    case 'state':
      return t('not.campaign.problem.state');
    case 'channel':
      return t('not.campaign.problem.channel');
    case 'conflict':
      return t('not.campaign.problem.conflict');
    case 'denied':
      return t('not.campaign.problem.denied');
    case 'notFound':
      return t('not.campaign.problem.notFound');
    case 'session':
      return t('not.campaign.problem.session');
    case 'general':
      return t('not.campaign.problem.general');
  }
}
