import { addNamedPhase, addRow, linesOf, nameLine, setLeadUnit, setLimit, settleCodes, unverifiedCopy } from './table-model';
import { MAX_DURATION, MAX_TASKS, blankTemplate, fresh, paramsOfTemplate, readTemplate, stepsOf } from './template-model';
import type { Template } from './template-model';

/** The ways a new procedure starts (PWF-01 "Tạo quy trình"): from a kind of procedure the platform ships, from a copy of one in use, from rows pasted out of a spreadsheet, or empty. */

// ---- a copy -----------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * A copy of a template under a new name, to be saved under a code of its own. The codes of its phases, steps and tasks are kept (they are identities inside one template), every legal ground comes unverified and
 * without a stamp (it was checked for the other procedure, R75), and nothing ties the copy to the rule it was read from: it is written in the editor's own form.
 */
export function cloneTemplate(source: Template, name: string): Template {
  const plain = readTemplate(JSON.parse(JSON.stringify(paramsOfTemplate(source))));
  const copy: Template = fresh({
    ...plain,
    name,
    phases: plain.phases.map((phase) => fresh(phase)),
    ...(plain.steps === undefined ? {} : { steps: stepsOf(plain).map((step) => fresh({ ...step, ...(step.legal_basis === undefined ? {} : { legal_basis: unverifiedCopy(step.legal_basis) }) })) }),
    tasks: plain.tasks.map((task) => fresh({ ...task, ...(task.legal_basis === undefined ? {} : { legal_basis: unverifiedCopy(task.legal_basis) }) })),
  });
  return copy;
}

/** An empty procedure with its first phase, ready for the first row. */
export const emptyTemplate = (name: string, phaseName: string): Template => addNamedPhase({ ...blankTemplate(), name }, phaseName);

// ---- rows pasted from a spreadsheet (R70) -----------------------------------------------------------------------------------------------------------------------------

export type PasteProblem = 'noName' | 'nameTooLong' | 'tooManyColumns' | 'badDays';

export interface PastedRow {
  /** The line of the pasted text, counted from 1. */
  line: number;
  name: string;
  /** The unit as it was typed; matched against the choices of the editor by its name, never guessed. */
  unit: string;
  days: number | null;
  problems: PasteProblem[];
}

export const MAX_PASTE_COLUMNS = 3;

/**
 * Reads rows copied from a spreadsheet: one row a line, the cells separated by tabs, at most three (the name of the step, the unit, the number of days). Empty lines are skipped. Nothing is added by this: the rows
 * are shown first, each with what is wrong with it, and only rows without a problem are added afterwards.
 */
export function parsePaste(text: string): PastedRow[] {
  const rows: PastedRow[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    if (raw.trim() === '') return;
    const cells = raw.split('\t').map((cell) => cell.trim());
    const [name = '', unit = '', days = ''] = cells;
    const problems: PasteProblem[] = [];
    if (cells.length > MAX_PASTE_COLUMNS && cells.slice(MAX_PASTE_COLUMNS).some((cell) => cell !== '')) problems.push('tooManyColumns');
    if (name === '') problems.push('noName');
    else if (name.length > 200) problems.push('nameTooLong');
    const count = days === '' ? null : /^\d{1,4}$/.test(days) ? Number(days) : Number.NaN;
    if (count !== null && !(Number.isInteger(count) && count >= 1 && count <= MAX_DURATION)) problems.push('badDays');
    rows.push({ line: index + 1, name, unit, days: count === null || Number.isNaN(count) ? null : count, problems });
  });
  return rows;
}

export interface PasteOutcome {
  template: Template;
  added: number;
  /** Rows left out because the template is full (BR-PWF-12). */
  overLimit: number;
}

/**
 * Appends the pasted rows that have no problem to the end of a phase, each starting when the one before is done. It only ever adds: no row of the template is changed or replaced. A unit is set only when its name is
 * one of the choices (`unitRefOf`); a row whose unit is not known is added without one.
 */
export function appendPasted(template: Template, phaseCode: string, rows: readonly PastedRow[], unitRefOf: (name: string) => string | undefined): PasteOutcome {
  let next = template;
  let added = 0;
  let overLimit = 0;
  for (const row of rows) {
    if (row.problems.length > 0) continue;
    if (next.tasks.length >= MAX_TASKS) {
      overLimit += 1;
      continue;
    }
    const made = addRow(next, phaseCode);
    if (made === undefined) {
      overLimit += 1;
      continue;
    }
    const line = linesOf(made.template).find((one) => one.key === made.key);
    if (line === undefined || line.taskIndex === null) continue;
    next = nameLine(made.template, line, row.name);
    if (row.days !== null) next = setLimit(next, line.taskIndex, { value: row.days });
    const ref = row.unit === '' ? undefined : unitRefOf(row.unit);
    if (ref !== undefined) next = setLeadUnit(next, line.taskIndex, ref);
    next = settleCodes(next);
    added += 1;
  }
  return { template: next, added, overLimit };
}
