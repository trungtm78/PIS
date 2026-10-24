import type { Translator } from '../../../i18n';
import type { FileProblem } from './rules';
import type { SignedProblem } from './problems';
import type { ChainStatus, Overall, SignatureRole } from './types';

type T = Translator['t'];

// Every key is written out so the i18n check can see it is in use.
export function overallLabel(t: T, overall: Overall): string {
  switch (overall) {
    case 'VALID':
      return t('doc.signed.overall.valid');
    case 'INVALID':
      return t('doc.signed.overall.invalid');
    case 'INDETERMINATE':
      return t('doc.signed.overall.indeterminate');
  }
}

/** The mark that goes with a verdict so that it is never told by colour alone. */
export function overallMark(overall: Overall): string {
  switch (overall) {
    case 'VALID':
      return '✓';
    case 'INVALID':
      return '✖';
    case 'INDETERMINATE':
      return '?';
  }
}

export function roleLabel(t: T, role: SignatureRole): string {
  switch (role) {
    case 'LEADER':
      return t('doc.signed.role.leader');
    case 'ORGANIZATION':
      return t('doc.signed.role.organization');
    case 'EXTERNAL':
      return t('doc.signed.role.external');
    case 'DOCUMENT_TIMESTAMP':
      return t('doc.signed.role.timestamp');
  }
}

export function chainLabel(t: T, chain: ChainStatus): string {
  switch (chain) {
    case 'TRUSTED':
      return t('doc.signed.chain.trusted');
    case 'UNTRUSTED':
      return t('doc.signed.chain.untrusted');
    case 'INCOMPLETE':
      return t('doc.signed.chain.incomplete');
    case 'NOT_CHECKED':
      return t('doc.signed.chain.notChecked');
  }
}

export function findingLabel(t: T, code: string): string {
  switch (code) {
    case 'SIGNING_TIME_UNPROVEN':
      return t('doc.signed.finding.timeUnproven');
    case 'CHAIN_UNTRUSTED':
      return t('doc.signed.finding.chainUntrusted');
    case 'LEADER_FIELD_REQUIRED':
      return t('doc.signed.finding.leaderField');
    case 'ONE_SIGNATURE_EXPECTED':
      return t('doc.signed.finding.oneSignature');
    case 'SEAL_DOES_NOT_COVER_FILE':
      return t('doc.signed.finding.sealCover');
    default:
      return t('doc.signed.finding.other', { code });
  }
}

export function fileProblemMessage(t: T, problem: FileProblem): string {
  switch (problem) {
    case 'REQUIRED':
      return t('doc.signed.file.required');
    case 'EMPTY':
      return t('doc.signed.file.empty');
    case 'NOT_PDF':
      return t('doc.signed.file.notPdf');
    case 'TOO_LARGE':
      return t('doc.signed.file.tooLarge');
  }
}

export function problemMessage(t: T, problem: SignedProblem): string {
  switch (problem.reason) {
    case 'signatureInvalid':
      return t('doc.signed.problem.signatureInvalid');
    case 'chainUntrusted':
      return t('doc.signed.problem.chainUntrusted');
    case 'timeUnproven':
      return t('doc.signed.problem.timeUnproven');
    case 'contentMismatch':
      return t('doc.signed.problem.contentMismatch');
    case 'numberTaken':
      return t('doc.signed.problem.numberTaken');
    case 'modeMismatch':
      return t('doc.signed.problem.modeMismatch');
    case 'registerClosed':
      return t('doc.signed.problem.registerClosed');
    case 'yearMismatch':
      return t('doc.signed.problem.yearMismatch');
    case 'symbolFormat':
      return t('doc.signed.problem.symbolFormat');
    case 'notPdf':
      return t('doc.signed.problem.notPdf');
    case 'scanPending':
      return t('doc.signed.problem.scanPending');
    case 'notClean':
      return t('doc.signed.problem.notClean');
    case 'tooLarge':
      return t('doc.signed.problem.tooLarge');
    case 'selfUpload':
      return t('doc.signed.problem.selfUpload');
    case 'notAuthorised':
      return problem.authority === 'SIGNER_IDENTITY_MISMATCH' ? t('doc.signed.problem.signerMismatch') : t('doc.signed.problem.notAuthorised');
    case 'conflict':
      return t('doc.signed.problem.conflict');
    case 'state':
      return t('doc.signed.problem.state');
    case 'invalid':
      return t('doc.signed.problem.invalid');
    case 'notFound':
      return t('doc.signed.problem.notFound');
    case 'denied':
      return t('doc.signed.problem.denied');
    case 'session':
      return t('doc.signed.problem.session');
    case 'duplicate':
      return t('doc.signed.problem.duplicate');
    case 'general':
      return t('doc.signed.problem.general');
  }
}
