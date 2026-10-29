import type { useTranslation } from '../../../i18n';
import type { DifferenceKind, FormProblem, GateOutcome, MappingStatus, Problem, ReconResult } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function mappingStatusLabel(t: Translate, status: MappingStatus): string {
  switch (status) {
    case 'PROPOSED':
      return t('dgv.source.status.proposed');
    case 'CONFIRMED':
      return t('dgv.source.status.confirmed');
    case 'REJECTED':
      return t('dgv.source.status.rejected');
    case 'RETIRED':
      return t('dgv.source.status.retired');
  }
}

export function mappingStatusTone(status: MappingStatus): 'green' | 'gray' | 'warn' | 'red' {
  switch (status) {
    case 'CONFIRMED':
      return 'green';
    case 'PROPOSED':
      return 'warn';
    case 'REJECTED':
      return 'red';
    case 'RETIRED':
      return 'gray';
  }
}

/** The unit of a mapping in words; none is dong. */
export function unitLabel(t: Translate, unit: string | null): string {
  switch (unit) {
    case null:
    case '':
      return t('dgv.source.unit.none');
    case 'VND':
      return t('dgv.source.unit.vnd');
    case 'THOUSAND_VND':
      return t('dgv.source.unit.thousand');
    case 'MILLION_VND':
      return t('dgv.source.unit.million');
    case 'BILLION_VND':
      return t('dgv.source.unit.billion');
    default:
      return unit;
  }
}

export function gateOutcomeLabel(t: Translate, outcome: GateOutcome): string {
  return outcome === 'APPLIED' ? t('dgv.pipeline.outcome.applied') : t('dgv.pipeline.outcome.quarantined');
}

export function gateReasonLabel(t: Translate, reason: string | null): string {
  return reason === 'MAPPING_NOT_CONFIRMED' ? t('dgv.pipeline.reason.mappingNotConfirmed') : (reason ?? t('dgv.source.none'));
}

export function resultLabel(t: Translate, result: ReconResult): string {
  switch (result) {
    case 'MATCHED':
      return t('dgv.recon.result.matched');
    case 'WITHIN_TOLERANCE':
      return t('dgv.recon.result.withinTolerance');
    case 'DIFFERENT':
      return t('dgv.recon.result.different');
  }
}

export function resultTone(result: ReconResult): 'green' | 'warn' | 'red' {
  switch (result) {
    case 'MATCHED':
      return 'green';
    case 'WITHIN_TOLERANCE':
      return 'warn';
    case 'DIFFERENT':
      return 'red';
  }
}

export function kindLabel(t: Translate, kind: DifferenceKind): string {
  switch (kind) {
    case 'MISSING':
      return t('dgv.recon.kind.missing');
    case 'TIMING':
      return t('dgv.recon.kind.timing');
    case 'REVERSAL':
      return t('dgv.recon.kind.reversal');
    case 'MAPPING':
      return t('dgv.recon.kind.mapping');
    case 'AMOUNT':
      return t('dgv.recon.kind.amount');
  }
}

export function sideLabel(t: Translate, side: 'A_ONLY' | 'B_ONLY' | 'BOTH'): string {
  switch (side) {
    case 'A_ONLY':
      return t('dgv.recon.side.aOnly');
    case 'B_ONLY':
      return t('dgv.recon.side.bOnly');
    case 'BOTH':
      return t('dgv.recon.side.both');
  }
}

export function formProblemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('dgv.source.problem.required');
    case 'tooShort':
      return t('dgv.source.problem.tooShort');
    case 'invalidId':
      return t('dgv.source.problem.invalidId');
    case 'invalidPeriod':
      return t('dgv.source.problem.invalidPeriod');
    case 'invalidAmount':
      return t('dgv.source.problem.invalidAmount');
  }
}

export function problemMessage(t: Translate, problem: Problem): string {
  switch (problem) {
    case 'unit':
      return t('dgv.source.error.unit');
    case 'datasetMissing':
      return t('dgv.source.error.datasetMissing');
    case 'duplicate':
      return t('dgv.source.error.duplicate');
    case 'selfApproval':
      return t('dgv.source.error.selfApproval');
    case 'stateInvalid':
      return t('dgv.source.error.stateInvalid');
    case 'basis':
      return t('dgv.source.error.basis');
    case 'noClosedMonth':
      return t('dgv.source.error.noClosedMonth');
    case 'versionConflict':
      return t('dgv.source.error.versionConflict');
    case 'validation':
      return t('dgv.source.error.validation');
    case 'notFound':
      return t('dgv.source.error.notFound');
    case 'denied':
      return t('dgv.source.error.denied');
    case 'general':
      return t('dgv.source.error.general');
  }
}
