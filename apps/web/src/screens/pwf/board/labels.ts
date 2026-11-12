import type { Translator } from '../../../i18n';
import type { View } from './model';

type T = Translator['t'];

export function viewWord(t: T, view: View): string {
  switch (view) {
    case 'list':
      return t('pwf.board.tab.list.label');
    case 'calendar':
      return t('pwf.board.tab.calendar.label');
    case 'milestones':
      return t('pwf.board.tab.milestones.label');
    case 'workload':
      return t('pwf.board.tab.workload.label');
  }
}

/** The short name of a weekday, Monday first (0 to 6). */
export function weekdayWord(t: T, index: number): string {
  switch (index) {
    case 0:
      return t('pwf.board.weekday.mon.word');
    case 1:
      return t('pwf.board.weekday.tue.word');
    case 2:
      return t('pwf.board.weekday.wed.word');
    case 3:
      return t('pwf.board.weekday.thu.word');
    case 4:
      return t('pwf.board.weekday.fri.word');
    case 5:
      return t('pwf.board.weekday.sat.word');
    default:
      return t('pwf.board.weekday.sun.word');
  }
}

/** The difference between the forecast and the baseline date of a milestone, in words (positive is late); no figure says nothing. */
export function slipText(t: T, days: number | null): string {
  if (days === null) return '–';
  if (days > 0) return t('pwf.board.slip.late.text', { days });
  if (days < 0) return t('pwf.board.slip.early.text', { days: Math.abs(days) });
  return t('pwf.board.slip.none.text');
}
