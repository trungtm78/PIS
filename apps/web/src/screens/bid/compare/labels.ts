import type { useTranslation } from '../../../i18n';
import type { CellRisk, ExclusionReason } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function riskLabel(t: Translate, risk: CellRisk): string {
  switch (risk) {
    case 'UNDECIDED':
      return t('bid.compare.risk.undecided');
    case 'NONE':
      return t('bid.compare.risk.none');
    case 'ATTENTION':
      return t('bid.compare.risk.attention');
    case 'MANDATORY_NOT_MET':
      return t('bid.compare.risk.mandatoryNotMet');
  }
}

/** The look of the tag of a cell: nothing to note is plain, a mandatory criterion that is not met is a danger. */
export function riskTone(risk: CellRisk): 'ok' | 'warning' | 'danger' | 'plain' {
  switch (risk) {
    case 'NONE':
      return 'ok';
    case 'ATTENTION':
      return 'warning';
    case 'MANDATORY_NOT_MET':
      return 'danger';
    case 'UNDECIDED':
      return 'plain';
  }
}

export function exclusionLabel(t: Translate, reason: ExclusionReason): string {
  switch (reason) {
    case 'CRITERIA_VERSION_MISMATCH':
      return t('bid.compare.excluded.mismatch');
    case 'NO_ANALYSIS_RUN':
      return t('bid.compare.excluded.noRun');
  }
}

/** Why there is no comparison to show: the package does not exist for the caller, they owe the declaration of conflict, or the version asked for is not one of the package. */
export function failureMessage(t: Translate, failure: 'notFound' | 'undeclared' | 'version'): string {
  switch (failure) {
    case 'notFound':
      return t('bid.compare.package.notFound');
    case 'undeclared':
      return t('bid.compare.package.undeclared');
    case 'version':
      return t('bid.compare.version.notOfPackage');
  }
}

/** The attribute a rule of the criteria nobody may ask for names; a rule the screen does not know is shown by its code. */
export function attributeLabel(t: Translate, code: string): string {
  switch (code) {
    case 'GENDER':
      return t('bid.compare.attribute.gender');
    case 'ETHNICITY':
      return t('bid.compare.attribute.ethnicity');
    case 'RELIGION':
      return t('bid.compare.attribute.religion');
    case 'MARITAL_STATUS':
      return t('bid.compare.attribute.maritalStatus');
    case 'AGE':
      return t('bid.compare.attribute.age');
    case 'ORIGIN':
      return t('bid.compare.attribute.origin');
    case 'LOCAL_PRESENCE':
      return t('bid.compare.attribute.localPresence');
    default:
      return code;
  }
}
