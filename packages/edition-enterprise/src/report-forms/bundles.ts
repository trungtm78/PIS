import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REPORT_FORM_CATALOGUE } from '@machvon/kernel/src/report-layout.ts';
import type { ReportFormBundle } from '@machvon/kernel/src/report-form.ts';
import { DEMO_FORMS } from './forms.ts';
import { illustrativeFillData } from './illustrative-data.ts';
import { ENTERPRISE_SNAPSHOT_PROVIDER } from './snapshot-data.ts';
import { templateFileName } from './template-builder.ts';

/**
 * The six demo forms as the report engine's registry takes them (RPT-1 part 2): each form with its receiver and period kind from the catalogue, its committed template files (`templates/demo`), and its illustrative data
 * (invented, labelled so). Nothing here is called by the manifest: the API's enterprise seam calls `enterpriseReportBundles()` once when the enterprise edition loads, so the public edition never holds these forms
 * and the web build never pulls the Excel and Word libraries in.
 */
const FOLDERS: readonly (readonly string[])[] = [
  ['packages', 'edition-enterprise', 'templates', 'demo'],
  ['templates', 'demo'],
];

/** The folder of the committed demo templates, found from the working directory and the started script and their parents by the presence of a template file. */
export function templatesFolder(starts: readonly string[] = [process.cwd(), process.argv[1] === undefined ? process.cwd() : dirname(process.argv[1])]): string {
  const probe = templateFileName(DEMO_FORMS[0]?.layout.code ?? 'PVN-MONTHLY', 'xlsx');
  for (const start of starts) {
    for (let directory = start; ; directory = dirname(directory)) {
      const found = FOLDERS.map((parts) => join(directory, ...parts)).find((path) => existsSync(join(path, probe)));
      if (found !== undefined) return found;
      if (dirname(directory) === directory) break;
    }
  }
  throw new Error(`demo forms: the template folder was not found from ${starts.join(', ')}`);
}

const readTemplate = (code: string, kind: 'xlsx' | 'docx'): Uint8Array => new Uint8Array(readFileSync(join(templatesFolder(), templateFileName(code, kind))));

export function enterpriseReportBundles(): ReportFormBundle[] {
  return DEMO_FORMS.map((form): ReportFormBundle => {
    const code = form.layout.code;
    const entry = REPORT_FORM_CATALOGUE.find((one) => one.code === code);
    if (entry === undefined) throw new Error(`demo forms: ${code} is not in the catalogue`);
    return {
      edition: 'enterprise',
      layout: form.layout,
      narrative: form.narrative,
      receiver: entry.receiver,
      periodKind: entry.period,
      dataSource: 'ILLUSTRATIVE',
      provider: null,
      // The form stays a DEMO form with its invented data until the official layout arrives (R18); when a frozen enterprise snapshot of the period exists, the engine fills it from that snapshot instead.
      snapshotProvider: ENTERPRISE_SNAPSHOT_PROVIDER,
      templates: async () => ({ xlsx: readTemplate(code, 'xlsx'), docx: form.narrative === null ? null : readTemplate(code, 'docx') }),
      illustrative: (period) => illustrativeFillData(form, period),
    };
  });
}
