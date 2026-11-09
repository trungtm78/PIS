import { NARRATIVE_PROJECTS_TOKEN } from '@machvon/kernel/src/ent-narrative.ts';
import { DEMO_MARK } from '@machvon/kernel/src/report-layout.ts';
import type { NarrativeBlock } from '@machvon/kernel/src/report-layout.ts';
import { formTexts } from './common.ts';
import { textsOf } from './texts.ts';

/**
 * The narrative parts (the Word "thuyet minh") of the demo report forms that have one: the skeleton of the Word document, as blocks the kernel resolves (`fillNarrative` puts the figure of the indicator register
 * into every `{{indicator:CODE@BASIS}}` token, so the sentence and the table of the form cannot give two numbers for one indicator). The parts the people write (reasons, difficulties and solutions, requests) are
 * the eight structured fields of each project (ENT-3b: status, milestones, disbursement, causes, difficulties, solutions, plan of the next period, proposals), laid out by `fillNarrative` at the token
 * `{{narrative:PROJECTS}}`; a field nobody wrote keeps a square-bracket hint, so a skeleton never invents a reason or a request. The demo mark is the first paragraph, and the Word writer repeats it in the header of every page.
 * The Vietnamese sentences are in `messages/narratives.vi.json`; the order of the blocks and the indicator codes of the capital table are here.
 */

interface SectionText {
  heading: string;
  /** The section lays out the narratives of the projects of the period (the token of the kernel). */
  projects: true;
}

interface NarrativeFormText {
  title: string;
  addressee?: string;
  afterFigures?: readonly string[];
  sections: readonly SectionText[];
}

interface NarrativeTexts {
  figures: {
    heading1: string;
    planParagraph: string;
    cumulativeParagraph: string;
    heading2: string;
    capitalHeader: readonly string[];
    capitalLabels: readonly string[];
    heading3: string;
    scheduleParagraph: string;
  };
  forms: Readonly<Record<string, NarrativeFormText>>;
}

const texts = textsOf<NarrativeTexts>('narratives');

const head = (title: string): NarrativeBlock[] => [
  { type: 'PARAGRAPH', text: DEMO_MARK, align: 'CENTER', bold: true },
  { type: 'PARAGRAPH', text: '{{meta:PARENT_NAME}}', align: 'LEFT', bold: false },
  { type: 'PARAGRAPH', text: '{{meta:ORG_NAME}}', align: 'LEFT', bold: true },
  { type: 'HEADING', level: 1, text: title },
  { type: 'PARAGRAPH', text: '{{meta:PERIOD_LABEL}}', align: 'CENTER', bold: true },
  { type: 'PARAGRAPH', text: '{{meta:UNIT_LABEL}}', align: 'RIGHT', italic: true },
];

/** The indicator of the capital table for each source of funds, in the order of the table: the amount and the share. */
const CAPITAL_ROWS: ReadonlyArray<readonly [string, string]> = [
  ['ENT_CAPITAL_EQUITY', 'ENT_SHARE_EQUITY'],
  ['ENT_CAPITAL_DEBT', 'ENT_SHARE_DEBT'],
  ['ENT_CAPITAL_OTHER', 'ENT_SHARE_OTHER'],
];

const figures: NarrativeBlock[] = [
  { type: 'HEADING', level: 2, text: texts.figures.heading1 },
  { type: 'PARAGRAPH', text: texts.figures.planParagraph },
  { type: 'PARAGRAPH', text: texts.figures.cumulativeParagraph },
  { type: 'HEADING', level: 2, text: texts.figures.heading2 },
  {
    type: 'TABLE',
    header: [...texts.figures.capitalHeader],
    rows: CAPITAL_ROWS.map(([amount, share], index) => [texts.figures.capitalLabels[index] as string, `{{indicator:${amount}@FULL_YEAR}}`, `{{indicator:${share}@FULL_YEAR}}`]),
    widths: [40, 35, 25],
  },
  { type: 'HEADING', level: 2, text: texts.figures.heading3 },
  { type: 'PARAGRAPH', text: texts.figures.scheduleParagraph },
];

const signatures: NarrativeBlock = {
  type: 'SIGNATURES',
  slots: ['{{meta:SIGN_PREPARER}}', '{{meta:SIGN_CHECKER}}', '{{meta:SIGN_APPROVER}}'].map((name, index) => ({ role: formTexts().layout.signRoles[index] as string, name })),
};

const sectionBlocks = (section: SectionText): NarrativeBlock[] => [
  { type: 'HEADING', level: 2, text: section.heading },
  { type: 'PARAGRAPH', text: NARRATIVE_PROJECTS_TOKEN },
];

/** The blocks of a form: the head, the figures (and the sentences after them), the narratives of the projects, the signatures. */
function narrativeOf(code: string): readonly NarrativeBlock[] {
  const form = texts.forms[code] as NarrativeFormText;
  return Object.freeze([
    ...head(form.title),
    ...(form.addressee === undefined ? [] : [{ type: 'PARAGRAPH', text: form.addressee, bold: true } as const]),
    ...figures,
    ...(form.afterFigures ?? []).map((text): NarrativeBlock => ({ type: 'PARAGRAPH', text })),
    ...form.sections.flatMap(sectionBlocks),
    signatures,
  ]);
}

/** The monthly report to the parent group: the narrative that goes with the table. */
export const PVN_MONTHLY_NARRATIVE: readonly NarrativeBlock[] = narrativeOf('PVN-MONTHLY');

/** The monthly report pushed to HPM: the narrative that goes with the table. */
export const HPM_MONTHLY_NARRATIVE: readonly NarrativeBlock[] = narrativeOf('HPM-MONTHLY');

/** The quarterly report to the parent group (Form 2): the narrative that goes with the table. */
export const PVN_QUARTERLY_NARRATIVE: readonly NarrativeBlock[] = narrativeOf('PVN-QUARTERLY-F2');

/** The periodic report to the committee for investment, development, science and technology. */
export const COMMITTEE_PERIODIC_NARRATIVE: readonly NarrativeBlock[] = narrativeOf('COMMITTEE-PERIODIC');

/** The monthly investment steering meeting report. */
export const INVEST_STEERING_NARRATIVE: readonly NarrativeBlock[] = narrativeOf('INVEST-STEERING');

/** The report of the Phu My fertiliser plant: capital construction and major repairs. */
export const PLANT_PHU_MY_NARRATIVE: readonly NarrativeBlock[] = narrativeOf('PLANT-PHU-MY');
