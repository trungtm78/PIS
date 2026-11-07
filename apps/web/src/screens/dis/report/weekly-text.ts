import type { Translator } from '../../../i18n';
import { dueMoment } from './weekly-model';
import type { DeadlineView } from './weekly-model';

type T = Translator['t'];

/** The deadline as a sentence: the moment, and how many days are left, or that today is the last day, or how many days late. */
export function dueText(t: T, dueAt: string, view: DeadlineView | undefined): string {
  const due = dueMoment(dueAt);
  if (view === undefined) return t('dis.wr.due.plain', { due });
  if (view.kind === 'open') return view.days === 0 ? t('dis.wr.due.today', { due }) : t('dis.wr.due.left', { due, days: view.days });
  return view.days === 0 ? t('dis.wr.due.late.today', { due }) : t('dis.wr.due.late', { due, days: view.days });
}
