import { MOF_REPORT_TEXT as TEXT } from './messages/gov12-texts.ts';
import { MOF_FORMS } from './period-report.ts';
import type { MofFormCode } from './period-report.ts';
import { DIS_WEEKLY_LAYOUT } from './report-public-forms.ts';
import type { LayoutCell, LayoutRow, ReportLayout } from './report-layout.ts';

/**
 * The four forms for the Ministry of Finance (G4-6): week, month, quarter and year. The official template has not been supplied, so each is a layout in the status PENDING_EXTERNAL (R18): the system builds the grid from the
 * indicators of its own register, a draft can be made and read, but the copy cannot be issued and never counts as a copy that was filed (`assertLayoutIssuable` says `layout_status`). To put the official form in its place: read its
 * rows and columns into a new layout with the same code and a new version, `formRef` set to the letter or decision, status DRAFT, and move it to READY only after the owner confirms the match (docs/report-engine.md).
 * The body (the indicators and their order) is that of the weekly report of the system; only the words and the period kind differ.
 */
export const MOF_FORM_VERSION = '2026.0';

const wide = (cell: LayoutCell): LayoutCell => ({ ...cell, colSpan: 4 });
const text = (value: string): LayoutCell => wide({ col: 1, binding: { kind: 'TEXT', text: value } });
const meta = (key: string): LayoutCell => wide({ col: 1, binding: { kind: 'META', key } });

const NAMES: Readonly<Record<MofFormCode, { name: string; title: string }>> = {
  'MOF-DIS-WEEKLY': { name: TEXT.weekly_name, title: TEXT.weekly_title },
  'MOF-DIS-MONTHLY': { name: TEXT.monthly_name, title: TEXT.monthly_title },
  'MOF-DIS-QUARTERLY': { name: TEXT.quarterly_name, title: TEXT.quarterly_title },
  'MOF-DIS-YEARLY': { name: TEXT.yearly_name, title: TEXT.yearly_title },
};

function layoutOf(code: MofFormCode): ReportLayout {
  const words = NAMES[code];
  const preface: LayoutRow[] = [
    { kind: 'TITLE', cells: [text(words.title)] },
    { kind: 'TITLE', cells: [meta('ORG_NAME')] },
    { kind: 'TITLE', cells: [meta('PERIOD_LABEL')] },
    { kind: 'TITLE', cells: [meta('SNAPSHOT_LINE')] },
    { kind: 'NOTE', cells: [text(TEXT.pending_note)] },
  ];
  return Object.freeze({ ...DIS_WEEKLY_LAYOUT, code, name: words.name, version: MOF_FORM_VERSION, status: 'PENDING_EXTERNAL', formRef: null, sheetName: code, preface }) as ReportLayout;
}

/** The layouts for the Ministry, in the order week, month, quarter, year. */
export const MOF_LAYOUTS: readonly ReportLayout[] = Object.freeze(MOF_FORMS.map((form) => layoutOf(form.code)));
