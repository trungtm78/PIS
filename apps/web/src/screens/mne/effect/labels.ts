import type { Tone } from '../../../ui';
import type { Anchor, AssessmentKind, Band, CalendarState, Conclusion, Direction, EvaluationKind, FormProblem, NaReason, Refused } from './model';

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Each key is written out so that the i18n check can see it is in use. */
export function bandText(t: Translate, band: Band): string {
  switch (band) {
    case 'MET':
      return t('mr1.effect.band.met');
    case 'PARTIAL':
      return t('mr1.effect.band.partial');
    case 'MISSED':
      return t('mr1.effect.band.missed');
    case 'NOT_MEASURED':
      return t('mr1.effect.band.notMeasured');
  }
}

// Check mark, half circle, cross, dash: a band is a word and a sign, never a colour alone.
export const BAND_GLYPH: Readonly<Record<Band, string>> = { MET: '✓', PARTIAL: '◐', MISSED: '✗', NOT_MEASURED: '–' };
export const bandTone = (band: Band): Tone => (band === 'MET' ? 'success' : band === 'PARTIAL' ? 'warning' : band === 'MISSED' ? 'danger' : 'neutral');

// Up arrow, down arrow: the direction an indicator should move in.
export const DIRECTION_GLYPH: Readonly<Record<Direction, string>> = { HIGHER_IS_BETTER: '↑', LOWER_IS_BETTER: '↓' };
export const directionText = (t: Translate, direction: Direction): string => (direction === 'HIGHER_IS_BETTER' ? t('mr1.effect.direction.higher') : t('mr1.effect.direction.lower'));

export function kindText(t: Translate, kind: AssessmentKind | EvaluationKind): string {
  switch (kind) {
    case 'INITIAL':
      return t('mr1.effect.kind.initial');
    case 'MIDTERM':
      return t('mr1.effect.kind.midterm');
    case 'FINAL':
      return t('mr1.effect.kind.final');
    case 'IMPACT':
      return t('mr1.effect.kind.impact');
    case 'AD_HOC':
      return t('mr1.effect.kind.adHoc');
  }
}

export function anchorText(t: Translate, anchor: Anchor): string {
  switch (anchor) {
    case 'IMPLEMENTATION_START':
      return t('mr1.effect.anchor.implementationStart');
    case 'COMPLETION':
      return t('mr1.effect.anchor.completion');
    case 'HANDOVER':
      return t('mr1.effect.anchor.handover');
  }
}

export function stateText(t: Translate, state: CalendarState, daysLate: number): string {
  switch (state) {
    case 'DONE':
      return t('mr1.effect.state.done');
    case 'OVERDUE':
      return t('mr1.effect.state.overdue', { days: daysLate });
    case 'DUE_SOON':
      return t('mr1.effect.state.dueSoon');
    case 'UPCOMING':
      return t('mr1.effect.state.upcoming');
  }
}

export const stateTone = (state: CalendarState): Tone => (state === 'DONE' ? 'success' : state === 'OVERDUE' ? 'danger' : state === 'DUE_SOON' ? 'warning' : 'neutral');
// Check mark, exclamation, clock, circle.
export const STATE_GLYPH: Readonly<Record<CalendarState, string>> = { DONE: '✓', OVERDUE: '!', DUE_SOON: '◷', UPCOMING: '○' };

export function conclusionText(t: Translate, conclusion: Conclusion): string {
  switch (conclusion) {
    case 'SATISFACTORY':
      return t('mr1.effect.conclusion.satisfactory');
    case 'PARTIALLY_SATISFACTORY':
      return t('mr1.effect.conclusion.partially');
    case 'UNSATISFACTORY':
      return t('mr1.effect.conclusion.unsatisfactory');
  }
}

export const conclusionTone = (conclusion: Conclusion): Tone => (conclusion === 'SATISFACTORY' ? 'success' : conclusion === 'PARTIALLY_SATISFACTORY' ? 'warning' : 'danger');

