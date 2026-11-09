export { DEMO_FORMS, COMMITTEE_PERIODIC, HPM_MONTHLY, INVEST_STEERING, PLANT_PHU_MY, PVN_MONTHLY, PVN_QUARTERLY_F2 } from './forms.ts';
export { FORM_META_KEYS, buildTableForm, columnsOf, moneyColumnKeys, rowRolesOf } from './common.ts';
export type { BodyRole, ColumnKey, DemoFormSpec, DemoPrint, PrefaceRole, RowRole, StripItem, TableFormDef } from './common.ts';
export { COMMITTEE_PERIODIC_NARRATIVE, INVEST_STEERING_NARRATIVE, PLANT_PHU_MY_NARRATIVE, PVN_QUARTERLY_NARRATIVE } from './narratives.ts';
export { ENTERPRISE_KPI_AS_OF, ENTERPRISE_KPI_CODES, ENTERPRISE_KPI_SEEDS, ENTERPRISE_KPI_SOURCE, demoFormsEnabled, registerEnterpriseReportRules } from './rules.ts';
export { ILLUSTRATIVE_COUNTS, illustrativeFigures, illustrativeFillData, illustrativeFillDataFor } from './illustrative-data.ts';
export { TEMPLATE_DATE, buildDemoTemplates, buildDocxSkeleton, buildXlsxTemplate, stampFooter, stampHeader, templateFileName } from './template-builder.ts';
export type { TemplateFile } from './template-builder.ts';
export { enterpriseReportBundles, templatesFolder } from './bundles.ts';
export { ENTERPRISE_SNAPSHOT_PROVIDER, snapshotFigures, snapshotFillData } from './snapshot-data.ts';
export type { SnapshotProjectName } from './snapshot-data.ts';
export { ENTERPRISE_DEFINITIONS } from './illustrative-data.ts';

import { DEMO_FORMS } from './forms.ts';
import type { DemoFormSpec } from './common.ts';

/** The demo form of a catalogue code, or undefined. */
export const demoFormOf = (code: string): DemoFormSpec | undefined => DEMO_FORMS.find((form) => form.layout.code === code);
