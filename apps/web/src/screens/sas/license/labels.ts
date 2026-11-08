import type { Translator } from '../../../i18n';
import type { Tone } from '../tenants/labels';
import type { ProblemView } from './problems';
import type { FieldProblem, LicenseAction } from './rules';

type Translate = Translator['t'];

/** The badge colour of a license state: the five states of the clock are told apart, and so are the labels people set. */
export function statusTone(status: string): Tone {
  switch (status) {
    case 'Active':
      return 'ok';
    case 'Grace':
    case 'Scheduled':
    case 'Suspended':
      return 'warn';
    case 'Expired':
    case 'Revoked':
      return 'red';
    default:
      return 'gray';
  }
}

/** The label of a license state; a state the screen does not know is shown as the server wrote it. */
export function statusLabel(t: Translate, status: string): string {
  switch (status) {
    case 'Draft':
      return t('sas.license.status.draft');
    case 'Scheduled':
      return t('sas.license.status.scheduled');
    case 'Active':
      return t('sas.license.status.active');
    case 'Grace':
      return t('sas.license.status.grace');
    case 'Expired':
      return t('sas.license.status.expired');
    case 'Suspended':
      return t('sas.license.status.suspended');
    case 'Revoked':
      return t('sas.license.status.revoked');
    case 'Superseded':
      return t('sas.license.status.superseded');
    default:
      return status;
  }
}

export function editionLabel(t: Translate, edition: string): string {
  switch (edition) {
    case 'PILOT':
      return t('sas.license.edition.pilot');
    case 'STANDARD':
      return t('sas.license.edition.standard');
    case 'ENTERPRISE':
      return t('sas.license.edition.enterprise');
    case 'PRIVATE':
      return t('sas.license.edition.private');
    default:
      return edition;
  }
}

/** Only a signature that verifies against the registered key and says what the row says is good news. */
export function signatureTone(check: string): Tone {
  return check === 'VALID' ? 'ok' : 'red';
}

export function signatureLabel(t: Translate, check: string): string {
  switch (check) {
    case 'VALID':
      return t('sas.license.signature.valid');
    case 'MALFORMED':
      return t('sas.license.signature.malformed');
    case 'UNKNOWN_KEY':
      return t('sas.license.signature.unknownKey');
    case 'BAD_SIGNATURE':
      return t('sas.license.signature.badSignature');
    case 'CLAIMS_MISMATCH':
      return t('sas.license.signature.claimsMismatch');
    default:
      return check;
  }
}

/** The message of a field the form refused before sending anything. */
export function fieldProblemMessage(t: Translate, problem: FieldProblem): string {
  switch (problem) {
    case 'required':
      return t('sas.licenseIssue.problem.required');
    case 'uuid':
      return t('sas.licenseIssue.problem.uuid');
    case 'choice':
      return t('sas.licenseIssue.problem.choice');
    case 'seats':
      return t('sas.licenseIssue.problem.seats');
    case 'date':
      return t('sas.licenseIssue.problem.date');
    case 'window':
      return t('sas.licenseIssue.problem.window');
    case 'grace':
      return t('sas.licenseIssue.problem.grace');
    case 'past':
      return t('sas.licenseIssue.problem.past');
    case 'lease':
      return t('sas.licenseIssue.problem.lease');
    case 'entitlement':
      return t('sas.licenseIssue.problem.entitlement');
  }
}

/** The message of a failed command; each key is written out so the i18n check can see it is in use. */
export function problemMessage(t: Translate, view: ProblemView): string {
  switch (view.reason) {
    case 'rangeInvalid':
      return t('sas.license.error.rangeInvalid');
    case 'tenantMismatch':
      return t('sas.license.error.tenantMismatch');
    case 'tenantState':
      return t('sas.license.error.tenantState');
    case 'signingKey':
      return t('sas.license.error.signingKey');
    case 'stateInvalid':
      return t('sas.license.error.stateInvalid');
    case 'conflict':
      return t('sas.license.error.conflict', { version: view.currentVersion ?? '' });
    case 'invalid':
      return t('sas.license.error.invalid');
    case 'fieldNotAllowed':
      return t('sas.license.error.fieldNotAllowed');
    case 'notFound':
      return t('sas.license.error.notFound');
    case 'denied':
      return t('sas.license.error.denied');
    case 'stepUp':
      return t('sas.license.error.stepUp');
    case 'session':
      return t('sas.license.error.session');
    case 'general':
      return t('sas.license.error.general');
  }
}

export function actionLabel(t: Translate, action: LicenseAction): string {
  switch (action) {
    case 'suspend':
      return t('sas.licenseAction.action.suspend');
    case 'reinstate':
      return t('sas.licenseAction.action.reinstate');
    case 'revoke':
      return t('sas.licenseAction.action.revoke');
  }
}

/** What the tenant experiences once the action took effect (SAS-15 "Data option": nothing is deleted). */
export function consequenceLabel(t: Translate, action: LicenseAction): string {
  switch (action) {
    case 'suspend':
      return t('sas.licenseAction.consequence.suspend');
    case 'reinstate':
      return t('sas.licenseAction.consequence.reinstate');
    case 'revoke':
      return t('sas.licenseAction.consequence.revoke');
  }
}
