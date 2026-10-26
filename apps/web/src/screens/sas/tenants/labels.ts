import type { Translator } from '../../../i18n';
import type { ProblemView } from './problems';
import type { FieldProblem } from './rules';

type Translate = Translator['t'];

/** The badge colour class of a tenant status in the prototype's pill language. */
export type Tone = 'ok' | 'warn' | 'red' | 'gray';

export function statusTone(status: string): Tone {
  switch (status) {
    case 'Active':
      return 'ok';
    case 'Failed':
      return 'red';
    case 'Requested':
    case 'Provisioning':
    case 'Suspended':
    case 'Offboarding':
      return 'warn';
    default:
      return 'gray';
  }
}

export const toneClass = (tone: Tone): string => (tone === 'ok' ? 'pill' : `pill ${tone}`);

/** The label of a tenant status; a status the screen does not know is shown as the server wrote it. */
export function statusLabel(t: Translate, status: string): string {
  switch (status) {
    case 'Requested':
      return t('sas.tenants.status.requested');
    case 'Provisioning':
      return t('sas.tenants.status.provisioning');
    case 'Active':
      return t('sas.tenants.status.active');
    case 'Failed':
      return t('sas.tenants.status.failed');
    case 'Suspended':
      return t('sas.tenants.status.suspended');
    case 'Offboarding':
      return t('sas.tenants.status.offboarding');
    case 'Archived':
      return t('sas.tenants.status.archived');
    default:
      return status;
  }
}

/** The label of a step of the provisioning saga. */
export function stepLabel(t: Translate, step: string): string {
  switch (step) {
    case 'IDP_ORG':
      return t('sas.tenants.step.idpOrg');
    case 'DNS_SUBDOMAIN':
      return t('sas.tenants.step.dnsTls');
    case 'STORAGE_PREFIX':
      return t('sas.tenants.step.storagePrefix');
    case 'DB_PLACEMENT':
      return t('sas.tenants.step.dbPlacement');
    case 'RLS_SEED':
      return t('sas.tenants.step.rlsSeed');
    case 'ENTITLEMENT_V1':
      return t('sas.tenants.step.entitlementV1');
    case 'LICENSE_PILOT':
      return t('sas.tenants.step.licensePilot');
    case 'ROLE_SEED':
      return t('sas.tenants.step.roleSeed');
    case 'ROOT_UNIT':
      return t('sas.tenants.step.rootUnit');
    case 'THEME_V1':
      return t('sas.tenants.step.themeV1');
    case 'OWNER_INVITE':
      return t('sas.tenants.step.ownerInvite');
    default:
      return step;
  }
}

export function runStatusLabel(t: Translate, status: string): string {
  switch (status) {
    case 'PENDING':
      return t('sas.tenants.run.pending');
    case 'RUNNING':
      return t('sas.tenants.run.running');
    case 'DONE':
      return t('sas.tenants.run.done');
    case 'FAILED':
      return t('sas.tenants.run.failed');
    case 'COMPENSATED':
      return t('sas.tenants.run.compensated');
    default:
      return status;
  }
}

export function isolationLabel(t: Translate, mode: string | undefined): string {
  switch (mode) {
    case 'POOL':
      return t('sas.tenantCreate.isolation.pool');
    case 'SILO':
      return t('sas.tenantCreate.isolation.silo');
    default:
      return mode ?? t('sas.tenants.none');
  }
}

export function regionLabel(t: Translate, region: string): string {
  return region === 'vn-south' ? t('sas.tenantCreate.region.south') : t('sas.tenantCreate.region.north');
}

export function governingBodyLabel(t: Translate, type: string): string {
  switch (type) {
    case 'MINISTRY':
      return t('sas.tenantCreate.governingBody.ministry');
    case 'CENTRAL_AGENCY':
      return t('sas.tenantCreate.governingBody.centralAgency');
    default:
      return t('sas.tenantCreate.governingBody.province');
  }
}

