import type { Translator } from '../../../i18n';
import type { InfoFormulaLabels, Tone } from '../../../ui';
import { effectiveCode, failureKind, rowCodeKey } from './import-model';
import type { ApplyBlock, ColumnNeed, Kind, KindFit, Problem, ProblemKind, PreviewRow, RowStatus, RunStatus } from './import-model';

type T = Translator['t'];

export function kindLabel(t: T, kind: Kind): string {
  switch (kind) {
    case 'KHLCNT':
      return t('egp.import.kind.khlcnt');
    case 'TBMT':
      return t('egp.import.kind.tbmt');
    case 'RESULT':
      return t('egp.import.kind.result');
    case 'CONTRACTOR':
      return t('egp.import.kind.contractor');
    case 'RESTRICTION':
      return t('egp.import.kind.restriction');
  }
}

export function needLabel(t: T, need: ColumnNeed): string {
  switch (need) {
    case 'required':
      return t('egp.import.need.required');
    case 'header':
      return t('egp.import.need.header');
    case 'optional':
      return t('egp.import.need.optional');
  }
}

export function statusLabel(t: T, status: RowStatus): string {
  switch (status) {
    case 'VALID':
      return t('egp.import.status.valid');
    case 'ERROR':
      return t('egp.import.status.error');
    case 'DUPLICATE':
      return t('egp.import.status.duplicate');
    case 'CONFLICT':
      return t('egp.import.status.conflict');
  }
}

/** The tone of a verdict; the word is always shown beside it, the colour never carries the state alone. */
export const statusTone = (status: RowStatus): Tone => (status === 'VALID' ? 'success' : status === 'ERROR' ? 'danger' : status === 'CONFLICT' ? 'warning' : 'neutral');

export function runStatusLabel(t: T, status: RunStatus): string {
  switch (status) {
    case 'IMPORTING':
      return t('egp.import.runStatus.importing');
    case 'APPLIED':
      return t('egp.import.runStatus.applied');
    case 'FAILED':
      return t('egp.import.runStatus.failed');
  }
}

export const runTone = (status: RunStatus): Tone => (status === 'APPLIED' ? 'success' : status === 'FAILED' ? 'danger' : 'info');

/** What the apply does with a row: the dry run's outcome for a valid row, the fate of a repeat, a clash or an error. */
export function outcomeLabel(t: T, row: PreviewRow): string {
  switch (row.status) {
    case 'DUPLICATE':
      return t('egp.import.outcome.skipped');
    case 'CONFLICT':
      return t('egp.import.outcome.refused');
    case 'ERROR':
      return t('egp.import.outcome.reported');
    case 'VALID':
      switch (row.outcome) {
        case 'RECORD_AND_PROPOSE':
          return t('egp.import.outcome.recordAndPropose');
        case 'RECORD_AND_DIFFERENCE':
          return t('egp.import.outcome.recordAndDifference');
        default:
          return t('egp.import.outcome.record');
      }
  }
}

/** The reason of a row in words; a code the screen has no sentence for is shown as it came, in the sentence of "other". */
export function rowCodeLabel(t: T, code: string | null): string {
  return t(`egp.import.rowCode.${rowCodeKey(code)}`, { code: code ?? '' });
}

export const previewRowCodeLabel = (t: T, row: PreviewRow): string | null => {
  const code = effectiveCode(row);
  return code === null ? null : rowCodeLabel(t, code);
};

export function fitMessage(t: T, fit: Exclude<KindFit, 'fits'>, params: { kinds: string; chosen: string }): string {
  return fit === 'other' ? t('egp.import.fit.other', params) : t('egp.import.fit.none');
}

export function applyBlockLabel(t: T, block: ApplyBlock): string {
  switch (block) {
    case 'noPreview':
      return t('egp.import.applyReason.noPreview');
    case 'noValid':
      return t('egp.import.applyReason.noValid');
    case 'alreadyApplied':
      return t('egp.import.applyReason.alreadyApplied');
    case 'connectionDisabled':
      return t('egp.import.applyReason.connectionDisabled');
    case 'noAuthority':
      return t('egp.import.applyReason.noAuthority');
    case 'done':
      return t('egp.import.applyReason.done');
    case 'working':
      return t('egp.import.applyReason.working');
  }
}

/** The words of a problem: what happened and what the person can do about it. */
export function problemMessage(t: T, problem: Problem): string {
  switch (problem.kind) {
    case 'alreadyApplied':
      return t('egp.import.problem.alreadyApplied');
    case 'connectionDisabled':
      return t('egp.import.problem.connectionDisabled');
    case 'hasErrors':
      return t('egp.import.problem.hasErrors');
    case 'hashMismatch':
      return t('egp.import.problem.hashMismatch');
    case 'schemaInvalid':
      return problem.missingColumns.length > 0 ? t('egp.import.problem.schemaInvalid', { columns: problem.missingColumns.join(', ') }) : t('egp.import.problem.schemaPlain');
    case 'empty':
      return t('egp.import.problem.empty');
    case 'layoutUnknown':
      return problem.layoutVersion === '' ? t('egp.import.problem.layoutPlain') : t('egp.import.problem.layoutUnknown', { version: problem.layoutVersion, supported: problem.supported.join(', ') });
    case 'fileRefused':
      return t('egp.import.problem.fileRefused');
    case 'tooLarge':
      return t('egp.import.problem.tooLarge');
    case 'scanPending':
      return t('egp.import.problem.scanPending');
    case 'validation':
      return t('egp.import.problem.validation');
    case 'notFound':
      return t('egp.import.problem.notFound');
    case 'scopeDenied':
      return t('egp.import.problem.scopeDenied');
    case 'denied':
      return t('egp.import.problem.denied');
    case 'general':
      return t('egp.import.problem.general');
  }
}

const plain = (kind: ProblemKind): Problem => ({ kind, missingColumns: [], layoutVersion: '', supported: [], code: '' });

/** Why a run failed, from the error code it kept: the sentence of the problem when the screen knows the code, else the code itself. */
export function failureText(t: T, code: string | null): string {
  if (code === null) return t('egp.import.runFailed.none');
  const kind = failureKind(code);
  return kind === null ? t('egp.import.runFailed.other', { code }) : t('egp.import.runFailed.reason', { reason: problemMessage(t, plain(kind)) });
}

export function infoLabels(t: T, name: string): InfoFormulaLabels {
  return {
    open: t('egp.import.info.open', { name }),
    close: t('egp.import.info.close'),
    formula: t('egp.import.info.formula'),
    numerator: t('egp.import.info.numerator'),
    denominator: t('egp.import.info.denominator'),
    exclusions: t('egp.import.info.exclusions'),
    source: t('egp.import.info.source'),
    asOf: t('egp.import.info.asOf'),
    owner: t('egp.import.info.owner'),
    version: t('egp.import.info.version'),
    unverified: t('egp.import.info.unverified'),
  };
}
