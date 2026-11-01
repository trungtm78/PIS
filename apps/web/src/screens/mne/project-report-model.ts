import type { FormView, ObligationView, ReportKind, ReportView } from './types';

/**
 * MNE-04: the monitoring reports of one project (ST-MNE-008, MNE F4). A project report is an ordinary report of the calendar whose form is of a project kind; the shell of one that an event of the project asks for
 * (start, revision, completion) is made by the server, and the screen opens it for the preparer. The figures are the cells filled from their source, the proposals the cells written by hand.
 */
export const PROJECT_KINDS: readonly ReportKind[] = ['PROJECT_START', 'PROJECT_ADJUST', 'PROJECT_COMPLETION', 'PROJECT_PERIODIC'];

export const isProjectKind = (kind: ReportKind): boolean => PROJECT_KINDS.includes(kind);

/** An obligation of the calendar whose form is a project form, with the kind of that form. */
export interface ProjectObligation {
  item: ObligationView;
  kind: ReportKind;
}

/**
 * The obligations of the calendar that are project reports. The calendar does not name the project of an obligation, only its form, so a form of a project kind is what tells them apart; the project of one is read
 * when it is opened.
 */
export function projectObligations(items: readonly ObligationView[], forms: readonly FormView[]): ProjectObligation[] {
  const kinds = new Map(forms.filter((form) => isProjectKind(form.reportKind)).map((form) => [form.formCode, form.reportKind]));
  return items.flatMap((item) => {
    const kind = kinds.get(item.formCode);
    return kind === undefined ? [] : [{ item, kind }];
  });
}

export interface Figures {
  /** The cells filled from their source. */
  figures: number;
  /** Of them, the ones that still hold nothing: the source has nothing to give yet. */
  empty: number;
  /** The cells written by hand (the proposals and the words). */
  written: number;
  /** Of them, the ones that hold something. */
  writtenFilled: number;
}

const holds = (value: string | number | null): boolean => value !== null && String(value).trim() !== '';

/** What the cells of a report hold: how many are figures from a source and how many of them are still empty, how many are written by hand and how many of those are filled. */
export function figuresOf(report: Pick<ReportView, 'fields'>): Figures {
  const figures = report.fields.filter((field) => field.locked);
  const written = report.fields.filter((field) => !field.locked);
  return { figures: figures.length, empty: figures.filter((field) => !holds(field.value)).length, written: written.length, writtenFilled: written.filter((field) => holds(field.value)).length };
}