/** The message of a field the form refused before sending anything. */
export function fieldProblemMessage(t: Translate, problem: FieldProblem): string {
  switch (problem) {
    case 'required':
      return t('sas.tenantCreate.problem.required');
    case 'pattern':
      return t('sas.tenantCreate.problem.pattern');
    case 'tooShort':
      return t('sas.tenantCreate.problem.tooShort');
    case 'tooLong':
      return t('sas.tenantCreate.problem.tooLong');
    case 'email':
      return t('sas.tenantCreate.problem.email');
    case 'uuid':
      return t('sas.tenantCreate.problem.uuid');
    case 'choice':
      return t('sas.tenantCreate.problem.choice');
  }
}

/** The message of a failed command; each key is written out so the i18n check can see it is in use. */
export function problemMessage(t: Translate, view: ProblemView): string {
  switch (view.reason) {
    case 'codeTaken':
      return t('sas.tenantCreate.error.codeTaken');
    case 'domainTaken':
      return t('sas.tenantCreate.error.domainTaken');
    case 'planNotPublished':
      return t('sas.tenantCreate.error.planNotPublished');
    case 'placementUnavailable':
      return t('sas.tenantCreate.error.placementUnavailable');
    case 'invalid':
      return t('sas.tenantCreate.error.invalid');
    case 'fieldNotAllowed':
      return t('sas.tenantCreate.error.fieldNotAllowed');
    case 'stateInvalid':
      return t('sas.tenantCreate.error.stateInvalid');
    case 'conflict':
      return t('sas.tenantCreate.error.conflict', { version: view.currentVersion ?? '' });
    case 'notFound':
      return t('sas.tenantCreate.error.notFound');
    case 'denied':
      return t('sas.tenantCreate.error.denied');
    case 'stepUp':
      return t('sas.tenantCreate.error.stepUp');
    case 'session':
      return t('sas.tenantCreate.error.session');
    case 'offline':
      return t('sas.tenantCreate.error.offline');
    case 'general':
      return t('sas.tenantCreate.error.general');
  }
}

export function featureLabel(t: Translate, code: string): string {
  switch (code) {
    case 'reporting':
      return t('sas.entitlements.feature.reporting');
    case 'export':
      return t('sas.entitlements.feature.export');
    case 'ai.analysis':
      return t('sas.entitlements.feature.aiAnalysis');
    case 'notification.campaign':
      return t('sas.entitlements.feature.notificationCampaign');
    case 'member.invite':
      return t('sas.entitlements.feature.memberInvite');
    case 'member.seats':
      return t('sas.entitlements.feature.memberSeats');
    default:
      return code;
  }
}

export function modeLabel(t: Translate, mode: string): string {
  switch (mode) {
    case 'FULL':
      return t('sas.entitlements.mode.full');
    case 'READ_ONLY':
      return t('sas.entitlements.mode.readOnly');
    case 'EXPORT_ONLY':
      return t('sas.entitlements.mode.exportOnly');
    case 'DENIED':
      return t('sas.entitlements.mode.denied');
    default:
      return mode;
  }
}

export const modeTone = (mode: string): Tone => (mode === 'FULL' ? 'ok' : mode === 'DENIED' ? 'red' : 'warn');

export function sourceLabel(t: Translate, source: string): string {
  return source === 'OVERRIDE' ? t('sas.entitlements.source.override') : t('sas.entitlements.source.plan');
}

export function licenseLabel(t: Translate, status: string | undefined): string {
  switch (status) {
    case 'FULL':
      return t('sas.entitlements.license.full');
    case 'GRACE':
      return t('sas.entitlements.license.grace');
    case 'EXPIRED':
      return t('sas.entitlements.license.expired');
    case 'SUSPENDED':
      return t('sas.entitlements.license.suspended');
    case 'REVOKED':
      return t('sas.entitlements.license.revoked');
    default:
      return status ?? t('sas.tenants.none');
  }
}
