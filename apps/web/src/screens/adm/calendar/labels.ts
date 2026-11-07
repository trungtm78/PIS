import type { Translator } from '../../../i18n';
import type { Tone } from '../../../ui';
import type { CalendarStatus, DayKind, FieldProblem, Finding, ProblemView } from './model';

type T = Translator['t'];

// Every key is written out so the i18n check can see it is in use.
export function statusLabel(t: T, status: CalendarStatus): string {
  switch (status) {
    case 'Draft':
      return t('adm.calendar.status.draft');
    case 'Published':
      return t('adm.calendar.status.published');
    case 'Superseded':
      return t('adm.calendar.status.superseded');
  }
}

export function dayKindLabel(t: T, kind: DayKind): string {
  switch (kind) {
    case 'working':
      return t('adm.calendar.day.working');
    case 'off':
      return t('adm.calendar.day.off');
    case 'holiday':
      return t('adm.calendar.day.holiday');
    case 'compensated':
      return t('adm.calendar.day.compensated');
  }
}

export function fieldMessage(t: T, problem: FieldProblem): string {
  switch (problem) {
    case 'required':
      return t('adm.calendar.field.required');
    case 'tooLong':
      return t('adm.calendar.field.tooLong');
    case 'range':
      return t('adm.calendar.field.range');
    case 'pattern':
      return t('adm.calendar.field.pattern');
    case 'nameRequired':
      return t('adm.calendar.field.nameRequired');
  }
}

/** The sentence for a finding of CALENDAR_INVALID (the codes of `validateWorkCalendar`); a code this screen does not know says only that the calendar is invalid. */
export function findingMessage(t: T, finding: Finding): string {
  switch (finding.code) {
    case 'DATE_INVALID':
      return t('adm.calendar.error.dateInvalid', { field: finding.field });
    case 'OUT_OF_YEAR':
      return t('adm.calendar.error.outOfYear', { field: finding.field });
    case 'DUPLICATE':
      return t('adm.calendar.error.duplicate', { field: finding.field });
    case 'NO_WORKING_DAYS':
      return t('adm.calendar.error.noWorkingDays', { field: finding.field });
    case 'CODE_INVALID':
      return t('adm.calendar.error.codeInvalid', { field: finding.field });
    case 'LEGAL_BASIS_REQUIRED':
      return t('adm.calendar.error.legalBasisRequired', { field: finding.field });
    case 'NAME_REQUIRED':
      return t('adm.calendar.error.nameRequired', { field: finding.field });
    case 'COMPENSATED_ON_HOLIDAY':
      return t('adm.calendar.error.compensatedOnHoliday', { field: finding.field });
    case 'COMPENSATED_ALREADY_WORKING':
      return t('adm.calendar.error.compensatedAlreadyWorking', { field: finding.field });
    default:
      return t('adm.calendar.problem.calendarInvalid');
  }
}

export function problemMessage(t: T, problem: ProblemView): string {
  switch (problem.reason) {
    case 'calendarInvalid':
      return t('adm.calendar.problem.calendarInvalid');
    case 'conflict':
      return t('adm.calendar.problem.conflict');
    case 'stage':
      return t('adm.calendar.problem.stage');
    case 'invalid':
      return t('adm.calendar.problem.invalid');
    case 'notFound':
      return t('adm.calendar.problem.notFound');
    case 'denied':
      return t('adm.calendar.problem.denied');
    case 'session':
      return t('adm.calendar.problem.session');
    case 'general':
      return t('adm.calendar.problem.general');
  }
}

/** The tone of the status pill of a version of the calendar. */
export function statusTone(status: CalendarStatus): Tone {
  switch (status) {
    case 'Draft':
      return 'warning';
    case 'Published':
      return 'success';
    case 'Superseded':
      return 'neutral';
  }
}