export function assessmentStatusText(t: Translate, status: 'SUBMITTED' | 'APPROVED' | 'RETURNED'): string {
  switch (status) {
    case 'SUBMITTED':
      return t('mr1.effect.assessment.status.submitted');
    case 'APPROVED':
      return t('mr1.effect.assessment.status.approved');
    case 'RETURNED':
      return t('mr1.effect.assessment.status.returned');
  }
}

export const assessmentStatusTone = (status: 'SUBMITTED' | 'APPROVED' | 'RETURNED'): Tone => (status === 'APPROVED' ? 'success' : status === 'RETURNED' ? 'danger' : 'warning');

export function naText(t: Translate, reason: NaReason): string {
  switch (reason) {
    case 'NO_MEASUREMENT':
      return t('mr1.effect.na.noMeasurement');
    case 'TARGET_ZERO':
      return t('mr1.effect.na.targetZero');
    case 'BASELINE_EQUALS_TARGET':
      return t('mr1.effect.na.baselineEqualsTarget');
    case 'NOT_COMPUTABLE':
      return t('mr1.effect.na.notComputable');
  }
}

/** The name of a field the server named; a field the screen has no word for is shown as it came, never hidden. */
export function fieldText(t: Translate, field: string): string {
  switch (field) {
    case 'basis':
      return t('mr1.effect.field.basis');
    case 'indicators':
      return t('mr1.effect.field.indicators');
    case 'indicator_code':
      return t('mr1.effect.field.indicatorCode');
    case 'measured_on':
      return t('mr1.effect.field.measuredOn');
    case 'value':
      return t('mr1.effect.field.value');
    case 'method_note':
      return t('mr1.effect.field.methodNote');
    case 'corrects_id':
      return t('mr1.effect.field.correctsId');
    case 'correction_reason':
      return t('mr1.effect.field.correctionReason');
    case 'supersede_reason':
      return t('mr1.effect.field.supersedeReason');
    case 'kind':
      return t('mr1.effect.field.kind');
    case 'conclusion':
      return t('mr1.effect.field.conclusion');
    case 'summary':
      return t('mr1.effect.field.summary');
    case 'reason':
      return t('mr1.effect.field.reason');
    case 'project_group':
      return t('mr1.effect.field.projectGroup');
    default:
      return field;
  }
}

/** What a refusal of a command says; the server's field is named when it named one. */
export function refusalText(t: Translate, refused: Refused): string {
  switch (refused.refusal) {
    case 'targetState':
      return t('mr1.effect.refusal.targetState');
    case 'notFixed':
      return t('mr1.effect.refusal.notFixed');
    case 'measurementDuplicate':
      return t('mr1.effect.refusal.measurementDuplicate');
    case 'assessmentState':
      return t('mr1.effect.refusal.assessmentState');
    case 'assessmentAlready':
      return t('mr1.effect.refusal.assessmentAlready');
    case 'stageInvalid':
      return t('mr1.effect.refusal.stageInvalid');
    case 'selfApproval':
      return t('mr1.effect.refusal.selfApproval');
    case 'versionConflict':
      return t('mr1.effect.refusal.versionConflict');
    case 'validation':
      return refused.field === undefined ? t('mr1.effect.refusal.validation') : t('mr1.effect.refusal.validationField', { field: fieldText(t, refused.field) });
    case 'noMeasurement':
      return t('mr1.effect.refusal.noMeasurement');
    case 'notTheAuthor':
      return t('mr1.effect.refusal.notTheAuthor');
    case 'denied':
      return t('mr1.effect.refusal.denied');
    case 'notFound':
      return t('mr1.effect.refusal.notFound');
    case 'session':
      return t('mr1.effect.refusal.session');
    case 'general':
      return t('mr1.effect.refusal.general');
  }
}

export function problemText(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('mr1.effect.problem.required');
    case 'invalid':
      return t('mr1.effect.problem.invalid');
    case 'short':
      return t('mr1.effect.problem.short');
  }
}
